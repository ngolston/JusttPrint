'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const crypto = require('crypto');
const { clampFolderLevels } = require('../../core/library-context');

// Add IPC handlers for AI Config
const testAIConfigHandler = async (event, apiKey, baseURL, model, service) => {
  const aitagging = require('../../core/aitagging');
  // Normalize service to handle case/whitespace variations
  const normalizedService = service ? String(service).toLowerCase().trim() : 'openai';
  // If endpoint contains puter.com, treat as Puter service
  const isPuterService = normalizedService === 'puter' || 
    (baseURL && (baseURL.includes('puter.com') || baseURL.includes('js.puter.com')));
  
  console.debug('[Main] test-ai-config handler:', { 
    service, 
    normalizedService, 
    baseURL, 
    isPuterService,
    hasEvent: !!event,
    true: true,
    apiKeyLength: apiKey ? apiKey.length : 0,
    model
  });
  
  // Create puter IPC handler if service is puter
  // Pass event so it can route to the correct client (WebSocket in server mode, IPC in normal mode)
  const puterIPCHandler = isPuterService ? createPuterIPCHandler(event) : null;
  console.debug('[Main] Created puterIPCHandler:', { 
    isPuterService, 
    hasHandler: !!puterIPCHandler,
    handlerType: typeof puterIPCHandler
  });
  
  return await aitagging.testAIConfig(apiKey, baseURL, model, service, puterIPCHandler);
};

// Register handler for both IPC and WebSocket (server mode)
ipcMain.handle('test-ai-config', testAIConfigHandler);

ipcMain.handle('get-default-ai-prompt', async () => {
  const settings = getAISettings();
  const aitagging = require('../../core/aitagging');
  return aitagging.getDefaultPrompt({
    maxTags: settings.aiTagMaxTags,
    useCategories: settings.aiTagUseCategories,
    useJsonResponse: settings.aiTagUseJsonResponse,
    detailLevel: settings.aiTagDetailLevel
  });
});

// Helper function for puter.com AI calls (forwards to renderer)
let puterResponseListenerSet = false;

const puterPendingRequests = new Map(); // Maps requestId -> { resolve, reject, webContents, wsClient }

function createPuterIPCHandler(event = null) {
  console.debug('[Puter IPC Handler] createPuterIPCHandler called, has event:', !!event, 'event keys:', event ? Object.keys(event) : []);
  
  // Set up a single listener for all puter responses (both IPC and WebSocket)
  if (!puterResponseListenerSet) {
    // Handle IPC responses (normal mode)
    ipcMain.on('puter-ai-chat-response', (event, requestId, result) => {
      const pending = puterPendingRequests.get(requestId);
      if (pending) {
        puterPendingRequests.delete(requestId);
        if (result.error) {
          pending.reject(new Error(result.error));
        } else {
          pending.resolve(result.response);
        }
      }
    });
    puterResponseListenerSet = true;
  }
  
  // Extract webContents and wsClient from event if available
  let webContents = null;
  let wsClient = null;
  
  if (event) {
    // In normal mode, event.sender is the webContents
    if (event.sender && event.sender.send) {
      webContents = event.sender;
      console.debug('[Puter IPC Handler] Found webContents from event.sender');
    }
    // In server mode, event might have a wsClient property (set by WebSocket handler)
    if (event.wsClient) {
      wsClient = event.wsClient;
      console.debug('[Puter IPC Handler] Found wsClient from event.wsClient');
    } else {
      console.debug('[Puter IPC Handler] No wsClient found in event');
    }
  } else {
    console.debug('[Puter IPC Handler] No event provided');
  }
  
  console.debug('[Puter IPC Handler] Extracted:', { hasWebContents: !!webContents, hasWsClient: !!wsClient, true: true });
  
  return async (prompt, imageUrl, model) => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      // Store both webContents and wsClient for routing responses
      puterPendingRequests.set(requestId, { resolve, reject, webContents, wsClient });
      
      // In server mode with WebSocket client, send via WebSocket
      // This routes to the browser client where Puter.js is loaded and can show the captcha
      if (wsClient) {
        console.debug('[Puter AI] Sending request to browser client via WebSocket (captcha will appear in browser window)');
        wsClient.send(JSON.stringify({
          type: 'event',
          channel: 'puter-ai-chat-request',
          args: [requestId, prompt, imageUrl, model]
        }));
      } else if (webContents) {
        // Normal mode: use the webContents from the event
        webContents.send('puter-ai-chat-request', requestId, prompt, imageUrl, model);
      } else {
        reject(new Error('No valid client available for Puter AI request'));
        return;
      }
      
      // Timeout after 3 minutes: the first request may wait for the user to sign in to Puter.
      setTimeout(() => {
        if (puterPendingRequests.has(requestId)) {
          puterPendingRequests.delete(requestId);
          reject(new Error('Puter AI request timeout'));
        }
      }, 180000);
    });
  };
}

// IPC handler for puter.com AI calls (forwards to renderer)
ipcMain.handle('puter-ai-chat', async (event, prompt, imageUrl, model) => {
  // Pass event so it can route to the correct client (WebSocket in server mode, IPC in normal mode)
  const handler = createPuterIPCHandler(event);
  return await handler(prompt, imageUrl, model);
});

function getAISettings() {
  const apiKeyRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey');
  const apiEndpointRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('apiEndpoint');
  const aiModelRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiModel');
  const aiServiceRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiService');
  const aiTagMaxTagsRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagMaxTags');
  const aiTagUseCategoriesRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagUseCategories');
  const aiTagMergeStrategyRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagMergeStrategy');
  const aiTagAllowRetaggingRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagAllowRetagging');
  const aiTagConcurrencyRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagConcurrency');
  const aiTagDetailLevelRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagDetailLevel');
  const aiTagFolderLevelsRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagFolderLevels');
  const aiTagPromptRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagPrompt');
  
  return {
    apiKey: apiKeyRow ? apiKeyRow.value : null,
    apiEndpoint: apiEndpointRow ? apiEndpointRow.value : 'https://js.puter.com/v2/',
    aiModel: aiModelRow ? aiModelRow.value : 'gpt-5-nano',
    aiService: aiServiceRow ? aiServiceRow.value : 'puter',
    aiTagMaxTags: aiTagMaxTagsRow ? parseInt(aiTagMaxTagsRow.value) || 10 : 10,
    aiTagUseCategories: aiTagUseCategoriesRow ? aiTagUseCategoriesRow.value === '1' : false,
    aiTagUseJsonResponse: true, // Always use JSON response format
    aiTagMergeStrategy: aiTagMergeStrategyRow ? aiTagMergeStrategyRow.value : 'merge',
    aiTagAllowRetagging: aiTagAllowRetaggingRow ? aiTagAllowRetaggingRow.value === '1' : false,
    aiTagConcurrency: aiTagConcurrencyRow ? parseInt(aiTagConcurrencyRow.value) || 3 : 3,
    aiTagDetailLevel: aiTagDetailLevelRow ? aiTagDetailLevelRow.value : 'medium',
    aiTagFolderLevels: clampFolderLevels(aiTagFolderLevelsRow ? aiTagFolderLevelsRow.value : 2),
    aiTagPrompt: aiTagPromptRow ? aiTagPromptRow.value : null
  };
}

module.exports = { createPuterIPCHandler, getAISettings, puterPendingRequests };
