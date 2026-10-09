'use strict';

const path = require('path');
const events = require('../events');
const database = require('../../core/database');
const aiTagJob = require('../ai-tag-job');
const { createPuterIPCHandler, getAISettings } = require('./ai');
const { getThumbnailImagePayload } = require('../../core/thumbnails');
const { getModelByFilePath } = require('../../core/models');
const { clientDialogs } = require('../dialogs');

/**
 * Context menu → Generate Tags: tags the selected models with the AI service in Settings.
 * `event` is the menu request, `clickEvent` the click (it routes Puter to the right browser),
 * `sender` the sender captured when the menu opened.
 */
async function generateTagsFromMenu(event, clickEvent, sender, filePaths) {
  console.debug('[Generate Tags] Click handler called, filePaths:', filePaths);
  // Use clickEvent.sender if available (server mode), otherwise use captured sender (desktop mode)
  const eventSender = clickEvent && clickEvent.sender ? clickEvent.sender : sender;
  console.debug('[Generate Tags] Event sender:', {
    hasClickEventSender: !!(clickEvent && clickEvent.sender),
    hasCapturedSender: !!sender,
    usingSender: !!eventSender,
    hasSend: !!(eventSender && eventSender.send)
  });
  /** @type {any} */
  let tagJob = null;
  try {
    // One run at a time (the AI client and Puter's browser are shared by the run).
    if (aiTagJob.running()) {
      clientDialogs.messageBox(event, {
        type: 'info',
        title: 'Generate Tags',
        message: 'AI tagging is already running. Wait for it to finish, or stop it in the sidebar.'
      });
      return;
    }
    const aitagging = require('../../core/aitagging');
    const settings = getAISettings();
    console.debug('[Generate Tags] Settings loaded, filesToProcess will be determined');

    // Create puter IPC handler if service is puter
    // Pass clickEvent (which is the mockEvent with proper WebSocket routing) so it can route to the correct client
    // If clickEvent doesn't have sender, create a mock event with the captured sender
    const eventForPuter = clickEvent && clickEvent.sender ? clickEvent : { sender: sender, wsClient: null };
    console.debug(
      '[Generate Tags] Creating puterIPCHandler, aiService:',
      settings.aiService,
      'has clickEvent:',
      !!clickEvent,
      'has wsClient:',
      !!clickEvent?.wsClient
    );
    const puterIPCHandler = settings.aiService === 'puter' ? createPuterIPCHandler(eventForPuter) : null;
    console.debug('[Generate Tags] puterIPCHandler created:', { hasHandler: !!puterIPCHandler, handlerType: typeof puterIPCHandler });

    // Initialize OpenAI with the API key
    aitagging.initializeOpenAI(settings.apiKey, settings.apiEndpoint, settings.aiService, puterIPCHandler);

    // Filter out invalid file paths first
    const validFilePaths = filePaths.filter((fp) => fp && typeof fp === 'string');

    // Deduplicate by normalized path (avoids duplicate entries when new models added before refresh, e.g. server/docker)
    const normalizePathForDedup = (p) => {
      if (!p || typeof p !== 'string') return '';
      const n = p.replace(/\\/g, '/').toLowerCase().trim();
      return n.replace(/^\/+/, ''); // strip leading slashes so "/3dmodels/..." and "3dmodels/..." match
    };
    const seenPaths = new Set();
    const filesToProcess = [];
    for (const fp of validFilePaths.length > 0 ? validFilePaths : filePaths) {
      const norm = normalizePathForDedup(fp);
      if (norm && !seenPaths.has(norm)) {
        seenPaths.add(norm);
        filesToProcess.push(fp);
      }
    }

    tagJob = aiTagJob.start(event && event.user ? event.user.username : null, filesToProcess);
    if (!tagJob) return;
    const runId = tagJob.id;
    // Every page hears each result (ai-tag-job.js keeps them for a review picked up later).
    const report = (filePath, tags, error) => {
      aiTagJob.record(runId, filePath, tags, error);
      events.broadcast('tags-generated', filePath, tags, error || null, runId);
    };

    // Start tag generation - show review dialog immediately for both single and multiple files
    if (filesToProcess.length > 1) {
      // Send all file paths so the dialog can show all models immediately
      console.debug('[Generate Tags] Sending start-batch-tag-generation event, count:', filesToProcess.length);
      // In server mode, use broadcastEvent to send to all WebSocket clients
      console.debug('[Generate Tags] Broadcasting start-batch-tag-generation via WebSocket');
      events.toCaller(event, 'start-batch-tag-generation', filesToProcess.length, filesToProcess, runId);
    } else if (filesToProcess.length === 1) {
      // For single file, also open dialog immediately with "Generating..." status
      const singleModel = getModelByFilePath(filesToProcess[0], { includeThumbnail: true });
      if (singleModel) {
        const modelTagRows = database.db
          .prepare(
            `
          SELECT t.name 
          FROM tags t
          JOIN model_tags mt ON mt.tag_id = t.id
          WHERE mt.model_id = ?
        `
          )
          .all(singleModel.id);
        const modelTags = modelTagRows.map((row) => row.name);

        const modelData = {
          filePath: filesToProcess[0],
          model: singleModel,
          generatedTags: undefined, // undefined means "generating"
          existingTags: modelTags
        };

        console.debug('[Generate Tags] Sending start-single-tag-generation event');
        // In server mode, use broadcastEvent to send to all WebSocket clients
        console.debug('[Generate Tags] Broadcasting start-single-tag-generation via WebSocket');
        events.toCaller(event, 'start-single-tag-generation', filesToProcess[0], modelData, runId);
      } else {
        console.debug('Model not found in database for single file generation');
      }
    }

    // Process files in parallel with concurrency limit
    const concurrency = Math.max(1, Math.min(settings.aiTagConcurrency || 3, 10));
    let rateLimitStopped = false;
    const totalFiles = filesToProcess.length;
    const rateLimitSkipMessage =
      'Rate limit exceeded: Tag generation stopped because the API rate limit did not clear. Tags already generated can still be applied.';

    // Helper function to process a single file
    // Use eventSender (captured from event or clickEvent) for sending events
    const processFile = async (filePath, index) => {
      if (rateLimitStopped || aiTagJob.stopRequested(runId)) {
        report(filePath, [], rateLimitStopped ? rateLimitSkipMessage : 'Stopped before this model. Tags already generated can still be applied.');
        return;
      }
      try {
        // Get the model from the database to access its thumbnail
        const model = getModelByFilePath(filePath, { includeThumbnail: true });

        if (!model) {
          console.debug(`Model not found in database: ${filePath}, skipping`);
          report(filePath, [], null);
          return;
        }

        // Get the model tags from the database
        const modelTagRows = database.db
          .prepare(
            `
          SELECT t.name 
          FROM tags t
          JOIN model_tags mt ON mt.tag_id = t.id
          WHERE mt.model_id = ?
        `
          )
          .all(model.id);

        const modelTags = modelTagRows.map((row) => row.name);

        // Check if model already has the "AI Tagged" tag (unless retagging is allowed)
        if (!settings.aiTagAllowRetagging && modelTags.includes('AI Tagged')) {
          console.debug(`Model ${filePath} already has AI Tagged tag, skipping generation`);
          report(filePath, [], null);
          return;
        }

        // Prepare tag generation options (read aiTagPrompt from DB so we always have latest)
        const aiTagPromptValue = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagPrompt')?.value ?? null;
        const tagOptions = {
          maxTags: settings.aiTagMaxTags,
          useCategories: settings.aiTagUseCategories,
          useJsonResponse: settings.aiTagUseJsonResponse,
          detailLevel: settings.aiTagDetailLevel,
          folderLevels: settings.aiTagFolderLevels,
          notes: model.notes || '',
          customPrompt: aiTagPromptValue != null && String(aiTagPromptValue).trim() !== '' ? String(aiTagPromptValue).trim() : null
        };

        let tags = [];

        if (!model.thumbnail) {
          // If no thumbnail exists, use default image
          console.debug(`No thumbnail found for model ${filePath}, using default image`);
          try {
            const fs = require('fs').promises;
            const defaultImagePath = path.join(__dirname, '..', '..', '..', 'assets', 'logo.png');
            const data = await fs.readFile(defaultImagePath, { encoding: 'base64' });
            tags = await aitagging.generateTagsForImage(data, settings.aiModel, tagOptions, 2000, 5, filePath);
          } catch (error) {
            console.error(`Error generating tags with default image for ${filePath}:`, error);
            // Check if it's a rate limit error
            if (error.message && error.message.includes('Rate limit')) {
              rateLimitStopped = true;
              report(filePath, [], error.message);
              return;
            }
          }
        } else {
          // Use default thumb only — multi-thumb strings are joined with `::`
          const imagePayload = getThumbnailImagePayload(model.thumbnail);

          if (!imagePayload) {
            console.error(`Invalid thumbnail format for ${filePath}`);
          } else {
            try {
              // Generate tags using the thumbnail image
              tags = await aitagging.generateTagsForImage(
                imagePayload.base64,
                settings.aiModel,
                { ...tagOptions, mimeType: imagePayload.mimeType },
                2000,
                5,
                filePath
              );
            } catch (error) {
              console.error(`Error generating tags for ${filePath}:`, error);
              // Check if it's a rate limit error
              if (error.message && error.message.includes('Rate limit')) {
                rateLimitStopped = true;
                report(filePath, [], error.message);
                return;
              }
            }
          }
        }

        report(filePath, tags, null);

        // Progress is now shown in the review dialog
      } catch (error) {
        console.error(`Unexpected error processing ${filePath}:`, error);
        // Check if it's a rate limit error
        if (error.message && error.message.includes('Rate limit')) {
          rateLimitStopped = true;
          report(filePath, [], error.message);
        } else {
          report(filePath, []);
        }
      }
    };

    // Process files in batches with concurrency limit
    for (let i = 0; i < filesToProcess.length; i += concurrency) {
      const batch = filesToProcess.slice(i, i + concurrency);
      await Promise.all(batch.map((filePath, batchIndex) => processFile(filePath, i + batchIndex)));
    }

    // Signal batch completion for multiple files
    aiTagJob.finish(runId);
    if (totalFiles > 1) {
      events.broadcast('batch-tag-generation-complete', runId);
    }
  } catch (error) {
    console.error('Error generating tags:', error);

    if (tagJob) {
      aiTagJob.finish(tagJob.id);
      if (tagJob.batch) events.broadcast('batch-tag-generation-complete', tagJob.id);
    }

    // Close progress dialog if open
    if (filePaths.length > 1 && eventSender && eventSender.send) {
      eventSender.send('close-progress-dialog');
    }

    // Provide more user-friendly error messages
    let errorMessage = 'Could not generate tags';
    let errorDetail = error.message || 'An unknown error occurred';

    if (error.message && error.message.includes('Authentication failed')) {
      errorMessage = 'Authentication Error';
      errorDetail = 'Your API key is invalid or has insufficient permissions. Please check your AI configuration settings.';
    } else if (error.message && error.message.includes('Network error')) {
      errorMessage = 'Connection Error';
      errorDetail = 'Unable to connect to the AI service. Please check your internet connection and API endpoint settings.';
    } else if (error.message && error.message.includes('Rate limit')) {
      errorMessage = 'Rate Limit Exceeded';
      // Extract the detailed message if available (after "Rate limit exceeded: ")
      const detailedMessage = error.message.includes('Rate limit exceeded: ')
        ? error.message.split('Rate limit exceeded: ')[1]
        : 'API rate limit has been exceeded. Please try again later.';
      errorDetail = detailedMessage;
    } else if (error.message && error.message.includes('Invalid request')) {
      errorMessage = 'Invalid Request';
      errorDetail = error.message;
    }

    clientDialogs.messageBox(event, {
      type: 'error',
      title: errorMessage,
      message: errorDetail,
      detail: error.stack ? `Technical details: ${error.stack.substring(0, 200)}...` : ''
    });
  }
}

module.exports = { generateTagsFromMenu };
