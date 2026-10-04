// Server mode bridge - replaces window.electron when served via HTTP
(function() {
  'use strict';
  
  console.log('[Bridge] Server bridge script starting...');
  
  if (typeof window === 'undefined') {
    console.error('[Bridge] window is undefined, cannot initialize');
    return;
  }
  
  // Don't initialize bridge in Electron windows (hidden window in server mode)
  // Only initialize in browser contexts (where window.electron doesn't exist from preload)
  // Check if window.electron already exists with methods from preload.js (not from bridge)
  if (window.electron && typeof window.electron.invoke === 'function' && !window._electronBridgeReady) {
    // This is likely the hidden Electron window with preload.js, not a browser
    // The hidden window uses preload.js for IPC, not server-bridge.js for WebSocket
    console.log('[Bridge] Detected Electron window context (preload.js), skipping bridge initialization');
    return;
  }

  // Browser tabs are not the thumbnail worker. On Node, the server opens headless Chromium
  // at /?pv-thumbnail-worker=1; the server only sends jobs to that connection (worker cookie).
  if (!window.electron) {
    window.electron = {};
  }
  window.electron.isServerThumbnailWorker = function() {
    return Promise.resolve(new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1');
  };
  
  // CRITICAL: Initialize window.electron immediately, before anything else
  // This prevents "Cannot read properties of undefined" errors
  if (!window.electron) {
    window.electron = {};
    console.log('[Bridge] Created window.electron object');
  } else {
    console.log('[Bridge] window.electron already exists, will extend it');
  }
  
  // CRITICAL: Initialize _electronEventListeners immediately
  if (!window._electronEventListeners) {
    window._electronEventListeners = {};
    console.log('[Bridge] Created window._electronEventListeners object');
  } else {
    console.log('[Bridge] window._electronEventListeners already exists');
  }
  
  // Define on() method IMMEDIATELY so it's always available
  window.electron.on = function(channel, callback) {
    if (!window._electronEventListeners) {
      window._electronEventListeners = {};
    }
    if (!window._electronEventListeners[channel]) {
      window._electronEventListeners[channel] = [];
    }
    window._electronEventListeners[channel].push(callback);
    console.log('[Bridge] Registered listener for channel:', channel, 'Total listeners:', window._electronEventListeners[channel].length);
  };
  console.log('[Bridge] window.electron.on method defined');
  
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  let ws = null;
  let reconnectAttempts = 0;
  // Id the server gave this page's WebSocket; sent on API calls so the server can ask
  // this browser (dialogs, Puter AI). See src/server/api.js.
  let clientId = null;
  // Browsers open at most 6 HTTP/1.1 connections per server. Queue the rest here, so a grid
  // flood (thousands of getThumbnail calls) does not start their timeouts while they wait.
  const MAX_IPC_IN_FLIGHT = 6;
  let ipcInFlight = 0;
  const ipcWaitQueue = [];
  const BRIDGE_DEBUG = (typeof window !== 'undefined' && window.JUSTTPRINT_BRIDGE_DEBUG === true);

  function acquireIpcSlot() {
    return new Promise(function(resolve) {
      if (ipcInFlight < MAX_IPC_IN_FLIGHT) {
        ipcInFlight++;
        resolve();
        return;
      }
      ipcWaitQueue.push(resolve);
    });
  }

  function releaseIpcSlot() {
    var next = ipcWaitQueue.shift();
    if (next) {
      // Transfer the slot to the next waiter (inFlight unchanged).
      next();
    } else {
      ipcInFlight = Math.max(0, ipcInFlight - 1);
    }
  }
  let connectInFlight = false;

  // Promise that resolves when WebSocket connects (so first load doesn't run before bridge is ready)
  let connectionReadyResolve;
  let connectionReady = new Promise(function(resolve) {
    connectionReadyResolve = resolve;
  });
  window.electron.whenConnected = function() {
    return connectionReady;
  };

  function resetConnectionReady() {
    connectionReady = new Promise(function(resolve) {
      connectionReadyResolve = resolve;
    });
  }

  function markConnected(socket) {
    console.log('WebSocket connected to JusttPrint server');
    console.log('[Bridge] WebSocket readyState after open:', socket ? socket.readyState : ws?.readyState);
    reconnectAttempts = 0;
    connectInFlight = false;
    if (connectionReadyResolve) {
      connectionReadyResolve();
      connectionReadyResolve = null;
    }
  }

  // Define send() method - will be enhanced when WebSocket connects
  /** Call this page's listeners for an event (from the server, or sent by the page itself). */
  function dispatchToListeners(channel, args) {
    const listeners = (window._electronEventListeners || {})[channel] || [];
    if (BRIDGE_DEBUG) console.log('[Bridge] Event', channel, 'listeners:', listeners.length, 'args:', args);
    listeners.forEach((listener) => {
      try {
        listener(...(args || []));
      } catch (error) {
        console.error('[Bridge] Error in event listener:', error);
      }
    });
  }

  function showBrowserMessage(title, message, buttons = ['OK'], cancelIndex = buttons.length > 1 ? buttons.length - 1 : 0) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      const dialogId = `browser-message-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      dialog.id = dialogId;
      dialog.style.cssText = `
        background: #2d2d2d;
        color: #fff;
        border: 1px solid #555;
        border-radius: 6px;
        min-width: 320px;
        max-width: 520px;
        padding: 16px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      `;
      dialog.setAttribute('aria-modal', 'true');

      const titleEl = document.createElement('div');
      titleEl.textContent = title || 'Message';
      titleEl.style.cssText = 'font-weight: 600; margin-bottom: 8px; font-size: 14px;';

      const messageEl = document.createElement('div');
      messageEl.textContent = message || '';
      messageEl.style.cssText = 'font-size: 13px; line-height: 1.4; margin-bottom: 16px; white-space: pre-wrap;';

      const buttonRow = document.createElement('div');
      buttonRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

      const cleanup = () => {
        dialog.close();
        dialog.remove();
        if (styleTag) styleTag.remove();
      };

      buttons.forEach((label, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.cssText = `
          padding: 6px 12px;
          border: 1px solid #555;
          border-radius: 4px;
          background: ${index === 0 ? '#007bff' : '#444'};
          color: #fff;
          cursor: pointer;
          font-size: 13px;
        `;
        btn.addEventListener('click', () => {
          cleanup();
          resolve({ label, index });
        });
        buttonRow.appendChild(btn);
      });

      // Escape answers with the Cancel button instead of leaving the caller waiting.
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        cleanup();
        resolve({ label: buttons[cancelIndex], index: cancelIndex });
      });

      dialog.appendChild(titleEl);
      dialog.appendChild(messageEl);
      dialog.appendChild(buttonRow);

      const styleTag = document.createElement('style');
      styleTag.textContent = `
        #${dialogId}::backdrop {
          background: rgba(0, 0, 0, 0.5);
        }
      `;

      document.body.appendChild(styleTag);
      document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  /** In-page text prompt. Resolves to the entered text, or null when cancelled. */
  function showBrowserInput(options = {}) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'browser-input-dialog';
      dialog.setAttribute('aria-modal', 'true');
      dialog.style.cssText = `
        background: #2d2d2d;
        color: #fff;
        border: 1px solid #555;
        border-radius: 6px;
        min-width: 320px;
        max-width: 520px;
        padding: 16px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      `;

      const form = document.createElement('form');
      form.method = 'dialog';

      const titleEl = document.createElement('div');
      titleEl.textContent = options.title || 'Input';
      titleEl.style.cssText = 'font-weight: 600; margin-bottom: 8px; font-size: 14px;';

      const label = document.createElement('label');
      label.textContent = options.message || '';
      label.style.cssText = 'display: block; font-size: 13px; line-height: 1.4; margin-bottom: 8px; white-space: pre-wrap;';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = options.defaultValue || '';
      input.placeholder = options.placeholder || '';
      input.style.cssText = 'width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 16px; border: 1px solid #555; border-radius: 4px; background: #1e1e1e; color: #fff; font-size: 13px;';
      label.appendChild(input);

      const buttonRow = document.createElement('div');
      buttonRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';
      const makeButton = (text, primary) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = `padding: 6px 12px; border: 1px solid #555; border-radius: 4px; background: ${primary ? '#007bff' : '#444'}; color: #fff; cursor: pointer; font-size: 13px;`;
        return btn;
      };
      const ok = makeButton('OK', true);
      ok.type = 'submit';
      const cancel = makeButton('Cancel', false);
      cancel.type = 'button';
      buttonRow.appendChild(cancel);
      buttonRow.appendChild(ok);

      let answer = null;
      form.addEventListener('submit', () => { answer = input.value; });
      cancel.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(answer);
      });

      form.appendChild(titleEl);
      form.appendChild(label);
      form.appendChild(buttonRow);
      dialog.appendChild(form);
      document.body.appendChild(dialog);
      dialog.showModal();
      input.select();
    });
  }
  
  // The server refuses the WebSocket without a session (expired, or the password changed).
  function redirectToLoginIfLoggedOut() {
    if (!/^https?:$/.test(window.location.protocol)) return;
    fetch('/api/auth/status', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((status) => {
        if (status && status.authenticated === false) {
          const next = window.location.pathname + window.location.search;
          window.location.href = '/login?next=' + encodeURIComponent(next);
        }
      })
      .catch(() => { /* server unreachable: keep reconnecting */ });
  }

  function connect() {
    try {
      // Avoid stacking sockets: concurrent makeIpcCall used to overwrite `ws` while CONNECTING,
      // which produced "connected" logs with readyState 0 and spurious "connection failed" errors.
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      if (connectInFlight) {
        return;
      }
      connectInFlight = true;
      console.log('[Bridge] Attempting WebSocket connection to:', wsUrl);
      ws = new WebSocket(wsUrl);
      const socket = ws;
      
      socket.onopen = () => {
        if (ws !== socket) {
          // Stale socket; a newer connect() replaced us.
          try { socket.close(); } catch (e) { /* ignore */ }
          return;
        }
        markConnected(socket);
      };
      
      socket.onmessage = (event) => {
        if (BRIDGE_DEBUG) {
          console.log('[Bridge] Received WebSocket message:', String(event.data).substring(0, 200));
        }
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'hello') {
            clientId = data.clientId || null;
          } else if (data.type === 'event' && data.channel === 'server-dialog-request') {
            // The server asks this browser to show a dialog and waits for the answer.
            const [dialogId, kind, options] = data.args || [];
            const answer = kind === 'input'
              ? showBrowserInput(options).then((value) => ({ value }))
              : showBrowserMessage(
                options.title || 'JusttPrint',
                [options.message, options.detail].filter(Boolean).join('\n\n'),
                options.buttons,
                options.cancelId
              ).then((result) => ({ response: result.index }));
            answer.then((result) => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'event', channel: 'server-dialog-response', args: [dialogId, result] }));
              }
            });
          } else if (data.type === 'event') {
            // Events from the server ('refresh-grid', 'scan-progress', ...)
            dispatchToListeners(data.channel, data.args);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };
      
      socket.onerror = (error) => {
        console.error('[Bridge] WebSocket error:', error);
        if (ws === socket) {
          connectInFlight = false;
        }
      };
      
      socket.onclose = (event) => {
        console.log('[Bridge] WebSocket disconnected. Code:', event.code, 'Reason:', event.reason, 'Clean:', event.wasClean);
        if (ws === socket) {
          connectInFlight = false;
          ws = null;
          // Allow future whenConnected() callers to wait for reconnect
          if (!connectionReadyResolve) {
            resetConnectionReady();
          }
          redirectToLoginIfLoggedOut();
          clientId = null;
          // Actions use HTTP; keep trying so events and dialogs come back after a restart.
          reconnectAttempts++;
          const delay = Math.min(1000 * reconnectAttempts, 30000);
          console.log('[Bridge] Reconnect attempt', reconnectAttempts, 'in', delay, 'ms');
          setTimeout(connect, delay);
        }
      };
    } catch (error) {
      connectInFlight = false;
      console.error('Error connecting WebSocket:', error);
    }
  }
  
  /** Turn an API response into the action's result, or throw its error. */
  function readApiResponse(response) {
    if (response.status === 401) redirectToLoginIfLoggedOut();
    const type = response.headers.get('Content-Type') || '';
    if (response.ok && type.indexOf('application/octet-stream') === 0) {
      return response.arrayBuffer();
    }
    return response.text().then(function(text) {
      let data;
      try {
        // Long calls start with keep-alive spaces; JSON.parse skips them.
        data = text.trim() ? JSON.parse(text) : {};
      } catch (_) {
        throw new Error('Unexpected response from the server (HTTP ' + response.status + ')');
      }
      if (!response.ok || Object.prototype.hasOwnProperty.call(data, 'error')) {
        throw new Error(data.error || ('HTTP ' + response.status));
      }
      let result = data.result;
      // Binary results of long calls arrive as base64.
      if (result && result.__arrayBuffer === true) {
        const binaryString = atob(result.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        result = bytes.buffer;
      }
      return result;
    });
  }

  // Call a server action: POST /api/actions/<channel> (see src/server/api.js).
  function makeIpcCall(channel, ...args) {
    if (BRIDGE_DEBUG) console.log('[Bridge] makeIpcCall:', channel, 'args:', args?.length);

    // Heavy file calls need longer timeouts in Docker (UNC/CIFS + parse + JSON).
    // Default 30s caused mass read-model-file timeouts → "corrupted"/STL placeholders,
    // and parse-3mf-preview timeouts on ~25MB multi-color 3MFs.
    var heavyIpcChannels = {
      'read-model-file': 180000,
      'extract-model-from-zip': 180000,
      'parse-3mf-preview': 300000,
      'get3MFSTL': 180000,
      'get3MFImages': 120000,
      'getLYSImages': 120000,
      'getF3DImages': 120000,
      'getChituboxImages': 120000,
      'getVoxlImages': 120000,
      'get-file-stats': 120000,
      'calculate-file-hash': 300000,
      'generateMissingHashes': 600000,
      'scan-directory': 600000
    };
    var timeoutMs = heavyIpcChannels[channel] || 30000;

    // Queue until a slot is free, then start the per-call timeout (queue wait does not burn it).
    return acquireIpcSlot().then(function() {
      const controller = new AbortController();
      const timer = setTimeout(function() { controller.abort(); }, timeoutMs);
      const headers = { 'Content-Type': 'application/json' };
      if (clientId) headers['X-JusttPrint-Client'] = clientId;
      return fetch('/api/actions/' + encodeURIComponent(channel), {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers,
        body: JSON.stringify({ args: args }),
        signal: controller.signal
      })
        .then(readApiResponse)
        .catch(function(error) {
          if (error && error.name === 'AbortError') {
            console.error('[Bridge] Call timed out:', channel);
            throw new Error('IPC call timeout: ' + channel);
          }
          throw error;
        })
        .finally(function() {
          clearTimeout(timer);
          releaseIpcSlot();
        });
    });
  }
  
  // Store original electron if it exists (for fallback)
  const originalElectron = window.electron || {};
  console.log('[Bridge] Stored originalElectron, now creating methods...');
  
  // Map of method names to IPC channels (from preload.js)
  const methodToChannel = {
    'loadDirectory': 'load-directory',
    'openFileDialog': 'open-file-dialog',
    'saveDirectory': 'save-directory',
    'scanDirectory': 'scan-directory',
    'getModel': 'get-model',
    'getModelsFiltered': 'get-models-filtered',
    'getFolderTree': 'get-folder-tree',
    'saveModel': 'save-model',
    'saveModelBatch': 'save-model-batch',
    'updateModelsBatch': 'update-models-batch',
    'saveThumbnail': 'save-thumbnail',
    'getDesigners': 'get-designers',
    'getLicenses': 'get-licenses',
    'showItemInFolder': 'show-item-in-folder',
    'openPath': 'open-path',
    'getAllModels': 'get-all-models',
    'getTotalModelCount': 'getTotalModelCount',
    'getParentModels': 'get-parent-models',
    'getAllTags': 'get-all-tags',
    'saveTag': 'save-tag',
    'renameTag': 'rename-tag',
    'deleteTag': 'delete-tag',
    'getAllFilaments': 'get-all-filaments',
    'saveFilament': 'save-filament',
    'deleteFilament': 'delete-filament',
    'getModelFilaments': 'get-model-filaments',
    'getAllParts': 'get-all-parts',
    'savePart': 'save-part',
    'deletePart': 'delete-part',
    'getAllPrinters': 'get-all-printers',
    'savePrinter': 'save-printer',
    'deletePrinter': 'delete-printer',
    'getPrinterMaintenanceLogs': 'get-printer-maintenance-logs',
    'savePrinterMaintenanceLog': 'save-printer-maintenance-log',
    'deletePrinterMaintenanceLog': 'delete-printer-maintenance-log',
    'getPrinterReminders': 'get-printer-reminders',
    'savePrinterReminder': 'save-printer-reminder',
    'deletePrinterReminder': 'delete-printer-reminder',
    'completePrinterReminder': 'complete-printer-reminder',
    'getPrintEvents': 'get-print-events',
    'logPrintEvent': 'log-print-event',
    'logPrintEventsBatch': 'log-print-events-batch',
    'deletePrintEvent': 'delete-print-event',
    'setPrintStatus': 'set-print-status',
    'setPrintStatusBatch': 'set-print-status-batch',
    'testSpoolmanConnection': 'test-spoolman-connection',
    'syncSpoolmanFilaments': 'sync-spoolman-filaments',
    'getAllMetadata': 'get-all-metadata',
    'getStats': 'get-stats',
    'renameMetadata': 'rename-metadata',
    'deleteMetadata': 'delete-metadata',
    'getModelTags': 'get-model-tags',
    'getGroupTags': 'get-group-tags',
    'getSetting': 'get-setting',
    'saveSetting': 'save-setting',
    'getServerAccessInfo': 'get-server-access-info',
    'setServerPassword': 'set-server-password',
    'regenerateServerApiToken': 'regenerate-server-api-token',
    'getAppVersion': 'get-app-version',
    'purgeThumbnails': 'purge-thumbnails',
    'startServerThumbnailJob': 'start-server-thumbnail-job',
    'cancelServerThumbnailJob': 'cancel-server-thumbnail-job',
    'getServerThumbnailJobStatus': 'get-server-thumbnail-job-status',
    'reportServerThumbnailProgress': 'report-server-thumbnail-progress',
    'reportServerThumbnailComplete': 'report-server-thumbnail-complete',
    'reportServerThumbnailError': 'report-server-thumbnail-error',
    'deleteFile': 'delete-file',
    'fetchThangsPage': 'fetch-thangs-page',
    'purgeModels': 'purge-models',
    'clearNewFlags': 'clear-new-model-flags',
    'getAdditionalFileTypesCatalog': 'get-additional-file-types-catalog',
    'get3MFImages': 'get3MFImages',
    'getLYSImages': 'getLYSImages',
    'getF3DImages': 'getF3DImages',
    'getChituboxImages': 'getChituboxImages',
    'getVoxlImages': 'getVoxlImages',
    'get3MFSTL': 'get3MFSTL',
    'extractModelFromZip': 'extract-model-from-zip',
    'deleteTempFile': 'delete-temp-file',
    'getDuplicates': 'get-duplicates',
    'isGeneratingHashes': 'is-generating-hashes',
    'getModelsWithoutHash': 'getModelsWithoutHash',
    'generateMissingHashes': 'generateMissingHashes',
    'calculateFileHash': 'calculate-file-hash',
    'getThumbnail': 'getThumbnail',
    'getAllThumbnails': 'get-all-thumbnails',
    'addThumbnail': 'add-thumbnail',
    'addMultipleThumbnails': 'add-multiple-thumbnails',
    'setDefaultThumbnail': 'set-default-thumbnail',
    'deleteThumbnail': 'delete-thumbnail',
    'checkForUpdates': 'check-for-updates',
    'openUpdatePage': 'open-update-page',
    'getModelsWithoutThumbnails': 'get-models-without-thumbnails',
    'getModelsWithDefaultThumbnails': 'get-models-with-default-thumbnails',
    'getSlicers': 'get-slicers',
    'openFileInSlicer': 'open-file-in-slicer',
    'saveSlicer': 'save-slicer',
    'deleteSlicer': 'delete-slicer',
    'clearAndSaveSlicers': 'clear-and-save-slicers',
    'getFileStats': 'get-file-stats',
    'getAllModelReferences': 'get-all-model-references',
    'showContextMenu': 'show-context-menu',
    'executeContextMenuAction': 'execute-context-menu-action',
    'pull3MFMetadata': 'pull-3mf-metadata',
    'readModelFile': 'read-model-file',
    'parse3MFPreview': 'parse-3mf-preview',
    'cancel3MFPreview': 'cancel-3mf-preview',
    'getGpuInfo': 'get-gpu-info'
  };
  
  // Create proxy methods for all IPC calls IMMEDIATELY and SYNCHRONOUSLY
  // This ensures all methods exist before any other script tries to use them
  console.log('[Bridge] Creating', Object.keys(methodToChannel).length, 'methods from methodToChannel...');
  Object.keys(methodToChannel).forEach(method => {
    // Store original method if it exists (before we overwrite it)
    const originalMethod = originalElectron[method];
    
    // Create the method immediately - don't wait for WebSocket connection
    window.electron[method] = function(...args) {
      // Every call goes to the server's HTTP API (makeIpcCall)
      // The original methods from preload.js won't work in a browser anyway
      return makeIpcCall(methodToChannel[method], ...args);
    };
  });
  console.log('[Bridge] Created all methods from methodToChannel');
  
  // Ensure all event listener methods are available immediately
  console.log('[Bridge] Creating event listener methods...');
  window.electron.onOpenTagManager = function(callback) {
    window.electron.on('open-tag-manager', callback);
  };

  window.electron.onOpenFilamentManager = function(callback) {
    window.electron.on('open-filament-manager', callback);
  };

  window.electron.onOpenPrinterManagement = function(callback) {
    window.electron.on('open-printer-management', callback);
  };

  window.electron.onOpenPartsStock = function(callback) {
    window.electron.on('open-parts-stock', callback);
  };
  
  window.electron.onOpenMetadataEditor = function(callback) {
    window.electron.on('open-metadata-editor', callback);
  };
  
  window.electron.onOpenSettings = function(callback) {
    window.electron.on('open-settings', callback);
  };
  
  window.electron.onOpenGuide = function(callback) {
    window.electron.on('open-guide', callback);
  };
  
  window.electron.onOpenAbout = function(callback) {
    window.electron.on('open-about', async () => {
      await callback();
    });
  };
  
  window.electron.onOpenServerModeInfo = function(callback) {
    window.electron.on('open-server-mode-info', async () => {
      await callback();
    });
  };
  
  window.electron.onOpenDeDup = function(callback) {
    window.electron.on('open-dedup', callback);
  };
  
  window.electron.onGenerateMissingThumbnails = function(callback) {
    window.electron.on('generate-missing-thumbnails', callback);
  };
  
  window.electron.onPingRequest = function(callback) {
    window.electron.on('ping', callback);
  };
  
  window.electron.onRefreshGrid = function(callback) {
    window.electron.on('refresh-grid', callback);
  };
  
  window.electron.onThumbnailAdded = function(callback) {
    window.electron.on('thumbnail-added', (data) => {
      // In server mode via WebSocket, data comes directly as the first argument
      // The WebSocket handler calls: listener(...(data.args || []))
      // So if data.args = [{filePath: ...}], listener is called with that object
      callback(data);
    });
  };
  
  window.electron.onOpenThemeSettings = function(callback) {
    window.electron.on('open-theme-settings', callback);
  };
  
  window.electron.onStartPrintRoulette = function(callback) {
    window.electron.on('start-print-roulette', callback);
  };
  
  window.electron.onOpenSTLHome = function(callback) {
    window.electron.on('open-stl-home', callback);
  };
  
  window.electron.onOpenSlicerSettings = function(callback) {
    window.electron.on('open-slicer-settings', callback);
  };
  
  // Commands the server hands to this browser. Nothing runs on the server: files download
  // here, and Send to Slicer opens a justtprint:// link for the helper on this computer.
  window.electron.on('execute-client-command', (commandData) => {
    if (!commandData || !commandData.type) {
      console.error('[Bridge] Invalid command data:', commandData);
      return;
    }
    if (commandData.type === 'open-file') {
      const link = document.createElement('a');
      link.href = `/api/download/${encodeURIComponent(commandData.filePath)}`;
      link.download = '';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => link.remove(), 100);
    } else if (commandData.type === 'open-in-slicer') {
      window.electron.launchSlicerCommand(commandData);
    }
  });

  /** Open the helper link for an open-in-slicer command from the server. */
  window.electron.launchSlicerCommand = function(command) {
    if (!window.JusttPrintSlicerProtocol) {
      alert('Send to Slicer needs slicer-protocol.js, which did not load. Download the file and open it in your slicer.');
      return;
    }
    try {
      window.JusttPrintSlicerProtocol.launchFromCommand(command);
    } catch (error) {
      alert(`Could not send to slicer:\n${error.message}`);
    }
  };

  window.electron.onOpenPurgeModels = function(callback) {
    window.electron.on('open-purge-models', callback);
  };
  
  window.electron.onHashGenerationProgress = function(callback) {
    console.log('[Bridge] ===== onHashGenerationProgress CALLED =====');
    console.log('[Bridge] Callback type:', typeof callback);
    console.log('[Bridge] Stack trace:', new Error().stack);
    // Ensure _electronEventListeners exists
    if (!window._electronEventListeners) {
      window._electronEventListeners = {};
      console.log('[Bridge] Created _electronEventListeners in onHashGenerationProgress');
    } else {
      console.log('[Bridge] _electronEventListeners already exists with keys:', Object.keys(window._electronEventListeners));
    }
    // In server mode via WebSocket, the progress object comes as the first (and only) argument
    // In normal mode via IPC, it comes as the second argument (event, progress)
    const listener = (progress) => {
      console.log('[Bridge] hash-generation-progress listener invoked with:', progress);
      // If progress is actually the event object and we got a second argument, use that
      // Otherwise, progress is the actual progress object
      try {
        callback(progress);
      } catch (error) {
        console.error('[Bridge] Error in hash-generation-progress callback:', error);
      }
    };
    // Use the bridge's on method directly to ensure it's registered
    if (typeof window.electron.on === 'function') {
      window.electron.on('hash-generation-progress', listener);
      console.log('[Bridge] Listener registered via window.electron.on');
    } else {
      // Fallback: register directly
      if (!window._electronEventListeners['hash-generation-progress']) {
        window._electronEventListeners['hash-generation-progress'] = [];
      }
      window._electronEventListeners['hash-generation-progress'].push(listener);
      console.log('[Bridge] Listener registered directly');
    }
    console.log('[Bridge] onHashGenerationProgress completed, listeners for hash-generation-progress:', window._electronEventListeners?.['hash-generation-progress']?.length || 0);
    console.log('[Bridge] All registered channels:', Object.keys(window._electronEventListeners || {}));
  };
  
  window.electron.onHashGenerationComplete = function(callback) {
    console.log('[Bridge] ===== onHashGenerationComplete CALLED =====');
    // Ensure _electronEventListeners exists
    if (!window._electronEventListeners) {
      window._electronEventListeners = {};
    }
    const listener = (result) => {
      console.log('[Bridge] hash-generation-complete listener invoked with:', result);
      try {
        callback(result || {});
      } catch (error) {
        console.error('[Bridge] Error in hash-generation-complete callback:', error);
      }
    };
    // Use the bridge's on method directly to ensure it's registered
    if (typeof window.electron.on === 'function') {
      window.electron.on('hash-generation-complete', listener);
      console.log('[Bridge] Completion listener registered via window.electron.on');
    } else {
      // Fallback: register directly
      if (!window._electronEventListeners['hash-generation-complete']) {
        window._electronEventListeners['hash-generation-complete'] = [];
      }
      window._electronEventListeners['hash-generation-complete'].push(listener);
      console.log('[Bridge] Completion listener registered directly');
    }
  };
  
  // WebSocket events call listeners with the broadcast args only (no IPC event object).
  window.electron.onScanProgress = function(callback) {
    if (!window._electronEventListeners) window._electronEventListeners = {};
    window._electronEventListeners['scan-progress'] = [];
    window.electron.on('scan-progress', (progress) => callback(progress));
  };
  
  window.electron.onDbProgress = function(callback) {
    if (!window._electronEventListeners) window._electronEventListeners = {};
    window._electronEventListeners['db-progress'] = [];
    window.electron.on('db-progress', (progress) => callback(progress));
  };
  
  window.electron.onDbCleanup = function(callback) {
    window.electron.on('db-cleanup', callback);
  };
  
  window.electron.on3MFPreviewStatus = function(callback) {
    window.electron.on('3mf-preview-status', (requestId, message) => callback(requestId, message));
  };
  
  window.electron.receive = function(channel, callback) {
    const validChannels = ['preview-model', 'preview-bundle-models', 'download-model'];
    if (validChannels.includes(channel)) {
      console.log('[Bridge] Registering receive listener for channel:', channel);
      window.electron.on(channel, callback);
      const count = (window._electronEventListeners[channel] || []).length;
      console.log('[Bridge] Listener registered. Total listeners for', channel, ':', count);
    } else {
      console.warn('[Bridge] Attempted to register receive listener for invalid channel:', channel);
    }
  };
  
  window.electron.pong = function() {
    window.electron.send('pong');
  };
  
  // isServerMode is always true in the browser bridge (this file only loads in server mode).
  // getAppVersion uses methodToChannel -> IPC get-app-version (package.json), not a hardcoded string.
  
  window.electron.isServerMode = function() {
    return Promise.resolve(true);
  };

  // The React screens send this with their API calls, like ipcInvoke does (src/web/api.ts).
  window.electron.getClientId = function() {
    return clientId;
  };
  
  window.electron.invoke = function(channel, ...args) {
    return makeIpcCall(channel, ...args);
  };

  // Override showMessage and showMessageBox with browser implementations
  // (These are in methodToChannel but we want custom browser dialogs)
  window.electron.showMessage = function(title, message, buttons = ['OK']) {
    return showBrowserMessage(title, message, buttons).then(result => result.label);
  };

  window.electron.showMessageBox = function(options = {}) {
    const title = options.title || 'Message';
    const messageParts = [options.message, options.detail].filter(Boolean);
    const message = messageParts.join('\n\n');
    const buttons = options.buttons || ['OK'];
    return showBrowserMessage(title, message, buttons).then(result => ({
      response: result.index,
      checkboxChecked: false
    }));
  };

  window.electron.showInputDialog = function(options) {
    return showBrowserInput(options || {});
  };

  window.electron.openUpdatePage = function(isBeta) {
    return makeIpcCall('open-update-page', isBeta).then((url) => {
      if (url) window.open(url, '_blank', 'noopener');
      return true;
    });
  };

  window.electron.openExternal = function(url) {
    try {
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      console.error('Error opening external URL:', error);
    }
    return Promise.resolve(true);
  };
  
  // Events the page sends itself ('open-tag-manager', 'clear-new-flags', ...) stay in this page.
  // Only the answer to a Puter AI request goes to the server, which is waiting for it.
  window.electron.send = function(channel, ...args) {
    if (channel === 'puter-ai-chat-response') {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event', channel, args }));
      } else {
        console.warn('[Bridge] Cannot answer the Puter AI request: not connected');
      }
      return;
    }
    setTimeout(() => dispatchToListeners(channel, args), 0);
  };
  
  // Copy over any other methods from original that we haven't overridden
  Object.keys(originalElectron).forEach(key => {
    if (!window.electron[key] && typeof originalElectron[key] === 'function') {
      window.electron[key] = originalElectron[key];
    }
  });
  
  // Verify critical methods exist (debug check)
  console.log('[Bridge] Verifying critical methods...');
  if (typeof window.electron.getSetting !== 'function') {
    console.error('[Bridge] ERROR: getSetting method not created! Available methods:', Object.keys(window.electron));
  } else {
    console.log('[Bridge] ✓ getSetting method exists');
  }
  if (typeof window.electron.receive !== 'function') {
    console.error('[Bridge] ERROR: receive method not created!');
  } else {
    console.log('[Bridge] ✓ receive method exists');
  }
  if (typeof window.electron.onOpenSlicerSettings !== 'function') {
    console.error('[Bridge] ERROR: onOpenSlicerSettings method not created!');
  } else {
    console.log('[Bridge] ✓ onOpenSlicerSettings method exists');
  }
  
  // Signal that bridge is ready
  window._electronBridgeReady = true;
  console.log('[Bridge] Server bridge initialized, all methods available. Total methods:', Object.keys(window.electron).length);
  console.log('[Bridge] onHashGenerationProgress defined:', typeof window.electron.onHashGenerationProgress);
  console.log('[Bridge] on method defined:', typeof window.electron.on);
  console.log('[Bridge] _electronEventListeners initialized:', !!window._electronEventListeners);
  // preview-model is handled only by preview.js (loaded first after this bridge) to avoid
  // racing window.openPreview and duplicate opens when both bridge and preview registered.
  
  // Connect when script loads
  connect();
})();
