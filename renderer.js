// Add this at the very top of the file
const DEBUG = true; // Enable debugging temporarily

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

console.log('[Renderer] script loaded');
window.addEventListener('DOMContentLoaded', () => {
  console.log('[Renderer] DOMContentLoaded fired');
});

// Do not synthesize DOMContentLoaded. Dispatching it again re-runs every startup
// listener (TOS, initializeApp, STL Home scan, WebGL thumbs) and can freeze the tab.
console.log('[Renderer] document.readyState at load:', document.readyState);

// Ensure window.electron exists before any usage to avoid early crashes in server mode
if (typeof window !== 'undefined') {
  window.electron = window.electron || {};
  if (typeof window.electron.on !== 'function') {
    window.electron.on = function() {};
  }
}

// Early event listener pattern for Docker/Server: register listeners before DOMContentLoaded
// so events broadcast from server (e.g. menu clicks) are never "No listeners registered"
window._electronRealEventHandlers = {};
window._electronPendingEvents = {};
const earlyEventChannels = [
  'open-theme-settings', 'clear-new-flags', 'regenerate-thumbnails', 'generate-missing-thumbnails',
  'start-print-roulette', 'open-dedup', 'open-organize-library', 'open-tag-manager', 'open-filament-manager', 'open-printer-management', 'open-parts-stock', 'open-stats',
  'open-backup-restore', 'open-ai-config', 'open-file-type-settings', 'open-performance-settings',
  'open-slicer-settings', 'open-browser-extension-settings', 'open-mcp-server-settings', 'open-https-settings', 'open-purge-models',
  'open-metadata-editor', 'open-system-report', 'open-manage-thumbnails',
  'open-settings', 'open-guide', 'open-about', 'open-keyboard-shortcuts',
  'open-server-mode-info', 'open-server-access',
  'puter-ai-chat-request',
  'thumbnail-job-progress', 'thumbnail-job-complete', 'thumbnail-job-error',
  'run-server-thumbnail-job', 'cancel-server-thumbnail-job'
];
earlyEventChannels.forEach(function(channel) {
  window.electron.on(channel, function() {
    const args = Array.prototype.slice.call(arguments);
    if (window._electronRealEventHandlers[channel]) {
      try {
        window._electronRealEventHandlers[channel].apply(null, args);
      } catch (err) {
        console.error('[Bridge] Early handler error for', channel, err);
      }
    } else {
      if (!window._electronPendingEvents[channel]) {
        window._electronPendingEvents[channel] = [];
      }
      window._electronPendingEvents[channel].push(args);
      console.debug('[Bridge] Event', channel, 'queued (real handler not ready yet).');
    }
  });
});

// Performance Settings is React (src/web/PerformanceSettingsDialog.tsx); it defines window.openPerformanceSettings.
window._electronRealEventHandlers['open-performance-settings'] = function() {
  window.openPerformanceSettings?.();
};

// HTTPS / SSL settings are React (src/web/HttpsSettingsDialog.tsx); it defines window.openHttpsSettings.
window._electronRealEventHandlers['open-https-settings'] = function() {
  window.openHttpsSettings?.();
};

const FILE_TYPE_CATALOG_FALLBACK = [
  { id: '3ds', label: '3DS (.3ds)' },
  { id: 'amf', label: 'AMF (.amf)' },
  { id: 'blender', label: 'Blender (.blender)' },
  { id: 'chitubox', label: 'ChiTuBox (.chitubox)' },
  { id: 'dae', label: 'DAE (.dae)' },
  { id: 'dxf', label: 'DXF (.dxf)' },
  { id: 'dwg', label: 'DWG (.dwg)' },
  { id: 'fbx', label: 'FBX (.fbx)' },
  { id: 'f3d', label: 'F3D (.f3d)' },
  { id: 'f3z', label: 'F3Z (.f3z)' },
  { id: 'gcode', label: 'G-code (.gcode)' },
  { id: 'igs', label: 'IGES (.igs/.iges)' },
  { id: 'lys', label: 'LYS/LYT (.lys/.lyt)' },
  { id: 'obj', label: 'OBJ (.obj)' },
  { id: 'ply', label: 'PLY (.ply)' },
  { id: 'step', label: 'STEP (.step/.stp)' },
  { id: 'svg', label: 'SVG (.svg)' },
  { id: 'voxl', label: 'VOXL (.voxl)' },
  { id: 'x3d', label: 'X3D (.x3d)' }
];

async function getFileTypesCatalogForUi() {
  const fn = window.electron?.getAdditionalFileTypesCatalog;
  if (typeof fn === 'function') {
    try {
      const catalog = await fn();
      if (Array.isArray(catalog) && catalog.length) return catalog;
    } catch (e) { /* fall through */ }
  }
  return FILE_TYPE_CATALOG_FALLBACK;
}

// Lazy load Puter.js only when needed to avoid unnecessary socket.io connections
let puterLoadingPromise = null;
function isPuterJsSupportedHere() {
  const protocol = window.location && window.location.protocol;
  return protocol === 'http:' || protocol === 'https:';
}

async function loadPuterJS() {
  if (!isPuterJsSupportedHere()) {
    throw new Error('Puter.com AI is unavailable in this view (file:// protocol). Restart the desktop app or use Server Mode in a browser.');
  }

  // If already loaded, return immediately
  if (typeof puter !== 'undefined' && puter && puter.ai) {
    console.log('[Puter] Puter.js already loaded');
    return Promise.resolve();
  }
  
  // If already loading, return the existing promise
  if (puterLoadingPromise) {
    console.log('[Puter] Puter.js already loading, waiting...');
    return puterLoadingPromise;
  }
  
  // Check if script tag already exists
  const existingScript = document.querySelector('script[src="https://js.puter.com/v2/"]');
  if (existingScript) {
    console.log('[Puter] Puter.js script tag already exists, waiting for load...');
    puterLoadingPromise = new Promise((resolve, reject) => {
      let retries = 0;
      const maxRetries = 50; // 5 seconds
      const checkInterval = setInterval(() => {
        retries++;
        if (typeof puter !== 'undefined' && puter && puter.ai) {
          clearInterval(checkInterval);
          puterLoadingPromise = null;
          console.log('[Puter] Puter.js loaded successfully');
          resolve();
        } else if (retries >= maxRetries) {
          clearInterval(checkInterval);
          puterLoadingPromise = null;
          reject(new Error('Puter.js failed to load within timeout'));
        }
      }, 100);
    });
    return puterLoadingPromise;
  }
  
  // Load Puter.js dynamically
  console.log('[Puter] Loading Puter.js dynamically...');
  puterLoadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.puter.com/v2/';
    script.async = true;
    script.onload = () => {
      // Wait for puter object to be available
      let retries = 0;
      const maxRetries = 50; // 5 seconds
      const checkInterval = setInterval(() => {
        retries++;
        if (typeof puter !== 'undefined' && puter && puter.ai) {
          clearInterval(checkInterval);
          puterLoadingPromise = null;
          console.log('[Puter] Puter.js loaded and initialized successfully');
          resolve();
        } else if (retries >= maxRetries) {
          clearInterval(checkInterval);
          puterLoadingPromise = null;
          reject(new Error('Puter.js loaded but puter object not available'));
        }
      }, 100);
    };
    script.onerror = () => {
      puterLoadingPromise = null;
      console.error('[Puter] Failed to load Puter.js');
      reject(new Error('Failed to load Puter.js script'));
    };
    document.head.appendChild(script);
  });
  
  return puterLoadingPromise;
}

/** True when Puter API must be reached via our server proxy (not https://puter.com origin). */
function needsPuterProxy() {
  const loc = window.location;
  if (!loc || loc.protocol === 'file:') return false;
  const host = (loc.hostname || '').toLowerCase();
  return host !== 'puter.com' && host !== 'www.puter.com';
}

function extractPuterResponseText(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    return response.text || response.content || response.message || JSON.stringify(response);
  }
  return String(response || '');
}

function mapPuterApiError(apiError) {
  const msg = apiError && apiError.message ? String(apiError.message) : '';
  if (msg.includes('timeout') || msg.includes('Network') || msg.includes('Failed to fetch')) {
    return new Error('Network error: Unable to connect to Puter.com API. Please check your internet connection. If running in Docker, ensure the container or browser has internet access.');
  }
  if (msg.includes('CORS') || msg.includes('Access-Control-Allow-Origin')) {
    return new Error('Puter.com API blocked by browser CORS policy. The server proxy should handle this — try refreshing the page.');
  }
  if (msg.includes('403')) {
    return new Error('Puter.com API access denied (403). This may be due to CORS restrictions or API limitations. Please try using a different AI service or check puter.com documentation.');
  }
  if (msg.includes('Forbidden')) {
    return new Error('Puter.com API access forbidden. This service may require additional setup or have usage restrictions.');
  }
  return apiError;
}

/** Call Puter AI — uses server proxy on localhost to avoid CORS; direct puter.ai.chat on puter.com. */
async function callPuterAI(prompt, imageUrl, model) {
  await loadPuterJS();
  let retries = 0;
  const maxRetries = 10;
  while ((typeof puter === 'undefined' || !puter.ai) && retries < maxRetries) {
    await new Promise((r) => setTimeout(r, 100));
    retries++;
  }
  if (typeof puter === 'undefined' || !puter.ai) {
    throw new Error('Puter.js is not loaded. Please refresh the application.');
  }

  const modelName = model || 'gpt-5-nano';
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Network timeout: Unable to reach Puter.com API. Please check your internet connection.')), 55000);
  });

  if (needsPuterProxy()) {
    if (!puter.authToken && puter.ui && typeof puter.ui.authenticateWithPuter === 'function') {
      console.log('[Puter AI] Authenticating with Puter.com (captcha may appear)...');
      await puter.ui.authenticateWithPuter();
    }
    const proxyCall = fetch('/api/puter-ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        imageUrl: imageUrl || null,
        model: modelName,
        authToken: puter.authToken || null
      })
    }).then(async (resp) => {
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = new Error(data.error || `Puter AI proxy error (${resp.status})`);
        if (data.code) err.code = data.code;
        throw err;
      }
      return data.response;
    });
    return await Promise.race([proxyCall, timeoutPromise]);
  }

  if (!puter.ai.chat) {
    throw new Error('Puter.js AI chat is not available. Please refresh the application.');
  }
  return await Promise.race([
    puter.ai.chat(prompt, imageUrl, { model: modelName }),
    timeoutPromise
  ]);
}

// Assign puter-ai-chat-request handler early so Test (Puter) works in Docker/server before DOMContentLoaded
window._electronRealEventHandlers['puter-ai-chat-request'] = async function(requestId, prompt, imageUrl, model) {
  console.log('[Puter AI] Received request, Puter.js captcha may appear in this window');
  try {
    const response = await callPuterAI(prompt, imageUrl, model);
    const responseText = extractPuterResponseText(response);
    console.log('[Puter AI] Sending response back, requestId:', requestId, 'response length:', responseText ? responseText.length : 0);
    window.electron.send('puter-ai-chat-response', requestId, { response: responseText });
  } catch (error) {
    console.error('[Puter AI] Error calling puter.ai.chat:', error);
    const mapped = mapPuterApiError(error);
    const errorMessage = mapped.message || 'Unknown error';
    window.electron.send('puter-ai-chat-response', requestId, { error: errorMessage });
  }
};

// Add debug logging utility function
function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}


/** The sidebar's "in view" count (src/web/filters/SidebarActions.tsx, which also refreshes the total). */
async function updateModelCounts(viewCount) {
  window.sidebarStatus?.setViewCount(viewCount);
}

// Helper function to normalize paths for comparison
// This handles URL encoding, path separators, and whitespace differences
function normalizePathForComparison(path) {
  if (!path) return '';
  // Decode URL encoding if present
  let normalized = path;
  try {
    normalized = decodeURIComponent(normalized);
  } catch (e) {
    // If decoding fails, use original path
  }
  // Normalize path separators (both forward and back slashes)
  normalized = normalized.replace(/\\/g, '/');
  // Trim whitespace
  normalized = normalized.trim();
  // Windows drive letter: compare case-insensitively (C: vs c:)
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
}


// Moved resetInputState definition before the focus handler that calls it
function resetInputState(input) {
  if (!input) return;
  input.disabled = false;
  input.readOnly = false;
  // Don't clear the value here to preserve any entered data on refocus
  setTimeout(() => {
    input.focus();
    input.click();
  }, 50);
}

// Add window focus handler
window.addEventListener('focus', () => {
  // Find any open dialog and reset its input
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog) {
    const input = openDialog.querySelector('input[type="text"]');
    if (input) {
      resetInputState(input);
    }
  }
});

// Flag to prevent multiple clear-new-flag confirmations from showing
let isClearingNewFlags = false;

function isServerThumbnailWorkerContext() {
  if (typeof window.electron?.isServerThumbnailWorker !== 'function') {
    return Promise.resolve(false);
  }
  return window.electron.isServerThumbnailWorker().catch(() => false);
}


/** The terms must be accepted before the app loads (src/web/startup/FirstRun.tsx asks). */
async function checkTermsOfService() {
  // The server's thumbnail worker has no one to ask.
  if (await isServerThumbnailWorkerContext()) return true;
  return window.checkTerms ? window.checkTerms() : false;
}


// Update the DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', async () => {
  if (window.__justtprintPrimaryUiInit) return;
  window.__justtprintPrimaryUiInit = true;
  // In server mode, the loading overlay blocks UI. Hide it early.
  const initialOverlay = document.getElementById('loading-overlay');
  if (initialOverlay) initialOverlay.style.display = 'none';

  // Docker/Server first connect: wait for WebSocket before any IPC so data loads without refresh
  const isServedOverHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (isServedOverHttp && window.electron && typeof window.electron.whenConnected === 'function') {
    const connected = window.electron.whenConnected();
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge connect timeout')), 15000));
    try {
      await Promise.race([connected, timeout]);
    } catch (e) {
      console.warn('[Renderer] Bridge whenConnected timeout or error, continuing:', e?.message || e);
    }
  }

  const tosAccepted = await checkTermsOfService();
  if (!tosAccepted) return; // Don't continue if TOS was declined


  // Docker/Server: parallelize initial round-trips to reduce startup lag
  const [serverMode, hasRunBeforeVal] = await Promise.all([
    window.electron.isServerMode().catch(() => false),
    window.electron.getSetting('hasRunBefore')
  ]);

  // After bridge is ready: show "Scan STL Home" when STL Home is set (Docker/server may set via env)
  if (typeof window.updateScanStlHomeButtonVisibility === 'function') {
    window.updateScanStlHomeButtonVisibility().catch(() => {});
  }

  // Show the welcome dialog if this is the first run
  if (!hasRunBeforeVal) {
    window.showWelcome?.();
    await window.electron.saveSetting('hasRunBefore', 'true');
  }

  
  // The grid's image carousels save a pending default image themselves when the page closes (ModelCard.tsx).
  
  // Proceed to initialize the application
  // Update checks are handled in initializeApp() to avoid duplicates
  debugLog('DOM fully loaded and parsed');

  const fileGrid = document.querySelector('.file-grid');
  // Docker/Server: hide overlay so main window shell (sidebar, empty grid) paints immediately
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.style.display = 'none';

  // Docker/Server: yield for first paint, then load data (reduces perceived startup lag).
  // Do NOT call getAllModels here: the same handler later runs performCombinedSearch(), which
  // loads the library in bounded chunks (see search.js). Loading tens of thousands of rows here
  // duplicated IPC work and blocked the main thread for tens of seconds before that path ran.
  requestAnimationFrame(async () => {
    const savedDirectoryPath = await window.electron.loadDirectory();
    const shouldLoadModels = serverMode || savedDirectoryPath;

    if (shouldLoadModels) {
      fileGrid.classList.remove('hidden');
    }

    // Initialize filters in parallel (Docker/Server: one batch instead of four sequential round-trips)
    await Promise.all([
      populateDesignerDropdown(),
      populateLicenseFilter(),
      populateParentModelFilter(),
      populateTagFilter()
    ]);
  });

  // Update the edit mode toggle button listener


  // Load background color setting
  const backgroundColor = await window.electron.getSetting('modelBackgroundColor');
  if (backgroundColor) {
    document.documentElement.style.setProperty('--model-background-color', backgroundColor);
  }

  // Load render color setting
  const renderColor = await window.electron.getSetting('renderColor');
  window.currentRenderColor = renderColor || '#cccccc';

  // Load lighting setting
  const renderLighting = await window.electron.getSetting('renderLighting');
  window.currentRenderLighting = renderLighting !== null && renderLighting !== undefined ? renderLighting === 'true' : true;

  // Function to apply theme colors
  function applyThemeColors(theme) {
    const root = document.documentElement;
    switch(theme) {
      case 'modern-purple':
        root.style.setProperty('--primary-accent', '#a855f7');
        root.style.setProperty('--primary-accent-hover', '#c084fc');
        root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #a855f7 0%, #c084fc 100%)');
        root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #b866ff 0%, #d094ff 100%)');
        root.style.setProperty('--primary-shadow', 'rgba(168, 85, 247, 0.3)');
        root.style.setProperty('--primary-shadow-hover', 'rgba(168, 85, 247, 0.4)');
        break;
      case 'modern-green':
        root.style.setProperty('--primary-accent', '#4ade80');
        root.style.setProperty('--primary-accent-hover', '#22c55e');
        root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)');
        root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #5ae890 0%, #2dd66f 100%)');
        root.style.setProperty('--primary-shadow', 'rgba(34, 197, 94, 0.3)');
        root.style.setProperty('--primary-shadow-hover', 'rgba(34, 197, 94, 0.4)');
        break;
      case 'modern-orange':
        root.style.setProperty('--primary-accent', '#fb923c');
        root.style.setProperty('--primary-accent-hover', '#f97316');
        root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #fb923c 0%, #f97316 100%)');
        root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #ffa34c 0%, #ff8326 100%)');
        root.style.setProperty('--primary-shadow', 'rgba(249, 115, 22, 0.3)');
        root.style.setProperty('--primary-shadow-hover', 'rgba(249, 115, 22, 0.4)');
        break;
      case 'modern-pink':
        root.style.setProperty('--primary-accent', '#f472b6');
        root.style.setProperty('--primary-accent-hover', '#ec4899');
        root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)');
        root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #ff82c6 0%, #fc58a9 100%)');
        root.style.setProperty('--primary-shadow', 'rgba(236, 72, 153, 0.3)');
        root.style.setProperty('--primary-shadow-hover', 'rgba(236, 72, 153, 0.4)');
        break;
      case 'dark-minimal':
        root.style.setProperty('--primary-accent', '#9ca3af');
        root.style.setProperty('--primary-accent-hover', '#d1d5db');
        root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)');
        root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)');
        root.style.setProperty('--primary-shadow', 'rgba(75, 85, 99, 0.3)');
        root.style.setProperty('--primary-shadow-hover', 'rgba(75, 85, 99, 0.4)');
        break;
      default: // modern-cyan
        root.style.setProperty('--primary-accent', '#00d4ff');
        root.style.setProperty('--primary-accent-hover', '#5b9fff');
        root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #00d4ff 0%, #5b9fff 100%)');
        root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #00e5ff 0%, #6ba8ff 100%)');
        root.style.setProperty('--primary-shadow', 'rgba(91, 159, 255, 0.3)');
        root.style.setProperty('--primary-shadow-hover', 'rgba(91, 159, 255, 0.4)');
    }
    const accent = root.style.getPropertyValue('--primary-accent').trim() || '#00d4ff';
    const accentHover = root.style.getPropertyValue('--primary-accent-hover').trim() || accent;
    root.style.setProperty('--accent-color', accent);
    root.style.setProperty('--primary-gradient', accent);
    root.style.setProperty('--primary-gradient-hover', accentHover);
  }

  window.applyThemeColors = applyThemeColors;

  // Load theme on startup
  const savedTheme = await window.electron.getSetting('uiTheme') || 'modern-cyan';
  document.body.setAttribute('data-theme', savedTheme);
  applyThemeColors(savedTheme);


  // Add open file button handler
  // open-file-button removed - folders in path tree are now directly clickable

  await populateDesignerDropdown();
  await populateLicenseFilter();
  await populateParentModelFilter();
  await populateTagFilter();

  // Remove the nested DOMContentLoaded listener and keep only one at the root level
  document.addEventListener('DOMContentLoaded', async () => {
    const tosAccepted = await checkTermsOfService();
    if (!tosAccepted) return;

    // Rest of initialization...
    await initializeTags();
    await populateTagFilter();
  });

  // Remove the other DOMContentLoaded listener that's adding filter change handlers

  await initializeTags();


  await populateTagFilter();

 

  // Keyboard Shortcuts and About are React (src/web/KeyboardShortcutsDialog.tsx, AboutDialog.tsx).
  window._electronRealEventHandlers['open-keyboard-shortcuts'] = function() {
    window.openKeyboardShortcuts?.();
  };
  if (window._electronPendingEvents['open-keyboard-shortcuts']) {
    window._electronPendingEvents['open-keyboard-shortcuts'].forEach((args) => {
      window._electronRealEventHandlers['open-keyboard-shortcuts'].apply(null, args);
    });
    delete window._electronPendingEvents['open-keyboard-shortcuts'];
  }

  window._electronRealEventHandlers['open-about'] = function() {
    window.openAbout?.();
  };

  if (window._electronPendingEvents['open-about']) {
    window._electronPendingEvents['open-about'].forEach((args) => {
      window._electronRealEventHandlers['open-about'].apply(null, args);
    });
    delete window._electronPendingEvents['open-about'];
  }

  window._electronRealEventHandlers['open-server-mode-info'] = function() {
    const dialog = document.getElementById('server-mode-info-dialog');
    if (dialog) dialog.showModal();
  };
  if (window._electronPendingEvents['open-server-mode-info']) {
    window._electronPendingEvents['open-server-mode-info'].forEach((args) => {
      window._electronRealEventHandlers['open-server-mode-info'].apply(null, args);
    });
    delete window._electronPendingEvents['open-server-mode-info'];
  }

  // Library Stats is React (src/web/StatsDialog.tsx); it defines window.openStats.
  window._electronRealEventHandlers['open-stats'] = function() {
    window.openStats?.();
  };
  if (window._electronPendingEvents['open-stats']) {
    window._electronPendingEvents['open-stats'].forEach((args) => {
      window._electronRealEventHandlers['open-stats'].apply(null, args);
    });
    delete window._electronPendingEvents['open-stats'];
  }

  // System Report is React (src/web/SystemReportDialog.tsx); it defines window.openSystemReport.
  window._electronRealEventHandlers['open-system-report'] = function() {
    window.openSystemReport?.();
  };
  if (window._electronPendingEvents['open-system-report']) {
    window._electronPendingEvents['open-system-report'].forEach((args) => {
      window._electronRealEventHandlers['open-system-report'].apply(null, args);
    });
    delete window._electronPendingEvents['open-system-report'];
  }

  // Backup/Restore is React (src/web/BackupRestoreDialog.tsx); it defines window.openBackupRestore.
  window._electronRealEventHandlers['open-backup-restore'] = function() {
    window.openBackupRestore?.();
  };
  if (window._electronPendingEvents['open-backup-restore']) {
    window._electronPendingEvents['open-backup-restore'].forEach((args) => {
      window._electronRealEventHandlers['open-backup-restore'].apply(null, args);
    });
    delete window._electronPendingEvents['open-backup-restore'];
  }

  // De-Dup is React (src/web/DedupDialog.tsx); it defines window.openDedup.
  window._electronRealEventHandlers['open-dedup'] = function() {
    window.openDedup?.();
  };

  if (window._electronPendingEvents['open-dedup']) {
    window._electronPendingEvents['open-dedup'].forEach((args) => {
      window._electronRealEventHandlers['open-dedup'].apply(null, args);
    });
    delete window._electronPendingEvents['open-dedup'];
  }

  // View Entire Library is bound once later (see onViewEntireLibraryClick).

  // Called by the Tag Manager and Review Generated Tags (React) after a change.
  window.refreshTagRelatedUi = async function refreshTagRelatedUi() {
    try {
      await populateTagSelect();
      await populateTagFilter();
      if (typeof populateRemoveTagSelect === 'function') {
        await populateRemoveTagSelect();
      }
      const currentModelPath = window.library.currentModelPath();
      if (currentModelPath) {
        await loadModelTags(currentModelPath);
        if (typeof window.loadModelFilaments === 'function') {
          await window.loadModelFilaments(currentModelPath);
        }
      }
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch();
      }
    } catch (error) {
      console.error('Error refreshing tag-related UI:', error);
    }
  };

  // The Tag Manager is React (src/web/TagManagerDialog.tsx); it defines window.openTagManager.
  window._electronRealEventHandlers['open-tag-manager'] = function() {
    window.openTagManager?.();
  };
  if (window._electronPendingEvents['open-tag-manager']) {
    window._electronPendingEvents['open-tag-manager'].forEach((args) => {
      window._electronRealEventHandlers['open-tag-manager'].apply(null, args);
    });
    delete window._electronPendingEvents['open-tag-manager'];
  }


  // Called by the Tag Manager (React) when it closes after changes.
  window.refreshAfterTagManagerClose = async function refreshAfterTagManagerClose() {
      try {
        // Small delay to ensure database writes are flushed
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Clear the model cache to force fresh data
        const container = document.querySelector('.file-grid');
        if (container) {
          container.currentModels = null; // Clear cache to force re-render
        }
        
        // Refresh tag dropdowns in edit view
        await populateTagSelect();
        
        // Refresh tag filter dropdown
        await populateTagFilter();
        if (typeof populateRemoveTagSelect === 'function') {
          await populateRemoveTagSelect();
        }
        if (typeof window.populateFilamentSelect === 'function') {
          await window.populateFilamentSelect();
        }
        if (typeof window.populateFilamentFilter === 'function') {
          await window.populateFilamentFilter();
        }
        
        // Refresh tag list in edit view if a model is currently being edited
        const currentModelPath = window.library.currentModelPath();
        if (currentModelPath) {
          await loadModelTags(currentModelPath);
          if (typeof window.loadModelFilaments === 'function') {
            await window.loadModelFilaments(currentModelPath);
          }
        }
        
        // Force a full grid refresh to show updated tags on all model cards
        if (typeof window.performCombinedSearch === 'function') {
          await window.performCombinedSearch();
        } else {
          // Fallback: Get current sort option and refresh the grid
          const sortSelect = document.getElementById('sort-select');
          const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc');
          await window.renderFiles(models);
        }
        
        // Update all visible model elements to refresh their tags
        // This ensures tags are updated even if the grid doesn't fully re-render
        const allFileItems = document.querySelectorAll('.file-item');
        for (const item of allFileItems) {
          const filePath = item.getAttribute('data-filepath') || item.dataset.filepath;
          if (filePath) {
            await window.library.updateModel(filePath);
          }
        }
      } catch (error) {
        console.error('Error refreshing UI after tag manager close:', error);
      }
  };

  // Organize Library is React (src/web/OrganizeLibraryDialog.tsx); it defines window.openOrganizeLibrary.
  window._electronRealEventHandlers['open-organize-library'] = function() {
    window.openOrganizeLibrary?.();
  };
  if (window._electronPendingEvents['open-organize-library']) {
    window._electronPendingEvents['open-organize-library'].forEach((args) => {
      window._electronRealEventHandlers['open-organize-library'].apply(null, args);
    });
    delete window._electronPendingEvents['open-organize-library'];
  }

  // Purge Models is React (src/web/PurgeModelsDialog.tsx); it defines window.openPurgeModels.
  window._electronRealEventHandlers['open-purge-models'] = function() {
    window.openPurgeModels?.();
  };
  if (window._electronPendingEvents['open-purge-models']) {
    window._electronPendingEvents['open-purge-models'].forEach((args) => {
      window._electronRealEventHandlers['open-purge-models'].apply(null, args);
    });
    delete window._electronPendingEvents['open-purge-models'];
  }

  // The Metadata Manager is React (src/web/MetadataEditorDialog.tsx); it defines window.openMetadataEditor.
  window._electronRealEventHandlers['open-metadata-editor'] = function() {
    window.openMetadataEditor?.();
  };
  if (window._electronPendingEvents['open-metadata-editor']) {
    window._electronPendingEvents['open-metadata-editor'].forEach((args) => {
      window._electronRealEventHandlers['open-metadata-editor'].apply(null, args);
    });
    delete window._electronPendingEvents['open-metadata-editor'];
  }

  async function refreshMetadataDropdowns() {
    // Refresh designer dropdowns
    if (typeof populateDesignerDropdown === 'function') {
      await populateDesignerDropdown();
    }
    if (typeof populateModelDesignerDropdown === 'function') {
      await populateModelDesignerDropdown(null, 'model-designer');
      await populateModelDesignerDropdown(null, 'multi-designer');
    }
    
    // Refresh parent model dropdowns
    if (typeof populateParentModelFilter === 'function') {
      await populateParentModelFilter();
    }
    if (typeof populateParentModelDropdown === 'function') {
      await populateParentModelDropdown(null, 'model-parent');
      await populateParentModelDropdown(null, 'multi-parent');
    }
    
    // Refresh license dropdowns
    if (typeof populateLicenseFilter === 'function') {
      await populateLicenseFilter();
    }
    if (typeof populateModelLicenseDropdown === 'function') {
      await populateModelLicenseDropdown(null, 'model-license');
      await populateModelLicenseDropdown(null, 'multi-license');
    }
  }

  // After the Metadata Manager renamed or cleared a value: pickers, filters, and the grid.
  window.refreshAfterMetadataChange = async function refreshAfterMetadataChange() {
    await refreshMetadataDropdowns();
    const container = document.querySelector('.file-grid');
    if (container) container.currentModels = null; // force a full re-render
    if (typeof window.performCombinedSearch === 'function') {
      await window.performCombinedSearch();
    } else {
      const sortSelect = document.getElementById('sort-select');
      await window.renderFiles(await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc'));
    }
  };

  window._electronRealEventHandlers['clear-new-flags'] = async function() {
    if (isClearingNewFlags) return;
    if (await isServerThumbnailWorkerContext()) return;
    isClearingNewFlags = true;
    try {
      const userChoice = await window.electron.showMessage(
        'Clear New Flag',
        'This will clear the New flag from every model in your library. Continue?',
        ['Yes', 'No']
      );
      if (userChoice !== 'Yes') return;

      const result = await window.electron.clearNewFlags();
      const cleared = result && typeof result.cleared === 'number' ? result.cleared : 0;

      const container = document.querySelector('.file-grid');
      if (container && Array.isArray(container.currentModels)) {
        for (const model of container.currentModels) {
          if (model) model.isNew = 0;
        }
      }
      window.library.refreshGrid();

      try {
        if (typeof window.performCombinedSearch === 'function') {
          await window.performCombinedSearch();
        }
      } catch (refreshError) {
        console.warn('Cleared new flags but failed to refresh the grid:', refreshError);
      }

      const message = cleared === 0
        ? 'No models were marked as new.'
        : `Cleared the New flag from ${cleared} model${cleared === 1 ? '' : 's'}.`;
      await window.electron.showMessage('Clear New Flag', message);
    } catch (error) {
      console.error('Error clearing new flags:', error);
      if (window.electron?.showMessage) {
        await window.electron.showMessage('Error', 'Failed to clear New flags: ' + (error.message || error));
      }
    } finally {
      isClearingNewFlags = false;
    }
  };
  if (window._electronPendingEvents['clear-new-flags']) {
    window._electronPendingEvents['clear-new-flags'].forEach((args) => {
      window._electronRealEventHandlers['clear-new-flags'].apply(null, args);
    });
    delete window._electronPendingEvents['clear-new-flags'];
  }

  // After Purge Models (src/web/PurgeModelsDialog.tsx): empty the grid and counts, and reset the filters.
  window.afterModelsPurged = async function afterModelsPurged() {
    window.library.showModels([]);
    await updateModelCounts(0);
    window.clearAllLibraryFilters?.();
  };

  // Sort-select handler is now managed by search.js via initializeCombinedSearch()
  // which properly calls performCombinedSearch() to re-render with filters preserved

  const scheduleThumbnailGridRefresh = window.gridRefresh.createCoalescedRefresh(
    window.gridRefresh.THUMBNAIL_REFRESH_COALESCE_MS,
    async () => {
      const preservedDateAddedFilter = window.dateAddedFilter || window._lastDateAddedFilter;
      if (preservedDateAddedFilter) {
        window.dateAddedFilter = preservedDateAddedFilter;
        window._lastDateAddedFilter = preservedDateAddedFilter;
      }
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch({ preserveScroll: true });
      } else {
        const grid = document.querySelector('.file-grid');
        const savedScrollTop = grid ? grid.scrollTop : 0;
        const sortSelect = document.getElementById('sort-select');
        const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc');
        await window.renderFiles(models);
        if (grid && grid.scrollTop !== savedScrollTop) grid.scrollTop = savedScrollTop;
      }
    }
  );

  // Add this near the top of the file with other initialization code
  // Handle thumbnail added event - refresh grid to show updated thumbnail
  window.electron.onThumbnailAdded(async (data) => {
    if (data && data.filePath) {
      // Use a small delay to ensure database write is complete
      setTimeout(async () => {
        try {
          // Preserve dateAddedFilter if it's set (for new models view)
          const preservedDateAddedFilter = window.dateAddedFilter || window._lastDateAddedFilter;

          // Always refresh primary-thumb cache so exiting new mode / re-search shows the new default
          const updatedModelEarly = await window.electron.getModel(data.filePath);
          if (updatedModelEarly?.thumbnail) {
            window.thumbnails.syncFromField(data.filePath, updatedModelEarly.thumbnail);
          } else if (data.filePath) {
            window.thumbnails.invalidate(data.filePath);
          }
          
          // If dateAddedFilter is active, we should only update the specific item, not refresh the whole grid
          // This prevents clearing the filter when thumbnails are generated
          if (preservedDateAddedFilter) {
            console.log('Thumbnail added while dateAddedFilter is active, updating item only');
            
            // First, verify the model was updated in the database
            const updatedModel = updatedModelEarly;
            if (!updatedModel || !updatedModel.thumbnail) {
              return;
            }
            
            // Check if this model matches the filter
            if (updatedModel.dateAdded) {
              const modelDateAdded = new Date(updatedModel.dateAdded);
              const filterDate = new Date(preservedDateAddedFilter);
              if (modelDateAdded < filterDate) {
                // This model doesn't match the dateAdded filter, don't refresh
                console.log('Thumbnail added for model outside dateAdded filter, skipping');
                return;
              }
            }
            
            // Restore the filter
            window.dateAddedFilter = preservedDateAddedFilter;
            window._lastDateAddedFilter = preservedDateAddedFilter;
            
            // Try to find and update the specific DOM element only
            const allFileItems = document.querySelectorAll('.file-item');
            const normalizedPath = normalizePathForComparison(data.filePath);
            
            for (const fileItem of allFileItems) {
              const itemPath = fileItem.getAttribute('data-filepath') || fileItem.dataset.filepath;
              const normalizedItemPath = normalizePathForComparison(itemPath);
              if (normalizedItemPath === normalizedPath) {
                // Update the model in currentModels array
                const container = document.querySelector('.file-grid');
                if (container && container.currentModels) {
                  const modelIndex = container.currentModels.findIndex(m => 
                    normalizePathForComparison(m.filePath) === normalizedPath
                  );
                  if (modelIndex >= 0) {
                    // Update the model with fresh data from database
                    container.currentModels[modelIndex] = { ...updatedModel };
                  }
                }
                
                // The React grid card redraws from the updated model.
                
                // Trigger re-render of visible items only (preserves filter)
                if (container && container.renderVisibleItemsFn) {
                  container.renderVisibleItemsFn();
                }
                
                // Don't call performCombinedSearch - just update the single item
                return;
              }
            }

            const offscreenContainer = document.querySelector('.file-grid');
            if (offscreenContainer && window.gridRefresh.patchLoadedModel(
              offscreenContainer.currentModels,
              normalizedPath,
              updatedModel,
              normalizePathForComparison
            )) {
              return;
            }

            // If item wasn't found in current view, it might be filtered out or not visible
            // Don't refresh the whole grid - just return
            console.log('Thumbnail added for item not in current view, skipping refresh');
            return;
          }
          
          // If dateAddedFilter is NOT active, proceed with normal refresh behavior
          // First, verify the model was updated in the database
          const updatedModel = updatedModelEarly;
          if (!updatedModel || !updatedModel.thumbnail) {
            return;
          }
          
          // Try to find and update the specific DOM element first
          const allFileItems = document.querySelectorAll('.file-item');
          const normalizedPath = normalizePathForComparison(data.filePath);
          let itemFound = false;
          
          for (const fileItem of allFileItems) {
            const itemPath = fileItem.getAttribute('data-filepath') || fileItem.dataset.filepath;
            const normalizedItemPath = normalizePathForComparison(itemPath);
            if (normalizedItemPath === normalizedPath) {
              itemFound = true;
              
              // Update the model in currentModels array
              const container = document.querySelector('.file-grid');
              if (container && container.currentModels) {
                const modelIndex = container.currentModels.findIndex(m => 
                  normalizePathForComparison(m.filePath) === normalizedPath
                );
                if (modelIndex >= 0) {
                  // Update the model with fresh data from database
                  container.currentModels[modelIndex] = { ...updatedModel };
                }
              }
              
              // The React grid card redraws from the updated model.
              break;
            }
          }
          
          const container = document.querySelector('.file-grid');

          // Off-screen in the virtual grid: patch the loaded model in place.
          if (!itemFound && container && window.gridRefresh.patchLoadedModel(
            container.currentModels,
            normalizedPath,
            updatedModel,
            normalizePathForComparison
          )) {
            return;
          }

          // Trigger re-render of visible items
          if (container && container.renderVisibleItemsFn) {
            container.renderVisibleItemsFn();
          }

          // Model is not in the loaded grid at all (or the grid has no renderer): reload, coalesced
          if (!itemFound || !container || !container.renderVisibleItemsFn) {
            scheduleThumbnailGridRefresh();
          }
        } catch (updateError) {
          console.error('Error refreshing grid after adding thumbnail:', updateError);
          scheduleThumbnailGridRefresh();
        }
      }, 300); // Delay to ensure database write completes
    }
  });

  // Keep primary-thumb cache aligned when default is changed (carousel / manage thumbnails)
  window.electron.on('thumbnail-default-changed', async (data) => {
    if (!data?.filePath) return;
    try {
      const updatedModel = await window.electron.getModel(data.filePath);
      if (updatedModel?.thumbnail) {
        window.thumbnails.syncFromField(data.filePath, updatedModel.thumbnail);
      } else {
        window.thumbnails.invalidate(data.filePath);
      }
    } catch (_) {
      window.thumbnails.invalidate(data.filePath);
    }
  });

  // Handle thumbnail deleted event - refresh grid to show updated thumbnail
  window.electron.on('thumbnail-deleted', async (data) => {
    if (data?.filePath) window.thumbnails.invalidate(data.filePath);
    if (data && data.filePath) {
      // Use a small delay to ensure database write is complete
      setTimeout(async () => {
        try {
          // Preserve dateAddedFilter if it's set (for new models view)
          const preservedDateAddedFilter = window.dateAddedFilter || window._lastDateAddedFilter;
          
          // If dateAddedFilter is active, we should only update the specific item, not refresh the whole grid
          if (preservedDateAddedFilter) {
            console.log('Thumbnail deleted while dateAddedFilter is active, updating item only');
            
            // First, verify the model was updated in the database
            const updatedModel = await window.electron.getModel(data.filePath);
            if (!updatedModel) {
              return;
            }
            
            // Check if this model matches the filter
            if (updatedModel.dateAdded) {
              const modelDateAdded = new Date(updatedModel.dateAdded);
              const filterDate = new Date(preservedDateAddedFilter);
              if (modelDateAdded < filterDate) {
                // This model doesn't match the dateAdded filter, don't refresh
                console.log('Thumbnail deleted for model outside dateAdded filter, skipping');
                return;
              }
            }
            
            // Restore the filter
            window.dateAddedFilter = preservedDateAddedFilter;
            window._lastDateAddedFilter = preservedDateAddedFilter;
            
            // Try to find and update the specific DOM element only
            const allFileItems = document.querySelectorAll('.file-item');
            const normalizedPath = normalizePathForComparison(data.filePath);
            
            for (const fileItem of allFileItems) {
              const itemPath = fileItem.getAttribute('data-filepath') || fileItem.dataset.filepath;
              const normalizedItemPath = normalizePathForComparison(itemPath);
              if (normalizedItemPath === normalizedPath) {
                // Update the model in currentModels array
                const container = document.querySelector('.file-grid');
                if (container && container.currentModels) {
                  const modelIndex = container.currentModels.findIndex(m => 
                    normalizePathForComparison(m.filePath) === normalizedPath
                  );
                  if (modelIndex >= 0) {
                    // Update the model with fresh data from database
                    container.currentModels[modelIndex] = { ...updatedModel };
                  }
                }
                
                // The React grid card redraws from the updated model.
                
                // Trigger re-render of visible items only (preserves filter)
                if (container && container.renderVisibleItemsFn) {
                  container.renderVisibleItemsFn();
                }
                
                return;
              }
            }
            
            return;
          }
          
          // If dateAddedFilter is NOT active, proceed with normal refresh behavior
          const updatedModel = await window.electron.getModel(data.filePath);
          if (!updatedModel) {
            return;
          }
          
          // Try to find and update the specific DOM element first
          const allFileItems = document.querySelectorAll('.file-item');
          const normalizedPath = normalizePathForComparison(data.filePath);
          let itemFound = false;
          
          for (const fileItem of allFileItems) {
            const itemPath = fileItem.getAttribute('data-filepath') || fileItem.dataset.filepath;
            const normalizedItemPath = normalizePathForComparison(itemPath);
            if (normalizedItemPath === normalizedPath) {
              itemFound = true;
              
              // Update the model in currentModels array
              const container = document.querySelector('.file-grid');
              if (container && container.currentModels) {
                const modelIndex = container.currentModels.findIndex(m => 
                  normalizePathForComparison(m.filePath) === normalizedPath
                );
                if (modelIndex >= 0) {
                  container.currentModels[modelIndex] = { ...updatedModel };
                }
              }
              
              // The React grid card redraws from the updated model.
              
              // Trigger re-render of visible items
              if (container && container.renderVisibleItemsFn) {
                container.renderVisibleItemsFn();
              }
              
              return;
            }
          }
          
          // If item wasn't found, do a full refresh
          if (!itemFound) {
            if (typeof window.performCombinedSearch === 'function') {
              await window.performCombinedSearch();
            } else {
              const sortSelect = document.getElementById('sort-select');
              const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc');
              await window.renderFiles(models);
            }
          }
        } catch (updateError) {
          console.error('Error refreshing grid after deleting thumbnail:', updateError);
          // Fallback to full refresh on error
          if (typeof window.performCombinedSearch === 'function') {
            await window.performCombinedSearch();
          }
        }
      }, 300); // Delay to ensure database write completes
    }
  });

  // Null currentModels so the virtual grid cannot treat a refetch as unchanged (Docker/server).
  async function forceGridRefresh() {
    window.disableGridRefresh = false;
    const gridEl = document.querySelector('.file-grid');
    if (gridEl) gridEl.currentModels = null;
    if (typeof populateFileTypeFilter === 'function') await populateFileTypeFilter();
    try {
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch({ force: true });
      }
    } catch (err) {
      console.error('[forceGridRefresh]', err);
    }
  }
  window.forceGridRefresh = forceGridRefresh;

  window.electron.onRefreshGrid(async () => {
    // Always allow grid refresh when server/main signals (e.g. after scan in docker/server mode)
    window.disableGridRefresh = false;
    const gridEl = document.querySelector('.file-grid');
    if (gridEl) gridEl.currentModels = null;
    // Preserve dateAddedFilter if it's set
    const preservedDateAddedFilter = window.dateAddedFilter || window._lastDateAddedFilter;
    if (preservedDateAddedFilter) {
      console.log('onRefreshGrid called, preserving dateAddedFilter:', preservedDateAddedFilter);
      window.dateAddedFilter = preservedDateAddedFilter;
      window._lastDateAddedFilter = preservedDateAddedFilter;
    }
    // Keep the selection: the search below drops selected models that are gone
    // (syncSelectionWithFilteredModels) and leaves multi-edit when none are left.

    if (typeof window.forceGridRefresh === 'function') {
      await window.forceGridRefresh();
    } else if (typeof window.performCombinedSearch === 'function') {
      await window.performCombinedSearch({ force: true });
    }
  });

  // Add this near other dialog event listeners
  // Theme settings are React (src/web/ThemeSettingsDialog.tsx); it defines window.openThemeSettings.
  window._electronRealEventHandlers['open-theme-settings'] = function() {
    window.openThemeSettings?.();
  };
  if (window._electronPendingEvents['open-theme-settings']) {
    window._electronPendingEvents['open-theme-settings'].forEach((args) => {
      window._electronRealEventHandlers['open-theme-settings'].apply(null, args);
    });
    delete window._electronPendingEvents['open-theme-settings'];
  }


  // Update the tag deletion handler
  async function deleteSelectedTags() {
    try {
      const selectedTagIds = Array.from(selectedTags);
      for (const tagId of selectedTagIds) {
        await window.electron.deleteTag(tagId);
      }
      
      // Reset the input state after successful deletion
      resetInputState();
      
      // Refresh the tag list
      await loadTags();
      
      // Refresh the model grid to update any models that had these tags
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch();
      } else if (typeof window.forceGridRefresh === 'function') {
        await window.forceGridRefresh();
      }
    } catch (error) {
      console.error('Error deleting tags:', error);
      await window.electron.showMessage('Error', 'Failed to delete tags: ' + error.message);
    }
  }

  // Make sure this event listener exists
  document.getElementById('delete-tag-button')?.addEventListener('click', async () => {
    if (selectedTags.size === 0) {
      await window.electron.showMessage('Error', 'Please select tags to delete');
      return;
    }

    const result = await window.electron.showMessageBox({
      type: 'warning',
      title: 'Delete Tags',
      message: `Are you sure you want to delete ${selectedTags.size} tag(s)?`,
      buttons: ['Yes', 'No'],
      defaultId: 1,
      cancelId: 1
    });

    if (result.response === 0) {
      await deleteSelectedTags();
    }
  });

  // Add this function to update all tag dropdowns
  async function updateAllTagDropdowns() {
    try {
      const tags = await window.electron.getAllTags();
      tags.sort((a, b) => a.name.localeCompare(b.name)); // Sort tags alphabetically
      const tagDropdowns = document.querySelectorAll('.tags-input-container select');
      
      tagDropdowns.forEach(dropdown => {
        // Save current selection
        const currentSelection = Array.from(dropdown.selectedOptions).map(opt => opt.value);
        
        // Clear existing options
        dropdown.innerHTML = '';
        
        // Add placeholder option first
        const placeholderOption = document.createElement('option');
        placeholderOption.value = '';
        placeholderOption.textContent = 'Select a tag...';
        dropdown.appendChild(placeholderOption);
        
        // Add tags
        tags.forEach(tag => {
          const option = document.createElement('option');
          option.value = tag.name;
          option.textContent = tag.name;
          option.selected = currentSelection.includes(tag.name);
          dropdown.appendChild(option);
        });
      });
    } catch (error) {
      console.error('Error updating tag dropdowns:', error);
    }
  }

  // NOTE: addTagToModel is defined at top level (line ~5637) - duplicate removed

  // Make sure the add-tag-button event listener is updated

  // Add this function to handle tag dropdown click
  async function refreshTagDropdown(dropdown) {
    try {
      const tags = await window.electron.getAllTags();
      
      // Save current selection
      const currentSelection = Array.from(dropdown.selectedOptions).map(opt => opt.value);
      
      // Clear existing options
      dropdown.innerHTML = '';
      
      // Add placeholder option first
      const placeholderOption = document.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = 'Select a tag...';
      dropdown.appendChild(placeholderOption);
      
      // Add tags
      tags.forEach(tag => {
        const option = document.createElement('option');
        option.value = tag.name;
        option.textContent = tag.name;
        option.selected = currentSelection.includes(tag.name);
        dropdown.appendChild(option);
      });
    } catch (error) {
      console.error('Error refreshing tag dropdown:', error);
    }
  }

  // Add this in your DOMContentLoaded event listener
  document.addEventListener('DOMContentLoaded', async () => {
    // ... existing code ...

    // Add click handlers to all tag dropdowns
    document.querySelectorAll('.tags-input-container select').forEach(dropdown => {
      dropdown.addEventListener('mousedown', async (event) => {
        // Prevent the default dropdown from showing immediately
        event.preventDefault();
        
        // Refresh the dropdown content
        await refreshTagDropdown(dropdown);
        
        // Show the dropdown
        dropdown.click();
      });
    });

    // Also add the handler for dynamically created dropdowns
    document.body.addEventListener('mousedown', async (event) => {
      if (event.target.matches('.tags-input-container select')) {
        event.preventDefault();
        await refreshTagDropdown(event.target);
        event.target.click();
      }
    });

    // ... rest of your existing code ...
  });

  // Add this near your other event listeners
  document.querySelectorAll('.refresh-tags-button').forEach(button => {
    button.addEventListener('click', async (event) => {
      const dropdown = event.target.closest('.tags-input-container').querySelector('select');
      if (dropdown) {
        // Use the refreshTagDropdown function for consistency
        await refreshTagDropdown(dropdown);
        
        // Add visual feedback
        const refreshButton = event.target;
        refreshButton.style.transform = 'rotate(360deg)';
        setTimeout(() => {
          refreshButton.style.transform = 'none';
        }, 200);
      }
    });
  });

  // Also add handler for dynamically created refresh buttons
  document.body.addEventListener('click', async (event) => {
    if (event.target.matches('.refresh-tags-button')) {
      const dropdown = event.target.closest('.tags-input-container').querySelector('select');
      if (dropdown) {
        await refreshTagDropdown(dropdown);
        
        // Optional: Add a visual feedback for refresh
        const refreshButton = event.target;
        refreshButton.style.transform = 'rotate(360deg)';
        setTimeout(() => {
          refreshButton.style.transform = 'none';
        }, 200);
      }
    }
  });


  // Update the About dialog content in index.html
  const tosContent = `
  <h4>MIT License</h4>
  <p class="tos-copyright">Copyright (c) 2025 JusttPrint</p>
  <p>
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
  </p>
  <p>
    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
  </p>
  <p class="tos-warning">
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
  </p>
  <p>
    <strong>Data and Risk Disclaimer:</strong> You are solely responsible for backing up your data. 
    Use of this software is entirely at your own risk. The developers assume no liability for any 
    data loss, corruption, or damage.
  </p>
  `;

  // Run a Performance Settings open that arrived before this point (handler registered at the top).
  document.addEventListener('DOMContentLoaded', async () => {
    await initializeSettings();

    if (window._electronPendingEvents['open-performance-settings']) {
      window._electronPendingEvents['open-performance-settings'].forEach((args) => {
        window._electronRealEventHandlers['open-performance-settings'].apply(null, args);
      });
      delete window._electronPendingEvents['open-performance-settings'];
    }

  });

  // Add this function to initialize all settings including performance settings
  async function initializeSettings() {
    try {
      // Initialize other settings as needed
      const backgroundColor = await window.electron.getSetting('modelBackgroundColor');
      if (backgroundColor) {
        document.documentElement.style.setProperty('--model-background-color', backgroundColor);
      }
    } catch (error) {
      console.error('Error initializing settings:', error);
    }
  }

  // Call initializeSettings when the app starts
  document.addEventListener('DOMContentLoaded', async () => {
    await initializeSettings();
    // Rest of your initialization code...
  });

  // ... rest of the existing code ...

  // Add this near the other electron event listeners
  window.electron.onDbCleanup(async (event, data) => {
    if (data.message) {
      await window.electron.showMessage('Database Cleanup', data.message);
    }
  });



  // Add this function to handle closing the details panel
  function closeDetailsPanel() {
    const detailsPanel = document.getElementById('model-details');
    if (detailsPanel) {
      detailsPanel.classList.add('hidden');
    }
  }

  // NOTE: renderFile is defined at top level (line ~5046) - duplicate removed

  // Add this function to filter by directory
  async function filterByDirectory(directoryPath) {
    try {
        const models = await window.electron.getModelsByDirectory(directoryPath);
        await window.library.showModels(models);
    } catch (error) {
        console.error('Error filtering by directory:', error);
    }
  }

  // Add these constants at the top with other constants
  const ROULETTE_SPINS = 10; // Number of models to highlight before stopping
  const ROULETTE_INITIAL_DELAY = 100; // Initial delay between highlights in ms
  const ROULETTE_DELAY_INCREMENT = 20; // How much to slow down each spin

  // Add the roulette functionality
  async function startPrintRoulette() {
    // Get all visible models in the grid
    const visibleModels = Array.from(document.querySelectorAll('.file-item'));
    if (visibleModels.length === 0) return;

    window.selection.clear();

    // Close details panel if open
    const detailsPanel = document.getElementById('model-details');
    if (detailsPanel) {
      detailsPanel.classList.add('hidden');
    }

    const paths = visibleModels.map((item) => item.getAttribute('data-filepath')).filter(Boolean);
    if (!paths.length) return;
    let delay = ROULETTE_INITIAL_DELAY;
    // Highlight a random model by selecting it (the cards follow the selection).
    const highlightRandom = () => {
      const filePath = paths[Math.floor(Math.random() * paths.length)];
      window.selection.set([filePath]);
      return filePath;
    };

    // Spin, slowing down
    for (let i = 0; i < ROULETTE_SPINS; i++) {
      await new Promise(resolve => setTimeout(resolve, delay));
      highlightRandom();
      delay += ROULETTE_DELAY_INCREMENT;
    }

    const filePath = highlightRandom();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const finalItem = document.querySelector(`.file-item[data-filepath="${CSS.escape(filePath)}"]`);
    if (finalItem) {
      finalItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Winning animation
      finalItem.classList.add('roulette-winner');
      setTimeout(() => finalItem.classList.remove('roulette-winner'), 3000);
    }
    await window.library.showModelDetails(filePath);

    // Show celebration message
    await window.electron.showMessage(
      'Print Roulette',
      'Your next print has been chosen! 🎲\nTime to get printing!'
    );
  }

  window._electronRealEventHandlers['start-print-roulette'] = function() {
    startPrintRoulette();
  };
  if (window._electronPendingEvents['start-print-roulette']) {
    window._electronPendingEvents['start-print-roulette'].forEach((args) => {
      window._electronRealEventHandlers['start-print-roulette'].apply(null, args);
    });
    delete window._electronPendingEvents['start-print-roulette'];
  }

  // Add these functions at an appropriate location
  async function checkForUpdates(silent = false) {
    try {
      if (silent && (await window.electron.getSetting('autoUpdateCheck')) === '0') return;
      const currentVersion = await window.electron.getSetting('currentVersion');
      const isBeta = (await window.electron.getSetting('betaOptIn')) === 'true';
      const lastDeclinedVersion = await window.electron.getSetting('lastDeclinedVersion');
      
      console.log('Checking for updates:', {
        currentVersion,
        isBeta,
        lastDeclinedVersion,
        checkType: silent ? 'startup' : 'manual',
        endpoint: isBeta ? 'beta.version' : 'public.version'
      });
      
      // Get latest version from web
      const latestVersion = await window.electron.checkForUpdates(isBeta);
      if (!latestVersion) return;

      console.log('Version check result:', {
        currentVersion,
        latestVersion,
        lastDeclinedVersion,
        isBeta,
        needsUpdate: latestVersion !== currentVersion
      });

      // Store the latest version
      await window.electron.saveSetting('latestVersion', latestVersion);
      await window.electron.saveSetting('lastUpdateCheck', new Date().toISOString());

      // Compare versions
      // For manual checks (silent=false), ignore lastDeclinedVersion so user can check again
      // For automatic checks (silent=true), respect lastDeclinedVersion to avoid re-prompting
      const shouldCheckDeclined = silent; // Only check declined version on automatic checks
      const isUpdateAvailable = latestVersion && 
                                latestVersion !== currentVersion && 
                                compareVersions(latestVersion, currentVersion) > 0;
      const shouldShowPrompt = isUpdateAvailable && 
                               (!shouldCheckDeclined || latestVersion !== lastDeclinedVersion);
      
      if (shouldShowPrompt) {
        // Always show update prompt if there's an update
        const shouldUpdate = await window.electron.showMessage(
          'Update Available',
          `Version ${latestVersion} is available. You are currently running version ${currentVersion}. Would you like to update?`,
          ['Yes', 'No']
        );

        if (shouldUpdate === 'Yes') {
          await window.electron.openUpdatePage(isBeta);
        } else {
          // Store the declined version
          console.log('User declined update, storing version:', latestVersion);
          await window.electron.saveSetting('lastDeclinedVersion', latestVersion);
        }
      } else if (!silent) {
        // For manual checks, show appropriate message
        if (isUpdateAvailable && latestVersion === lastDeclinedVersion) {
          // Update available but was previously declined
          await window.electron.showMessage(
            'Update Previously Declined',
            `Version ${latestVersion} is available, but you previously declined this update. You can still update by visiting the website.`
          );
        } else {
          // Actually up to date
          await window.electron.showMessage(
            'Up to Date',
            'You are running the latest version.'
          );
        }
      }
    } catch (error) {
      console.error('Error checking for updates:', error);
      if (!silent) {
        await window.electron.showMessage(
          'Error',
          'Failed to check for updates. Please try again later.'
        );
      }
    }
  }

  // Remove any nested DOMContentLoaded listeners and consolidate into one
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      // Initialize all settings first
      await initializeSettings();
      
      // About dialog: handled by early listener (electron.on('open-about')).
      // Register onOpenAbout so preload has a listener; callback is a no-op here to avoid
      // double-open (early handler already opens the dialog).
      window.electron.onOpenAbout(() => {});

      // Add server mode info dialog handler
      window.electron.onOpenServerModeInfo(async () => {
        const dialog = document.getElementById('server-mode-info-dialog');
        if (dialog) {
          dialog.showModal();
        }
      });

      // Defer silent check so settings/dialogs can paint first (IPC + network; main also checks)
      setTimeout(() => {
        checkForUpdates(true).catch((err) => console.error('Silent update check:', err));
      }, 2000);
      
    } catch (error) {
      console.error('Error during initialization:', error);
    }
  });


  // Update the parent directory click handler to show the clear button


  // Scanning is TypeScript (src/web/scan/); the server also scans STL Home on its own.
  await window.performCombinedSearch?.();
  // STL Home may be set by the environment before the page loaded.
  await window.updateScanStlHomeButtonVisibility?.();


;

  // Assuming this is where the menu item is defined
  document.addEventListener('DOMContentLoaded', function() {
    // Remove any old guide references
    // const guideDialog = document.getElementById('guide-dialog'); // Remove this line if it exists

    // Assuming this is where the menu item is defined
    document.getElementById("guide-button").addEventListener("click", function() {
      // Call the new guide function
      window.electron.send('open-guide'); // Ensure this sends the correct event to show the new guide
    });
  });

  // Add this listener at the top of the file or within the DOMContentLoaded event
  window._electronRealEventHandlers['open-guide'] = function() {
    if (typeof showGuide === 'function') showGuide();
  };
  if (window._electronPendingEvents['open-guide']) {
    window._electronPendingEvents['open-guide'].forEach((args) => {
      window._electronRealEventHandlers['open-guide'].apply(null, args);
    });
    delete window._electronPendingEvents['open-guide'];
  }

  // Handler for puter.com AI requests from main process
  // In server mode, this is called via WebSocket from server-bridge.js
  // In normal mode, this is called via IPC from main process
  // The captcha will appear in this window (browser window in server mode, Electron window in normal mode)
  window._electronRealEventHandlers['puter-ai-chat-request'] = async function(requestId, prompt, imageUrl, model) {
    console.log('[Puter AI] Received request, Puter.js captcha may appear in this window');
    try {
      const response = await callPuterAI(prompt, imageUrl, model);
      const responseText = extractPuterResponseText(response);
      console.log('[Puter AI] Sending response back, requestId:', requestId, 'response length:', responseText?.length);
      window.electron.send('puter-ai-chat-response', requestId, { response: responseText });
    } catch (error) {
      console.error('[Puter AI] Error calling puter.ai.chat:', error);
      const mapped = mapPuterApiError(error);
      const errorMessage = mapped.message || 'Unknown error';
      console.log('[Puter AI] Sending error response, requestId:', requestId, 'error:', errorMessage);
      window.electron.send('puter-ai-chat-response', requestId, { error: errorMessage });
    }
  };
  if (window._electronPendingEvents['puter-ai-chat-request']) {
    window._electronPendingEvents['puter-ai-chat-request'].forEach((args) => {
      window._electronRealEventHandlers['puter-ai-chat-request'].apply(null, args);
    });
    delete window._electronPendingEvents['puter-ai-chat-request'];
  }

  // AI Configuration is React (src/web/AiConfigDialog.tsx); it defines window.openAiConfig.
  window._electronRealEventHandlers['open-ai-config'] = function() {
    window.openAiConfig?.();
  };
  if (window._electronPendingEvents['open-ai-config']) {
    window._electronPendingEvents['open-ai-config'].forEach((args) => {
      window._electronRealEventHandlers['open-ai-config'].apply(null, args);
    });
    delete window._electronPendingEvents['open-ai-config'];
  }

  // File Type settings are React (src/web/FileTypeSettingsDialog.tsx); it defines window.openFileTypeSettings.
  window._electronRealEventHandlers['open-file-type-settings'] = function() {
    window.openFileTypeSettings?.();
  };
  if (window._electronPendingEvents['open-file-type-settings']) {
    window._electronPendingEvents['open-file-type-settings'].forEach((args) => {
      window._electronRealEventHandlers['open-file-type-settings'].apply(null, args);
    });
    delete window._electronPendingEvents['open-file-type-settings'];
  }

  // Populate File Type filter dropdown with only enabled types (from Settings > File Type)
  async function populateFileTypeFilter() {
    window.libraryFilters?.reloadOptions();
  }

  // The File Type settings screen (React) calls this after saving.
  window.populateFileTypeFilter = populateFileTypeFilter;


  // Browser Extension settings are React (src/web/BrowserExtensionSettingsDialog.tsx).
  window._electronRealEventHandlers['open-browser-extension-settings'] = function() {
    window.openBrowserExtensionSettings?.();
  };
  if (window._electronPendingEvents['open-browser-extension-settings']) {
    window._electronPendingEvents['open-browser-extension-settings'].forEach((args) => {
      window._electronRealEventHandlers['open-browser-extension-settings'].apply(null, args);
    });
    delete window._electronPendingEvents['open-browser-extension-settings'];
  }

  // MCP Server settings are React (src/web/McpServerSettingsDialog.tsx); it defines window.openMcpServerSettings.
  window._electronRealEventHandlers['open-mcp-server-settings'] = function() {
    window.openMcpServerSettings?.();
  };
  if (window._electronPendingEvents['open-mcp-server-settings']) {
    window._electronPendingEvents['open-mcp-server-settings'].forEach((args) => {
      window._electronRealEventHandlers['open-mcp-server-settings'].apply(null, args);
    });
    delete window._electronPendingEvents['open-mcp-server-settings'];
  }

  // Server Access dialog: React (src/web/ServerAccessDialog.tsx) defines window.openServerAccess.

  window.logOutOfServer = async function logOutOfServer() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = '/login';
    }
  };

  window._electronRealEventHandlers['open-server-access'] = async function() {
    await window.openServerAccess();
  };


  // Review Generated Tags is React (src/web/tags/TagPreviewDialog.tsx).

  // Add handlers for progress dialog
  window.electron.on('show-progress-dialog', (data) => {
    const progressDialog = document.getElementById('progress-dialog');
    const progressTitle = document.getElementById('progress-title');
    const progressMessage = document.getElementById('progress-message');
    const progressBar = document.getElementById('progress-bar');
    const progressStatus = document.getElementById('progress-status');
    
    // Set initial values
    progressTitle.textContent = data.title || 'Processing...';
    progressMessage.textContent = data.message || 'Please wait...';
    progressBar.style.width = '0%';
    progressStatus.textContent = `0 / ${data.total}`;
    
    // Show the dialog
    progressDialog.showModal();
  });
  
  window.electron.on('update-progress', (data) => {
    const progressBar = document.getElementById('progress-bar');
    const progressMessage = document.getElementById('progress-message');
    const progressStatus = document.getElementById('progress-status');
    
    // Update progress bar
    const percentage = (data.current / data.total) * 100;
    progressBar.style.width = `${percentage}%`;
    
    // Update message and status
    if (data.message) {
      progressMessage.textContent = data.message;
    }
    progressStatus.textContent = `${data.current} / ${data.total}`;
  });
  
  window.electron.on('close-progress-dialog', () => {
    const progressDialog = document.getElementById('progress-dialog');
    progressDialog.close();
  });

  // Listen for tag generation progress updates and update a progress bar
  window.electron.on('tag-generation-progress', (completed, total) => {
    // Assume an element with id "ai-tag-progress" exists in the DOM.
    let progressContainer = document.getElementById('ai-tag-progress');
    if (!progressContainer) {
      // If not, create one dynamically and append it to the main-content or body.
      progressContainer = document.createElement('div');
      progressContainer.id = 'ai-tag-progress';
      progressContainer.style.position = 'fixed';
      progressContainer.style.top = '10px';
      progressContainer.style.right = '10px';
      progressContainer.style.width = '300px';
      progressContainer.style.height = '30px';
      progressContainer.style.background = '#444';
      progressContainer.style.borderRadius = '5px';
      progressContainer.style.boxShadow = '0 0 5px rgba(0,0,0,0.5)';
      progressContainer.style.zIndex = '10000';

      // Create an inner progress bar element
      const progressBar = document.createElement('div');
      progressBar.className = 'progress-bar';
      progressBar.style.height = '100%';
      progressBar.style.width = '0%';
      progressBar.style.background = '#4a9eff';
      progressBar.style.transition = 'width 0.2s ease';

      // Create a text overlay
      const progressText = document.createElement('span');
      progressText.className = 'progress-text';
      progressText.style.position = 'absolute';
      progressText.style.top = '50%';
      progressText.style.left = '50%';
      progressText.style.transform = 'translate(-50%, -50%)';
      progressText.style.color = '#fff';
      progressText.style.fontSize = '14px';

      progressContainer.appendChild(progressBar);
      progressContainer.appendChild(progressText);
      document.body.appendChild(progressContainer);
    }

    // Update the progress bar based on the completed progress.
    const progressBar = progressContainer.querySelector('.progress-bar');
    const progressText = progressContainer.querySelector('.progress-text');
    const percent = Math.floor((completed / total) * 100);
    progressBar.style.width = percent + '%';
    progressText.textContent = `${completed} / ${total}`;

    // If complete, hide the progress bar after a short delay.
    if (completed === total) {
      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 1000);
    } else {
      progressContainer.style.display = 'block';
    }
  });

  window.electron.on('select-model-by-filepath', (filePath) => {
    // Context menu highlights the file only. Details open from the Details control.
    window.library.highlightModel(filePath);
  });

  // Global variable for storing a parent directory filter.
  window.currentDirectoryFilter = "";

  // Add ping/pong handler to keep the renderer process alive
  window.electron.on('ping', () => {
    window.electron.pong();
    
    // Force a minimal UI update to prevent freezing
    requestAnimationFrame(() => {
      const dummyElement = document.createElement('div');
      document.body.appendChild(dummyElement);
      document.body.removeChild(dummyElement);
    });
  });

  // Add download handler for server/docker mode (only register once)
  if (!window._downloadHandlerRegistered) {
    window._downloadHandlerRegistered = true;
    const activeDownloads = new Set(); // Track active downloads to prevent duplicates
    
  // Handle add-image-request event (for server/Docker mode). Accepts single filePath or array for multi-edit.
  let activeImageInput = null; // Track active file input to prevent duplicates
  window.electron.on('add-image-request', async (filePathOrPaths) => {
    // Prevent multiple file input dialogs from opening
    if (activeImageInput) {
      console.log('Image file input dialog already open, ignoring request');
      return;
    }
    const paths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];
    
    try {
      // Create a file input element
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/jpg,image/gif,image/webp';
      fileInput.style.display = 'none';
      activeImageInput = fileInput;
      
      let fileSelected = false;
      
      // Handle file selection
      fileInput.addEventListener('change', async (e) => {
        // Prevent multiple change events
        if (fileSelected) {
          return;
        }
        fileSelected = true;
        
        const file = e.target.files[0];
        
        // Clean up immediately, even if no file was selected
        if (activeImageInput === fileInput) {
          activeImageInput = null;
        }
        if (fileInput.parentNode) {
          fileInput.parentNode.removeChild(fileInput);
        }
        
        if (!file) {
          return; // User cancelled
        }
        
        try {
          // Read file as data URL
          const reader = new FileReader();
          reader.onload = async (event) => {
            try {
              const dataUrl = event.target.result;
              // Add thumbnail to each selected model (multi-edit: same image to all)
              for (const filePath of paths) {
                await window.electron.addThumbnail(filePath, dataUrl);
              }
              // Server-side handler sends thumbnail-added per model to refresh the UI
            } catch (error) {
              console.error('Error adding image:', error);
              alert('Error adding image: ' + error.message);
            }
          };
          reader.onerror = (error) => {
            console.error('Error reading file:', error);
            alert('Error reading image file');
          };
          reader.readAsDataURL(file);
        } catch (error) {
          console.error('Error processing image file:', error);
          alert('Error processing image: ' + error.message);
        }
      });
      
      // Clean up if user cancels (no file selected after a delay)
      setTimeout(() => {
        if (!fileSelected && activeImageInput === fileInput) {
          activeImageInput = null;
          if (fileInput.parentNode) {
            fileInput.parentNode.removeChild(fileInput);
          }
        }
      }, 1000);
      
      // Trigger file input dialog
      document.body.appendChild(fileInput);
      fileInput.click();
    } catch (error) {
      console.error('Error setting up image file input:', error);
      alert('Error: Could not open file dialog');
      activeImageInput = null;
    }
  });


    window.electron.on('download-model', async (filePath) => {
      // Prevent duplicate downloads of the same file
      if (activeDownloads.has(filePath)) {
        console.log('Download already in progress for:', filePath);
        return;
      }
      
      activeDownloads.add(filePath);
      console.log('Download handler triggered with filePath:', filePath);
      
      try {
        // Check if in server mode
        const serverMode = await window.electron.isServerMode().catch(() => false);
        if (!serverMode) {
          console.error('Download only available in server mode');
          alert('Download is only available in server mode');
          return;
        }

        console.log('Server mode confirmed, constructing download URL');
        // Construct download URL - use /api/download/ endpoint which handles zip entries
        const encodedPath = encodeURIComponent(filePath);
        const downloadUrl = `/api/download/${encodedPath}`;
        console.log('Download URL:', downloadUrl);

        // Try using direct link first (simpler and more reliable)
        // This works better when the server sets Content-Disposition header
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = ''; // Let server set filename via Content-Disposition
        link.style.display = 'none';
        document.body.appendChild(link);
        
        // Get filename from path for logging
        let fileName = filePath;
        if (fileName.includes('::')) {
          fileName = fileName.split('::')[1] || fileName.split('::')[0];
        }
        fileName = fileName.split(/[/\\]/).pop() || fileName;
        
        console.log('Triggering download via direct link for:', fileName);
        link.click();
        
        // Clean up link after a short delay
        setTimeout(() => {
          if (document.body.contains(link)) {
            document.body.removeChild(link);
          }
          // Remove from active downloads after a delay to allow download to start
          setTimeout(() => {
            activeDownloads.delete(filePath);
          }, 2000);
        }, 100);
      } catch (error) {
        console.error('Error downloading file:', error);
        activeDownloads.delete(filePath);
        // Show error message to user
        alert(`Error downloading file: ${error.message}`);
      }
    });
  }

  // Add near the top of your DOMContentLoaded event listener
  document.addEventListener('DOMContentLoaded', async () => {
    // ... existing code ...

    // Add visibility change handler
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Force a refresh of the UI
        requestAnimationFrame(() => {
          // Refresh any dynamic content that might be stale
          refreshUIContent();
        });
      }
    });
  });

  // Add this new function
  function refreshUIContent() {
    // Refresh the file grid if it exists
    const fileGrid = document.querySelector('.file-grid');
    if (fileGrid) {
      // Re-render the current view
      window.electron.getAllModels(
        document.getElementById('sort-select')?.value || 'name',
        50
      ).then(models => {
        window.renderFiles(models);
        
      }).catch(console.error);
    }
  }

  // Slicer settings are React (src/web/SlicerSettingsDialog.tsx); it defines window.openSlicerSettings.
  window._electronRealEventHandlers['open-slicer-settings'] = function() {
    window.openSlicerSettings?.();
  };

  if (window._electronPendingEvents['open-slicer-settings']) {
    window._electronPendingEvents['open-slicer-settings'].forEach((args) => {
      window._electronRealEventHandlers['open-slicer-settings'].apply(null, args);
    });
    delete window._electronPendingEvents['open-slicer-settings'];
  }

  // The server's thumbnail worker page (src/web/thumbnails/worker.ts) needs no grid or library.
  if (await isServerThumbnailWorkerContext()) {
    console.log('[Server thumbnails] Worker window: skipping the rest of the UI init');
    document.body?.classList.add('server-thumbnail-worker');
    return;
  }

 


  // Remove the override of getCombinedFilteredModels - use the one from search.js instead
  // window.getCombinedFilteredModels = async (limit = 0) => {
  //   try {
  //     // Get current filter values
  //     ...
  //   } catch (error) {
  //     console.error("Error in getCombinedFilteredModels:", error);
  //     return [];
  //   }
  // };

  // Add this IPC handler to preload.js
  // getAllModelReferences: () => ipcRenderer.invoke('get-all-model-references'),


  // ... existing code ...
});


// Update populateModelDesignerDropdown to handle multiple dropdowns
/** Reload the designer pickers (details panel and multi-edit panel are React). */
async function populateModelDesignerDropdown() {
  window.detailsFields?.reloadOptions();
  window.multiEdit?.reloadOptions();
}

async function populateDesignerDropdown() {
  window.libraryFilters?.reloadOptions(); // React (src/web/filters/Sidebar.tsx)
}


// Replace the existing tag handling functions with these
async function initializeTags() {
  // The tag and filament pickers are React; they load their own options.
  await populateTagSelect();
}

/** Reload the tag pickers (details panel, multi-edit panel and bundle panel are React). */
async function populateTagSelect() {
  window.detailsFields?.reloadOptions();
  window.multiEdit?.reloadOptions();
  window.bundleDetails?.reloadOptions();
}


// Populate the remove tag dropdown with tags from selected files
async function populateRemoveTagSelect() {
  window.multiEdit?.selectionChanged();
}

// Update the addTagToModel function
/** Add a tag to the model in the details panel (React, DetailsFields.tsx). */
async function addTagToModel(tagName, containerId, options = {}) {
  if (!options.skipSave) await window.detailsFields?.addTag(tagName);
}

async function loadModelTags(modelIdOrPath) {
  // Reload the details panel's tags (React, DetailsFields.tsx) from the database.
  try {
    const model = await window.electron.getModel(modelIdOrPath);
    if (!model || !model.id) return;
    const tags = await window.electron.getModelTags(model.id);
    window.detailsFields?.setTags((tags || []).map((t) => (typeof t === 'string' ? t : t && t.name)).filter(Boolean));
  } catch (error) {
    console.error('Error loading model tags:', error);
  }
}


// Add this function to populate the tag filter dropdown
async function populateTagFilter() {
  window.libraryFilters?.reloadOptions();
}


// Add license filter population with null checks
async function populateLicenseFilter() {
  window.libraryFilters?.reloadOptions();
}

// After De-Dup (src/web/DedupDialog.tsx) deleted files: clear the selection and reload the grid.
window.refreshAfterDedupDelete = async function refreshAfterDedupDelete() {
  window.selection.clear();
  const sortSelect = document.getElementById('sort-select');
  await window.renderFiles(await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc'));
};


// Add helper function for populating license dropdown
/** Reload the license pickers (details panel and multi-edit panel are React). */
async function populateModelLicenseDropdown() {
  window.detailsFields?.reloadOptions();
  window.multiEdit?.reloadOptions();
}

// Add helper function for populating parent model dropdown
/** Reload the parent model pickers (details panel and multi-edit panel are React). */
async function populateParentModelDropdown() {
  window.detailsFields?.reloadOptions();
  window.multiEdit?.reloadOptions();
}

// Add back the populateParentModelFilter function
async function populateParentModelFilter() {
  window.libraryFilters?.reloadOptions();
}


// Remove all existing DOMContentLoaded event listeners and create a single one
// Place this at the end of the file, after all function declarations

// First, declare all initialization functions outside of any event listeners
async function initializeApp() {
  if (window.__justtprintInitializeAppPromise) {
    return window.__justtprintInitializeAppPromise;
  }
  window.__justtprintInitializeAppPromise = initializeAppOnce();
  return window.__justtprintInitializeAppPromise;
}

async function initializeAppOnce() {
  try {
    if (await isServerThumbnailWorkerContext()) {
      console.log('[Server thumbnails] Worker window: skipping initializeApp');
      return;
    }
    // The saved sort order and notes setting (src/web/filters/store.ts)
    if (typeof window.initializeCombinedSearch === 'function') {
      await window.initializeCombinedSearch();
    }
    
    console.log('1. Starting initialization sequence');
    
    // Initialize settings inline instead of calling initializeSettings()
    console.log('2. Loading settings...');
    try {
      // Initialize other settings as needed
      const backgroundColor = await window.electron.getSetting('modelBackgroundColor');
      if (backgroundColor) {
        document.documentElement.style.setProperty('--model-background-color', backgroundColor);
      }
      
      // Load UI theme
      const savedTheme = await window.electron.getSetting('uiTheme') || 'modern-cyan';
      document.body.setAttribute('data-theme', savedTheme);
      
      // Apply theme colors if function exists
      if (typeof applyThemeColors === 'function') {
        applyThemeColors(savedTheme);
      } else {
        // Fallback: apply theme colors inline
        const root = document.documentElement;
        switch(savedTheme) {
          case 'modern-purple':
            root.style.setProperty('--primary-accent', '#a855f7');
            root.style.setProperty('--primary-accent-hover', '#c084fc');
            root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #a855f7 0%, #c084fc 100%)');
            root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #b866ff 0%, #d094ff 100%)');
            root.style.setProperty('--primary-shadow', 'rgba(168, 85, 247, 0.3)');
            root.style.setProperty('--primary-shadow-hover', 'rgba(168, 85, 247, 0.4)');
            break;
          case 'modern-green':
            root.style.setProperty('--primary-accent', '#4ade80');
            root.style.setProperty('--primary-accent-hover', '#22c55e');
            root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)');
            root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #5ae890 0%, #2dd66f 100%)');
            root.style.setProperty('--primary-shadow', 'rgba(34, 197, 94, 0.3)');
            root.style.setProperty('--primary-shadow-hover', 'rgba(34, 197, 94, 0.4)');
            break;
          case 'modern-orange':
            root.style.setProperty('--primary-accent', '#fb923c');
            root.style.setProperty('--primary-accent-hover', '#f97316');
            root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #fb923c 0%, #f97316 100%)');
            root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #ffa34c 0%, #ff8326 100%)');
            root.style.setProperty('--primary-shadow', 'rgba(249, 115, 22, 0.3)');
            root.style.setProperty('--primary-shadow-hover', 'rgba(249, 115, 22, 0.4)');
            break;
          case 'modern-pink':
            root.style.setProperty('--primary-accent', '#f472b6');
            root.style.setProperty('--primary-accent-hover', '#ec4899');
            root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)');
            root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #ff82c6 0%, #fc58a9 100%)');
            root.style.setProperty('--primary-shadow', 'rgba(236, 72, 153, 0.3)');
            root.style.setProperty('--primary-shadow-hover', 'rgba(236, 72, 153, 0.4)');
            break;
          case 'dark-minimal':
            root.style.setProperty('--primary-accent', '#9ca3af');
            root.style.setProperty('--primary-accent-hover', '#d1d5db');
            root.style.setProperty('--primary-gradient', 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)');
            root.style.setProperty('--primary-gradient-hover', 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)');
            root.style.setProperty('--primary-shadow', 'rgba(75, 85, 99, 0.3)');
            root.style.setProperty('--primary-shadow-hover', 'rgba(75, 85, 99, 0.4)');
            break;
        }
        const accent = root.style.getPropertyValue('--primary-accent').trim() || '#00d4ff';
        const accentHover = root.style.getPropertyValue('--primary-accent-hover').trim() || accent;
        root.style.setProperty('--accent-color', accent);
        root.style.setProperty('--primary-gradient', accent);
        root.style.setProperty('--primary-gradient-hover', accentHover);
      }
    } catch (error) {
      console.error('Error initializing settings:', error);
    }
    
    console.log('3. Checking current version...');
    const currentVersion = await window.electron.getSetting('currentVersion');
    const isBeta = (await window.electron.getSetting('betaOptIn')) === 'true';
    
    console.log('4. Current app state:', {
      currentVersion,
      isBeta,
      checkingForUpdates: true
    });
    
    // Check if version check was already performed by main process
    const versionCheckPerformed = await window.electron.getSetting('versionCheckPerformedOnStartup');
    const autoUpdateCheck = await window.electron.getSetting('autoUpdateCheck');
    let latestVersion;
    
    if (autoUpdateCheck === '0') {
      console.log('5. Automatic update check is off, skipping');
      latestVersion = null;
    } else if (versionCheckPerformed === 'true') {
      console.log('5. Version check already performed by main process, retrieving stored version');
      // Get the latest version from the database instead of making another HTTP request
      latestVersion = await window.electron.getSetting('latestVersion');
      console.log('Retrieved latest version from database:', latestVersion);
    } else {
      console.log('5. Checking for updates...');
      latestVersion = await window.electron.checkForUpdates(isBeta);
    }
    
    // Reset the flag for next app start
    await window.electron.saveSetting('versionCheckPerformedOnStartup', 'false');
    
    const lastDeclinedVersion = await window.electron.getSetting('lastDeclinedVersion');
    
    console.log('6. Version check results:', {
      currentVersion,
      latestVersion,
      lastDeclinedVersion,
      isBeta,
      needsUpdate: latestVersion !== currentVersion
    });
    
    // Only show prompt if it's a new version and not the one user previously declined
    // This is an automatic check (silent=true), so respect lastDeclinedVersion
    const isUpdateAvailable = latestVersion && 
                              latestVersion !== currentVersion && 
                              compareVersions(latestVersion, currentVersion) > 0;
    const shouldShowPrompt = isUpdateAvailable && 
                             latestVersion !== lastDeclinedVersion;
    
    if (shouldShowPrompt) {
      console.log('7. Update available - showing prompt');
      const shouldUpdate = await window.electron.showMessage(
        'Update Available',
        `Version ${latestVersion} is available. You are currently running version ${currentVersion}. Would you like to update?`,
        ['Yes', 'No']
      );
      
      console.log('Renderer - Update prompt response:', shouldUpdate);
      if (shouldUpdate === 'Yes') {
        await window.electron.openUpdatePage(isBeta);
      } else {
        // Store the declined version
        console.log('Renderer - User declined update, storing version:', latestVersion);
        await window.electron.saveSetting('lastDeclinedVersion', latestVersion);
      }
    }

    // Store the latest version after check
    if (latestVersion) {
      console.log('Renderer - Saving latest version to settings:', latestVersion);
      await window.electron.saveSetting('latestVersion', latestVersion);
      await window.electron.saveSetting('lastUpdateCheck', new Date().toISOString());
    }
    
    console.log('8. Initializing UI components');
    

    
    console.log('9. Initialization complete');
  } catch (error) {
    console.error('Fatal error during initialization:', error);
    throw error; // Re-throw to be caught by the DOMContentLoaded handler
  }
}

// Edit the DOMContentLoaded event listener to remove the call to promptPendingThumbnails
document.addEventListener('DOMContentLoaded', async () => {
  const tosAccepted = await checkTermsOfService();
  if (!tosAccepted) return; // Don't continue if TOS was declined

  // First-run welcome is handled in the primary DOMContentLoaded startup path in this file.
  debugLog('DOM fully loaded and parsed');

  // Continue with normal initialization (which includes update checking)
  await initializeApp();

  // (Any additional event listeners and UI initialization code below)
});

// Add a semantic version comparison function at an appropriate place in the file
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  
  return 0;
}

// Add this event handler after the other window.electron.on handlers
window.electron.on('show-native-prompt', async (options) => {
  const { title, label, placeholder } = options;
  const value = prompt(label || 'Please enter a value:', placeholder || '');
  
  // Send the response back to main process
  window.electron.send('native-prompt-response', { 
    value: value,
    canceled: value === null
  });
});




// ---- Group cards (src/web/grid/GroupCard.tsx) ----
