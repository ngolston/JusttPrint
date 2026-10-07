'use strict';;
const events = require('../events');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { createPuterIPCHandler, getAISettings } = require('./ai');
const fs = require('fs');
const path = require('path');
const { isUrlModel, parseZipPath } = require('../../core/library-paths');
const { getThumbnailImagePayload, parseThumbnails, readThumbnailColumn } = require('../../core/thumbnails');
const { deleteModelJunctionRows, deleteModelsByFilePaths, getModelByFilePath } = require('../../core/models');
const { clientDialogs } = require('../dialogs');
const { clampFolderLevels } = require('../../core/library-context');
const { applyFolderTagsToModels: applyFolderTagsInDb } = require('../../core/folder-tags');
require("../auth");
require("../../core/zip-entries");
const { ensureSlicersTableExists, slicerCommand } = require('./slicers');
const { extract3MFMetadata, filter3MFMetadataBySettings } = require('../../core/three-mf');

// Store pending context menu actions for server mode (browser access)
const pendingContextMenus = new Map();

let contextMenuRequestIdCounter = 0;

function getPreviewableExtension(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const pathForExt = filePath.includes('::') ? (filePath.split('::')[1] || '') : filePath;
  return path.extname(pathForExt).toLowerCase();
}

function isPreviewableModelFile(filePath) {
  const ext = getPreviewableExtension(filePath);
  return ext === '.stl' || ext === '.3mf' || ext === '.obj' || ext === '.ply'
    || ext === '.step' || ext === '.stp' || ext === '.lys' || ext === '.igs' || ext === '.iges'
    || ext === '.f3d' || ext === '.chitubox' || ext === '.voxl';
}

function sendPreviewBundleEvent(event, payload) {
  events.toCaller(event, 'preview-bundle-models', payload);
}

function sendPreviewModelEvent(event, filePath) {
  events.toCaller(event, 'preview-model', filePath);
}

// Update the show-context-menu handler
ipcMain.handle('show-context-menu', async (event, fileIdentifier) => {
  let filePaths;
  let groupLabel = null;
  let previewAsBundle = false;
  if (
    fileIdentifier &&
    typeof fileIdentifier === 'object' &&
    !Array.isArray(fileIdentifier) &&
    Array.isArray(fileIdentifier.filePaths)
  ) {
    filePaths = fileIdentifier.filePaths.filter(Boolean);
    groupLabel = fileIdentifier.groupLabel || null;
    previewAsBundle = Boolean(fileIdentifier.previewAsBundle);
  } else {
    filePaths = Array.isArray(fileIdentifier) ? fileIdentifier : [fileIdentifier];
  }

  // In single edit mode, if exactly one file is right-clicked, instruct the renderer to select it.
  if (filePaths.length === 1) {
    events.toCaller(event, 'select-model-by-filepath', filePaths[0]);
  }

  // Check if any file is a zip entry
  const isZipEntry = filePaths.length === 1 && filePaths[0].includes('::');
  const pathInfo = filePaths.length === 1 ? parseZipPath(filePaths[0]) : null;

  let menuItems = [];

  // Add "Preview" option at the top (single model or full bundle/group)
  const previewablePaths = filePaths.filter((fp) => isPreviewableModelFile(fp));
  if (previewablePaths.length === 1 && !previewAsBundle) {
    const fp = previewablePaths[0];
    menuItems.push({
      label: 'Preview',
      click: async () => {
        try {
          console.log('Preview clicked for file:', fp);
          sendPreviewModelEvent(event, fp);
        } catch (error) {
          console.error('Error triggering preview:', error);
          if (event && event.sender) {
            clientDialogs.messageBox(event, {
              type: 'error',
              title: 'Error',
              message: 'Could not preview file',
              detail: error.message
            });
          }
        }
      }
    });
    menuItems.push({ type: 'separator' });
  } else if (previewablePaths.length > 1 || (previewAsBundle && previewablePaths.length >= 1)) {
    const bundlePayload = {
      groupLabel: groupLabel || (previewablePaths.length > 1 ? 'Bundle' : 'Preview'),
      children: previewablePaths.map((fp) => ({
        filePath: fp,
        fileName: fp.includes('::')
          ? path.basename(fp.split('::')[1] || fp)
          : path.basename(fp)
      }))
    };
    menuItems.push({
      label: 'Preview',
      click: async () => {
        try {
          console.log('Preview clicked for bundle/group:', bundlePayload.groupLabel, bundlePayload.children.length);
          sendPreviewBundleEvent(event, bundlePayload);
        } catch (error) {
          console.error('Error triggering bundle preview:', error);
          if (event && event.sender) {
            clientDialogs.messageBox(event, {
              type: 'error',
              title: 'Error',
              message: 'Could not preview bundle',
              detail: error.message
            });
          }
        }
      }
    });
    menuItems.push({ type: 'separator' });
  }

  // Download and Copy Path run in the browser that opened the menu (clientAction); the click
  // handlers are for callers that cannot.
  if (filePaths.length === 1) {
    menuItems.push({
      label: 'Download',
      clientAction: { type: 'download', filePath: filePaths[0] },
      click: async () => {
        events.toCaller(event, 'download-model', filePaths[0]);
      }
    });
  }
  if (filePaths.length >= 1) {
    menuItems.push({
      label: filePaths.length === 1 ? 'Copy Path' : 'Copy Paths',
      clientAction: { type: 'copy-paths', filePaths: filePaths.slice() },
      click: () => {}
    });
    menuItems.push({ type: 'separator' });
  }

  // Get all configured slicers from the database
  let slicers = [];
  try {
    // Ensure the slicers table exists before querying it
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (tableExists) {
      slicers = database.db.prepare('SELECT * FROM slicers').all();
    } else {
      // Create the table if it doesn't exist
      ensureSlicersTableExists();
    }
  } catch (error) {
    console.error('Error getting slicers:', error);
  }

  // Send to Slicer hands the files to the helper on the user's computer (justtprint://).
  if (slicers.length > 0 && filePaths.length >= 1) {
    const slicerSubmenu = {
      label: 'Open in Slicer',
      submenu: slicers.map(slicer => ({
        label: slicer.name,
        slicerName: slicer.name,
        slicerPath: slicer.path,
        // The browser launches straight from the menu item's clientAction; this only runs
        // when a client asks the server to run the item, and answers that browser alone.
        click: async () => {
          events.sendTo(event.wsClient, 'execute-client-command', slicerCommand(slicer, filePaths));
        }
      }))
    };
    menuItems.push(slicerSubmenu);
  }

  menuItems.push({
    label: 'Tag from Folder',
    click: async () => {
      const configuredLevels = clampFolderLevels(getAISettings().aiTagFolderLevels);
      const levels = configuredLevels > 0 ? configuredLevels : 1;
      try {
        const result = applyFolderTagsToModels(filePaths, levels);
        events.broadcast('refresh-grid');
        const summary = result.tagsAdded > 0
          ? `Added ${result.tagsAdded} tag${result.tagsAdded === 1 ? '' : 's'} on ${result.updated} model${result.updated === 1 ? '' : 's'}.`
          : 'No new folder tags were added. Those tags may already be on the models, or the files have no usable parent folder.';
        console.log('[Tag from Folder]', summary);
      } catch (error) {
        console.error('Error tagging from folder:', error);
      }
    }
  });

  // Check if API key exists in settings
  const apiKeyRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey');
  const apiKey = apiKeyRow ? apiKeyRow.value : null;

  // Check AI service type
  const aiServiceRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiService');
  const aiService = aiServiceRow ? aiServiceRow.value : 'openai';
  const apiEndpointRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('apiEndpoint');
  const apiEndpoint = apiEndpointRow ? apiEndpointRow.value : null;
  const aitaggingForMenu = require('../../core/aitagging');

  // Add "Generate Tags" when a key is set, or when the selected service/endpoint does not need one
  // (Puter, Custom, and local OpenAI-compatible servers such as Ollama / LM Studio)
  if (apiKey || !aitaggingForMenu.requiresApiKey(aiService, apiEndpoint)) {
    // Capture event.sender for use in the click handler (needed for desktop mode)
    const sender = event.sender;
    menuItems.push({
      label: 'Generate Tags',
      // Remove the restriction to only one file
      click: async (clickEvent) => {
        console.log('[Generate Tags] Click handler called, filePaths:', filePaths);
        // Use clickEvent.sender if available (server mode), otherwise use captured sender (desktop mode)
        const eventSender = (clickEvent && clickEvent.sender) ? clickEvent.sender : sender;
        console.log('[Generate Tags] Event sender:', { 
          hasClickEventSender: !!(clickEvent && clickEvent.sender),
          hasCapturedSender: !!sender,
          usingSender: !!eventSender,
          hasSend: !!(eventSender && eventSender.send)
        });
        try {
          const aitagging = require('../../core/aitagging');
          const settings = getAISettings();
          console.log('[Generate Tags] Settings loaded, filesToProcess will be determined');
          
          // Create puter IPC handler if service is puter
          // Pass clickEvent (which is the mockEvent with proper WebSocket routing) so it can route to the correct client
          // If clickEvent doesn't have sender, create a mock event with the captured sender
          const eventForPuter = clickEvent && clickEvent.sender ? clickEvent : { sender: sender, wsClient: null };
          console.log('[Generate Tags] Creating puterIPCHandler, aiService:', settings.aiService, 'has clickEvent:', !!clickEvent, 'has wsClient:', !!(clickEvent?.wsClient));
          const puterIPCHandler = settings.aiService === 'puter' ? createPuterIPCHandler(eventForPuter) : null;
          console.log('[Generate Tags] puterIPCHandler created:', { hasHandler: !!puterIPCHandler, handlerType: typeof puterIPCHandler });
          
          // Initialize OpenAI with the API key
          aitagging.initializeOpenAI(settings.apiKey, settings.apiEndpoint, settings.aiService, puterIPCHandler);
          
          // Filter out invalid file paths first
          const validFilePaths = filePaths.filter(fp => fp && typeof fp === 'string');
          
          // Deduplicate by normalized path (avoids duplicate entries when new models added before refresh, e.g. server/docker)
          const normalizePathForDedup = (p) => {
            if (!p || typeof p !== 'string') return '';
            const n = p.replace(/\\/g, '/').toLowerCase().trim();
            return n.replace(/^\/+/, ''); // strip leading slashes so "/3dmodels/..." and "3dmodels/..." match
          };
          const seenPaths = new Set();
          const filesToProcess = [];
          for (const fp of (validFilePaths.length > 0 ? validFilePaths : filePaths)) {
            const norm = normalizePathForDedup(fp);
            if (norm && !seenPaths.has(norm)) {
              seenPaths.add(norm);
              filesToProcess.push(fp);
            }
          }
          
          // Start tag generation - show review dialog immediately for both single and multiple files
          if (filesToProcess.length > 1) {
            // Send all file paths so the dialog can show all models immediately
            console.log('[Generate Tags] Sending start-batch-tag-generation event, count:', filesToProcess.length);
            // In server mode, use broadcastEvent to send to all WebSocket clients
            console.log('[Generate Tags] Broadcasting start-batch-tag-generation via WebSocket');
            events.toCaller(event, 'start-batch-tag-generation', filesToProcess.length, filesToProcess);
          } else if (filesToProcess.length === 1) {
            // For single file, also open dialog immediately with "Generating..." status
            const singleModel = getModelByFilePath(filesToProcess[0], { includeThumbnail: true });
            if (singleModel) {
              const modelTagRows = database.db.prepare(`
                SELECT t.name 
                FROM tags t
                JOIN model_tags mt ON mt.tag_id = t.id
                WHERE mt.model_id = ?
              `).all(singleModel.id);
              const modelTags = modelTagRows.map(row => row.name);

              const modelData = {
                filePath: filesToProcess[0],
                model: singleModel,
                generatedTags: undefined, // undefined means "generating"
                existingTags: modelTags
              };

              console.log('[Generate Tags] Sending start-single-tag-generation event');
              // In server mode, use broadcastEvent to send to all WebSocket clients
              console.log('[Generate Tags] Broadcasting start-single-tag-generation via WebSocket');
              events.toCaller(event, 'start-single-tag-generation', filesToProcess[0], modelData);
            } else {
              console.log('Model not found in database for single file generation');
            }
          }
          
          // Process files in parallel with concurrency limit
          const concurrency = Math.max(1, Math.min(settings.aiTagConcurrency || 3, 10));
          let completed = 0;
          let successCount = 0;
          let failureCount = 0;
          let rateLimitStopped = false;
          const totalFiles = filesToProcess.length;
          const rateLimitSkipMessage = 'Rate limit exceeded: Tag generation stopped because the API rate limit did not clear. Tags already generated can still be applied.';
          
          // Helper function to process a single file
          // Use eventSender (captured from event or clickEvent) for sending events
          const processFile = async (filePath, index) => {
            if (rateLimitStopped) {
              completed++;
              events.toCaller(event, 'tags-generated', filePath, [], rateLimitSkipMessage);
              return;
            }
            try {
              // Get the model from the database to access its thumbnail
              const model = getModelByFilePath(filePath, { includeThumbnail: true });

              if (!model) {
                console.log(`Model not found in database: ${filePath}, skipping`);
                completed++;
                events.toCaller(event, 'tags-generated', filePath, [], null);
                return;
              }

              // Get the model tags from the database
              const modelTagRows = database.db.prepare(`
                SELECT t.name 
                FROM tags t
                JOIN model_tags mt ON mt.tag_id = t.id
                WHERE mt.model_id = ?
              `).all(model.id);

              const modelTags = modelTagRows.map(row => row.name);

              // Check if model already has the "AI Tagged" tag (unless retagging is allowed)
              if (!settings.aiTagAllowRetagging && modelTags.includes("AI Tagged")) {
                console.log(`Model ${filePath} already has AI Tagged tag, skipping generation`);
                completed++;
                events.toCaller(event, 'tags-generated', filePath, [], null);
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
                customPrompt: (aiTagPromptValue != null && String(aiTagPromptValue).trim() !== '') ? String(aiTagPromptValue).trim() : null
              };

              let tags = [];

              if (!model.thumbnail) {
                // If no thumbnail exists, use default image
                console.log(`No thumbnail found for model ${filePath}, using default image`);
                try {
                  const fs = require('fs').promises;
                  const defaultImagePath = './logo.png';
                  const data = await fs.readFile(defaultImagePath, { encoding: 'base64' });
                  tags = await aitagging.generateTagsForImage(data, settings.aiModel, tagOptions, 2000, 5, filePath);
                  successCount++;
                } catch (error) {
                  console.error(`Error generating tags with default image for ${filePath}:`, error);
                  failureCount++;
                  // Check if it's a rate limit error
                  if (error.message && error.message.includes('Rate limit')) {
                    rateLimitStopped = true;
                    events.toCaller(event, 'tags-generated', filePath, [], error.message);
                    completed++;
                    return;
                  }
                }
              } else {
                // Use default thumb only — multi-thumb strings are joined with `::`
                const imagePayload = getThumbnailImagePayload(model.thumbnail);
                
                if (!imagePayload) {
                  console.error(`Invalid thumbnail format for ${filePath}`);
                  failureCount++;
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
                    successCount++;
                  } catch (error) {
                    console.error(`Error generating tags for ${filePath}:`, error);
                    failureCount++;
                    // Check if it's a rate limit error
                    if (error.message && error.message.includes('Rate limit')) {
                      rateLimitStopped = true;
                      events.toCaller(event, 'tags-generated', filePath, [], error.message);
                      completed++;
                      return;
                    }
                  }
                }
              }

              events.toCaller(event, 'tags-generated', filePath, tags, null);

              completed++;
              // Progress is now shown in the review dialog
            } catch (error) {
              console.error(`Unexpected error processing ${filePath}:`, error);
              failureCount++;
              completed++;
              // Check if it's a rate limit error
              if (error.message && error.message.includes('Rate limit')) {
                rateLimitStopped = true;
                events.toCaller(event, 'tags-generated', filePath, [], error.message);
              } else {
                events.toCaller(event, 'tags-generated', filePath, []);
              }
            }
          };
          
          // Process files in batches with concurrency limit
          for (let i = 0; i < filesToProcess.length; i += concurrency) {
            const batch = filesToProcess.slice(i, i + concurrency);
            await Promise.all(batch.map((filePath, batchIndex) => 
              processFile(filePath, i + batchIndex)
            ));
          }
          
          // Signal batch completion for multiple files
          if (totalFiles > 1) {
            events.toCaller(event, 'batch-tag-generation-complete');
          }
        } catch (error) {
          console.error('Error generating tags:', error);

          if (filePaths.length > 1) {
            events.toCaller(event, 'batch-tag-generation-complete');
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
    });
  }

  // Check if any selected files are 3MF files
  const has3MFFiles = filePaths.some(fp => {
    const ext = path.extname(fp).toLowerCase();
    // Handle zip entries - check the entry path extension
    if (fp.includes('::')) {
      const entryPath = fp.split('::')[1];
      return path.extname(entryPath).toLowerCase() === '.3mf';
    }
    return ext === '.3mf';
  });

  // Add "Pull Metadata" option for 3MF files
  if (has3MFFiles) {
    menuItems.push({
      label: 'Pull Metadata',
      click: async () => {
        try {
          // Filter to only 3MF files
          const threeMFFiles = filePaths.filter(fp => {
            const ext = path.extname(fp).toLowerCase();
            if (fp.includes('::')) {
              const entryPath = fp.split('::')[1];
              return path.extname(entryPath).toLowerCase() === '.3mf';
            }
            return ext === '.3mf';
          });
          
          if (threeMFFiles.length === 0) {
            return;
          }
          
          // Check existing models to see if any have data that will be overwritten
          const modelsWithData = [];
          for (const filePath of threeMFFiles) {
            const model = getModelByFilePath(filePath, { includeThumbnail: true });
            if (model) {
              const hasData = (model.designer && model.designer.trim()) ||
                             (model.parentModel && model.parentModel.trim()) ||
                             (model.notes && model.notes.trim()) ||
                             (model.license && model.license.trim());
              if (hasData) {
                modelsWithData.push({
                  filePath,
                  fileName: model.fileName || path.basename(filePath),
                  designer: model.designer,
                  parentModel: model.parentModel,
                  notes: model.notes,
                  license: model.license
                });
              }
            }
          }
          
          // Show confirmation dialog if any models have existing data
          if (modelsWithData.length > 0) {
            const message = modelsWithData.length === 1
              ? `This will overwrite existing metadata for:\n\n${modelsWithData[0].fileName}\n\nExisting data:\n${modelsWithData[0].designer ? `Designer: ${modelsWithData[0].designer}\n` : ''}${modelsWithData[0].parentModel ? `Parent Model: ${modelsWithData[0].parentModel}\n` : ''}${modelsWithData[0].notes ? `Notes: ${modelsWithData[0].notes.substring(0, 50)}${modelsWithData[0].notes.length > 50 ? '...' : ''}\n` : ''}${modelsWithData[0].license ? `License: ${modelsWithData[0].license}\n` : ''}\n\nContinue?`
              : `This will overwrite existing metadata for ${modelsWithData.length} model(s).\n\nContinue?`;
            
            const confirm = await clientDialogs.messageBox(event, {
              type: 'warning',
              title: 'Confirm Metadata Overwrite',
              message: message,
              buttons: ['Yes', 'No'],
              defaultId: 1,
              cancelId: 1
            });
            
            if (confirm.response !== 0) {
              return; // User cancelled
            }
          }
          
          // Process each file
          const results = [];
          let successCount = 0;
          let errorCount = 0;
          let noMetadataCount = 0;
          
          for (const filePath of threeMFFiles) {
            try {
              const metadata = await extract3MFMetadata(filePath);
              
              // Filter metadata based on user settings
              const filteredMetadata = filter3MFMetadataBySettings(metadata);
              
              if (filteredMetadata && (filteredMetadata.designer || filteredMetadata.parentModel || filteredMetadata.notes || filteredMetadata.license)) {
                // Get or create model in database
                let existingModel = getModelByFilePath(filePath, { includeThumbnail: true });
                
                if (!existingModel) {
                  // Create new model entry
                  const fileName = path.basename(filePath);
                  const finalFileName = filePath.includes('::') 
                    ? filePath.split('::').pop() 
                    : fileName;
                  const dateAdded = new Date().toISOString();
                  
                  database.db.prepare(`
                    INSERT INTO models (filePath, fileName, designer, parentModel, notes, license, dateAdded, isNew)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                  `).run(
                    filePath,
                    finalFileName,
                    filteredMetadata.designer || null,
                    filteredMetadata.parentModel || null,
                    filteredMetadata.notes || null,
                    filteredMetadata.license || null,
                    dateAdded
                  );
                  
                  results.push({ filePath, success: true, action: 'created' });
                  successCount++;
                } else {
                  // Update existing model - overwrite all fields
                  database.db.prepare(`
                    UPDATE models 
                    SET designer = ?, parentModel = ?, notes = ?, license = ?
                    WHERE filePath = ?
                  `).run(
                    filteredMetadata.designer || null,
                    filteredMetadata.parentModel || null,
                    filteredMetadata.notes || null,
                    filteredMetadata.license || null,
                    filePath
                  );
                  
                  results.push({ filePath, success: true, action: 'updated' });
                  successCount++;
                }
              } else {
                results.push({ filePath, success: false, error: 'No metadata found in 3MF file' });
                noMetadataCount++;
              }
            } catch (error) {
              console.error(`Error processing ${filePath}:`, error);
              results.push({ filePath, success: false, error: error.message });
              errorCount++;
            }
          }
          
          // Refresh the grid
          event.sender.send('refresh-grid');
          
          // Show completion message
          let message = '';
          if (successCount > 0) {
            message = `Successfully pulled metadata from ${successCount} file(s).`;
          }
          
          const parts = [];
          if (noMetadataCount > 0) {
            parts.push(`${noMetadataCount} file(s) didn't have metadata`);
          }
          if (errorCount > 0) {
            parts.push(`${errorCount} file(s) had errors`);
          }
          
          if (parts.length > 0) {
            if (message) {
              message += '\n\n' + parts.join('.\n');
            } else {
              message = parts.join('.\n');
            }
          }
          
          if (!message) {
            message = 'No files processed.';
          }
          
          await clientDialogs.messageBox(event, {
            type: 'info',
            title: 'Metadata Pull Complete',
            message: message
          });
        } catch (error) {
          console.error('Error pulling metadata:', error);
          await clientDialogs.messageBox(event, {
            type: 'error',
            title: 'Error',
            message: 'Could not pull metadata',
            detail: error.message
          });
        }
      }
    });
  }

  // Add "Add Image" option for single or multi selection (same image added to all selected)
  if (filePaths.length >= 1) {
    menuItems.push({
      label: 'Add Image',
      click: async () => {
        try {
          events.toCaller(event, 'add-image-request', filePaths);
        } catch (error) {
          console.error('Error adding image:', error);
          clientDialogs.messageBox(event, {
            type: 'error',
            title: 'Error',
            message: 'Could not add image',
            detail: error.message
          });
        }
      }
    });
  }

  // Keep "Manage Thumbnails" visible in all modes for menu consistency.
  // It is only actionable for a single selected model.
  menuItems.push({
    label: 'Manage Thumbnails',
    enabled: filePaths.length === 1,
    click: async () => {
      if (filePaths.length !== 1) return;
      try {
        // Check if model has at least one thumbnail
        const storedThumbnail = readThumbnailColumn(filePaths[0]);
        const thumbnails = storedThumbnail ? parseThumbnails(storedThumbnail).filter(t => t && t !== '3d.png' && t.length > 0 && t.startsWith('data:image')) : [];

        if (thumbnails.length === 0) {
          await clientDialogs.messageBox(event, {
            type: 'info',
            title: 'No Thumbnails',
            message: 'This model has no thumbnails to manage.',
            detail: 'Please add an image first using "Add Image".'
          });
          return;
        }

        events.toCaller(event, 'manage-thumbnails-request', filePaths[0]);
      } catch (error) {
        console.error('Error opening manage thumbnails:', error);
        clientDialogs.messageBox(event, {
          type: 'error',
          title: 'Error',
          message: 'Could not open thumbnail manager',
          detail: error.message
        });
      }
    }
  });

  // Add separator before file operations
  menuItems.push({ type: 'separator' });

  // Add Move and new file operations
  // Note: "Move" is excluded in server mode
  const fileOperationItems = [];

  menuItems.push(
    ...fileOperationItems,
    {
      label: 'Remove from Library',
      click: async () => {
        // In server mode (Docker/browser), no native dialog - proceed and broadcast refresh
        let confirmed = true;
        if (confirmed) {
          try {
            deleteModelsByFilePaths(filePaths);
            events.broadcast('refresh-grid');
          } catch (error) {
            console.error('Error removing from library:', error);
          }
        }
      }
    },
    {
      label: 'Delete from Disk',  // Renamed from just "Delete"
      click: async () => {
        // In server mode (Docker/browser), no native dialog - proceed and broadcast refresh
        let confirmed = true;
        if (confirmed) {
          for (const fp of filePaths) {
            try {
              const success = await deleteFile(fp);
            } catch (error) {
              console.error('Error deleting file:', error);
            }
          }
          events.broadcast('refresh-grid');
        }
      }
    }
  );

  // The browser renders the menu; clicks come back through execute-context-menu-action.
  {
    // Generate unique request ID for this context menu
    const requestId = `ctx_${++contextMenuRequestIdCounter}_${Date.now()}`;
    
    // Store the menu items with their click handlers
    pendingContextMenus.set(requestId, {
      menuItems: menuItems,
      filePaths: filePaths,
      event: event,
      timestamp: Date.now()
    });
    
    // Clean up old menus (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    for (const [id, menu] of pendingContextMenus.entries()) {
      if (menu.timestamp < fiveMinutesAgo) {
        pendingContextMenus.delete(id);
      }
    }
    
    // Serialize menu items for browser rendering
    const serializedItems = menuItems.map((item, index) => {
      if (item.type === 'separator') {
        return { type: 'separator' };
      }
      const serialized = {
        label: item.label,
        enabled: item.enabled !== false, // Default to true if not specified
        index: index
      };
      if (item.clientAction) serialized.clientAction = item.clientAction;
      // Handle submenus
      if (item.submenu) {
        serialized.submenu = item.submenu.map((subItem, subIndex) => {
          const entry = {
            label: subItem.label,
            enabled: subItem.enabled !== false,
            index: index,
            subIndex: subIndex
          };
          if (subItem.slicerPath) {
            entry.clientAction = slicerCommand({ name: subItem.slicerName || subItem.label, path: subItem.slicerPath }, filePaths);
          }
          return entry;
        });
      }
      return serialized;
    });
    
    // Return menu items instead of showing native menu
    return {
      type: 'html-menu',
      requestId: requestId,
      items: serializedItems,
      filePaths: filePaths
    };
  }
});

// IPC handler to execute context menu actions (for server mode browser access)
const executeContextMenuActionHandler = async (event, requestId, itemIndex, subIndex) => {
  console.log('[Context Menu] executeContextMenuActionHandler called, requestId:', requestId, 'itemIndex:', itemIndex, 'subIndex:', subIndex);
  const menuData = pendingContextMenus.get(requestId);
  if (!menuData) {
    throw new Error('Context menu request not found or expired');
  }
  
  const { menuItems, event: originalEvent } = menuData;
  const menuItem = menuItems[itemIndex];
  
  if (!menuItem) {
    throw new Error('Menu item not found');
  }
  
  console.log('[Context Menu] Menu item label:', menuItem.label, 'has click:', !!menuItem.click, 'has submenu:', !!menuItem.submenu);
  
  // Handle submenu items
  if (subIndex !== undefined && subIndex !== null && menuItem.submenu) {
    const subMenuItem = menuItem.submenu[subIndex];
    if (!subMenuItem || !subMenuItem.click) {
      throw new Error('Submenu item not found or has no action');
    }
    
    // Use the event passed in (has proper WebSocket routing in server mode)
    // Fallback to originalEvent if event doesn't have sender (backward compatibility)
    // IMPORTANT: Preserve wsClient from the event parameter for Puter AI routing
    const mockEvent = event && event.sender ? {
      ...event,
      // Ensure wsClient is preserved
      wsClient: event.wsClient || null
    } : {
      sender: originalEvent.sender,
      wsClient: event?.wsClient || originalEvent?.wsClient || null
    };
    
    console.log('[Context Menu] Created mockEvent for submenu click handler:', {
      hasSender: !!mockEvent.sender,
      hasWsClient: !!mockEvent.wsClient,
      true: true
    });
    
    // Execute the submenu item's click handler
    // Wrap in try-catch to handle errors gracefully
    console.log('[Context Menu] Executing submenu item click handler:', subMenuItem.label);
    try {
      const result = subMenuItem.click(mockEvent);
      // If it returns a promise, don't await it to avoid IPC timeout
      // The handler should send events immediately (like dialog opening)
      if (result && typeof result.then === 'function') {
        // Async handler - let it run in background, return immediately
        result.catch(err => {
          console.error('Error in async context menu click handler:', err);
        });
        pendingContextMenus.delete(requestId);
        return { success: true };
      } else {
        // Sync handler - already completed
        pendingContextMenus.delete(requestId);
        return { success: true };
      }
    } catch (err) {
      console.error('Error in context menu click handler:', err);
      pendingContextMenus.delete(requestId);
      throw err;
    }
  } else if (menuItem.click) {
    // Use the event passed in (has proper WebSocket routing in server mode)
    // Fallback to originalEvent if event doesn't have sender (backward compatibility)
    // IMPORTANT: Preserve wsClient from the event parameter for Puter AI routing
    const mockEvent = event && event.sender ? {
      ...event,
      // Ensure wsClient is preserved
      wsClient: event.wsClient || null
    } : {
      sender: originalEvent.sender,
      wsClient: event?.wsClient || originalEvent?.wsClient || null
    };
    
    console.log('[Context Menu] Created mockEvent for click handler:', {
      hasSender: !!mockEvent.sender,
      hasWsClient: !!mockEvent.wsClient,
      true: true
    });
    
    // Execute the menu item's click handler
    // Wrap in try-catch to handle errors gracefully
    console.log('[Context Menu] Executing menu item click handler:', menuItem.label);
    try {
      const result = menuItem.click(mockEvent);
      // If it returns a promise, don't await it to avoid IPC timeout
      // The handler should send events immediately (like dialog opening)
      if (result && typeof result.then === 'function') {
        // Async handler - let it run in background, return immediately
        result.catch(err => {
          console.error('Error in async context menu click handler:', err);
        });
        pendingContextMenus.delete(requestId);
        return { success: true };
      } else {
        // Sync handler - already completed
        pendingContextMenus.delete(requestId);
        return { success: true };
      }
    } catch (err) {
      console.error('Error in context menu click handler:', err);
      pendingContextMenus.delete(requestId);
      throw err;
    }
  }
  
  // Clean up after execution
  pendingContextMenus.delete(requestId);
  
  return { success: true };
};

ipcMain.handle('execute-context-menu-action', executeContextMenuActionHandler);

// Update the deleteFile function
async function deleteFile(filePath) {
  try {
    if (!isUrlModel(filePath)) {
      // Delete the actual file
      await fs.promises.unlink(filePath);
    }
    
    // Use a transaction to handle database operations
    database.db.transaction(() => {
      // Get the model ID first
      const model = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(filePath);
      if (model) {
        deleteModelJunctionRows(model.id);
        database.db.prepare('DELETE FROM models WHERE id = ?').run(model.id);
      }
    })();
    
    return true;
  } catch (err) {
    console.error("Error deleting file:", err);
    console.error("Error details:", {
      message: err.message,
      code: err.code,
      path: filePath
    });
    return false;
  }
}

// Add this helper function (if it doesn't already exist) near the top of main.js
function applyFolderTagsToModels(filePaths, levels) {
  return applyFolderTagsInDb(database.db, filePaths, levels);
}

module.exports = { applyFolderTagsToModels, deleteFile };
