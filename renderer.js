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
  'tags-generated', 'start-single-tag-generation', 'start-batch-tag-generation', 'batch-tag-generation-complete',
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

// Minimal handlers for tag-preview so dialog opens when events arrive before late block (Docker/Server)
window._electronRealEventHandlers['start-single-tag-generation'] = function(filePath, modelData) {
  var dialog = document.getElementById('tag-preview-dialog');
  if (dialog && !dialog.open) {
    dialog.showModal();
    var container = document.getElementById('tag-preview-container');
    if (container) container.innerHTML = '<div style="padding: 20px; color: #fff;">Generating tags...</div>';
  }
};
window._electronRealEventHandlers['start-batch-tag-generation'] = function(count, filePaths) {
  var dialog = document.getElementById('tag-preview-dialog');
  if (dialog && !dialog.open) {
    dialog.showModal();
    var container = document.getElementById('tag-preview-container');
    if (container) container.innerHTML = '<div style="padding: 20px; color: #fff;">Generating tags for ' + (count || 0) + ' model(s)...</div>';
  }
};

// Add debug logging utility function
function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

// Above this many scan hits without thumbnails, skip bulk scan-time rendering; grid queues thumbs when cells mount.
const DEFER_SCAN_BATCH_THUMBNAILS_THRESHOLD = 80;

let BATCH_SIZE = 50; // Default batch size for database operations
let MAX_FILE_SIZE_MB = 50; // Default max file size in MB
/** Called by the Performance Settings screen (React) after it saves maxFileSizeMB. */
window.applyMaxFileSizeMB = function applyMaxFileSizeMB(mb) {
  MAX_FILE_SIZE_MB = mb;
};
const THUMBNAIL_BATCH_SIZE = 10; // Default batch size for thumbnails
// Higher concurrency in Server/Docker mode to compensate for slower file system operations
// Docker file system operations (especially on network shares) can be 10-100ms per operation
// vs <1ms for local file systems, so we need more parallel operations to maintain throughput
let MAX_CONCURRENT_RENDERS = 5; // Default value, will be adjusted based on mode

let currentGridView = 'detailed'; // Current grid view mode: 'list', 'preview', 'detailed'

/** Preview wall tile size: small / medium / large (persisted as previewTileSize). */
let currentPreviewTileSize = 'm';
const PREVIEW_TILE_PX = { s: 140, m: 180, l: 240 };

function mobileLibraryColumns() {
  if (!document.body?.classList.contains('mobile-ui')) return 0;
  if (document.body.classList.contains('mobile-ui-wide')) return 3;
  if (window.matchMedia('(orientation: landscape)').matches) return 3;
  return 2;
}

function getPreviewTileSizePx() {
  const grid = document.querySelector('.file-grid');
  if (
    currentGridView === 'preview' &&
    grid &&
    typeof grid._previewTilePx === 'number' &&
    grid._previewTilePx > 0
  ) {
    return grid._previewTilePx;
  }
  return PREVIEW_TILE_PX[currentPreviewTileSize] || PREVIEW_TILE_PX.m;
}

// Per-folder view preference (when "View Entire Library" is off): remember list/preview/detailed per scanned root
async function getPerFolderViewPrefs() {
  try {
    const raw = await window.electron.getSetting('perFolderView');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function getViewForFolder(folderPath) {
  if (!folderPath) return null;
  const prefs = await getPerFolderViewPrefs();
  if (prefs[folderPath] && ['list', 'preview', 'detailed'].includes(prefs[folderPath])) {
    return prefs[folderPath];
  }
  const lastUsed = await window.electron.getSetting('lastUsedView');
  if (lastUsed && ['list', 'preview', 'detailed'].includes(lastUsed)) return lastUsed;
  const globalView = await window.electron.getSetting('gridView');
  if (globalView && ['list', 'preview', 'detailed'].includes(globalView)) return globalView === 'small' ? 'preview' : globalView;
  return 'detailed';
}

async function savePerFolderView(folderPath, view) {
  if (!folderPath || !['list', 'preview', 'detailed'].includes(view)) return;
  const prefs = await getPerFolderViewPrefs();
  prefs[folderPath] = view;
  await window.electron.saveSetting('perFolderView', JSON.stringify(prefs));
  await window.electron.saveSetting('lastUsedView', view);
}

async function applyViewForCurrentFolder() {
  const folder = window.currentDirectoryFilter;
  if (!folder) return;
  const view = await getViewForFolder(folder);
  if (!view || view === currentGridView) return;
  currentGridView = view;
  const viewButtons = document.querySelectorAll('.view-button');
  viewButtons.forEach(btn => btn.classList.remove('active'));
  viewButtons.forEach(button => {
    if (button.dataset.view === currentGridView) button.classList.add('active');
  });
  updateListViewColumnsToolbarButton();
}

window.savePerFolderView = savePerFolderView;
window.applyViewForCurrentFolder = applyViewForCurrentFolder;

function persistGridViewPreference(view) {
  if (!window.electron?.saveSetting) return;
  window.electron.saveSetting('gridView', view).catch((err) => {
    console.warn('save gridView:', err);
  });
  if (!window.viewingEntireLibrary && window.currentDirectoryFilter && typeof window.savePerFolderView === 'function') {
    window.savePerFolderView(window.currentDirectoryFilter, view).catch((err) => {
      console.warn('save perFolderView:', err);
    });
  }
}

/** Re-show the grid from models already loaded (view or tile size changed). False when there are none. */
function rebuildVirtualGridFromCache(container, cachedModels) {
  if (typeof closeListViewColumnsPopover === 'function') {
    closeListViewColumnsPopover();
  }
  if (container) container.currentModels = null;
  if (cachedModels && cachedModels.length > 0) {
    renderVirtualGrid(cachedModels);
    return true;
  }
  return false;
}


const DEFAULT_SORT = 'dateAdded DESC'; // Show newest models by default

// RENDER_DELAY is already declared later in the file
let currentBatch = 0;
let isRendering = false;
// The selection is window.selection (src/web/selection.ts); cards and the multi-edit panel follow it.
let isMultiSelectMode = false;
let isScanning = false;

// Scan STL Home (the sidebar button, src/web/filters/SidebarActions.tsx).
function runScanSTLHomeImpl() {
  console.log('[Scan STL Home] runScanSTLHome entered');
  if (isScanning) {
    console.log('[Scan STL Home] skipped - already scanning');
    return;
  }
  (async () => {
    const stlHomes = await getStlHomeDirectories();
    if (!stlHomes.length) {
      console.log('[Scan STL Home] no path set');
      if (window.electron && typeof window.electron.showMessage === 'function') {
        await window.electron.showMessage('STL Home', 'Set STL Home directories in Settings first (Settings → STL Home).');
      }
      return;
    }
    console.log('[Scan STL Home] starting scan:', stlHomes.join(', '));
    await window.electron.saveDirectory(stlHomes[0]);
    const clearFilterButton = document.querySelector('.clear-filter-button');
    if (clearFilterButton) {
      clearFilterButton.click();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    window.sidebarStatus?.setScanning(true);
    isScanning = true;
    showProgressBars();
    let lastScanProcessed = 0;
    window.electron.onScanProgress((progress) => {
      const processedRaw = typeof progress?.processed === 'number' ? progress.processed : 0;
      lastScanProcessed = Math.max(lastScanProcessed, processedRaw);
      const percent = progress.total ? (lastScanProcessed / progress.total) * 100 : 0;
      const progressBar = document.getElementById('progress-bar');
      const progressText = document.getElementById('progress-text');
      if (progressBar) progressBar.style.width = `${percent}%`;
      if (progressText) progressText.textContent = `Checking files: ${lastScanProcessed}`;
    });
    window.electron.onDbProgress((progress) => {
      if (window._scanThumbnailProgress) return; // Thumbnail phase drives progress so bar stays in sync with renders
      const percent = progress.total ? (progress.processed / progress.total) * 100 : 0;
      const renderProgressBar = document.getElementById('render-progress-bar');
      const renderProgressText = document.getElementById('render-progress-text');
      if (renderProgressBar) renderProgressBar.style.width = `${percent}%`;
      if (renderProgressText) renderProgressText.textContent = progress.processed + ' / ' + (progress.total || 0);
    });
    try {
      let skippedDueToSize = 0;
      for (const stlHomeDir of stlHomes) {
        const scanInfo = await scanAndRenderDirectory(stlHomeDir, false, true, { suppressSizeNotice: true });
        skippedDueToSize += Number(scanInfo && scanInfo.skippedDueToSize) || 0;
      }
      await maybeShowSkippedFileSizeNotice(skippedDueToSize);
      await populateDesignerDropdown();
      await populateParentModelFilter();
      await populateTagFilter();
      await populateLicenseFilter();
      console.log('[Scan STL Home] scan complete');
    } catch (err) {
      console.error('[Scan STL Home] scan error:', err);
      if (window.electron && typeof window.electron.showMessage === 'function') {
        await window.electron.showMessage('Scan STL Home Error', err.message || String(err));
      }
    } finally {
      isScanning = false;
      window.sidebarStatus?.setScanning(false);
      const progressSection = document.getElementById('progress-section');
      if (progressSection) progressSection.classList.add('hidden');
      // Force grid to refetch and re-render so models show without reload (Docker/server)
      window.disableGridRefresh = false;
      const gridEl = document.querySelector('.file-grid');
      if (gridEl) gridEl.currentModels = null;
      if (typeof window.forceGridRefresh === 'function') {
        window.forceGridRefresh().catch(err => console.error('[Scan STL Home] post-scan refresh:', err));
      } else if (typeof window.performCombinedSearch === 'function') {
        window.performCombinedSearch().catch(err => console.error('[Scan STL Home] post-scan refresh:', err));
      }
    }
  })();
}
window.runScanSTLHome = runScanSTLHomeImpl;

// Add these queue-related variables
let renderQueue = [];
/** Lower values run first. Scan / off-grid work uses THUMB_PRIORITY_BACKGROUND so on-screen grid cells win. */
const THUMB_PRIORITY_BACKGROUND = 1e12;
/** Priorities at or above this are off-viewport grid rows (see computeThumbPriorityForScroll / refresh). */
const THUMB_PRIORITY_LOW_TIER_MIN = 2e9;
/** Extra delay after each low-priority render so visible/interactive work stays smooth. */
let RENDER_DELAY_BACKGROUND = 750;
/** When the queue has only off-screen work, cap parallel WebGL thumbs (foreground uses MAX_CONCURRENT_RENDERS). */
let MAX_CONCURRENT_RENDERS_BACKGROUND = 2;
let pendingThumbnails = new Set(); // Track files currently being rendered
/** Paths with an in-flight WebGL/extract job (dequeued). Kept separate so prune cannot clear pending and allow a duplicate concurrent render. */
let activeThumbnailRenders = new Set();
/** Soft cap so fast scrolling cannot enqueue thousands of 3MF extract/WebGL jobs. */
const RENDER_QUEUE_SOFT_CAP = 120;

function isBenignThumbnailDropError(error) {
  const msg = (error && error.message) ? String(error.message) : String(error || '');
  return /Render task pruned \(cell scrolled off-screen\)|Render task dropped \(queue soft cap\)/.test(msg)
    || !!(error && error.benignThumbnailDrop);
}

function dropRenderTask(task, reason) {
  if (!task) return;
  // Only free the pending slot when nothing is actively rendering this path.
  // Otherwise a virtual-grid rebuild can re-enqueue the same file mid-render.
  if (task.filePath && !activeThumbnailRenders.has(task.filePath)) {
    pendingThumbnails.delete(task.filePath);
  }
  // Scan/bulk waiters must not hang forever if a task is discarded.
  if (typeof task.reject === 'function') {
    try {
      const err = new Error(reason || 'Render task dropped');
      err.benignThumbnailDrop = true;
      task.reject(err);
    } catch (_) { /* already settled */ }
  }
  // Soft-cap / prune often leaves a still-visible cell on 3d.png — re-hydrate next frame.
  scheduleVisibleThumbnailHydrate();
}

let _visibleThumbHydrateTimer = null;
function scheduleVisibleThumbnailHydrate() {
  if (_visibleThumbHydrateTimer != null) return;
  _visibleThumbHydrateTimer = setTimeout(() => {
    _visibleThumbHydrateTimer = null;
    const grid = document.querySelector('.file-grid');
    if (grid && typeof grid.renderVisibleItemsFn === 'function') {
      try {
        grid.renderVisibleItemsFn();
      } catch (_) { /* ignore */ }
    }
  }, 50);
}

function findQueuedThumbnailTask(filePath) {
  if (!filePath) return null;
  for (let i = 0; i < renderQueue.length; i++) {
    const task = renderQueue[i];
    if (task && task.filePath === filePath && !task.retainDetached) return task;
  }
  return null;
}

function enqueueRenderTask(task) {
  if (!task || !task.filePath) return false;
  pruneDisconnectedRenderTasks();
  if (renderQueue.length >= RENDER_QUEUE_SOFT_CAP) {
    // Drop lowest-priority (usually off-screen) tasks first.
    // Never soft-cap-drop scan/bulk jobs that intentionally use detached containers.
    renderQueue.sort((a, b) => (a.thumbPriority ?? 1e9) - (b.thumbPriority ?? 1e9));
    while (renderQueue.length >= RENDER_QUEUE_SOFT_CAP) {
      let dropIdx = -1;
      for (let i = renderQueue.length - 1; i >= 0; i--) {
        if (!renderQueue[i]?.retainDetached) {
          dropIdx = i;
          break;
        }
      }
      if (dropIdx < 0) break;
      const dropped = renderQueue.splice(dropIdx, 1)[0];
      dropRenderTask(dropped, 'Render task dropped (queue soft cap)');
    }
  }
  renderQueue.push(task);
  return true;
}

function isLowPriorityThumbnailTask(task) {
  const p = task?.thumbPriority ?? THUMB_PRIORITY_BACKGROUND;
  return p >= THUMB_PRIORITY_LOW_TIER_MIN;
}

function renderQueueHasOnlyLowPriorityWork() {
  if (renderQueue.length === 0) return false;
  return renderQueue.every(isLowPriorityThumbnailTask);
}

function effectiveMaxConcurrentRenders() {
  // While a Docker/server bulk thumb job runs in the hidden window, pause grid
  // WebGL renders so scrolling does not OOM the shared Electron process.
  if (window._serverBulkThumbnailJobActive) {
    return 0;
  }
  return renderQueueHasOnlyLowPriorityWork()
    ? Math.min(MAX_CONCURRENT_RENDERS, MAX_CONCURRENT_RENDERS_BACKGROUND)
    : MAX_CONCURRENT_RENDERS;
}

function refreshThumbnailQueuePriorities() {
  const grid = document.querySelector('.file-grid');
  if (!grid || renderQueue.length === 0) return;
  const gr = grid.getBoundingClientRect();
  const vh = grid.clientHeight;
  const NEAR = 80;
  for (const task of renderQueue) {
    if (!task || !task.container) continue;
    if (!task.container.isConnected) continue;
    const tr = task.container.getBoundingClientRect();
    const relTop = tr.top - gr.top;
    const relBottom = tr.bottom - gr.top;
    if (relBottom < -NEAR) task.thumbPriority = 3e9 + relTop;
    else if (relTop > vh + NEAR) task.thumbPriority = 2e9 + relTop;
    else task.thumbPriority = relTop;
  }
}

function pruneDisconnectedRenderTasks() {
  if (renderQueue.length === 0) return 0;
  let removed = 0;
  for (let i = renderQueue.length - 1; i >= 0; i--) {
    const task = renderQueue[i];
    // Scan / foreground batch thumbs use a detached dummy container on purpose.
    // Only prune scroll-hydrate jobs whose grid cell left the DOM (2.1.17 Docker fix).
    if (task?.retainDetached) continue;
    if (task?.container && !task.container.isConnected) {
      renderQueue.splice(i, 1);
      dropRenderTask(task, 'Render task pruned (cell scrolled off-screen)');
      removed++;
    }
  }
  return removed;
}

function dequeueNextRenderTask() {
  pruneDisconnectedRenderTasks();
  if (renderQueue.length === 0) return null;
  if (renderQueue.length === 1) return renderQueue.shift();
  let minIdx = 0;
  let minP = renderQueue[0].thumbPriority ?? THUMB_PRIORITY_BACKGROUND;
  for (let i = 1; i < renderQueue.length; i++) {
    const p = renderQueue[i].thumbPriority ?? THUMB_PRIORITY_BACKGROUND;
    if (p < minP) {
      minP = p;
      minIdx = i;
    }
  }
  return renderQueue.splice(minIdx, 1)[0];
}
// When set during scan, any thumbnail completion (scan or grid) increments progress so bar stays in sync with visible renders
window._scanThumbnailProgress = null;
let activeRenders = 0;
let isProcessingQueue = false;

// Add these at the top of the file
let isScanCancelled = false;
let isRenderCancelled = false;
let isBackgrounded = false;

// Add these at the top with other global variables
let RENDER_DELAY = 200; // Increase delay between renders to 200ms
let autoStartedRendering = false;
let thumbnailCache = new Map();
let renderContext = null;


// Define loadModel function at top level so it's available immediately (before DOMContentLoaded)
// Helper function to parse zip path format
function parseZipPath(filePath) {
  if (filePath.includes('::')) {
    const [zipPath, entryPath] = filePath.split('::');
    return { zipPath, entryPath, isZipEntry: true };
  }
  return { zipPath: filePath, entryPath: null, isZipEntry: false };
}


// Extensions that are valid for library (scan/add). Used for isValidFile.
const EXTENSIONS_VALID_FOR_LIBRARY = new Set(['.stl', '.3mf', '.3ds', '.amf', '.blender', '.chitubox', '.dae', '.dxf', '.dwg', '.fbx', '.f3d', '.f3z', '.gcode', '.igs', '.iges', '.lys', '.lyt', '.obj', '.ply', '.step', '.stp', '.svg', '.voxl', '.x3d']);

function isRenderable3dExtension(extension) {
  const ext = (extension || '').toLowerCase().replace(/^\./, '');
  return ext === 'stl' || ext === '3mf' || ext === 'obj' || ext === 'ply'
    || ext === 'step' || ext === 'stp' || ext === 'lys' || ext === 'igs' || ext === 'iges';
}

// Map file extension (with or without dot) to label for typed placeholder
const EXTENSION_TO_PLACEHOLDER_LABEL = {
  '3ds': '3DS', 'amf': 'AMF', 'blender': 'Blender', 'dae': 'DAE', 'dxf': 'DXF', 'dwg': 'DWG',
  'fbx': 'FBX', 'f3d': 'F3D', 'f3z': 'F3Z', 'chitubox': 'ChiTuBox', 'gcode': 'G-code', 'igs': 'IGES', 'iges': 'IGES',
  'lys': 'LYS', 'lyt': 'LYT', 'obj': 'OBJ', 'ply': 'PLY', 'step': 'STEP', 'stp': 'STEP', 'svg': 'SVG', 'voxl': 'VOXL', 'x3d': 'X3D'
};

function generateTypedPlaceholder(extension) {
  const ext = (extension || '').toLowerCase().replace(/^\./, '');
  const label = EXTENSION_TO_PLACEHOLDER_LABEL[ext] || (ext ? ext.toUpperCase() : '?');
  const size = 250;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '3d.png';
  // Dark background similar to 3d.png style
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, size / 2, size / 2);
  try {
    return canvas.toDataURL('image/png');
  } catch (e) {
    return '3d.png';
  }
}

function generateCorruptedPlaceholder() {
  const size = 250;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '3d.png';
  const bg = (typeof getComputedStyle !== 'undefined' && document.documentElement
    ? getComputedStyle(document.documentElement).getPropertyValue('--model-background-color').trim()
    : '') || '#070147';
  ctx.fillStyle = bg || '#070147';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255, 120, 100, 0.95)';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Model may be', size / 2, size / 2 - 14);
  ctx.fillText('corrupted', size / 2, size / 2 + 10);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '12px sans-serif';
  ctx.fillText('(could not load)', size / 2, size / 2 + 32);
  try {
    return canvas.toDataURL('image/png');
  } catch (e) {
    return '3d.png';
  }
}

/** True for failure art that must not be persisted (keeps hasThumbnail=0 so Docker can retry). */
function isFailurePlaceholderThumbnail(thumb) {
  if (!thumb || thumb === '3d.png') return true;
  if (typeof thumb !== 'string' || !thumb.startsWith('data:image')) return false;
  try {
    if (thumb === generateCorruptedPlaceholder()) return true;
    // Bulk-gen used to save typed STL/3MF/OBJ placeholders "to prevent future attempts"
    for (const ext of ['stl', '3mf', 'obj', 'ply', 'step', 'stp', 'lys', 'lyt', 'igs', 'iges', 'f3d', 'chitubox', 'voxl', 'svg', 'f3z']) {
      if (thumb === generateTypedPlaceholder(ext)) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

/**
 * Image-only formats (f3d / chitubox / voxl) that already failed embedded-preview extract.
 * Mesh render cannot produce a thumb — without this, returning 3d.png + scheduleVisibleThumbnailHydrate
 * re-queues forever (DevTools shows renderModelToPNG Start ×N).
 */
const IMAGE_ONLY_PREVIEW_MISS = new Set();

function markImageOnlyPreviewMiss(filePath) {
  const key = normalizeThumbCacheKey(filePath);
  if (key) IMAGE_ONLY_PREVIEW_MISS.add(key);
}

function hasImageOnlyPreviewMiss(filePath) {
  const key = normalizeThumbCacheKey(filePath);
  return !!(key && IMAGE_ONLY_PREVIEW_MISS.has(key));
}

function extensionFromModelPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const pathPart = filePath.includes('::') ? filePath.split('::')[1] : filePath;
  const base = pathPart.split(/[/\\]/).pop() || pathPart;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Primary thumbnail cache for grid cells (path -> data URL | null).
 * Grid must never call getAllThumbnails — only the default thumb for visible rows.
 * Cap keeps memory bounded for huge libraries.
 */
const PRIMARY_THUMBNAIL_CACHE = new Map();
const PRIMARY_THUMBNAIL_CACHE_MAX = 800;

function normalizeThumbCacheKey(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  return typeof normalizePathForComparison === 'function'
    ? normalizePathForComparison(filePath)
    : filePath.replace(/\\/g, '/').toLowerCase();
}

function getCachedPrimaryThumbnail(filePath) {
  const key = normalizeThumbCacheKey(filePath);
  if (!key || !PRIMARY_THUMBNAIL_CACHE.has(key)) return undefined;
  return PRIMARY_THUMBNAIL_CACHE.get(key);
}

function setCachedPrimaryThumbnail(filePath, thumb) {
  const key = normalizeThumbCacheKey(filePath);
  if (!key) return;
  if (PRIMARY_THUMBNAIL_CACHE.size >= PRIMARY_THUMBNAIL_CACHE_MAX && !PRIMARY_THUMBNAIL_CACHE.has(key)) {
    const oldest = PRIMARY_THUMBNAIL_CACHE.keys().next().value;
    PRIMARY_THUMBNAIL_CACHE.delete(oldest);
  }
  PRIMARY_THUMBNAIL_CACHE.set(key, thumb || null);
}

function invalidatePrimaryThumbnailCache(filePath = null) {
  if (!filePath) {
    PRIMARY_THUMBNAIL_CACHE.clear();
    return;
  }
  PRIMARY_THUMBNAIL_CACHE.delete(normalizeThumbCacheKey(filePath));
}

/** Keep grid primary-thumb cache aligned with the DB default (first :: segment). */
function syncPrimaryThumbnailCacheFromThumbnailString(filePath, thumbnailString) {
  if (!filePath) return;
  invalidatePrimaryThumbnailCache(filePath);
  if (!thumbnailString || thumbnailString === '3d.png' || typeof thumbnailString !== 'string') {
    setCachedPrimaryThumbnail(filePath, null);
    return;
  }
  const parts = thumbnailString.includes('::')
    ? thumbnailString.split('::').filter(
        (t) => t && t !== '3d.png' && typeof t === 'string' && t.startsWith('data:image')
      )
    : thumbnailString.startsWith('data:image')
      ? [thumbnailString]
      : [];
  setCachedPrimaryThumbnail(filePath, parts[0] || null);
}

/** Load only the default/primary thumbnail for a grid cell (never getAllThumbnails). */
async function fetchPrimaryThumbnailForGrid(filePath) {
  if (!filePath || !window.electron?.getThumbnail) return null;
  const cached = getCachedPrimaryThumbnail(filePath);
  if (cached !== undefined) return cached;
  try {
    const thumb = await window.electron.getThumbnail(filePath);
    const valid =
      thumb &&
      thumb !== '3d.png' &&
      typeof thumb === 'string' &&
      thumb.startsWith('data:image') &&
      !isFailurePlaceholderThumbnail(thumb)
        ? thumb
        : null;
    if (valid && typeof isMostlyEmptyThumbnailDataUrl === 'function') {
      if (await isMostlyEmptyThumbnailDataUrl(valid)) {
        setCachedPrimaryThumbnail(filePath, null);
        return null;
      }
    }
    setCachedPrimaryThumbnail(filePath, valid);
    return valid;
  } catch (_) {
    return null;
  }
}

/** Only persist real renders — never corrupted/typed failure art. */
async function saveThumbnailIfReal(filePath, thumbnail) {
  if (!filePath || !thumbnail || thumbnail === '3d.png') return false;
  if (isFailurePlaceholderThumbnail(thumbnail)) return false;
  if (typeof isMostlyEmptyThumbnailDataUrl === 'function' && await isMostlyEmptyThumbnailDataUrl(thumbnail)) {
    return false;
  }
  await window.electron.saveThumbnail(filePath, thumbnail);
  invalidatePrimaryThumbnailCache(filePath);
  setCachedPrimaryThumbnail(filePath, thumbnail);
  return true;
}

const stepParseJobHandlers = new Map();
let sharedStepParseWorker = null;

function coerceModelArrayBuffer(raw) {
  if (!raw) return null;
  if (raw instanceof ArrayBuffer) return raw.byteLength ? raw : null;
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  }
  if (raw.buffer) {
    return raw.buffer.slice(raw.byteOffset || 0, (raw.byteOffset || 0) + (raw.byteLength || raw.length || 0));
  }
  return null;
}

async function readModelArrayBuffer(pathToRead) {
  if (typeof window.loadLibraryFileBuffer === 'function') {
    try {
      const buf = coerceModelArrayBuffer(await window.loadLibraryFileBuffer(pathToRead));
      if (buf) return buf;
    } catch (_) { /* try IPC */ }
  }
  if (window.electron && typeof window.electron.readModelFile === 'function') {
    try {
      return coerceModelArrayBuffer(await window.electron.readModelFile(pathToRead));
    } catch (_) { /* ignore */ }
  }
  return null;
}

async function collectStepAssemblyBuffers(rootPath, rootBuffer) {
  const list = window.StepAssembly && window.StepAssembly.listStepExternalFileNames;
  const sibling = window.StepAssembly && window.StepAssembly.siblingStepPath;
  if (typeof list !== 'function' || typeof sibling !== 'function' || !rootBuffer) return [];

  const maxFiles = 24;
  const visited = new Set();
  const leaves = [];

  async function walk(filePath, buffer) {
    if (!buffer || leaves.length >= maxFiles) return;
    const key = String(filePath).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const names = list(buffer);
    if (!names.length) {
      if (filePath !== rootPath) leaves.push(buffer);
      return;
    }
    for (const name of names) {
      if (leaves.length >= maxFiles) return;
      const childPath = sibling(filePath, name);
      if (!childPath) continue;
      const childBuf = await readModelArrayBuffer(childPath);
      if (!childBuf) continue;
      await walk(childPath, childBuf);
    }
  }

  await walk(rootPath, rootBuffer);
  return leaves;
}

function getSharedStepParseWorker() {
  if (sharedStepParseWorker) return sharedStepParseWorker;
  const worker = new Worker(window.parseWorkerUrl);
  worker.onmessage = function(e) {
    const handler = stepParseJobHandlers.get(e.data && e.data.id);
    if (handler) handler(e);
  };
  worker.onerror = function(error) {
    console.error('Shared STEP parse worker failed:', error.message);
    const pending = [...stepParseJobHandlers.entries()];
    stepParseJobHandlers.clear();
    try { worker.terminate(); } catch (_) { /* ignore */ }
    sharedStepParseWorker = null;
    pending.forEach(([id, handler]) => {
      try {
        handler({ data: { id, success: false, error: error.message || 'STEP worker failed' } });
      } catch (_) { /* ignore */ }
    });
  };
  sharedStepParseWorker = worker;
  return worker;
}

/**
 * Parse a model file in the parse worker. Resolves to { geometries, fileExtension } (plain
 * arrays per mesh), or null when the file has nothing to draw. The 3D preview (React,
 * src/web/preview/) and loadModel (thumbnails) each build three.js meshes from it.
 */
async function loadModelData(filePath, options = {}) {
  if (filePath && filePath.startsWith('url::')) {
    return null;
  }
  const startTime = Date.now();
  console.log(`[DEBUG] loadModel: Start loading ${filePath}`);
  try {
    console.log('loadModel: Starting for file:', filePath);
    
    // Check if this is a zip entry
    const pathInfo = parseZipPath(filePath);
    let actualFilePath = filePath;
    let tempFilePath = null;
    
    if (pathInfo.isZipEntry) {
      console.log(`[DEBUG] loadModel: Detected zip entry, extracting to temp file`);
      try {
        // Extract to temp file
        actualFilePath = await window.electron.extractModelFromZip(filePath);
        tempFilePath = actualFilePath;
        console.log(`[DEBUG] loadModel: Extracted to temp file: ${actualFilePath}`);
      } catch (error) {
        console.error(`[DEBUG] loadModel: Error extracting zip entry: ${error}`);
        throw new Error(`Failed to extract model from zip: ${error.message}`);
      }
    }
    
    const fileExtension = actualFilePath.split('.').pop().toLowerCase();

    // Standalone .zip (container only): no 3D model to load — treat like scan zip
    if (fileExtension === 'zip') {
      console.log(`[DEBUG] loadModel: Standalone .zip file, skipping 3D load`);
      return null;
    }
    
    // Only mesh-loadable types are rendered; other types use typed placeholders
    if (!isRenderable3dExtension(fileExtension)) {
      return null;
    }
    
    // For 3MF files, check for embedded images BEFORE 3D loading
    // NOTE: This is a safety check - renderModelToPNG should have already checked
    // and returned early if embedded images exist. This prevents unnecessary 3D loading.
    if (fileExtension === '3mf') {
      console.log(`[DEBUG] loadModel: Checking for embedded images in 3MF: ${actualFilePath}`);
      try {
        const images = await window.electron.get3MFImages(pathInfo.isZipEntry ? filePath : actualFilePath);
        if (images && images.length > 0) {
          console.log(`[DEBUG] loadModel: WARNING - Found embedded image in 3MF but loadModel was still called for ${filePath}`);
          console.log(`[DEBUG] loadModel: Returning null to skip 3D loading - embedded image should be used instead`);
          // Note: Temp file cleanup handled by OS
          // Return null to skip 3D loading - embedded image should be used instead
          return null;
        } else {
          console.log(`[DEBUG] loadModel: No embedded images found, proceeding with 3D loading for ${filePath}`);
        }
      } catch (imageError) {
        console.error(`[DEBUG] loadModel: Error checking for embedded image: ${imageError}`);
        // Continue with 3D loading if there's an error checking for images
      }
    }
    
    // Check if we're in server mode - use HTTP endpoint instead of file://
    const serverMode = await window.electron.isServerMode().catch(() => false);
    
    let encodedFilePath;
    
    // Check if this is a UNC path (works in both server and non-server mode)
    const isUncPath = actualFilePath.startsWith('\\\\') && !/^[A-Za-z]:/.test(actualFilePath);
    
    if (serverMode || isUncPath) {
      // In server mode, or for UNC paths in any mode, use HTTP endpoint
      // Encode the path for URL
      const encodedPath = encodeURIComponent(actualFilePath);
      // Use full URL for HTTP endpoint (Three.js loaders need absolute URLs)
      // In server mode (browser access), use current window origin
      // In non-server mode (Electron) with UNC paths, HTTP server runs on localhost:5000
      const serverPort = (await window.electron.getSetting('browserExtensionPort').catch(() => null)) || 5000;
      if (serverMode && window.location.origin && window.location.origin !== 'null' && window.location.origin !== 'file://') {
        // Server mode with browser access - use current origin
        encodedFilePath = `${window.location.origin}/api/file/${encodedPath}`;
      } else {
        // Electron mode with UNC paths - HTTP server runs on localhost:5000
        encodedFilePath = `http://localhost:${serverPort}/api/file/${encodedPath}`;
      }
      console.log(`loadModel: Using HTTP endpoint ${serverMode ? 'for server mode' : 'for UNC path'}:`, encodedFilePath);
      // In server mode, client paths (e.g. C:\ from extension) are not on the server; avoid loader error by checking first
      if (serverMode && /^[A-Za-z]:/.test(actualFilePath)) {
        try {
          const check = await fetch(encodedFilePath, { method: 'HEAD' });
          if (check.status === 404) {
            console.log('loadModel: File not on server (client path), skipping 3D load');
            return null;
          }
        } catch (e) { /* proceed to load */ }
      }
    } else if (/^[A-Za-z]:/.test(actualFilePath)) {
      // Check if we're running on Windows (starts with drive letter)
      // For Windows paths: 
      // 1. Convert backslashes to forward slashes
      // 2. Add file:/// protocol
      // 3. Properly encode special characters
      
      try {
        // First normalize the path to use forward slashes
        const normalizedPath = actualFilePath.replace(/\\/g, '/');
        
        // Create URL object for proper handling - this works better for Windows paths
        const fileUrl = new URL(`file:///${normalizedPath}`);
        
        // Get the properly encoded pathname from the URL
        encodedFilePath = fileUrl.href;
        
        // Explicitly handle hash character in path segments
        if (normalizedPath.includes('#')) {
          // Replace the hash character with its URL encoding (%23)
          // But ensure we don't double-encode anything
          encodedFilePath = encodedFilePath.replace(/#/g, '%23');
        }
        
        // Ensure other problematic characters are properly encoded
        encodedFilePath = encodedFilePath
          .replace(/\?/g, '%3F')
          .replace(/\s/g, '%20')
          .replace(/\(/g, '%28')
          .replace(/\)/g, '%29')
          .replace(/'/g, '%27')
          .replace(/\[/g, '%5B')
          .replace(/\]/g, '%5D');
      } catch (error) {
        console.error('Error creating URL from file path:', error);
        
        // Fallback method: direct string replacement
        const normalizedPath = actualFilePath.replace(/\\/g, '/');
        encodedFilePath = `file:///${normalizedPath}`
            .replace(/#/g, '%23')
            .replace(/\s/g, '%20');
      }
      
      console.log('loadModel: Encoded Windows path:', encodedFilePath);
    } else {
      // For non-Windows paths, use a direct encoding approach
      try {
        const normalizedPath = actualFilePath.replace(/\\/g, '/');
        
        // Simply replace problematic characters directly
        encodedFilePath = `file://${normalizedPath}`
            .replace(/#/g, '%23')
            .replace(/\s/g, '%20')
            .replace(/\(/g, '%28')
            .replace(/\)/g, '%29')
            .replace(/'/g, '%27')
            .replace(/\[/g, '%5B')
            .replace(/\]/g, '%5D');
      } catch (error) {
        console.error('Error encoding non-Windows file path:', error);
        // Super simple fallback
        encodedFilePath = `file://${actualFilePath.replace(/#/g, '%23')}`;
      }
      console.log('loadModel: Encoded Unix path:', encodedFilePath);
    }
    
    // If no embedded image found, proceed with 3D loading using Web Worker
    if (!isRenderable3dExtension(fileExtension)) {
      throw new Error(`Unsupported file type: ${fileExtension}`);
    }

    // Prefer HTTP /api/file (or /api/download for zip entries) so server-mode
    // WebSocket IPC does not base64 the entire STL/3MF. Fall back to IPC.
    let modelArrayBuffer = null;
    const loadBuffer = window.loadLibraryFileBuffer;
    if (typeof loadBuffer === 'function') {
      try {
        modelArrayBuffer = await loadBuffer(filePath);
      } catch (e) {
        console.warn('loadModel: loadLibraryFileBuffer failed, worker will use URL:', e);
      }
    } else if (window.electron && typeof window.electron.readModelFile === 'function') {
      try {
        const raw = await window.electron.readModelFile(filePath);
        if (raw) {
          if (raw instanceof ArrayBuffer) {
            modelArrayBuffer = raw;
          } else if (ArrayBuffer.isView(raw)) {
            modelArrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
          } else if (raw.buffer) {
            modelArrayBuffer = raw.buffer.slice(raw.byteOffset || 0, (raw.byteOffset || 0) + (raw.byteLength || raw.length || 0));
          }
        }
      } catch (e) {
        console.warn('loadModel: readModelFile failed, worker will use URL:', e);
      }
    }

    if (modelArrayBuffer && ArrayBuffer.isView(modelArrayBuffer)) {
      modelArrayBuffer = modelArrayBuffer.buffer.slice(
        modelArrayBuffer.byteOffset,
        modelArrayBuffer.byteOffset + modelArrayBuffer.byteLength
      );
    }
    if (modelArrayBuffer instanceof ArrayBuffer && modelArrayBuffer.byteLength > 0) {
      const copy = new ArrayBuffer(modelArrayBuffer.byteLength);
      new Uint8Array(copy).set(new Uint8Array(modelArrayBuffer));
      modelArrayBuffer = copy;
    }

    let stepExtraBuffers = [];
    if ((fileExtension === 'step' || fileExtension === 'stp') && modelArrayBuffer) {
      try {
        stepExtraBuffers = await collectStepAssemblyBuffers(filePath, modelArrayBuffer);
        if (stepExtraBuffers.length) {
          console.log(`[DEBUG] loadModel: STEP assembly resolved ${stepExtraBuffers.length} part file(s) for ${filePath}`);
        }
      } catch (assemblyError) {
        console.warn('loadModel: STEP assembly resolve failed:', assemblyError);
      }
    }

    return new Promise((resolve, reject) => {
      const reuseWorker = fileExtension === 'step' || fileExtension === 'stp'
        || fileExtension === 'igs' || fileExtension === 'iges';
      const worker = reuseWorker ? getSharedStepParseWorker() : new Worker(window.parseWorkerUrl);
      const jobId = Date.now().toString() + Math.random().toString();
      let settled = false;

      const cleanupJob = () => {
        if (reuseWorker) stepParseJobHandlers.delete(jobId);
      };

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        cleanupJob();
        if (!reuseWorker) {
          try { worker.terminate(); } catch (_) { /* ignore */ }
        }
        fn();
      };

      const handleMessage = function(e) {
        const data = e.data;
        if (data.id !== jobId) return;

        finish(() => {
          if (!data.success) {
            const errMsg = data.error || 'Unknown worker parse error';
            console.error('Worker error:', errMsg, filePath);
            if (tempFilePath) {
              window.electron.deleteTempFile?.(tempFilePath).catch(err => console.error(err));
            }
            reject(new Error(errMsg));
            return;
          }

          resolve({ geometries: data.geometries || [], fileExtension });
        });
      };

      if (reuseWorker) {
        stepParseJobHandlers.set(jobId, handleMessage);
      } else {
        worker.onmessage = handleMessage;
        worker.onerror = function(error) {
          console.error('Worker failed:', error.message, filePath);
          finish(() => {
            if (tempFilePath) {
              window.electron.deleteTempFile?.(tempFilePath).catch(err => console.error(err));
            }
            reject(error);
          });
        };
      }

      const payload = {
        id: jobId,
        fileExtension,
        url: encodedFilePath,
        arrayBuffer: modelArrayBuffer || undefined,
        extraBuffers: stepExtraBuffers.length ? stepExtraBuffers : undefined
      };
      const transfer = [];
      if (modelArrayBuffer && modelArrayBuffer instanceof ArrayBuffer) transfer.push(modelArrayBuffer);
      stepExtraBuffers.forEach((buf) => {
        if (buf instanceof ArrayBuffer) transfer.push(buf);
      });
      if (transfer.length) {
        worker.postMessage(payload, transfer);
      } else {
        worker.postMessage(payload);
      }
    }).finally(() => {
      const endTime = Date.now();
      console.log(`[DEBUG] loadModel: Finished loading ${filePath}. Took ${endTime - startTime}ms.`);
    });
  } catch (error) {
    console.error('loadModel error:', error);
    throw error;
  }
}

window.loadModelData = loadModelData;

// Add these variables at the top
let totalThumbnailsToGenerate = 0;
let generatedThumbnailsCount = 0;

// Add WebGL context management variables
const MAX_CONTEXT_REUSE_COUNT = 100; // Desktop default; server mode lowers this at init
let maxContextReuseCount = MAX_CONTEXT_REUSE_COUNT;

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

// Visible tiles only. Keyed by normalized path so updates do not scan every .file-item
// when the raw data-filepath string does not match the lookup path.
const fileItemByNormalizedPath = new Map();

function registerFileItemElement(element, filePath) {
  if (!element || element.nodeType !== 1 || !element.classList?.contains('file-item')) return;
  const raw = filePath || element.getAttribute('data-filepath') || element.dataset?.filepath || '';
  const key = normalizePathForComparison(raw);
  if (!key) return;
  const prevKey = element._normalizedFilePathKey;
  if (prevKey && prevKey !== key && fileItemByNormalizedPath.get(prevKey) === element) {
    fileItemByNormalizedPath.delete(prevKey);
  }
  const occupant = fileItemByNormalizedPath.get(key);
  if (occupant && occupant !== element && occupant._normalizedFilePathKey === key) {
    delete occupant._normalizedFilePathKey;
  }
  element._normalizedFilePathKey = key;
  fileItemByNormalizedPath.set(key, element);
}

function unregisterFileItemElement(element) {
  if (!element || element.nodeType !== 1) return;
  const key = element._normalizedFilePathKey
    || normalizePathForComparison(element.getAttribute?.('data-filepath') || element.dataset?.filepath || '');
  if (key && fileItemByNormalizedPath.get(key) === element) {
    fileItemByNormalizedPath.delete(key);
  }
  if (element._normalizedFilePathKey) delete element._normalizedFilePathKey;
}

function clearFileItemPathIndex() {
  fileItemByNormalizedPath.clear();
}

function findFileItemElement(filePath) {
  const key = normalizePathForComparison(filePath);
  if (!key) return null;
  const cached = fileItemByNormalizedPath.get(key);
  if (cached?.isConnected) {
    const currentKey = normalizePathForComparison(
      cached.getAttribute('data-filepath') || cached.dataset?.filepath || ''
    );
    if (currentKey === key) return cached;
  }
  if (cached) fileItemByNormalizedPath.delete(key);

  try {
    const exact = document.querySelector(`.file-item[data-filepath="${CSS.escape(filePath)}"]`);
    if (exact) {
      registerFileItemElement(exact, filePath);
      return exact;
    }
  } catch (e) {
    /* invalid path for selector */
  }
  return null;
}

function bindFileItemPathIndex(virtualContent) {
  if (!virtualContent || virtualContent._fileItemPathIndexBound) return;
  virtualContent._fileItemPathIndexBound = true;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node.nodeType === 1 && node.classList?.contains('file-item')) {
          unregisterFileItemElement(node);
        }
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && node.classList?.contains('file-item')) {
          registerFileItemElement(node);
        }
      }
    }
  });
  observer.observe(virtualContent, { childList: true });
  virtualContent.querySelectorAll(':scope > .file-item').forEach((el) => registerFileItemElement(el));
}

/**
 * Full parent directory path for a model file (or zip file's folder for zip entries).
 * Used for filtering and tooltips — always drive/UNC aware.
 * Drive-root files (e.g. E:\model.stl) return "E:\" so the removable drive is obvious.
 */
function getParentDirectoryFullPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  if (filePath.startsWith('url::')) return '';
  const pathForParent = filePath.includes('::') ? filePath.split('::')[0] : filePath;
  const lastSlash = Math.max(pathForParent.lastIndexOf('\\'), pathForParent.lastIndexOf('/'));
  if (lastSlash < 0) return '';
  // Keep the trailing separator for Windows drive roots ("E:\file" → "E:\") and Unix root ("/file" → "/").
  const parent = pathForParent.substring(0, lastSlash);
  if (/^[A-Za-z]:$/i.test(parent)) {
    return parent + (pathForParent[lastSlash] || '\\');
  }
  if (parent === '' && (pathForParent[lastSlash] === '/' || pathForParent[lastSlash] === '\\')) {
    return pathForParent[lastSlash];
  }
  return parent;
}

/**
 * Directory label shown in grid/list/details.
 * Prefer the full parent path (includes drive letter) so removable-drive scans
 * are not mistaken for similarly named folders on C:.
 * Zip entries: "<zipParent>\<zipName> → <entryFolder>".
 */
function getDirectoryDisplayLabel(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  if (filePath.startsWith('url::')) return 'Open in browser';
  if (filePath.includes('::')) {
    const [zipPath, entryPath] = filePath.split('::');
    const zipFileName = zipPath.split(/[/\\]/).pop() || zipPath;
    const zipParent = getParentDirectoryFullPath(zipPath);
    const entryDir = (entryPath || '').split(/[/\\]/).slice(0, -1).join('/') || 'root';
    const sep = zipPath.includes('\\') ? '\\' : '/';
    // Avoid double separators when zipParent is already a drive root ("E:\") or "/".
    const zipLabel = zipParent
      ? (zipParent.endsWith('\\') || zipParent.endsWith('/')
          ? `${zipParent}${zipFileName}`
          : `${zipParent}${sep}${zipFileName}`)
      : zipFileName;
    return `${zipLabel} → ${entryDir}`;
  }
  return getParentDirectoryFullPath(filePath);
}

/** Stable identity for grid rows: same file path = one row (handles duplicate DB ids). */
function getGridModelDedupeKey(model) {
  if (!model) return '';
  const pathNorm = normalizePathForComparison(model.filePath || '');
  if (pathNorm) return `p:${pathNorm}`;
  if (model.id != null && model.id !== '') return `id:${model.id}`;
  return '';
}

/** One row per filesystem / zip entry — duplicate DB rows share the same normalized path. */
function dedupeModelsForVirtualGrid(models) {
  if (!models || models.length < 2) return models || [];
  const seen = new Map();
  const out = [];
  for (const model of models) {
    if (!model) continue;
    const key = getGridModelDedupeKey(model);
    if (!key) {
      out.push(model);
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, model);
      out.push(model);
      continue;
    }
    const keeper = seen.get(key);
    const keepHasId = keeper && keeper.id != null && keeper.id !== '';
    const candHasId = model.id != null && model.id !== '';
    if (!keepHasId && candHasId) {
      const idx = out.indexOf(keeper);
      if (idx !== -1) out[idx] = model;
      seen.set(key, model);
    }
  }
  return out;
}

/** Drop expand state for parent groups that no longer have 2+ distinct files. */
function pruneParentModelExpandedGroups(models) {
  if (!parentModelExpandedGroups.size) return;
  const pathSets = new Map();
  for (const model of models || []) {
    const label = getParentModelGroupLabel(model);
    if (!label) continue;
    const gk = `parent:${getParentModelGroupKey(label)}`;
    const pathKey = normalizePathForComparison(model.filePath || '');
    if (!pathKey) continue;
    if (!pathSets.has(gk)) pathSets.set(gk, new Set());
    pathSets.get(gk).add(pathKey);
  }
  for (const key of [...parentModelExpandedGroups]) {
    const set = pathSets.get(key);
    if (!set || set.size < 2) {
      parentModelExpandedGroups.delete(key);
    }
  }
}

function pruneZipArchiveExpandedGroups(models) {
  if (!zipArchiveExpandedGroups.size) return;
  const pathSets = new Map();
  for (const model of models || []) {
    const parsed = parseZipPath(model?.filePath || '');
    if (!parsed.isZipEntry || !parsed.zipPath) continue;
    const gk = `zip:${normalizePathForComparison(parsed.zipPath)}`;
    if (!gk || gk === 'zip:') continue;
    const pathKey = normalizePathForComparison(model.filePath || '');
    if (!pathKey) continue;
    if (!pathSets.has(gk)) pathSets.set(gk, new Set());
    pathSets.get(gk).add(pathKey);
  }
  for (const key of [...zipArchiveExpandedGroups]) {
    const set = pathSets.get(key);
    if (!set || set.size < 2) {
      zipArchiveExpandedGroups.delete(key);
    }
  }
}

/** True when the model should show the "New" badge (SQLite 1, boolean, or string "1"). */
function isModelNew(model) {
  if (!model) return false;
  const v = model.isNew;
  return v === 1 || v === true || v === '1';
}

function deriveBundleFieldsForModel(model) {
  const filePath = model?.filePath || '';
  if (!filePath || filePath.startsWith('url::')) {
    return { bundleKey: '', bundleLabel: '', bundleKind: '' };
  }
  // Only ZIP archive entries are bundled; plain directory siblings stay individual.
  if (!filePath.includes('::')) {
    return { bundleKey: '', bundleLabel: '', bundleKind: '' };
  }
  const zipPath = filePath.split('::')[0];
  const normalized = normalizePathForComparison(zipPath).toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const label = parts.length ? parts[parts.length - 1] : zipPath;
  return { bundleKey: `zip:${normalized}`, bundleLabel: label, bundleKind: 'zip' };
}

function isZipBundleModel(model) {
  const kind = String(model?.bundleKind || '').trim().toLowerCase();
  if (kind === 'zip') return true;
  if (kind === 'folder') return false;
  const key = String(model?.bundleKey || '').trim().toLowerCase();
  if (key.startsWith('zip:')) return true;
  if (key.startsWith('folder:')) return false;
  const filePath = model?.filePath || '';
  return Boolean(filePath.includes('::') && !filePath.startsWith('url::'));
}

function getBundleGroupLabel(model) {
  if (!isZipBundleModel(model)) return '';
  if (model?.bundleLabel) return String(model.bundleLabel).trim();
  return deriveBundleFieldsForModel(model).bundleLabel;
}

function getBundleGroupKey(model) {
  if (!isZipBundleModel(model)) return '';
  if (model?.bundleKey) return String(model.bundleKey).trim().toLowerCase();
  return deriveBundleFieldsForModel(model).bundleKey;
}

function pruneBundleExpandedGroups(models) {
  if (!bundleExpandedGroups.size) return;
  const pathSets = new Map();
  for (const model of models || []) {
    const bundleKey = getBundleGroupKey(model);
    if (!bundleKey) continue;
    const gk = `bundle:${bundleKey}`;
    const pathKey = normalizePathForComparison(model.filePath || '');
    if (!pathKey) continue;
    if (!pathSets.has(gk)) pathSets.set(gk, new Set());
    pathSets.get(gk).add(pathKey);
  }
  for (const key of [...bundleExpandedGroups]) {
    const set = pathSets.get(key);
    if (!set || set.size < 2) {
      bundleExpandedGroups.delete(key);
    }
  }
}

/** Merge fresh model into virtual grid's currentModels when paths match (normalized). */
function mergeModelIntoGridCurrentModels(model) {
  const container = document.querySelector('.file-grid');
  if (!container || !container.currentModels || !model) return false;
  const target = normalizePathForComparison(model.filePath || '');
  if (!target) return false;
  const idx = container.currentModels.findIndex(m =>
    normalizePathForComparison(m.filePath || m.id || '') === target
  );
  if (idx === -1) return false;
  container.currentModels[idx] = model;
  invalidateVirtualGridLayoutCache(container);
  return true;
}


async function updateModelElement(filePath) {
  try {
    const model = await window.electron.getModel(filePath);
    if (!model) {
      console.warn('updateModelElement: Model not found for', filePath);
      return;
    }
    console.log('updateModelElement: Updating element for', filePath, 'with model data:', {
      designer: model.designer,
      source: model.source,
      parentModel: model.parentModel,
      license: model.license,
      tags: model.tags
    });

    // The sidebar filters (src/web/filters/store.ts). A quick check here; the next search decides exactly.
    const filters = window.libraryFilters?.state();
    const one = (list) => (Array.isArray(list) && list.length === 1 ? list[0] : '');
    const designer = one(filters?.designer);
    const license = one(filters?.license);
    const parentModel = one(filters?.parentModel);
    const printStatus = filters?.printed || 'all';
    const newStatus = filters?.isNew || 'all';
    const favoriteStatus = filters?.favorite || 'all';
    const ratingStatus = filters?.rating || 'all';
    const ratingMinStatus = filters?.ratingMin || 'all';
    const fileType = filters?.fileType || '';
    
    // Check if the model matches current filters
    let shouldBeVisible = true;
    
    if (designer) {
      if (designer === '__none__') {
        shouldBeVisible = !model.designer || model.designer.trim() === '';
      } else {
        shouldBeVisible = model.designer && 
          model.designer.trim().toLowerCase() === designer.trim().toLowerCase();
      }
    }
    
    if (shouldBeVisible && license) {
      if (license === '__none__') {
        shouldBeVisible = !model.license || model.license.trim() === '';
      } else {
        shouldBeVisible = model.license === license;
      }
    }
    
    if (shouldBeVisible && parentModel) {
      if (parentModel === '__none__') {
        shouldBeVisible = !model.parentModel || model.parentModel.trim() === '';
      } else {
        shouldBeVisible = model.parentModel === parentModel;
      }
    }
    
    if (shouldBeVisible && printStatus && printStatus !== 'all') {
      shouldBeVisible = window.PrintHistory
        ? window.PrintHistory.modelMatchesPrintFilter(model, printStatus)
        : (printStatus === 'printed' ? !!model.printed : printStatus === 'not-printed' ? !model.printed : true);
    }

    if (shouldBeVisible && newStatus === 'new') {
      shouldBeVisible = isModelNew(model);
    } else if (shouldBeVisible && newStatus === 'not-new') {
      shouldBeVisible = !isModelNew(model);
    }

    if (shouldBeVisible && favoriteStatus === 'favorited') {
      shouldBeVisible = Boolean(model.favorite);
    } else if (shouldBeVisible && favoriteStatus === 'not-favorited') {
      shouldBeVisible = !model.favorite;
    }

    const modelRating = normalizeModelRatingValue(model.rating);
    if (shouldBeVisible && ratingStatus === 'unrated') {
      shouldBeVisible = modelRating === 0;
    } else if (shouldBeVisible && ratingStatus !== 'all' && /^[1-5]$/.test(ratingStatus)) {
      shouldBeVisible = modelRating === parseInt(ratingStatus, 10);
    }

    if (shouldBeVisible && ratingMinStatus !== 'all' && /^[1-5]$/.test(ratingMinStatus)) {
      shouldBeVisible = modelRating >= parseInt(ratingMinStatus, 10);
    }
    
    // Check file type filter
    if (shouldBeVisible && fileType) {
      if (fileType.toLowerCase() === 'zip') {
        shouldBeVisible = model.filePath && model.filePath.includes('::');
      } else {
        const fileName = model.fileName || '';
        shouldBeVisible = fileName.toLowerCase().endsWith(`.${fileType.toLowerCase()}`);
      }
    }
    
    const container = document.querySelector('.file-grid');

    // No longer matches the filters: take it out of the grid.
    if (!shouldBeVisible) {
      if (isMultiSelectMode) window.selection.delete(filePath);
      if (container && Array.isArray(container.currentModels)) {
        const modelIndex = container.currentModels.findIndex(m =>
          (m.id || m.filePath) === (model.id || model.filePath)
        );
        if (modelIndex !== -1) {
          container.currentModels.splice(modelIndex, 1);
          if (container.currentModels.length > 0) {
            window.modelFieldAnalysis = analyzeModelFields(container.currentModels);
          }
        }
        updateModelCounts(container.currentModels.length);
      }
      refreshLibraryGrid();
      return;
    }

    // The React grid card draws from the model: update it and repaint.
    mergeModelIntoGridCurrentModels(model);
    refreshLibraryGrid();
  } catch (error) {
    console.error('Error updating model element:', error);
  }
}



// Move showModelDetails outside the DOMContentLoaded event listener
// Track the current model being displayed to prevent race conditions
let currentModelDetailsPath = null;
let currentModelDetailsAbort = false;
/** Show a model's path in the details panel; getCurrentModelFilePath() reads it back. */
function setDetailsPath(filePath) {
  const container = document.getElementById('path-tree-container');
  if (filePath) {
    container?.setAttribute('data-file-path', filePath);
    window.detailsPath?.show(filePath);
  } else {
    container?.removeAttribute('data-file-path');
    window.detailsPath?.clear();
  }
}

async function showModelDetails(filePath) {
  try {
    // A newer selection, a filter change or a deselect sets the abort flag or moves the path.
    currentModelDetailsAbort = true;
    currentModelDetailsPath = filePath;
    currentModelDetailsAbort = false;
    const isCurrent = () => !currentModelDetailsAbort && currentModelDetailsPath === filePath;

    debugLog('Showing model details for:', filePath);
    const model = await window.electron.getModel(filePath);
    if (!isCurrent() || !model) return;

    hideBundleDetailsPanel();

    const detailsPanel = document.getElementById('model-details');
    if (!detailsPanel) {
      console.error('Model details panel not found');
      return;
    }

    // Name, source, designer, parent model, license and tags are React (src/web/details/DetailsFields.tsx).
    window.detailsFields?.show(model);
    window.detailsFilaments?.show(model);

    setDetailsPath(model.filePath || '');

    window.detailsNotes?.show(model);

    if (window.PrintHistory) {
      await window.PrintHistory.populateDetails(model);
    }
    if (!isCurrent()) return;

    // Show the details panel
    detailsPanel.classList.remove('hidden');
    window.collapseSidebarFilters?.();
    requestAnimationFrame(() => {
      detailsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Hide multi-edit panel if it's open and clear its form fields
    const multiEditPanel = document.getElementById('multi-edit-panel');
    multiEditPanel.classList.add('hidden');
    clearMultiEditFormFields(); // Clear form fields when switching to single-edit mode

  } catch (error) {
    console.error('Error showing model details:', error);
  }
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

// Flag to prevent multiple thumbnail generation dialogs from showing
let isThumbnailDialogShowing = false;
// Flag to prevent multiple regenerate thumbnails dialogs from showing
let isRegeneratingThumbnails = false;
// Flag to prevent multiple clear-new-flag confirmations from showing
let isClearingNewFlags = false;

// Active browser-side waiter for a server/Docker bulk thumbnail job
let activeServerThumbnailJobWaiter = null;

function isServerThumbnailWorkerContext() {
  if (typeof window.electron?.isServerThumbnailWorker !== 'function') {
    return Promise.resolve(false);
  }
  return window.electron.isServerThumbnailWorker().catch(() => false);
}

function showBackgroundThumbnailProgress(text, percent) {
  const progressSection = document.getElementById('progress-section');
  const progressContainer = document.getElementById('progress-container');
  const renderProgressContainer = document.getElementById('render-progress-container');
  const renderProgressBar = document.getElementById('render-progress-bar');
  const renderProgressText = document.getElementById('render-progress-text');
  const stopButton = document.getElementById('stop-thumbnail-generation');
  if (!progressSection || !renderProgressBar || !renderProgressText) return;

  progressSection.classList.remove('hidden');
  if (renderProgressContainer) renderProgressContainer.classList.remove('hidden');
  if (progressContainer) progressContainer.classList.add('hidden');
  renderProgressBar.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  renderProgressText.textContent = text || 'Generating thumbnails in background...';
  if (stopButton) {
    stopButton.style.display = 'block';
    stopButton.onclick = () => {
      window.electron.cancelServerThumbnailJob().catch((err) => {
        console.warn('Failed to cancel background thumbnail job:', err);
      });
      renderProgressText.textContent = 'Stopping...';
      stopButton.disabled = true;
    };
    stopButton.disabled = false;
  }
}

function hideBackgroundThumbnailProgress() {
  const progressSection = document.getElementById('progress-section');
  const renderProgressContainer = document.getElementById('render-progress-container');
  const stopButton = document.getElementById('stop-thumbnail-generation');
  if (stopButton) {
    stopButton.style.display = 'none';
    stopButton.onclick = null;
    stopButton.disabled = false;
  }
  if (renderProgressContainer) renderProgressContainer.classList.add('hidden');
  if (progressSection) {
    const progressContainer = document.getElementById('progress-container');
    const scanVisible = progressContainer && !progressContainer.classList.contains('hidden');
    if (!scanVisible) progressSection.classList.add('hidden');
  }
}

async function refreshGridAfterBackgroundThumbnailJob() {
  try {
    if (typeof invalidatePrimaryThumbnailCache === 'function') {
      invalidatePrimaryThumbnailCache();
    }
    const sortSelect = document.getElementById('sort-select');
    if (typeof window.performCombinedSearch === 'function') {
      await window.performCombinedSearch();
    } else if (typeof renderFiles === 'function') {
      const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0);
      await renderFiles(models);
    }
  } catch (err) {
    console.warn('Failed to refresh grid after background thumbnail job:', err);
  }
}

/**
 * Browser clients in server mode: start a server-side job and mirror progress locally.
 * Desktop / non-server: returns null so callers fall back to local generation.
 * Resolves early with { backgrounded: true } if the user moves the job to the sidebar.
 */
async function startAndWatchServerThumbnailJob(mode, title) {
  const serverMode = await window.electron.isServerMode().catch(() => false);
  const isWorker = await isServerThumbnailWorkerContext();
  if (!serverMode || isWorker || typeof window.electron.startServerThumbnailJob !== 'function') {
    return null;
  }

  if (activeServerThumbnailJobWaiter) {
    throw new Error('A thumbnail job is already running');
  }

  const jobMode = mode === 'all' ? 'all' : 'missing';
  const overlay = window.ThumbnailProgress;
  const jobTitle = title || (jobMode === 'all' ? 'Regenerate Thumbnails' : 'Generate Missing Thumbnails');

  return new Promise(async (resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      settled: false,
      backgrounded: false,
      mode: jobMode,
      title: jobTitle,
      lastProcessed: 0,
      lastTotal: 0
    };
    activeServerThumbnailJobWaiter = waiter;
    window._serverBulkThumbnailJobActive = true;

    overlay?.show({
      title: jobTitle,
      phase: 'Starting on server...',
      cancellable: true,
      allowBackground: true
    });
    overlay?.onCancel(() => {
      window.electron.cancelServerThumbnailJob().catch((err) => {
        console.warn('Failed to cancel server thumbnail job:', err);
      });
    });
    overlay?.onBackground(() => {
      if (!activeServerThumbnailJobWaiter || activeServerThumbnailJobWaiter !== waiter) return;
      waiter.backgrounded = true;
      const total = waiter.lastTotal || 0;
      const processed = waiter.lastProcessed || 0;
      const percent = total > 0 ? Math.floor((processed / total) * 100) : 0;
      const label = total > 0
        ? `${jobTitle}: ${processed}/${total} (${percent}%)`
        : `${jobTitle}: running in background...`;
      showBackgroundThumbnailProgress(label, percent);
      overlay.hide();
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.resolve({ backgrounded: true, mode: jobMode });
      }
    });

    try {
      const start = await window.electron.startServerThumbnailJob({ mode: jobMode });
      if (!start || !start.success) {
        activeServerThumbnailJobWaiter = null;
        window._serverBulkThumbnailJobActive = false;
        hideBackgroundThumbnailProgress();
        overlay?.hide();
        reject(new Error((start && start.error) || 'Failed to start server thumbnail job'));
        return;
      }
    } catch (err) {
      activeServerThumbnailJobWaiter = null;
      window._serverBulkThumbnailJobActive = false;
      hideBackgroundThumbnailProgress();
      overlay?.hide();
      reject(err);
    }
  });
}

window._electronRealEventHandlers['thumbnail-job-progress'] = function(payload) {
  window._serverBulkThumbnailJobActive = true;
  const waiter = activeServerThumbnailJobWaiter;
  if (!waiter || !payload) return;

  if (typeof payload.processed === 'number') waiter.lastProcessed = payload.processed;
  if (typeof payload.total === 'number') waiter.lastTotal = payload.total;

  if (waiter.backgrounded) {
    const total = waiter.lastTotal || 0;
    const processed = waiter.lastProcessed || 0;
    const percent = total > 0 ? Math.floor((processed / total) * 100) : 0;
    const label = total > 0
      ? `${waiter.title}: ${processed}/${total} (${percent}%)`
      : (payload.phase || `${waiter.title}: running in background...`);
    showBackgroundThumbnailProgress(label, percent);
    return;
  }

  const overlay = window.ThumbnailProgress;
  if (!overlay) return;
  if (payload.phase) overlay.setPhase(payload.phase);
  if (typeof payload.total === 'number' && payload.total > 0) {
    overlay.update(payload.processed || 0, payload.total, payload.phase);
  } else if (payload.phase) {
    overlay.setIndeterminate(true);
    overlay.setPhase(payload.phase);
  }
};
if (window._electronPendingEvents['thumbnail-job-progress']) {
  window._electronPendingEvents['thumbnail-job-progress'].forEach((args) => {
    window._electronRealEventHandlers['thumbnail-job-progress'].apply(null, args);
  });
  delete window._electronPendingEvents['thumbnail-job-progress'];
}

window._electronRealEventHandlers['thumbnail-job-complete'] = function(result) {
  const waiter = activeServerThumbnailJobWaiter;
  activeServerThumbnailJobWaiter = null;
  window._serverBulkThumbnailJobActive = false;
  const wasBackgrounded = !!(waiter && waiter.backgrounded);

  hideBackgroundThumbnailProgress();
  if (typeof processRenderQueue === 'function' && renderQueue.length > 0) {
    setTimeout(() => processRenderQueue(), 100);
  }

  if (wasBackgrounded) {
    const cancelled = !!(result && result.cancelled);
    refreshGridAfterBackgroundThumbnailJob();
    window.electron.showMessage(
      waiter.title || 'Thumbnails',
      cancelled ? 'Thumbnail generation stopped.' : 'Thumbnail generation finished.'
    ).catch(() => {});
    return;
  }

  if (!waiter || waiter.settled) return;
  waiter.settled = true;
  const overlay = window.ThumbnailProgress;
  overlay?.complete(result && result.cancelled ? 'Stopped.' : 'Finished.');
  waiter.resolve(result || { success: true });
};
if (window._electronPendingEvents['thumbnail-job-complete']) {
  window._electronPendingEvents['thumbnail-job-complete'].forEach((args) => {
    window._electronRealEventHandlers['thumbnail-job-complete'].apply(null, args);
  });
  delete window._electronPendingEvents['thumbnail-job-complete'];
}

window._electronRealEventHandlers['thumbnail-job-error'] = function(payload) {
  const waiter = activeServerThumbnailJobWaiter;
  activeServerThumbnailJobWaiter = null;
  window._serverBulkThumbnailJobActive = false;
  const wasBackgrounded = !!(waiter && waiter.backgrounded);

  hideBackgroundThumbnailProgress();
  window.ThumbnailProgress?.hide();
  if (typeof processRenderQueue === 'function' && renderQueue.length > 0) {
    setTimeout(() => processRenderQueue(), 100);
  }

  const message = (payload && payload.error) || 'Server thumbnail job failed';
  if (wasBackgrounded) {
    window.electron.showMessage('Error', message).catch(() => {});
    return;
  }

  if (!waiter || waiter.settled) return;
  waiter.settled = true;
  waiter.reject(new Error(message));
};
if (window._electronPendingEvents['thumbnail-job-error']) {
  window._electronPendingEvents['thumbnail-job-error'].forEach((args) => {
    window._electronRealEventHandlers['thumbnail-job-error'].apply(null, args);
  });
  delete window._electronPendingEvents['thumbnail-job-error'];
}

// Hidden Electron window (--server): WebGL bulk thumbnail worker.
// Registered at top level so it still initializes if later DOMContentLoaded paths return early (e.g. TOS).
(function initServerThumbnailWorkerEarly() {
  const cancelRef = { cancelled: false };
  let workerBusy = false;

  async function waitForGenerateThumbnailsForModels(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 60000);
    while (typeof window.generateThumbnailsForModels !== 'function') {
      if (Date.now() > deadline) {
        throw new Error('Thumbnail generator not ready in server worker window');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return window.generateThumbnailsForModels;
  }

  window._electronRealEventHandlers['cancel-server-thumbnail-job'] = function() {
    cancelRef.cancelled = true;
  };
  if (window._electronPendingEvents['cancel-server-thumbnail-job']) {
    window._electronPendingEvents['cancel-server-thumbnail-job'].forEach((args) => {
      window._electronRealEventHandlers['cancel-server-thumbnail-job'].apply(null, args);
    });
    delete window._electronPendingEvents['cancel-server-thumbnail-job'];
  }

  window._electronRealEventHandlers['run-server-thumbnail-job'] = async function(payload) {
    const isWorker = await isServerThumbnailWorkerContext();
    if (!isWorker) return;
    if (workerBusy) {
      console.warn('[Server thumbnails] Ignoring job; worker already busy');
      return;
    }

    const mode = payload && payload.mode === 'all' ? 'all' : 'missing';
    workerBusy = true;
    cancelRef.cancelled = false;
    window._serverBulkThumbnailJobActive = true;

    try {
      const generateThumbnailsForModels = await waitForGenerateThumbnailsForModels();

      // Path-only worklist — never preload thousands of full model rows (OOM on large libs).
      let filePaths = [];
      if (mode === 'missing') {
        const without = await window.electron.getModelsWithoutThumbnails();
        filePaths = (without || []).map((m) => m.filePath).filter(Boolean);
      } else if (typeof window.electron.getAllModelReferences === 'function') {
        const refs = await window.electron.getAllModelReferences();
        filePaths = (refs || []).map((m) => m.filePath).filter(Boolean);
      } else {
        const all = await window.electron.getAllModels('date-desc', 0);
        filePaths = (all || []).map((m) => m.filePath).filter(Boolean);
      }

      const total = filePaths.length;
      await window.electron.reportServerThumbnailProgress({
        phase: total ? `Generating thumbnails for ${total} models...` : 'Nothing to generate',
        processed: 0,
        total,
        mode
      });

      if (cancelRef.cancelled) {
        await window.electron.reportServerThumbnailComplete({ cancelled: true, mode, count: 0 });
        return;
      }

      if (!total) {
        await window.electron.reportServerThumbnailComplete({ cancelled: false, mode, count: 0 });
        return;
      }

      // Small chunks keep peak RAM low; concurrency 1 avoids shared-WebGL races + OOM.
      const CHUNK_SIZE = 25;
      let cancelled = false;
      for (let offset = 0; offset < filePaths.length; offset += CHUNK_SIZE) {
        if (cancelRef.cancelled) {
          cancelled = true;
          break;
        }
        const chunkPaths = filePaths.slice(offset, offset + CHUNK_SIZE);
        const chunkModels = chunkPaths.map((filePath) => ({ filePath, hash: '' }));
        const result = await generateThumbnailsForModels(chunkModels, {
          headless: true,
          maxConcurrent: 1,
          cancelRef,
          mode,
          skipHash: true,
          progressOffset: offset,
          progressTotal: total,
          title: mode === 'all' ? 'Regenerate Thumbnails' : 'Generate Missing Thumbnails'
        });
        if (result && result.cancelled) {
          cancelled = true;
          break;
        }
        // Drop chunk references before next batch; yield so V8 can GC.
        chunkModels.length = 0;
        chunkPaths.length = 0;
        await new Promise((r) => setTimeout(r, 50));
        if (typeof gc === 'function') {
          try { gc(); } catch (_) { /* ignore */ }
        }
      }

      await window.electron.reportServerThumbnailComplete({
        cancelled: cancelled || cancelRef.cancelled,
        mode,
        count: total
      });
    } catch (error) {
      console.error('[Server thumbnails] Worker job failed:', error);
      try {
        await window.electron.reportServerThumbnailError({ message: error.message || String(error) });
      } catch (reportErr) {
        console.error('[Server thumbnails] Failed to report error:', reportErr);
      }
    } finally {
      workerBusy = false;
      cancelRef.cancelled = false;
      window._serverBulkThumbnailJobActive = false;
    }
  };
  if (window._electronPendingEvents['run-server-thumbnail-job']) {
    window._electronPendingEvents['run-server-thumbnail-job'].forEach((args) => {
      window._electronRealEventHandlers['run-server-thumbnail-job'].apply(null, args);
    });
    delete window._electronPendingEvents['run-server-thumbnail-job'];
  }

  isServerThumbnailWorkerContext().then((isWorker) => {
    if (isWorker) {
      console.log('[Server thumbnails] Hidden window worker handlers registered');
    }
  }).catch(() => {});
})();
/** Visible grid card for a model path. Map lookup; exact selector only if the tile was not indexed. */
function findVisibleFileItem(filePath) {
  return findFileItemElement(filePath);
}

function replaceVisibleGridModel(filePath, normalizedPath, updatedModel) {
  const container = document.querySelector('.file-grid');
  const fileItem = findVisibleFileItem(filePath, normalizedPath);
  if (!fileItem) return false;
  if (container?.currentModels) {
    const modelIndex = container.currentModels.findIndex(
      (m) => normalizePathForComparison(m.filePath) === normalizedPath
    );
    if (modelIndex >= 0) container.currentModels[modelIndex] = { ...updatedModel };
  }
  // The React grid card redraws from the updated model.
  if (container?.renderVisibleItemsFn) container.renderVisibleItemsFn();
  return true;
}

/** After reordering the default thumbnail, sync the virtual grid cell (same approach as thumbnail-deleted IPC). */
async function refreshGridModelAfterManageThumbnailsActiveChange(filePath) {
  await new Promise((r) => setTimeout(r, 200));
  try {
    const preservedDateAddedFilter = window.dateAddedFilter || window._lastDateAddedFilter;
    const normalizedPath = normalizePathForComparison(filePath);

    const updatedModel = await window.electron.getModel(filePath);
    if (!updatedModel) return;
    syncPrimaryThumbnailCacheFromThumbnailString(filePath, updatedModel.thumbnail);

    if (preservedDateAddedFilter) {
      if (updatedModel.dateAdded) {
        const modelDateAdded = new Date(updatedModel.dateAdded);
        const filterDate = new Date(preservedDateAddedFilter);
        if (modelDateAdded < filterDate) return;
      }
      window.dateAddedFilter = preservedDateAddedFilter;
      window._lastDateAddedFilter = preservedDateAddedFilter;

      replaceVisibleGridModel(filePath, normalizedPath, updatedModel);
      return;
    }

    if (replaceVisibleGridModel(filePath, normalizedPath, updatedModel)) return;

    if (typeof window.performCombinedSearch === 'function') {
      await window.performCombinedSearch();
    } else {
      const sortSelect = document.getElementById('sort-select');
      const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc');
      if (typeof renderFiles === 'function') await renderFiles(models);
    }
  } catch (err) {
    console.error('Error refreshing grid after active thumbnail change:', err);
    if (typeof window.performCombinedSearch === 'function') {
      await window.performCombinedSearch();
    }
  }
}

// Manage Thumbnails is React (src/web/ManageThumbnailsDialog.tsx); it redraws the card through this.
window.refreshModelThumbnails = refreshGridModelAfterManageThumbnailsActiveChange;

function safeShowModal(dialog) {
  if (!dialog) return false;
  try {
    if (dialog.open) return true;
    dialog.showModal();
    return true;
  } catch (err) {
    console.warn('showModal failed:', dialog.id || dialog, err);
    return dialog.open === true;
  }
}

function closeDialogSafe(dialog) {
  if (!dialog) return;
  try {
    if (dialog.open) dialog.close();
  } catch (_) { /* ignore */ }
}

let tosCheckPromise = null;

// Update the checkTermsOfService function to return a promise
async function checkTermsOfService() {
  if (tosCheckPromise) return tosCheckPromise;
  tosCheckPromise = (async () => {
  try {
    // Hidden server worker has no interactive UI; never block init on TOS.
    if (await isServerThumbnailWorkerContext()) {
      return true;
    }

    let tosAccepted = await window.electron.getSetting('tosAcceptedDate');
    const termsDialog = document.getElementById('terms-of-service-dialog');
    const acceptButton = document.getElementById('accept-terms');
    const declineButton = document.getElementById('decline-terms');

    if (!termsDialog || !acceptButton || !declineButton) {
      console.error('Terms of Service dialog elements not found');
      return false; // Return false if dialog elements are not found
    }

    if (!tosAccepted) {
      safeShowModal(termsDialog);
      
      return new Promise((resolve) => {
        const acceptHandler = async () => {
          // Remove event listeners first to prevent double-clicks
          acceptButton.removeEventListener('click', acceptHandler);
          declineButton.removeEventListener('click', declineHandler);
          
          // Save TOS acceptance to database
          await window.electron.saveSetting('tosAcceptedDate', new Date().toISOString());
          
          // Close the terms dialog so the document is no longer inert
          closeDialogSafe(termsDialog);
          
          resolve(true); // Resolve promise when accepted
        };

        const declineHandler = () => {
          acceptButton.removeEventListener('click', acceptHandler);
          declineButton.removeEventListener('click', declineHandler);
          closeDialogSafe(termsDialog);
          // Declining logs this browser out; the server keeps running for everyone else.
          if (typeof window.logOutOfServer === 'function') window.logOutOfServer();
          resolve(false); // Resolve promise when declined
        };

        acceptButton.addEventListener('click', acceptHandler);
        declineButton.addEventListener('click', declineHandler);
      });
    }
    closeDialogSafe(termsDialog);
    return true; // Return true if already accepted
  } catch (error) {
    console.error('Error checking Terms of Service:', error);
    closeDialogSafe(document.getElementById('terms-of-service-dialog'));
    return false; // Return false on error
  }
  })();
  return tosCheckPromise;
}

function parseStlHomeExcludeSetting(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const out = [];
    for (const item of parsed) {
      const p = String(item || '').trim();
      if (!p) continue;
      const key = p.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  } catch (err) {
    console.error('[STL Home] Invalid exclude list:', err);
    return [];
  }
}

function parseLegacyStlHomeSetting(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) return parseStlHomeExcludeSetting(text);
  if (/[\r\n,;]/.test(text)) {
    return parseStlHomeExcludeSetting(JSON.stringify(
      text.split(/[\r\n,;]+/).map((entry) => entry.trim()).filter(Boolean)
    ));
  }
  return [text];
}

async function getStlHomeDirectories() {
  const raw = await window.electron.getSetting('stlHomeDirectories');
  const fromList = parseStlHomeExcludeSetting(raw);
  if (fromList.length) return fromList;
  const legacy = await window.electron.getSetting('stlHome');
  return parseLegacyStlHomeSetting(legacy);
}
window.getStlHomeDirectories = getStlHomeDirectories;

// Extract 3MF thumbnail function - must be at top level for generateThumbnail to access
async function extract3MFThumbnail(filePath) {
  try {
    console.log(`[DEBUG] extract3MFThumbnail: Extracting images from ${filePath}`);
    const images = await window.electron.get3MFImages(filePath);
    if (images && images.length > 0) {
      console.log(`[DEBUG] extract3MFThumbnail: Found ${images.length} image(s) in 3MF file`);
      return images; // Return array of images
    } else {
      console.log(`[DEBUG] extract3MFThumbnail: No images found in 3MF file`);
      return null;
    }
  } catch (error) {
    console.error('extract3MFThumbnail error:', error);
    return null; // Or return null to indicate failure
  }
}

async function extractF3DThumbnail(filePath) {
  try {
    if (typeof window.electron.getF3DImages !== 'function') return null;
    console.log(`[DEBUG] extractF3DThumbnail: Extracting preview from ${filePath}`);
    const images = await window.electron.getF3DImages(filePath);
    if (images && images.length > 0) {
      console.log(`[DEBUG] extractF3DThumbnail: Found ${images.length} image(s) in F3D file`);
      return images;
    }
    console.log(`[DEBUG] extractF3DThumbnail: No preview found in F3D file`);
    return null;
  } catch (error) {
    console.error('extractF3DThumbnail error:', error);
    return null;
  }
}

async function extractEmbeddedPreviewImages(filePath, fileExtension, options) {
  const ext = (fileExtension || '').toLowerCase();
  if (ext === 'lys' && typeof window.electron.getLYSImages === 'function') {
    return window.electron.getLYSImages(filePath, options);
  }
  if (ext === 'f3d' && typeof window.electron.getF3DImages === 'function') {
    return window.electron.getF3DImages(filePath, options);
  }
  if (ext === 'chitubox' && typeof window.electron.getChituboxImages === 'function') {
    return window.electron.getChituboxImages(filePath, options);
  }
  if (ext === 'voxl' && typeof window.electron.getVoxlImages === 'function') {
    return window.electron.getVoxlImages(filePath, options);
  }
  if (ext === '3mf' && typeof window.electron.get3MFImages === 'function') {
    return window.electron.get3MFImages(filePath, options);
  }
  return null;
}

function isEmbeddedImagePreviewExt(extension) {
  const ext = (extension || '').toLowerCase().replace(/^\./, '');
  return ext === '3mf' || ext === 'lys' || ext === 'f3d' || ext === 'chitubox' || ext === 'voxl';
}

function isImageOnlyPreviewExt(extension) {
  const ext = (extension || '').toLowerCase().replace(/^\./, '');
  return ext === 'f3d' || ext === 'chitubox' || ext === 'voxl';
}

async function extractLYSThumbnail(filePath) {
  try {
    if (typeof window.electron.getLYSImages !== 'function') return null;
    console.log(`[DEBUG] extractLYSThumbnail: Extracting preview from ${filePath}`);
    const images = await window.electron.getLYSImages(filePath);
    if (images && images.length > 0) {
      console.log(`[DEBUG] extractLYSThumbnail: Found ${images.length} image(s) in LYS file`);
      return images;
    }
    console.log(`[DEBUG] extractLYSThumbnail: No preview found in LYS file`);
    return null;
  } catch (error) {
    console.error('extractLYSThumbnail error:', error);
    return null;
  }
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

  await loadListViewColumnStateFromStore();

  // Docker/Server: parallelize initial round-trips to reduce startup lag
  const [serverMode, hasRunBeforeVal, savedView] = await Promise.all([
    window.electron.isServerMode().catch(() => false),
    window.electron.getSetting('hasRunBefore'),
    window.electron.getSetting('gridView')
  ]);

  // After bridge is ready: show "Scan STL Home" when STL Home is set (Docker/server may set via env)
  if (typeof window.updateScanStlHomeButtonVisibility === 'function') {
    window.updateScanStlHomeButtonVisibility().catch(() => {});
  }

  // Docker/server: keep concurrency low — high parallelism + 30s IPC timeouts caused mass
  // "corrupted"/STL placeholders that then got persisted as permanent thumbs.
  // NVIDIA+ANGLE: parallel WebGL + compositor SharedImages tend to Skia-OOM the GPU process.
  if (serverMode) {
    let glBackend = 'unknown';
    try {
      const gpuInfo = typeof window.electron.getGpuInfo === 'function'
        ? await window.electron.getGpuInfo()
        : null;
      glBackend = (gpuInfo && gpuInfo.glBackend) || 'unknown';
    } catch (_) { /* ignore */ }
    if (glBackend === 'nvidia') {
      MAX_CONCURRENT_RENDERS = 1;
      MAX_CONCURRENT_RENDERS_BACKGROUND = 1;
      maxContextReuseCount = 25;
    } else {
      MAX_CONCURRENT_RENDERS = 3;
      MAX_CONCURRENT_RENDERS_BACKGROUND = 1;
      maxContextReuseCount = 40;
    }
    console.log(
      'Server mode detected: Capped MAX_CONCURRENT_RENDERS to',
      MAX_CONCURRENT_RENDERS,
      `(glBackend=${glBackend}, contextReuse=${maxContextReuseCount})`
    );
  }
  // Hidden worker window must not run grid WebGL at all (bulk job owns the GPU/CPU).
  if (await isServerThumbnailWorkerContext()) {
    MAX_CONCURRENT_RENDERS = 0;
    MAX_CONCURRENT_RENDERS_BACKGROUND = 0;
    window._serverBulkThumbnailJobActive = true;
    console.log('[Server thumbnails] Worker window: grid thumbnail renders disabled');
  }


  // Show the welcome dialog if this is the first run
  if (!hasRunBeforeVal) {
    const welcomeDialog = document.getElementById('welcome-message');
    if (welcomeDialog) {
      safeShowModal(welcomeDialog);
    }
    await window.electron.saveSetting('hasRunBefore', 'true');
  }

  // Load saved grid view preference
  if (savedView && ['list', 'preview', 'detailed'].includes(savedView)) {
    if (savedView === 'small') {
      currentGridView = 'preview';
    } else {
      currentGridView = savedView;
    }
  }

  try {
    const previewTileRaw = await window.electron.getSetting('previewTileSize');
    if (previewTileRaw && ['s', 'm', 'l'].includes(previewTileRaw)) {
      currentPreviewTileSize = previewTileRaw;
    }
  } catch (_) {
    /* ignore */
  }
  
  // Initialize view selector buttons
  const viewButtons = document.querySelectorAll('.view-button');
  // First, remove active class from all buttons
  viewButtons.forEach(btn => btn.classList.remove('active'));
  // Then, add active class only to the button matching the current view
  viewButtons.forEach(button => {
    const view = button.dataset.view;
    if (view === currentGridView) {
      button.classList.add('active');
    }
    button.addEventListener('click', async () => {
      if (view === currentGridView) return;
      const container = document.querySelector('.file-grid');
      // Capture current models BEFORE clearing so we can re-render without a round-trip (Docker/Server)
      const cachedModels = container?.currentModels ? [...container.currentModels] : null;

      // Remove active class from all buttons
      viewButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      currentGridView = view;
      updateListViewColumnsToolbarButton();
      // Persist in the background — Docker IPC await here left the old virtual grid
      // applying the new view to leftover list/preview cells (blank/huge tiles).
      persistGridViewPreference(view);

      if (rebuildVirtualGridFromCache(container, cachedModels)) return;
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch();
      } else {
        const sortSelect = document.getElementById('sort-select');
        const sortOption = sortSelect ? sortSelect.value : 'date-desc';
        const models = await window.electron.getAllModels(sortOption, 0);
        await renderFiles(models);
      }
    });
  });

  const listColsToolbarBtn = document.getElementById('list-view-columns-toolbar-btn');
  if (listColsToolbarBtn) {
    listColsToolbarBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleListViewColumnsPopover(listColsToolbarBtn);
    });
  }

  const previewSizeSwitcher = document.getElementById('preview-size-switcher');
  if (previewSizeSwitcher) {
    previewSizeSwitcher.querySelectorAll('[data-preview-size]').forEach((sizeBtn) => {
      sizeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const s = sizeBtn.dataset.previewSize;
        if (!s || s === currentPreviewTileSize) return;
        currentPreviewTileSize = s;
        syncPreviewSizeSwitcherActive();
        if (window.electron?.saveSetting) {
          window.electron.saveSetting('previewTileSize', s).catch((err) => {
            console.warn('save previewTileSize:', err);
          });
        }
        const grid = document.querySelector('.file-grid');
        const cached = grid?.currentModels ? [...grid.currentModels] : null;
        if (!rebuildVirtualGridFromCache(grid, cached) && typeof window.performCombinedSearch === 'function') {
          await window.performCombinedSearch();
        }
      });
    });
  }

  updateListViewColumnsToolbarButton();
  
  // The grid's image carousels save a pending default image themselves when the page closes (ModelCard.tsx).
  
  // Proceed to initialize the application
  // Update checks are handled in initializeApp() to avoid duplicates
  debugLog('DOM fully loaded and parsed');

  const fileGrid = document.querySelector('.file-grid');
  if (typeof bindGridBackgroundDeselect === 'function') {
    bindGridBackgroundDeselect();
  }
  const welcomeDialog = document.getElementById('welcome-message');

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
    } else {
      console.log('[DEBUG] No directory path set and not in server mode, showing welcome');
      if (welcomeDialog) {
        safeShowModal(welcomeDialog);
      }
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

  // Theme settings are React (src/web/ThemeSettingsDialog.tsx). After it saves, it applies the
  // theme with applyThemeColors and, when the model color or lighting changed, may call this.
  window.regenerateAllThumbnails = async function regenerateAllThumbnails() {
    const sortSelect = document.getElementById('sort-select');
    const allModels = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0);
    if (allModels.length === 0) return;
    const serverJob = await startAndWatchServerThumbnailJob('all', 'Regenerate Thumbnails');
    if (serverJob) {
      if (serverJob.backgrounded || serverJob.cancelled) return;
      invalidatePrimaryThumbnailCache();
      await window.electron.showMessage('Success', 'Thumbnail regeneration completed successfully.');
      await renderFiles(await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0));
      return;
    }
    window.ThumbnailProgress?.show({ title: 'Regenerate Thumbnails', phase: 'Clearing existing thumbnails...', cancellable: false });
    await window.electron.purgeThumbnails();
    invalidatePrimaryThumbnailCache();
    await generateThumbnailsForModels(allModels);
    await window.electron.showMessage('Success', 'Thumbnail regeneration completed successfully.');
    await renderFiles(await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0));
  };

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

  // Add dismiss button handler
  document.getElementById('dismiss-welcome')?.addEventListener('click', () => {
    welcomeDialog.close();
  });



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
    initializeListButtons();
  });

  // Remove the other DOMContentLoaded listener that's adding filter change handlers

  await initializeTags();
  initializeListButtons();


  await populateTagFilter();

  // Scan Directory (the sidebar button, the Tools menu and Ctrl/Cmd+Shift+S).
  window.scanDirectory = async () => {
    if (isScanning) return; // Prevent multiple scans
    
    // First, check if there are any active filters and clear them
    const clearFilterButton = document.querySelector('.clear-filter-button');
    if (clearFilterButton) {
      console.log('Clearing filters before directory scan');
      clearFilterButton.click(); // Programmatically trigger the clear filters action
      // Wait a moment for the filter clearing to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Ask for a folder inside the container, starting from the first STL Home directory.
    const stlHomes = await getStlHomeDirectories();
    const enteredPath = await window.electron.showInputDialog({
      title: 'Scan Directory',
      message: 'Folder to scan (a path inside the container, for example /models):',
      defaultValue: stlHomes[0] || ''
    });
    if (!enteredPath || !enteredPath.trim()) return;
    const directoryPath = [enteredPath.trim()];

    await window.electron.saveDirectory(directoryPath[0]);
    console.log('Scanning directory:', directoryPath[0]);
    
    window.sidebarStatus?.setScanning(true);
    isScanning = true;
    
    // Show progress section
    showProgressBars();
    
    try {
      // Update progress bars
      const progressSection = document.getElementById('progress-section');
      const progressContainer = document.getElementById('progress-container');
      const progressBar = document.getElementById('progress-bar');
      const progressText = document.getElementById('progress-text');
      const renderProgressContainer = document.getElementById('render-progress-container');
      const renderProgressBar = document.getElementById('render-progress-bar');
      const renderProgressText = document.getElementById('render-progress-text');
      
      progressSection.classList.remove('hidden');
      progressContainer.classList.remove('hidden');
      renderProgressContainer.classList.remove('hidden');

      // Listen for progress updates
      // Note: scan progress events can arrive out-of-order because the scan worker
      // processes many operations concurrently. Keep the displayed count monotonic.
      let lastScanProcessed = 0;
      window.electron.onScanProgress((progress) => {
        const processedRaw = typeof progress?.processed === 'number' ? progress.processed : 0;
        lastScanProcessed = Math.max(lastScanProcessed, processedRaw);
        const percent = progress.total ? (lastScanProcessed / progress.total) * 100 : 0;
        progressBar.style.width = `${percent}%`;
        progressText.textContent = `Checking files: ${lastScanProcessed}`;
      });

      window.electron.onDbProgress((progress) => {
        if (window._scanThumbnailProgress) return;
        const percent = progress.total ? (progress.processed / progress.total) * 100 : 0;
        renderProgressBar.style.width = `${percent}%`;
        renderProgressText.textContent = `Processing models: ${progress.processed} / ${progress.total}`;
      });

      // This function now handles both scanning and thumbnail generation
      await scanAndRenderDirectory(directoryPath[0]);

      // Update UI after scan completes
      await populateDesignerDropdown();
      await populateParentModelFilter();
      await populateTagFilter();
      await populateLicenseFilter();
      
      // Show the whole library again
      window.clearAllLibraryFilters?.();

      // Force grid to refetch and re-render so models show without reload (Docker/server - same as Scan STL Home / View Entire Library)
      window.disableGridRefresh = false;
      const gridEl = document.querySelector('.file-grid');
      if (gridEl) gridEl.currentModels = null;
      if (typeof window.forceGridRefresh === 'function') {
        await window.forceGridRefresh();
      } else {
        const allModels = await window.electron.getAllModels();
        await renderFiles(allModels);
        await updateModelCounts(allModels.length);
      }

    } catch (error) {
      console.error('Error scanning directory:', error);
      await window.electron.showMessage('Error', 'Failed to scan directory');
    } finally {
      hideProgressBars();
      isScanning = false;
      window.sidebarStatus?.setScanning(false);
    }
  };
 

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

  // Called by the Tag Manager (React) after each change.
  window.refreshTagRelatedUi = async function refreshTagRelatedUi() {
    try {
      await populateTagSelect();
      await populateTagFilter();
      if (typeof populateRemoveTagSelect === 'function') {
        await populateRemoveTagSelect();
      }
      const currentModelPath = getCurrentModelFilePath() || currentModelDetailsPath;
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
        const currentModelPath = getCurrentModelFilePath() || currentModelDetailsPath;
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
          await renderFiles(models);
        }
        
        // Update all visible model elements to refresh their tags
        // This ensures tags are updated even if the grid doesn't fully re-render
        const allFileItems = document.querySelectorAll('.file-item');
        for (const item of allFileItems) {
          const filePath = item.getAttribute('data-filepath') || item.dataset.filepath;
          if (filePath) {
            await updateModelElement(filePath);
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
      await renderFiles(await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc'));
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
      refreshLibraryGrid();

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

  window._electronRealEventHandlers['regenerate-thumbnails'] = async function() {
    if (isRegeneratingThumbnails) return;
    // Hidden server worker ignores UI events; it only runs run-server-thumbnail-job.
    if (await isServerThumbnailWorkerContext()) return;
    try {
      const sortSelect = document.getElementById('sort-select');
      const allModels = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0);
      if (allModels.length === 0) {
        await window.electron.showMessage('Information', 'No models found in the database.');
        return;
      }
      isRegeneratingThumbnails = true;
      const userChoice = await window.electron.showMessage(
        'Regenerate Thumbnails',
        `This will regenerate thumbnails for all ${allModels.length} models. This may take a while. Continue?`,
        ['Yes', 'No']
      );
      if (userChoice === 'Yes') {
        const serverJob = await startAndWatchServerThumbnailJob('all', 'Regenerate Thumbnails');
        if (serverJob) {
          isRegeneratingThumbnails = false;
          if (serverJob.backgrounded || serverJob.cancelled) {
            return;
          }
          await window.electron.showMessage('Success', 'Thumbnail regeneration completed successfully.');
          invalidatePrimaryThumbnailCache();
          const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0);
          await renderFiles(models);
          return;
        }

        window.ThumbnailProgress?.show({
          title: 'Regenerate Thumbnails',
          phase: 'Clearing existing thumbnails...',
          cancellable: false
        });
        await window.electron.purgeThumbnails();
        invalidatePrimaryThumbnailCache();
        await generateThumbnailsForModels(allModels);
        isRegeneratingThumbnails = false;
        await window.electron.showMessage('Success', 'Thumbnail regeneration completed successfully.');
        const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0);
        await renderFiles(models);
      } else {
        isRegeneratingThumbnails = false;
      }
    } catch (error) {
      console.error('Error regenerating thumbnails:', error);
      isRegeneratingThumbnails = false;
      window.ThumbnailProgress?.hide();
      await window.electron.showMessage('Error', 'Failed to regenerate thumbnails: ' + error.message);
    }
  };
  if (window._electronPendingEvents['regenerate-thumbnails']) {
    window._electronPendingEvents['regenerate-thumbnails'].forEach((args) => {
      window._electronRealEventHandlers['regenerate-thumbnails'].apply(null, args);
    });
    delete window._electronPendingEvents['regenerate-thumbnails'];
  }

  window._electronRealEventHandlers['generate-missing-thumbnails'] = async function() {
    // Check if a thumbnail dialog is already showing
    if (isThumbnailDialogShowing) {
      return; // Exit early if dialog is already showing
    }
    if (await isServerThumbnailWorkerContext()) return;
    
    try {
      // Get models without thumbnails (NULL, empty, or default '3d.png')
      const modelsWithoutThumbs = await window.electron.getModelsWithoutThumbnails();
      
      if (modelsWithoutThumbs.length === 0) {
        await window.electron.showMessage('Information', 'All models already have thumbnails. Nothing to generate.');
        return;
      }
      
      isThumbnailDialogShowing = true; // Set flag before showing dialog
      // Ask for user confirmation
      const userChoice = await window.electron.showMessage(
        'Generate Missing Thumbnails',
        `${modelsWithoutThumbs.length} models are missing thumbnails. Would you like to generate them now?`,
        ['Yes', 'No']
      );
      
      if (userChoice === 'Yes') {
        const serverJob = await startAndWatchServerThumbnailJob('missing', 'Generate Missing Thumbnails');
        if (serverJob) {
          isThumbnailDialogShowing = false;
          if (serverJob.backgrounded || serverJob.cancelled) {
            return;
          }
          await window.electron.showMessage('Success', 'Thumbnail generation completed successfully.');
          invalidatePrimaryThumbnailCache();
          const sortSelect = document.getElementById('sort-select');
          const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0);
          await renderFiles(models);
          return;
        }

        const progress = window.ThumbnailProgress;
        progress?.show({
          title: 'Generate Missing Thumbnails',
          phase: 'Loading model details...',
          total: modelsWithoutThumbs.length,
          cancellable: false
        });

        // Get full model data for the models without thumbnails
        const fullModels = [];
        let loadedCount = 0;
        for (const model of modelsWithoutThumbs) {
          const fullModel = await window.electron.getModel(model.filePath);
          if (fullModel) {
            fullModels.push(fullModel);
          }
          loadedCount++;
          progress?.update(loadedCount, modelsWithoutThumbs.length);
        }
        
        // Generate thumbnails for models without them
        await generateThumbnailsForModels(fullModels);
        
        isThumbnailDialogShowing = false; // Reset flag after generation completes
        await window.electron.showMessage('Success', 'Thumbnail generation completed successfully.');
        
        // Refresh the grid to show the new thumbnails
        const sortSelect = document.getElementById('sort-select');
        const models = await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc', 0);
        await renderFiles(models);
      } else {
        isThumbnailDialogShowing = false; // Reset flag if user clicks "No"
      }
    } catch (error) {
      console.error('Error generating missing thumbnails:', error);
      isThumbnailDialogShowing = false;
      window.ThumbnailProgress?.hide();
      await window.electron.showMessage('Error', 'Failed to generate missing thumbnails: ' + error.message);
    }
  };
  if (window._electronPendingEvents['generate-missing-thumbnails']) {
    window._electronPendingEvents['generate-missing-thumbnails'].forEach((args) => {
      window._electronRealEventHandlers['generate-missing-thumbnails'].apply(null, args);
    });
    delete window._electronPendingEvents['generate-missing-thumbnails'];
  }

  // After Purge Models (src/web/PurgeModelsDialog.tsx): empty the grid and counts, and reset the filters.
  window.afterModelsPurged = async function afterModelsPurged() {
    clearFileItemPathIndex();
    renderVirtualGrid([]);
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
        await renderFiles(models);
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
            syncPrimaryThumbnailCacheFromThumbnailString(data.filePath, updatedModelEarly.thumbnail);
          } else if (data.filePath) {
            invalidatePrimaryThumbnailCache(data.filePath);
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
        syncPrimaryThumbnailCacheFromThumbnailString(data.filePath, updatedModel.thumbnail);
      } else {
        invalidatePrimaryThumbnailCache(data.filePath);
      }
    } catch (_) {
      invalidatePrimaryThumbnailCache(data.filePath);
    }
  });

  // Handle thumbnail deleted event - refresh grid to show updated thumbnail
  window.electron.on('thumbnail-deleted', async (data) => {
    if (data?.filePath) invalidatePrimaryThumbnailCache(data.filePath);
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
              await renderFiles(models);
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

  // Update the file scanning function to use MAX_FILE_SIZE_MB
  function isValidFile(filename, size) {
    const maxSize = MAX_FILE_SIZE_MB * 1024 * 1024;
    const lower = filename.toLowerCase();
    const ext = lower.includes('.') ? '.' + lower.split('.').pop() : '';
    const isValid = EXTENSIONS_VALID_FOR_LIBRARY.has(ext) && size <= maxSize;
    debugLog(`File validation: ${filename}, size: ${size}, max: ${maxSize}, valid: ${isValid}`);
    return isValid;
  }

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

  // 1. Implement thumbnail caching system
  const thumbnailCache = new Map();

  // extract3MFThumbnail moved to top level for generateThumbnail access
  
  // NOTE: loadModel is now defined at top level (line ~50) - duplicate removed



  // NOTE: refreshModelDisplay is defined at top level (line ~5093) - duplicate removed

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
        await displayModels(models);
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
    await showModelDetails(filePath);

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


  // Periodic STL Home scanning for server mode
  let stlHomeScanInterval = null;

  async function startPeriodicSTLHomeScan() {
    // Stop any existing interval
    stopPeriodicSTLHomeScan();
    
    const serverMode = await window.electron.isServerMode().catch(() => false);
    if (!serverMode) return;
    
    const stlHomes = await getStlHomeDirectories();
    if (!stlHomes.length) return;
    
    const updateFrequency = await window.electron.getSetting('stlHomeUpdateFrequency');
    const frequencyMinutes = parseInt(updateFrequency) || 60;
    const frequencyMs = frequencyMinutes * 60 * 1000;
    
    console.log(`Starting periodic STL Home scan. Frequency: ${frequencyMinutes} minutes (first run after interval)`);
    
    // In server mode: no scan on page load; first check after interval, then on interval
    const runScan = async () => {
      const currentStlHomes = await getStlHomeDirectories();
      if (currentStlHomes.length) {
        await performSTLHomeScan(currentStlHomes);
      } else {
        stopPeriodicSTLHomeScan();
      }
    };
    stlHomeScanInterval = setInterval(runScan, frequencyMs);
  }

  function stopPeriodicSTLHomeScan() {
    if (stlHomeScanInterval) {
      clearInterval(stlHomeScanInterval);
      stlHomeScanInterval = null;
      console.log('Stopped periodic STL Home scan');
    }
  }

  async function performSTLHomeScan(stlHomeDir) {
    const explicit = Array.isArray(stlHomeDir)
      ? stlHomeDir.map((dir) => String(dir || '').trim()).filter(Boolean)
      : parseLegacyStlHomeSetting(stlHomeDir);
    const dirs = explicit.length ? explicit : await getStlHomeDirectories();
    if (!dirs.length) return;
    let newFilesCount = 0;
    let skippedDueToSize = 0;
    // Index every directory before thumbnail rendering. scanAndRenderDirectory waits on
    // thumbnails, and in the server window that wait never finishes, so later homes
    // were never scanned.
    for (const dir of dirs) {
      try {
        console.log(`Performing STL Home scan: ${dir}`);
        const result = await window.electron.scanDirectory(dir, { isStlHomeScan: true });
        newFilesCount += Number(result && result.newFilesCount) || 0;
        skippedDueToSize += Number(result && result.skippedDueToSize) || 0;
      } catch (error) {
        console.error('Error during STL Home scan:', dir, error);
      }
    }
    try {
      await populateDesignerDropdown();
      await populateParentModelFilter();
      await populateTagFilter();
      await populateLicenseFilter();
    } catch (error) {
      console.error('STL Home scan filter refresh failed:', error);
    }
    if (newFilesCount > 0 && window.electron && typeof window.electron.showMessageBox === 'function') {
      window.electron.showMessageBox({
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        title: 'New Models Found',
        message: `${newFilesCount} new model(s) found, would you like to see them?`
      }).catch((error) => console.error('STL Home new-models prompt failed:', error));
    }
    maybeShowSkippedFileSizeNotice(skippedDueToSize).catch((error) => {
      console.error('Skipped file size notice failed:', error);
    });
  }
  window.performSTLHomeScan = performSTLHomeScan;
  window.startPeriodicSTLHomeScan = startPeriodicSTLHomeScan;
  window.stopPeriodicSTLHomeScan = stopPeriodicSTLHomeScan;

  // On startup, if STL Home directories are specified:
  // - In docker/server mode (STL_HOME set via startup/env): run one background check when the server loads, then on the interval.
  // - When user saves STL Home via the UI in server mode: scan runs in the dialog submit handler when saved.
  // - In normal mode: scan once on load and refresh filters.
  const stlHomes = await getStlHomeDirectories();
  
  if (stlHomes.length) {
    const serverModeStlHome = await window.electron.isServerMode().catch(() => false);
    if (serverModeStlHome) {
      // Browser tabs share the Docker API. A scan on every page load freezes the tab
      // (getAllModels + render). The Electron server window owns background scans.
      const isElectronShell = /Electron/i.test(navigator.userAgent);
      if (isElectronShell) {
        console.log("STL Home is set (server window). Running initial background check, then on the configured interval.", stlHomes.join(', '));
        performSTLHomeScan(stlHomes).catch(err => console.error('Background STL Home scan on server load:', err));
        startPeriodicSTLHomeScan();
      } else {
        console.log("STL Home is set (browser client). Loading library from the database; scan stays on the server window.");
        if (typeof window.performCombinedSearch === 'function') {
          await window.performCombinedSearch();
        }
      }
    } else {
      console.log("STL Home is set. Showing library from database; STL Home scan in background:", stlHomes.join(', '));
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch();
      }
      await populateDesignerDropdown();
      await populateParentModelFilter();
      await populateTagFilter();
      await populateLicenseFilter();
      (async () => {
        let skippedDueToSize = 0;
        for (const stlHomeDir of stlHomes) {
          try {
            const scanInfo = await scanAndRenderDirectory(stlHomeDir, true, true, { suppressSizeNotice: true });
            skippedDueToSize += Number(scanInfo && scanInfo.skippedDueToSize) || 0;
          } catch (err) {
            console.error('Background STL Home scan on startup:', stlHomeDir, err);
          }
        }
        try {
          await maybeShowSkippedFileSizeNotice(skippedDueToSize);
        } catch (err) {
          console.error('Startup skipped file size notice failed:', err);
        }
        try {
          await populateDesignerDropdown();
          await populateParentModelFilter();
          await populateTagFilter();
          await populateLicenseFilter();
        } catch (e) {
          console.error('Startup STL Home scan: filter refresh failed:', e);
        }
      })();
    }
  } else if (typeof window.performCombinedSearch === 'function') {
    await window.performCombinedSearch();
  }
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


  // Store pending tags for preview (can handle multiple models)
  let pendingTagData = [];
  let batchTagGenerationInProgress = false;
  let expectedBatchCount = 0;
  let reviewDialogOpen = false;
  let rateLimitDialogShown = false; // Track if rate limit dialog has been shown during current batch
  /** Set when the tag preview dialog closes; cleared when a new generate-tags run starts. Stops late IPC from reopening the dialog. */
  let suppressTagPreviewReopen = false;
  /** Bumps on each showTagPreviewDialog call so stale getSetting() callbacks cannot append duplicate UI */
  let tagPreviewDialogRenderGeneration = 0;

  // Helper function to normalize file paths for comparison (Docker/server may use leading slash or not)
  function normalizeFilePath(path) {
    if (!path) return '';
    const normalized = path.replace(/\\/g, '/').toLowerCase().trim();
    return normalized.replace(/^\/+/, ''); // strip leading slashes so "/3dmodels/..." and "3dmodels/..." match
  }

  // Helper function to get filePath from modelData (checks both locations)
  function getFilePathFromModelData(modelData) {
    return modelData.model?.filePath || modelData.filePath;
  }

  // Helper function to deduplicate model data array
  function deduplicateModelData(modelsData) {
    if (!Array.isArray(modelsData) || modelsData.length === 0) {
      return [];
    }
    
    const deduplicated = new Map();
    
    for (const modelData of modelsData) {
      if (!modelData) continue; // Skip null/undefined entries
      
      const filePath = getFilePathFromModelData(modelData);
      if (!filePath) {
        console.warn('[Deduplicate] Skipping modelData with no filePath:', modelData);
        continue;
      }
      
      const normalizedPath = normalizeFilePath(filePath);
      if (!normalizedPath) {
        console.warn('[Deduplicate] Skipping modelData with empty normalized path:', filePath);
        continue;
      }
      
      const existing = deduplicated.get(normalizedPath);
      
      // Prefer entry with actual tags over "Generating..." entries or empty tags
      if (!existing) {
        deduplicated.set(normalizedPath, modelData);
      } else {
        const existingHasTags = existing.generatedTags !== undefined && existing.generatedTags.length > 0;
        const newHasTags = modelData.generatedTags !== undefined && modelData.generatedTags.length > 0;
        const existingIsGenerating = existing.generatedTags === undefined;
        const newIsGenerating = modelData.generatedTags === undefined;
        
        // Always prefer entry with actual tags
        if (newHasTags && !existingHasTags) {
          // New has tags, existing doesn't - replace
          deduplicated.set(normalizedPath, modelData);
        } else if (existingHasTags && !newHasTags) {
          // Existing has tags, new doesn't - keep existing
          // (don't replace)
        } else if (newIsGenerating && !existingIsGenerating) {
          // New is generating, existing has some result - keep existing
          // (don't replace)
        } else if (existingIsGenerating && !newIsGenerating) {
          // Existing is generating, new has result - replace
          deduplicated.set(normalizedPath, modelData);
        } else {
          // Both in same state - prefer the one with more complete data (has model object)
          // If both have model objects, keep existing (first one wins)
          const existingHasModel = existing.model && typeof existing.model === 'object';
          const newHasModel = modelData.model && typeof modelData.model === 'object';
          
          if (newHasModel && !existingHasModel) {
            // New has model object, existing doesn't - replace
            deduplicated.set(normalizedPath, modelData);
          } else {
            // Keep existing (first one wins or both have same completeness)
            // (don't replace)
          }
        }
      }
    }
    
    const result = Array.from(deduplicated.values());
    
    // Final validation: ensure no duplicates by path
    const pathSet = new Set();
    const finalResult = [];
    for (const modelData of result) {
      const filePath = getFilePathFromModelData(modelData);
      if (!filePath) continue;
      const normalizedPath = normalizeFilePath(filePath);
      if (!pathSet.has(normalizedPath)) {
        pathSet.add(normalizedPath);
        finalResult.push(modelData);
      } else {
        console.warn(`[Deduplicate] Found duplicate after deduplication: ${filePath}`);
      }
    }
    
    return finalResult;
  }

  // Helper function to update or add model data to pendingTagData (ensures no duplicates)
  function updatePendingTagData(filePath, tagData) {
    const normalizedFilePath = normalizeFilePath(filePath);
    
    // First, remove ALL entries with this filePath (in case there are duplicates)
    // This ensures we never have multiple entries for the same file
    const beforeCount = pendingTagData.length;
    pendingTagData = pendingTagData.filter(d => {
      const dPath1 = normalizeFilePath(d.filePath);
      const dPath2 = normalizeFilePath(getFilePathFromModelData(d));
      return (dPath1 !== normalizedFilePath) && (dPath2 !== normalizedFilePath);
    });
    
    // Then add the new/updated entry
    pendingTagData.push(tagData);
    
    // Always deduplicate after update to ensure no duplicates
    // This is a final safeguard
    const beforeDedup = pendingTagData.length;
    pendingTagData = deduplicateModelData(pendingTagData);
    
    // Debug: log if we removed duplicates
    if (beforeCount !== pendingTagData.length || beforeDedup !== pendingTagData.length) {
      console.log(`updatePendingTagData: Removed duplicates for ${filePath}. Before: ${beforeCount}, After filter: ${pendingTagData.length + 1}, After dedup: ${pendingTagData.length}`);
    }
  }

  // Function to update the tag preview dialog (for real-time updates)
  function updateTagPreviewDialog() {
    if (!reviewDialogOpen) return;
    // CRITICAL: Always deduplicate before showing to prevent duplicates from rapid updates
    // This is especially important when multiple tags arrive quickly
    pendingTagData = deduplicateModelData(pendingTagData);
    // showTagPreviewDialog will use pendingTagData when dialog is open (ignores parameter)
    showTagPreviewDialog(pendingTagData);
  }

  async function showRateLimitNotice(errorMessage) {
    const detailedMessage = errorMessage && errorMessage.includes('Rate limit exceeded: ')
      ? errorMessage.split('Rate limit exceeded: ')[1]
      : 'API rate limit has been exceeded. Tags already generated can still be applied.';
    if (rateLimitDialogShown) return;
    rateLimitDialogShown = true;
    try {
      await window.electron.showMessage('Rate Limit Exceeded', detailedMessage);
    } catch (error) {
      console.error('Error showing rate limit message:', error);
    }
  }

  window._electronRealEventHandlers['tags-generated'] = async function(filePath, tags, errorMessage) {
    try {
      const isRateLimit = !!(errorMessage && errorMessage.includes('Rate limit'));

      // Fetch the current model data for the given filePath
      const model = await window.electron.getModel(filePath);
      if (!model) {
        console.error(`Model not found for ${filePath}`);
        return;
      }

      // Check if this is a batch operation (if review dialog is already open, it's batch)
      const isBatchOperation = batchTagGenerationInProgress;
      
      if (isBatchOperation) {
        // Store or update tag data for this model (even if tags are empty)
        const tagData = {
          filePath: filePath,
          model: model,
          generatedTags: tags || [],
          existingTags: model.tags || [],
          errorMessage: errorMessage || null
        };
        
        // Use helper function to update pendingTagData (ensures no duplicates)
        updatePendingTagData(filePath, tagData);
        
        // Update the review dialog in real-time (only while user still has it open)
        if (reviewDialogOpen) {
          updateTagPreviewDialog();
        }
      } else {
        // Single model operation - update existing dialog or show if not open
        const tagData = {
          filePath: filePath,
          model: model,
          generatedTags: tags || [],
          existingTags: model.tags || [],
          errorMessage: errorMessage || null
        };
        
        // Same merge as batch: normalized path dedupe (strict filePath compare missed Docker/UNC variants)
        updatePendingTagData(filePath, tagData);
        
        // Update the dialog if it's open, otherwise show it (unless user closed this run)
        if (reviewDialogOpen) {
          updateTagPreviewDialog();
        } else if (!suppressTagPreviewReopen) {
          showTagPreviewDialog(pendingTagData);
        }
        
        // Show message if no tags were generated (but don't block)
        if (!tags || tags.length === 0) {
          console.log(`No tags generated for ${filePath}`);
        }
      }

      if (isRateLimit) {
        await showRateLimitNotice(errorMessage);
      }
    } catch (error) {
      console.error(`Error updating tags for model ${filePath}:`, error);
    }
  };
  if (window._electronPendingEvents['tags-generated']) {
    window._electronPendingEvents['tags-generated'].forEach((args) => {
      window._electronRealEventHandlers['tags-generated'].apply(null, args);
    });
    delete window._electronPendingEvents['tags-generated'];
  }

  window._electronRealEventHandlers['start-single-tag-generation'] = async function(filePath, modelData) {
    try {
      console.log('[Renderer] Received start-single-tag-generation event', filePath, modelData);
      batchTagGenerationInProgress = false;
      expectedBatchCount = 1;
      pendingTagData = [modelData];
      reviewDialogOpen = false; // Reset dialog state
      suppressTagPreviewReopen = false;
      rateLimitDialogShown = false; // Reset rate limit dialog flag
      // Deduplicate before showing (should be single item, but be safe)
      const uniquePendingData = deduplicateModelData(pendingTagData);
      console.log('[Renderer] About to call showTagPreviewDialog with:', uniquePendingData);
      console.log('[Renderer] showTagPreviewDialog exists:', typeof showTagPreviewDialog);
      
      // Ensure dialog opens even if showTagPreviewDialog has issues
      const dialog = document.getElementById('tag-preview-dialog');
      if (dialog && !dialog.open) {
        console.log('[Renderer] Opening tag preview dialog directly');
        dialog.showModal();
        reviewDialogOpen = true;
      }
      
      if (typeof showTagPreviewDialog === 'function') {
        showTagPreviewDialog(uniquePendingData);
      } else {
        console.error('[Renderer] showTagPreviewDialog is not a function!');
        // If function doesn't exist, at least show the dialog with basic content
        if (dialog && dialog.open) {
          const container = document.getElementById('tag-preview-container');
          if (container) {
            container.innerHTML = '<div style="padding: 20px; color: #fff;">Generating tags...</div>';
          }
        }
      }
    } catch (error) {
      console.error('[Renderer] Error in start-single-tag-generation handler:', error);
      // Try to open dialog anyway
      try {
        const dialog = document.getElementById('tag-preview-dialog');
        if (dialog && !dialog.open && !suppressTagPreviewReopen) {
          dialog.showModal();
          reviewDialogOpen = true;
        }
      } catch (dialogError) {
        console.error('[Renderer] Failed to open dialog:', dialogError);
      }
    }
  };
  if (window._electronPendingEvents['start-single-tag-generation']) {
    window._electronPendingEvents['start-single-tag-generation'].forEach((args) => {
      window._electronRealEventHandlers['start-single-tag-generation'].apply(null, args);
    });
    delete window._electronPendingEvents['start-single-tag-generation'];
  }

  window._electronRealEventHandlers['start-batch-tag-generation'] = async function(count, filePaths) {
    try {
      console.log('[Renderer] Received start-batch-tag-generation event', count, filePaths);
      batchTagGenerationInProgress = true;
      expectedBatchCount = count;
      pendingTagData = [];
      reviewDialogOpen = false;
      suppressTagPreviewReopen = false;
      rateLimitDialogShown = false; // Reset rate limit dialog flag for new batch
      
      // Ensure dialog opens immediately, even before loading models
      const dialog = document.getElementById('tag-preview-dialog');
      if (dialog && !dialog.open) {
        console.log('[Renderer] Opening tag preview dialog directly for batch');
        dialog.showModal();
        reviewDialogOpen = true;
      }
      
      // Pre-populate with all models so they appear immediately (deduplicate by normalized path to avoid duplicate entries)
      if (filePaths && filePaths.length > 0) {
        const seenPaths = new Set();
        for (const filePath of filePaths) {
          const norm = normalizeFilePath(filePath);
          if (!norm || seenPaths.has(norm)) continue;
          seenPaths.add(norm);
          if (suppressTagPreviewReopen) break;
          try {
            const model = await window.electron.getModel(filePath);
            if (suppressTagPreviewReopen) break;
            if (model) {
              pendingTagData.push({
                filePath: filePath,
                model: model,
                generatedTags: undefined, // Not generated yet
                existingTags: model.tags || []
              });
            }
          } catch (error) {
            console.error(`Error loading model ${filePath} for preview:`, error);
          }
        }
      }
      
      // Show the review dialog immediately with all models (some may show "Generating...")
      // Deduplicate before showing to prevent any duplicates
      const uniquePendingData = deduplicateModelData(pendingTagData);
      console.log('[Renderer] About to call showTagPreviewDialog with:', uniquePendingData.length, 'items');
      console.log('[Renderer] showTagPreviewDialog exists:', typeof showTagPreviewDialog);
      if (!suppressTagPreviewReopen && typeof showTagPreviewDialog === 'function') {
        if (uniquePendingData.length > 0) {
          showTagPreviewDialog(uniquePendingData);
        } else {
          showTagPreviewDialog([]);
        }
      } else if (!suppressTagPreviewReopen) {
        console.error('[Renderer] showTagPreviewDialog is not a function!');
        // If function doesn't exist, at least show the dialog with basic content
        if (dialog && dialog.open) {
          const container = document.getElementById('tag-preview-container');
          if (container) {
            container.innerHTML = `<div style="padding: 20px; color: #fff;">Generating tags for ${count} model(s)...</div>`;
          }
        }
      }
    } catch (error) {
      console.error('[Renderer] Error in start-batch-tag-generation handler:', error);
      // Try to open dialog anyway
      try {
        const dialog = document.getElementById('tag-preview-dialog');
        if (dialog && !dialog.open && !suppressTagPreviewReopen) {
          dialog.showModal();
          reviewDialogOpen = true;
          const container = document.getElementById('tag-preview-container');
          if (container) {
            container.innerHTML = '<div style="padding: 20px; color: #fff;">Error loading tag preview. Tags are still being generated...</div>';
          }
        }
      } catch (dialogError) {
        console.error('[Renderer] Failed to open dialog:', dialogError);
      }
    }
  };
  if (window._electronPendingEvents['start-batch-tag-generation']) {
    window._electronPendingEvents['start-batch-tag-generation'].forEach((args) => {
      window._electronRealEventHandlers['start-batch-tag-generation'].apply(null, args);
    });
    delete window._electronPendingEvents['start-batch-tag-generation'];
  }

  window._electronRealEventHandlers['batch-tag-generation-complete'] = async function() {
    batchTagGenerationInProgress = false;
    pendingTagData = pendingTagData.map((entry) => {
      if (!entry || entry.generatedTags !== undefined) return entry;
      return {
        ...entry,
        generatedTags: [],
        errorMessage: entry.errorMessage || 'Tag generation stopped before this model finished. Tags already generated can still be applied.'
      };
    });
    
    // Wait a tiny bit to ensure all pending tag updates have completed
    // This prevents race conditions where the last tag update hasn't finished
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Update the dialog one final time to show completion status
    // CRITICAL: Ensure pendingTagData is fully deduplicated before final refresh
    if (reviewDialogOpen && pendingTagData.length > 0) {
      // Debug: Log before deduplication
      console.log('batch-tag-generation-complete: Before dedup, pendingTagData has', pendingTagData.length, 'entries');
      pendingTagData.forEach((d, i) => {
        const path = getFilePathFromModelData(d);
        const hasTags = d.generatedTags !== undefined && d.generatedTags.length > 0;
        const isGenerating = d.generatedTags === undefined;
        console.log(`  [${i}] ${path}: hasTags=${hasTags}, isGenerating=${isGenerating}, tags=${d.generatedTags?.length || 0}`);
      });
      
      // Force deduplication one more time before final update
      // This ensures no duplicates from rapid tag generation events
      const beforeCount = pendingTagData.length;
      pendingTagData = deduplicateModelData(pendingTagData);
      const afterCount = pendingTagData.length;
      
      if (beforeCount !== afterCount) {
        console.log(`batch-tag-generation-complete: Removed ${beforeCount - afterCount} duplicates. Now have ${afterCount} entries`);
      }
      
      // Use showTagPreviewDialog directly with the deduplicated data
      // Don't call updateTagPreviewDialog which might use stale data
      showTagPreviewDialog(pendingTagData);
    }
    
    // Don't auto-close - let the user review what happened (even if no tags)
    // They can see which models failed and which succeeded
  };
  if (window._electronPendingEvents['batch-tag-generation-complete']) {
    window._electronPendingEvents['batch-tag-generation-complete'].forEach((args) => {
      window._electronRealEventHandlers['batch-tag-generation-complete'].apply(null, args);
    });
    delete window._electronPendingEvents['batch-tag-generation-complete'];
  }

  // Function to show tag preview dialog (now handles multiple models)
  function showTagPreviewDialog(modelsData) {
    const dialog = document.getElementById('tag-preview-dialog');
    const container = document.getElementById('tag-preview-container');
    const modelInfoEl = document.getElementById('tag-preview-model-info');
    
    if (!dialog || !container) {
      console.error('Tag preview dialog elements not found');
      return;
    }

    const renderGeneration = ++tagPreviewDialogRenderGeneration;

    // Check if dialog is open BEFORE we use it (fix race condition).
    // A close during in-flight generation sets suppressTagPreviewReopen; do not
    // reopen or rewrite the dialog from a call that started before that close.
    const isDialogOpen = dialog.open === true;
    if (!isDialogOpen && suppressTagPreviewReopen) {
      return;
    }
    reviewDialogOpen = isDialogOpen;

    // When dialog is already open, ALWAYS use pendingTagData as the single source of truth
    // This prevents stale data from being displayed and ensures consistency
    let dataToDeduplicate;
    if (isDialogOpen) {
      // Dialog is open - ONLY use pendingTagData (ignore passed parameter)
      // pendingTagData is already updated by updatePendingTagData before this is called
      dataToDeduplicate = pendingTagData;
    } else {
      // Dialog not open yet - use passed data (first time opening)
      dataToDeduplicate = modelsData;
    }
    
    // Deduplicate models by filePath - prefer entries with actual tags over "Generating..." entries
    const beforeDedup = dataToDeduplicate.length;
    const uniqueModelsData = deduplicateModelData(dataToDeduplicate);
    const afterDedup = uniqueModelsData.length;
    
    // Debug: Log if duplicates were found
    if (beforeDedup !== afterDedup) {
      console.log(`showTagPreviewDialog: Found ${beforeDedup - afterDedup} duplicates. Before: ${beforeDedup}, After: ${afterDedup}`);
      // Log what was removed
      const removed = dataToDeduplicate.filter(d1 => {
        const path1 = normalizeFilePath(getFilePathFromModelData(d1));
        return !uniqueModelsData.some(d2 => {
          const path2 = normalizeFilePath(getFilePathFromModelData(d2));
          return path1 === path2;
        });
      });
      removed.forEach(d => {
        const path = getFilePathFromModelData(d);
        console.log(`  Removed duplicate: ${path}, hasTags=${d.generatedTags?.length > 0}, isGenerating=${d.generatedTags === undefined}`);
      });
    }
    
    // Update pendingTagData to match what we're showing (single source of truth)
    pendingTagData = uniqueModelsData;

    // Hide single model info, show batch info if multiple models
    if (uniqueModelsData.length === 1) {
      // Single model - show model info
      if (modelInfoEl) {
        modelInfoEl.style.display = 'block';
        const model = uniqueModelsData[0].model;
        const modelNameEl = document.getElementById('tag-preview-model-name');
        const modelPathEl = document.getElementById('tag-preview-model-path');
        
        if (modelNameEl && modelPathEl) {
          const fileName = model.fileName || model.filePath?.split(/[/\\]/).pop() || 'Unknown';
          const filePath = model.filePath || 'Unknown path';
          
          modelNameEl.textContent = fileName;
          modelPathEl.textContent = filePath;
        }
      }
    } else {
      // Multiple models - hide single model info
      if (modelInfoEl) {
        modelInfoEl.style.display = 'none';
      }
    }

    // Save checkbox states before clearing (to preserve user selections when dialog is updated)
    const checkboxStates = new Map();
    if (container) {
      const existingCheckboxes = container.querySelectorAll('input[type="checkbox"]');
      console.log(`Saving checkbox states: found ${existingCheckboxes.length} checkboxes`);
      existingCheckboxes.forEach(checkbox => {
        const filePath = checkbox.dataset.filePath;
        const tagValue = checkbox.value;
        if (filePath && tagValue) {
          const key = `${filePath}::${tagValue}`;
          checkboxStates.set(key, checkbox.checked);
          if (checkbox.checked) {
            console.log(`Saved checked state for: ${key}`);
          }
        } else {
          console.warn(`Checkbox missing filePath or value:`, { filePath, tagValue, checked: checkbox.checked });
        }
      });
      console.log(`Total checkbox states saved: ${checkboxStates.size}`);
    }

    // Clear container completely to prevent duplicates
    container.innerHTML = '';

    // Open dialog immediately (before loading settings) so it appears in desktop mode.
    // Re-check open state here: the user can only close across an await, but
    // showModal throws if the dialog was opened by an earlier handler in this turn.
    if (!dialog.open) {
      if (suppressTagPreviewReopen) return;
      try {
        dialog.showModal();
      } catch (err) {
        if (!dialog.open) {
          console.error('Failed to open tag preview dialog:', err);
          return;
        }
      }
      reviewDialogOpen = true;
    }

    // Get merge strategy from settings
    window.electron.getSetting('aiTagMergeStrategy').then((strategy) => {
      if (renderGeneration !== tagPreviewDialogRenderGeneration) {
        return;
      }
      if (!dialog.open || suppressTagPreviewReopen) {
        return;
      }

      const mergeStrategy = strategy || 'merge';

      // Clear again here: overlapping showTagPreviewDialog calls only cleared synchronously earlier;
      // without this, each resolved callback would append another full model list.
      container.innerHTML = '';

      // Final deduplication check before rendering - use a Set to track rendered filePaths
      const renderedPaths = new Set();
      const finalUniqueModels = [];
      
      for (const modelData of uniqueModelsData) {
        const filePath = getFilePathFromModelData(modelData);
        if (!filePath) continue;
        
        const normalizedPath = normalizeFilePath(filePath);
        if (!renderedPaths.has(normalizedPath)) {
          renderedPaths.add(normalizedPath);
          finalUniqueModels.push(modelData);
        } else {
          console.warn(`[Tag Preview] Skipping duplicate model: ${filePath}`);
        }
      }
      
      if (finalUniqueModels.length !== uniqueModelsData.length) {
        console.log(`[Tag Preview] Final deduplication: ${uniqueModelsData.length} -> ${finalUniqueModels.length} models`);
      }

      // Create a container for multiple models (scrolling handled by parent)
      const modelsContainer = document.createElement('div');

      // Process each model - use for...of to support async operations
      for (const [index, modelData] of finalUniqueModels.entries()) {
        const { model, generatedTags, existingTags, errorMessage } = modelData;
        const fileName = model.fileName || model.filePath?.split(/[/\\]/).pop() || 'Unknown';
        const filePath = model.filePath || 'Unknown path';

        // Create model section with unique ID to prevent duplicate rendering
        const normalizedModelPath = normalizeFilePath(model.filePath);
        const existingSection = modelsContainer.querySelector(`[data-normalized-path="${normalizedModelPath}"]`);
        if (existingSection) {
          console.warn(`[Tag Preview] Skipping duplicate model section for: ${model.filePath}`);
          continue; // Skip if this model section already exists
        }
        
        const modelSection = document.createElement('div');
        modelSection.style.marginBottom = '25px';
        modelSection.style.padding = '15px';
        modelSection.style.backgroundColor = '#2a2a2a';
        modelSection.style.border = '1px solid #444';
        modelSection.style.borderRadius = '8px';
        modelSection.dataset.filePath = model.filePath;
        modelSection.dataset.normalizedPath = normalizedModelPath;

        // Model header with thumbnail
        const modelHeader = document.createElement('div');
        modelHeader.style.display = 'flex';
        modelHeader.style.gap = '12px';
        modelHeader.style.marginBottom = '12px';
        modelHeader.style.paddingBottom = '10px';
        modelHeader.style.borderBottom = '1px solid #444';
        
        // Thumbnail
        const thumbnailContainer = document.createElement('div');
        thumbnailContainer.style.flexShrink = '0';
        thumbnailContainer.style.width = '80px';
        thumbnailContainer.style.height = '80px';
        thumbnailContainer.style.backgroundColor = '#1a1a1a';
        thumbnailContainer.style.border = '1px solid #444';
        thumbnailContainer.style.borderRadius = '6px';
        thumbnailContainer.style.overflow = 'hidden';
        thumbnailContainer.style.display = 'flex';
        thumbnailContainer.style.alignItems = 'center';
        thumbnailContainer.style.justifyContent = 'center';
        
        const thumbnailImg = document.createElement('img');
        
        // Handle thumbnail loading - especially for 3MF files which may have thumbnails stored differently
        let thumbnailSrc = null;
        
        if (model.thumbnail) {
          // Check if it's a delimited string (multiple thumbnails)
          if (model.thumbnail.includes('::')) {
            const thumbnails = model.thumbnail.split('::').filter(t => 
              t && t !== '3d.png' && t.length > 0 && t.startsWith('data:image')
            );
            thumbnailSrc = thumbnails.length > 0 ? thumbnails[0] : null;
          } else if (model.thumbnail !== '3d.png' && model.thumbnail.startsWith('data:image')) {
            // Single thumbnail
            thumbnailSrc = model.thumbnail;
          }
        }
        
        // For 3MF files, try to get primary thumbnail from database if not found in model.thumbnail
        // Load asynchronously to avoid blocking — never getAllThumbnails for a single display slot
        (async () => {
          if (!thumbnailSrc && model.filePath && /\.(3mf|lys|f3d|chitubox|voxl)$/i.test(model.filePath)) {
            try {
              const primary = await fetchPrimaryThumbnailForGrid(model.filePath);
              if (primary) {
                thumbnailSrc = primary;
                thumbnailImg.src = thumbnailSrc;
                thumbnailImg.style.width = '100%';
                thumbnailImg.style.height = '100%';
                thumbnailImg.style.objectFit = 'cover';
              }
            } catch (e) {
              console.log('Could not fetch 3MF thumbnail from database:', e);
            }
          }
        })();
        
        if (thumbnailSrc) {
          thumbnailImg.src = thumbnailSrc;
          thumbnailImg.style.width = '100%';
          thumbnailImg.style.height = '100%';
          thumbnailImg.style.objectFit = 'cover';
          thumbnailImg.onerror = () => {
            // If image fails to load, show placeholder
            thumbnailImg.style.width = '40px';
            thumbnailImg.style.height = '40px';
            thumbnailImg.style.opacity = '0.3';
            thumbnailImg.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>';
          };
        } else {
          thumbnailImg.style.width = '40px';
          thumbnailImg.style.height = '40px';
          thumbnailImg.style.opacity = '0.3';
          thumbnailImg.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>';
        }
        thumbnailContainer.appendChild(thumbnailImg);
        
        // Model info
        const modelInfo = document.createElement('div');
        modelInfo.style.flex = '1';
        modelInfo.style.minWidth = '0';
        modelInfo.innerHTML = `
          <div style="color: #4a9eff; font-weight: 600; font-size: 15px; margin-bottom: 4px;">${fileName}</div>
          <div style="color: #999; font-size: 12px; word-break: break-all;">${filePath}</div>
        `;
        
        modelHeader.appendChild(thumbnailContainer);
        modelHeader.appendChild(modelInfo);
        modelSection.appendChild(modelHeader);

        // Existing tags
        if (existingTags.length > 0) {
          const existingDiv = document.createElement('div');
          existingDiv.style.marginBottom = '12px';
          const existingLabel = document.createElement('div');
          existingLabel.style.color = '#aaa';
          existingLabel.style.fontSize = '12px';
          existingLabel.style.marginBottom = '6px';
          existingLabel.textContent = `Existing tags (${existingTags.length}):`;

          const existingChips = document.createElement('div');
          existingChips.style.color = '#ccc';
          existingChips.style.lineHeight = '1.6';
          existingTags.forEach((t) => {
            const chip = document.createElement('span');
            chip.style.display = 'inline-block';
            chip.style.background = '#3a3a3a';
            chip.style.padding = '3px 6px';
            chip.style.margin = '2px';
            chip.style.borderRadius = '4px';
            chip.style.fontSize = '12px';
            chip.textContent = t;
            existingChips.appendChild(chip);
          });

          existingDiv.appendChild(existingLabel);
          existingDiv.appendChild(existingChips);
          modelSection.appendChild(existingDiv);
        }

        // Generated tags with checkboxes
        if (generatedTags && generatedTags.length > 0) {
          const generatedDiv = document.createElement('div');
          generatedDiv.style.color = '#fff';
          generatedDiv.style.fontWeight = '600';
          generatedDiv.style.marginBottom = '10px';
          generatedDiv.style.fontSize = '13px';
          generatedDiv.innerHTML = `Generated tags (${generatedTags.length}):`;
          modelSection.appendChild(generatedDiv);

          const tagList = document.createElement('div');
          tagList.style.display = 'flex';
          tagList.style.flexWrap = 'wrap';
          tagList.style.gap = '8px';
          tagList.style.marginBottom = '10px';

          generatedTags.forEach(tag => {
            const tagItem = document.createElement('label');
            tagItem.style.display = 'inline-flex';
            tagItem.style.alignItems = 'center';
            tagItem.style.padding = '6px 10px';
            tagItem.style.backgroundColor = '#3a3a3a';
            tagItem.style.border = '1px solid #555';
            tagItem.style.borderRadius = '6px';
            tagItem.style.cursor = 'pointer';
            tagItem.style.userSelect = 'none';
            tagItem.style.color = '#fff';
            tagItem.style.transition = 'all 0.2s ease';
            tagItem.style.fontSize = '13px';

            // Hover effect
            tagItem.addEventListener('mouseenter', () => {
              tagItem.style.backgroundColor = '#4a4a4a';
              tagItem.style.borderColor = '#666';
            });
            tagItem.addEventListener('mouseleave', () => {
              tagItem.style.backgroundColor = '#3a3a3a';
              tagItem.style.borderColor = '#555';
            });

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            // Restore checked state if it was previously set, otherwise default to true
            const stateKey = `${model.filePath}::${tag}`;
            const wasChecked = checkboxStates.has(stateKey) ? checkboxStates.get(stateKey) : true;
            checkbox.checked = wasChecked;
            if (!wasChecked && checkboxStates.has(stateKey)) {
              console.log(`Restored unchecked state for: ${stateKey}`);
            } else if (wasChecked && checkboxStates.has(stateKey)) {
              console.log(`Restored checked state for: ${stateKey}`);
            }
            checkbox.value = tag;
            checkbox.dataset.filePath = model.filePath;
            checkbox.style.marginRight = '6px';
            checkbox.style.width = '14px';
            checkbox.style.height = '14px';
            checkbox.style.cursor = 'pointer';
            checkbox.style.accentColor = '#4a9eff';

            const tagText = document.createElement('span');
            tagText.textContent = tag;
            tagText.style.color = '#fff';

            tagItem.appendChild(checkbox);
            tagItem.appendChild(tagText);
            tagList.appendChild(tagItem);
          });

          modelSection.appendChild(tagList);

          // Add Select All / Clear Selection buttons
          const buttonContainer = document.createElement('div');
          buttonContainer.style.display = 'flex';
          buttonContainer.style.gap = '12px';
          buttonContainer.style.marginTop = '8px';

          const selectAllBtn = document.createElement('button');
          selectAllBtn.textContent = 'Select All';
          selectAllBtn.style.background = 'none';
          selectAllBtn.style.border = 'none';
          selectAllBtn.style.color = '#fff';
          selectAllBtn.style.cursor = 'pointer';
          selectAllBtn.style.fontSize = '13px';
          selectAllBtn.style.padding = '4px 0';
          selectAllBtn.style.textDecoration = 'underline';
          selectAllBtn.style.textUnderlineOffset = '2px';
          selectAllBtn.addEventListener('mouseenter', () => {
            selectAllBtn.style.opacity = '0.7';
          });
          selectAllBtn.addEventListener('mouseleave', () => {
            selectAllBtn.style.opacity = '1';
          });
          selectAllBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const checkboxes = tagList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = true);
          });

          const clearSelectionBtn = document.createElement('button');
          clearSelectionBtn.textContent = 'Clear Selection';
          clearSelectionBtn.style.background = 'none';
          clearSelectionBtn.style.border = 'none';
          clearSelectionBtn.style.color = '#fff';
          clearSelectionBtn.style.cursor = 'pointer';
          clearSelectionBtn.style.fontSize = '13px';
          clearSelectionBtn.style.padding = '4px 0';
          clearSelectionBtn.style.textDecoration = 'underline';
          clearSelectionBtn.style.textUnderlineOffset = '2px';
          clearSelectionBtn.addEventListener('mouseenter', () => {
            clearSelectionBtn.style.opacity = '0.7';
          });
          clearSelectionBtn.addEventListener('mouseleave', () => {
            clearSelectionBtn.style.opacity = '1';
          });
          clearSelectionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const checkboxes = tagList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(cb => cb.checked = false);
          });

          buttonContainer.appendChild(selectAllBtn);
          buttonContainer.appendChild(clearSelectionBtn);
          modelSection.appendChild(buttonContainer);
        } else {
          // Show status for models with no tags
          const noTagsDiv = document.createElement('div');
          noTagsDiv.style.color = '#888';
          noTagsDiv.style.fontSize = '13px';
          noTagsDiv.style.fontStyle = 'italic';
          noTagsDiv.style.padding = '8px';
          noTagsDiv.style.backgroundColor = '#1a1a1a';
          noTagsDiv.style.borderRadius = '4px';
          noTagsDiv.style.border = '1px solid #333';
          
          // Check if tags are still being generated (undefined) vs failed (empty array)
          if (generatedTags === undefined) {
            noTagsDiv.textContent = 'Generating tags...';
            noTagsDiv.style.color = '#aaa';
          } else if (errorMessage && errorMessage.includes('Rate limit')) {
            // Show rate limit error message
            const detailedMessage = errorMessage.includes('Rate limit exceeded: ') 
              ? errorMessage.split('Rate limit exceeded: ')[1]
              : 'API rate limit has been exceeded. Please try again later.';
            noTagsDiv.textContent = `Rate limit exceeded: ${detailedMessage}`;
            noTagsDiv.style.color = '#ff6b6b';
            noTagsDiv.style.fontStyle = 'normal';
            noTagsDiv.style.border = '1px solid #ff6b6b';
          } else {
            noTagsDiv.textContent = 'No tags generated for this model';
            noTagsDiv.style.color = '#888';
          }
          modelSection.appendChild(noTagsDiv);
        }

        modelsContainer.appendChild(modelSection);
      }

      container.appendChild(modelsContainer);

      // Show merge strategy info (only once at the bottom)
      // Remove any existing strategy info first to prevent duplicates
      const existingStrategyInfo = container.querySelector('#tag-preview-merge-strategy');
      if (existingStrategyInfo) {
        existingStrategyInfo.remove();
      }
      
      const strategyInfo = document.createElement('div');
      strategyInfo.id = 'tag-preview-merge-strategy';
      strategyInfo.style.marginTop = '15px';
      strategyInfo.style.padding = '12px';
      strategyInfo.style.backgroundColor = '#2a3a4a';
      strategyInfo.style.border = '1px solid #4a5a6a';
      strategyInfo.style.borderRadius = '6px';
      strategyInfo.style.fontSize = '0.9em';
      strategyInfo.innerHTML = `<div style="color: #fff; font-weight: 600; margin-bottom: 6px;">Merge Strategy: <span style="color: #4a9eff;">${mergeStrategy}</span></div>` +
        `<div style="color: #bbb; line-height: 1.5;">${getMergeStrategyDescription(mergeStrategy)}</div>`;
      container.appendChild(strategyInfo);

      const statusEl = document.getElementById('tag-preview-status');
      if (statusEl) {
        const rateLimited = uniqueModelsData.find((modelData) => modelData.errorMessage && modelData.errorMessage.includes('Rate limit'));
        if (rateLimited) {
          const detail = rateLimited.errorMessage.includes('Rate limit exceeded: ')
            ? rateLimited.errorMessage.split('Rate limit exceeded: ')[1]
            : rateLimited.errorMessage;
          statusEl.hidden = false;
          statusEl.textContent = detail;
        } else {
          statusEl.hidden = true;
          statusEl.textContent = '';
        }
      }

      // Apply stays disabled only while this run is still waiting on models.
      // A stopped run (rate limit, error, or completion) can apply tags that already came back.
      const applyButton = document.getElementById('tag-preview-apply');
      if (applyButton) {
        const stillGenerating = batchTagGenerationInProgress && uniqueModelsData.some(modelData => modelData.generatedTags === undefined);
        
        if (stillGenerating) {
          applyButton.disabled = true;
          applyButton.style.opacity = '0.5';
          applyButton.style.cursor = 'not-allowed';
          applyButton.title = 'Please wait for tags to finish generating';
        } else {
          applyButton.disabled = false;
          applyButton.style.opacity = '1';
          applyButton.style.cursor = 'pointer';
          applyButton.title = '';
        }
      }

      // Update dialog title for multiple models
      const dialogTitle = dialog.querySelector('h3');
      if (dialogTitle) {
        const modelCount = pendingTagData.length;
        if (modelCount > 1 || batchTagGenerationInProgress) {
          const completedCount = pendingTagData.filter(d => d.generatedTags !== undefined).length;
          const tagsGeneratedCount = pendingTagData.filter(d => d.generatedTags && d.generatedTags.length > 0).length;
          let status = '';
          if (batchTagGenerationInProgress) {
            status = `(${completedCount}/${expectedBatchCount || modelCount} processed, ${tagsGeneratedCount} with tags)`;
          } else {
            status = `(${modelCount} models, ${tagsGeneratedCount} with tags)`;
          }
          dialogTitle.textContent = `Review Generated Tags ${status}`;
        } else {
          dialogTitle.textContent = 'Review Generated Tags';
        }
      }

    });
  }

  // Get description for merge strategy
  function getMergeStrategyDescription(strategy) {
    switch (strategy) {
      case 'merge':
        return 'Selected tags will be added to existing tags (duplicates removed)';
      case 'append':
        return 'Only new tags not already present will be added';
      case 'replace':
        return 'Existing tags will be replaced with selected tags';
      default:
        return 'Selected tags will be merged with existing tags';
    }
  }

  // Function to apply tags to model
  async function applyTagsToModel(filePath, selectedTags, existingTags, mergeStrategy) {
    try {
      const model = await window.electron.getModel(filePath);
      if (!model) {
        console.error(`Model not found for ${filePath}`);
        return;
      }

      let finalTags = [];

      switch (mergeStrategy) {
        case 'replace':
          // Replace all tags with selected tags
          finalTags = [...selectedTags, "AI Tagged"];
          break;
        case 'append':
          // Only add tags that don't already exist
          const existingSet = new Set(existingTags.map(t => t.toLowerCase()));
          finalTags = [...existingTags];
          selectedTags.forEach(tag => {
            if (!existingSet.has(tag.toLowerCase())) {
              finalTags.push(tag);
            }
          });
          finalTags.push("AI Tagged");
          break;
        case 'merge':
        default:
          // Merge all tags, removing duplicates
          finalTags = Array.from(new Set([...existingTags, ...selectedTags, "AI Tagged"]));
          break;
      }

      // Update the model data with the new tag list
      await window.electron.saveModel({ ...model, tags: finalTags });

      // Update the model element in the grid/UI
      await updateModelElement(filePath);
      
      // Refresh the tags in the Edit Model Details view if it's showing the current model
      const currentModelPath = getCurrentModelFilePath();
      if (currentModelPath === filePath) {
        await loadModelTags(filePath);
      }

      console.log(`Tags updated for model: ${filePath}`);
    } catch (error) {
      console.error(`Error applying tags to model ${filePath}:`, error);
      throw error;
    }
  }

  // Tag preview dialog handlers
  document.getElementById('tag-preview-apply')?.addEventListener('click', async () => {
    if (!pendingTagData || pendingTagData.length === 0) {
      console.error('No pending tag data');
      await window.electron.showMessage('Info', 'No models to process.');
      return;
    }

    const container = document.getElementById('tag-preview-container');
    if (!container) {
      console.error('Tag preview container not found');
      await window.electron.showMessage('Error', 'Tag preview container not found');
      return;
    }
    
    const mergeStrategy = await window.electron.getSetting('aiTagMergeStrategy') || 'merge';

    let successCount = 0;
    let failCount = 0;
    let totalTagsApplied = 0;

    try {
      // Debug: Log all model sections in container
      const allSectionsInContainer = container.querySelectorAll('div[data-file-path]');
      console.log(`\n=== Starting tag application ===`);
      console.log(`Total model sections found in container: ${allSectionsInContainer.length}`);
      console.log('Section file paths:', Array.from(allSectionsInContainer).map(s => s.dataset.filePath));
      console.log(`Total models in pendingTagData: ${pendingTagData.length}`);
      console.log('Pending tag data file paths:', pendingTagData.map(d => d.model?.filePath || d.filePath));
      console.log('Pending tag data structure:', pendingTagData.map(d => ({
        hasModel: !!d.model,
        filePath: d.filePath,
        modelFilePath: d.model?.filePath,
        generatedTagsCount: d.generatedTags?.length || 0,
        hasGeneratedTags: !!(d.generatedTags && d.generatedTags.length > 0)
      })));
      
      // Build models to process from DOM sections (source of truth) instead of pendingTagData
      // This ensures we process all visible models even if pendingTagData is incomplete
      const modelsToProcess = [];
      const processedFilePaths = new Set(); // Track duplicates
      
      for (const section of allSectionsInContainer) {
        const filePath = section.dataset.filePath;
        if (!filePath) {
          console.warn('Found section without file path, skipping');
          continue;
        }
        
        // Skip duplicates (some models might appear twice in the DOM)
        if (processedFilePaths.has(filePath)) {
          console.log(`Skipping duplicate model: ${filePath}`);
          continue;
        }
        processedFilePaths.add(filePath);
        
        // Try to find corresponding data in pendingTagData for existing tags info
        const modelData = pendingTagData.find(d => 
          (d.model?.filePath === filePath) || (d.filePath === filePath)
        );
        
        modelsToProcess.push({
          filePath: filePath,
          section: section,
          existingTags: modelData?.existingTags || [],
          modelData: modelData // Keep reference for any other needed data
        });
      }
      
      console.log(`Will process ${modelsToProcess.length} models from DOM sections`);
      console.log(`pendingTagData has ${pendingTagData.length} models`);
      
      if (modelsToProcess.length !== pendingTagData.length) {
        console.warn(`Mismatch: DOM has ${modelsToProcess.length} models, pendingTagData has ${pendingTagData.length}`);
        console.warn('Processing all models from DOM (source of truth)');
      }
      
      // Filter models that have selected tags before processing
      const modelsWithTags = [];
      for (const modelInfo of modelsToProcess) {
        const targetFilePath = modelInfo.filePath;
        const modelSection = modelInfo.section;
        
        // Get selected tags for this specific model from within its section
        let allCheckboxes = modelSection.querySelectorAll('input[type="checkbox"]');
        let checkedCheckboxes = modelSection.querySelectorAll('input[type="checkbox"]:checked');
        
        // Fallback: if no checkboxes found in section, try finding by filePath in entire container
        if (allCheckboxes.length === 0) {
          try {
            const escapedPath = targetFilePath.replace(/[!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~]/g, '\\$&');
            const fallbackCheckboxes = container.querySelectorAll(`input[type="checkbox"][data-file-path="${escapedPath}"]`);
            if (fallbackCheckboxes.length > 0) {
              allCheckboxes = fallbackCheckboxes;
              checkedCheckboxes = container.querySelectorAll(`input[type="checkbox"][data-file-path="${escapedPath}"]:checked`);
            }
          } catch (e) {
            // Try alternative fallback
            const allCheckboxesInContainer = container.querySelectorAll('input[type="checkbox"]');
            const matchingCheckboxes = Array.from(allCheckboxesInContainer).filter(cb => 
              cb.dataset.filePath === targetFilePath ||
              (modelInfo.modelData?.model?.filePath && cb.dataset.filePath === modelInfo.modelData.model.filePath) ||
              (modelInfo.modelData?.filePath && cb.dataset.filePath === modelInfo.modelData.filePath)
            );
            if (matchingCheckboxes.length > 0) {
              allCheckboxes = matchingCheckboxes;
              checkedCheckboxes = matchingCheckboxes.filter(cb => cb.checked);
            }
          }
        }
        
        const selectedTags = Array.from(checkedCheckboxes).map(cb => cb.value);
        
        if (selectedTags.length > 0) {
          modelsWithTags.push({
            ...modelInfo,
            selectedTags: selectedTags
          });
        }
      }
      
      if (modelsWithTags.length === 0) {
        const allCheckedBoxes = container.querySelectorAll('input[type="checkbox"]:checked');
        if (allCheckedBoxes.length === 0) {
          await window.electron.showMessage('Info', 'No tags were selected to apply.');
        } else {
          await window.electron.showMessage('Warning', 'Tags were selected but could not be applied. Please check the console for details.');
        }
        const tagPreviewDialog = document.getElementById('tag-preview-dialog');
        if (tagPreviewDialog?.open) tagPreviewDialog.close();
        pendingTagData = [];
        return;
      }
      
      // Show progress dialog
      const progressDialog = document.getElementById('progress-dialog');
      const progressTitle = document.getElementById('progress-title');
      const progressMessage = document.getElementById('progress-message');
      const progressBar = document.getElementById('progress-bar');
      const progressStatus = document.getElementById('progress-status');
      
      if (progressDialog && progressTitle && progressMessage && progressBar && progressStatus) {
        progressTitle.textContent = 'Applying Tags';
        progressMessage.textContent = 'Processing models...';
        progressBar.style.width = '0%';
        progressStatus.textContent = `0 / ${modelsWithTags.length}`;
        progressDialog.showModal();
      }
      
      // Process models in parallel batches (5 at a time)
      const BATCH_SIZE = 5;
      let processedCount = 0;
      
      for (let i = 0; i < modelsWithTags.length; i += BATCH_SIZE) {
        const batch = modelsWithTags.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (modelInfo) => {
          const targetFilePath = modelInfo.filePath;
          const selectedTags = modelInfo.selectedTags;
          
          try {
            console.log(`Applying ${selectedTags.length} tags to model: ${targetFilePath}`);
            await applyTagsToModel(
              targetFilePath,
              selectedTags,
              modelInfo.existingTags || [],
              mergeStrategy
            );
            
            processedCount++;
            const fileName = targetFilePath.split(/[/\\]/).pop() || targetFilePath;
            
            // Update progress
            if (progressDialog && progressMessage && progressBar && progressStatus) {
              const percentage = (processedCount / modelsWithTags.length) * 100;
              progressBar.style.width = `${percentage}%`;
              progressMessage.textContent = `Processing: ${fileName}`;
              progressStatus.textContent = `${processedCount} / ${modelsWithTags.length}`;
            }
            
            successCount++;
            totalTagsApplied += selectedTags.length;
            console.log(`Successfully applied tags to ${targetFilePath}`);
            return { success: true, filePath: targetFilePath, tagsCount: selectedTags.length };
          } catch (error) {
            processedCount++;
            console.error(`Error applying tags to ${targetFilePath}:`, error);
            failCount++;
            
            // Update progress even on error
            if (progressDialog && progressBar && progressStatus) {
              const percentage = (processedCount / modelsWithTags.length) * 100;
              progressBar.style.width = `${percentage}%`;
              progressStatus.textContent = `${processedCount} / ${modelsWithTags.length}`;
            }
            
            return { success: false, filePath: targetFilePath, error: error.message };
          }
        });
        
        // Wait for batch to complete before starting next batch
        await Promise.all(batchPromises);
      }
      
      // Close progress dialog
      if (progressDialog) {
        progressDialog.close();
      }
      
      console.log(`\n=== Finished processing all models ===`);
      console.log(`Total processed: ${processedCount}, Success: ${successCount}, Failed: ${failCount}, Total tags: ${totalTagsApplied}`);

      // Show results
      if (successCount > 0) {
        const message = failCount > 0
          ? `Tags applied to ${successCount} model(s) (${failCount} failed). ${totalTagsApplied} tag(s) applied.`
          : `Tags applied successfully to ${successCount} model(s)! ${totalTagsApplied} tag(s) applied.`;
        await window.electron.showMessage('Success', message);
        
        // Refresh the tag filter dropdown to include any new tags
        await populateTagFilter();
      } else if (totalTagsApplied === 0) {
        // Only show "no tags selected" if we actually processed models but found no selected tags
        // Check if we have any checked checkboxes at all in the container
        const allCheckedBoxes = container.querySelectorAll('input[type="checkbox"]:checked');
        if (allCheckedBoxes.length === 0) {
          await window.electron.showMessage('Info', 'No tags were selected to apply.');
        } else {
          // Tags were checked but couldn't be applied - show different message
          await window.electron.showMessage('Warning', 'Tags were selected but could not be applied. Please check the console for details.');
        }
      }

      const tagPreviewDialog = document.getElementById('tag-preview-dialog');
      if (tagPreviewDialog?.open) tagPreviewDialog.close();
      pendingTagData = [];
    } catch (error) {
      console.error('Error applying tags:', error);
      await window.electron.showMessage('Error', 'Failed to apply tags: ' + error.message);
    }
  });

  document.getElementById('tag-preview-dialog')?.addEventListener('close', () => {
    suppressTagPreviewReopen = true;
    reviewDialogOpen = false;
    pendingTagData = [];
    batchTagGenerationInProgress = false;
    rateLimitDialogShown = false;
  });

  document.getElementById('tag-preview-cancel')?.addEventListener('click', () => {
    const tagPreviewDialog = document.getElementById('tag-preview-dialog');
    if (tagPreviewDialog?.open) tagPreviewDialog.close();
  });
  
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
    highlightModelWithoutDetails(filePath);
  });

  // Fetch models without thumbnails
  const modelsWithoutThumbnails = await window.electron.getModelsWithoutThumbnails();
  const modelsCount = modelsWithoutThumbnails.length;

  // Add missing function renderThumbnail used in generateThumbnail().
  async function renderThumbnail(file) {
    try {
      // Determine filePath: if file is a string, use it directly; otherwise, assume it's an object with filePath property.
      const filePath = (typeof file === 'string') ? file : file.filePath;
      if (!filePath) {
        throw new Error("renderThumbnail: filePath is undefined");
      }
      // Create a temporary container (not attached to DOM — retainDetached required)
      const tempContainer = document.createElement('div');
      // Call renderModelToPNG with the filePath; no existing thumbnail provided.
      const thumbnail = await renderModelToPNG(filePath, tempContainer, null, {
        retainDetached: true
      });
      return thumbnail;
    } catch (error) {
      console.error("Error in renderThumbnail:", error);
      throw error;
    }
  }

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
        renderFiles(models);
        
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

  // Modify the prompt handler
  async function promptPendingThumbnails() {
    try {
      const modelsWithoutThumbs = await window.electron.getModelsWithoutThumbnails();
      if (modelsWithoutThumbs.length > 0) {
        totalThumbnailsToGenerate = modelsWithoutThumbs.length;
        generatedThumbnailsCount = 0;
        
        // Process in batches
        // UI is now handled inside generateThumbnailsForModels
        await generateThumbnailsForModels(modelsWithoutThumbs);
      }
    } catch (error) {
      console.error('Error in thumbnail generation:', error);
    }
  }

  // Add this to the generateThumbnail function
  function updateProgress() {
    generatedThumbnailsCount++;
    const progress = Math.floor((generatedThumbnailsCount / totalThumbnailsToGenerate) * 100);
    progressBar.style.width = `${progress}%`;
    progressText.textContent = `${generatedThumbnailsCount}/${totalThumbnailsToGenerate} (${progress}%)`;
  }

  // Add function for generating thumbnails for multiple models
  async function generateThumbnailsForModels(models, options = {}) {
    const headless = !!options.headless;
    const cancelRef = options.cancelRef || null;
    const skipHash = !!options.skipHash;
    const progressOffset = typeof options.progressOffset === 'number' ? options.progressOffset : 0;
    const progressTotal = typeof options.progressTotal === 'number' ? options.progressTotal : models.length;
    console.log(`[DEBUG] generateThumbnailsForModels: Starting thumbnail generation for ${models.length} models.`);
    
    // Check if we're in server mode (Docker typically runs in server mode)
    // Hidden worker must stay at concurrency 1 (shared WebGL + SwiftShader RAM).
    const serverMode = await window.electron.isServerMode().catch(() => false);
    const isWorker = await isServerThumbnailWorkerContext();
    const maxConcurrentThumbnails = typeof options.maxConcurrent === 'number'
      ? options.maxConcurrent
      : (isWorker || headless ? 1 : (serverMode ? 3 : 3));
    
    // New progress UI elements (Sidebar)
    const progressSection = document.getElementById('progress-section');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const renderProgressContainer = document.getElementById('render-progress-container');
    const renderProgressBar = document.getElementById('render-progress-bar');
    const renderProgressText = document.getElementById('render-progress-text');
    const stopButton = document.getElementById('stop-thumbnail-generation');

    // Use render progress bar for thumbnail generation
    const activeProgressBar = renderProgressBar;
    const activeProgressText = renderProgressText;
    
    // Check if progress elements exist before proceeding
    const hasProgressUI = !headless && progressSection && activeProgressBar && activeProgressText;
    
    const overlay = headless ? null : window.ThumbnailProgress;

    totalThumbnailsToGenerate = progressTotal;
    generatedThumbnailsCount = progressOffset;
    let isCancelled = false;
    let processedInBatch = 0;

    const reportHeadlessProgress = async (processed, total, phase) => {
      if (!headless || typeof window.electron.reportServerThumbnailProgress !== 'function') return;
      try {
        await window.electron.reportServerThumbnailProgress({
          processed,
          total,
          phase: phase || `Processing ${processed}/${total}`,
          mode: options.mode || null
        });
      } catch (err) {
        console.warn('[Server thumbnails] progress report failed:', err);
      }
    };

    // Handle stop button
    const handleStopClick = () => {
        isCancelled = true;
        if (cancelRef) cancelRef.cancelled = true;
        if (activeProgressText) activeProgressText.textContent = 'Stopping...';
    };
    if (stopButton && !headless) {
        // Remove existing listener if any (to avoid duplicates)
        stopButton.replaceWith(stopButton.cloneNode(true));
        const newStopButton = document.getElementById('stop-thumbnail-generation');
        newStopButton.addEventListener('click', handleStopClick);
        newStopButton.style.display = 'block';
    }

    try {
      // Show progress section
      if (hasProgressUI) {
        progressSection.classList.remove('hidden');
        renderProgressContainer.classList.remove('hidden');
        // Hide the file scan progress as we are only generating thumbnails
        if (progressContainer) progressContainer.classList.add('hidden'); 
        
        activeProgressBar.style.width = '0%';
        activeProgressText.textContent = `Processing ${progressOffset}/${progressTotal} (0%)`;
      }

      if (overlay) {
        overlay.show({ title: options.title || 'Generating Thumbnails', total: progressTotal });
        overlay.update(progressOffset, progressTotal, `Generating thumbnails for ${progressTotal} model${progressTotal === 1 ? '' : 's'}...`);
        overlay.onCancel(handleStopClick);
      }

      if (progressOffset === 0) {
        await reportHeadlessProgress(0, progressTotal, `Generating thumbnails for ${progressTotal} model${progressTotal === 1 ? '' : 's'}...`);
      }
      
      // Process models in parallel with concurrency control for better performance
      const modelQueue = [...models];
      const activePromises = new Set();
      let processedCount = 0;
      
      const processModel = async (model) => {
        let thumbnail = null;
        const pathForExt = model.filePath.includes('::') ? (model.filePath.split('::')[1] || '') : model.filePath;
        const fileExt = pathForExt.split('.').pop().toLowerCase();
        
        try {
          // 0. Non-previewable types: use typed placeholder (file type label)
          if (!isRenderable3dExtension(fileExt) && fileExt !== 'svg' && fileExt !== 'lys' && !isImageOnlyPreviewExt(fileExt)) {
            thumbnail = generateTypedPlaceholder(fileExt);
            await window.electron.saveThumbnail(model.filePath, thumbnail);
            if (!skipHash && (!model.hash || model.hash === '')) {
              try { await window.electron.calculateFileHash(model.filePath); } catch (e) { /* ignore */ }
            }
            return;
          }
          
          // 0b. SVG: try to load as image data URL; on failure use typed placeholder
          if (fileExt === 'svg') {
            try {
              const buf = await window.electron.readModelFile(model.filePath);
              if (buf && (buf instanceof ArrayBuffer || buf.byteLength)) {
                const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
                const decoder = new TextDecoder();
                const svgText = decoder.decode(bytes);
                thumbnail = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
              }
            } catch (e) { /* ignore */ }
            if (!thumbnail || !thumbnail.startsWith('data:image')) {
              thumbnail = generateTypedPlaceholder('svg');
            }
            await window.electron.saveThumbnail(model.filePath, thumbnail);
            if (!skipHash && (!model.hash || model.hash === '')) {
              try { await window.electron.calculateFileHash(model.filePath); } catch (e) { /* ignore */ }
            }
            return;
          }

          // 0c. Image-only previews: F3D / ChiTuBox / VOXL embedded thumbs (no mesh)
          if (isImageOnlyPreviewExt(fileExt)) {
            console.log(
              `[DEBUG] generateThumbnailsForModels: Attempting to extract embedded thumbnail for ${model.filePath}`
            );
            try {
              const embeddedImages = await extractEmbeddedPreviewImages(model.filePath, fileExt);
              if (embeddedImages && embeddedImages.length > 0) {
                const validImages = embeddedImages.filter(
                  (im) => typeof im === 'string' && im.startsWith('data:image')
                );
                if (validImages.length > 0) {
                  thumbnail = validImages[0];
                  await window.electron.addMultipleThumbnails(model.filePath, validImages);
                  console.log(
                    `[DEBUG] generateThumbnailsForModels: SUCCESS - Saved ${validImages.length} embedded image(s) for ${model.filePath}`
                  );
                  if (!skipHash && (!model.hash || model.hash === '')) {
                    try { await window.electron.calculateFileHash(model.filePath); } catch (e) { /* ignore */ }
                  }
                  return;
                }
                console.log(
                  `[DEBUG] generateThumbnailsForModels: Invalid image format for ${model.filePath}`
                );
              } else {
                console.log(
                  `[DEBUG] generateThumbnailsForModels: No embedded thumbnail found for ${model.filePath} (${fileExt}). Saving placeholder.`
                );
              }
            } catch (embeddedError) {
              console.error(
                `[DEBUG] generateThumbnailsForModels: Error extracting embedded image from ${fileExt.toUpperCase()}: ${model.filePath}`,
                embeddedError
              );
            }
            // Leave retryable — typed placeholders used to stick forever on Docker grids.
            await window.electron.saveThumbnail(model.filePath, '3d.png');
            if (!skipHash && (!model.hash || model.hash === '')) {
              try { await window.electron.calculateFileHash(model.filePath); } catch (e) { /* ignore */ }
            }
            return;
          }

          // 0d. LYS: pull embedded preview.png; otherwise render the mesh
          if (fileExt === 'lys') {
            console.log(
              `[DEBUG] generateThumbnailsForModels: Attempting to extract embedded thumbnail for ${model.filePath}`
            );
            try {
              const embeddedImages = await extractLYSThumbnail(model.filePath);
              if (embeddedImages && embeddedImages.length > 0) {
                const validImages = embeddedImages.filter(
                  (im) => typeof im === 'string' && im.startsWith('data:image')
                );
                if (validImages.length > 0) {
                  thumbnail = validImages[0];
                  await window.electron.addMultipleThumbnails(model.filePath, validImages);
                  console.log(
                    `[DEBUG] generateThumbnailsForModels: SUCCESS - Saved ${validImages.length} embedded image(s) for ${model.filePath}`
                  );
                  if (!skipHash && (!model.hash || model.hash === '')) {
                    try { await window.electron.calculateFileHash(model.filePath); } catch (e) { /* ignore */ }
                  }
                  return;
                }
                console.log(
                  `[DEBUG] generateThumbnailsForModels: Invalid image format for ${model.filePath}`
                );
              } else {
                console.log(
                  `[DEBUG] generateThumbnailsForModels: No embedded thumbnail found for ${model.filePath}. Falling back to 3D rendering.`
                );
              }
            } catch (embeddedError) {
              console.error(
                `[DEBUG] generateThumbnailsForModels: Error extracting embedded image from LYS: ${model.filePath}`,
                embeddedError
              );
            }
          }
          
          // 1. Try to get embedded images for 3MF (all packed into DB for Manage Thumbnails)
          let saved3mfEmbedsViaBatch = false;
          if (model.filePath.toLowerCase().endsWith('.3mf')) {
            console.log(`[DEBUG] generateThumbnailsForModels: Attempting to extract embedded thumbnail for ${model.filePath}`);
            try {
              const embeddedImages = await extract3MFThumbnail(model.filePath);
              if (embeddedImages && embeddedImages.length > 0) {
                const validImages = embeddedImages.filter(
                  (im) => typeof im === 'string' && im.startsWith('data:image')
                );
                if (validImages.length > 0) {
                  thumbnail = validImages[0];
                  await window.electron.addMultipleThumbnails(model.filePath, validImages);
                  saved3mfEmbedsViaBatch = true;
                  console.log(
                    `[DEBUG] generateThumbnailsForModels: SUCCESS - Saved ${validImages.length} embedded image(s) for ${model.filePath}`
                  );
                } else {
                  console.log(`[DEBUG] generateThumbnailsForModels: Invalid image format for ${model.filePath}`);
                }
              } else {
                console.log(`[DEBUG] generateThumbnailsForModels: No embedded thumbnail found for ${model.filePath}. Falling back to 3D rendering.`);
              }
            } catch (embeddedError) {
              console.error(`Error extracting embedded image from 3MF: ${model.filePath}`, embeddedError);
            }
          }

          // 2. If no embedded thumbnail, try 3D rendering
          if (!thumbnail) {
            console.log(`[DEBUG] generateThumbnailsForModels: Rendering 3D model for ${model.filePath}`);
            try {
              thumbnail = await generateThumbnail(model.filePath);
            } catch (renderError) {
              console.error(`Error generating 3D thumbnail for ${model.filePath}:`, renderError);
            }
          }

          // 3. Validate and fallback to default if necessary (STL/3MF only reach here)
          if (!thumbnail || typeof thumbnail !== 'string' || !thumbnail.startsWith('data:image') || isFailurePlaceholderThumbnail(thumbnail)) {
            thumbnail = '3d.png';
          }

          // 4. Save real renders only — never lock in failure placeholders
          if (!saved3mfEmbedsViaBatch && thumbnail !== '3d.png') {
            await window.electron.saveThumbnail(model.filePath, thumbnail);
          } else if (!saved3mfEmbedsViaBatch) {
            await window.electron.saveThumbnail(model.filePath, '3d.png');
          }
          
          // 5. Hash during bulk jobs is optional (extra I/O / memory); skip in Docker headless.
          if (!skipHash && (!model.hash || model.hash === '')) {
            try {
              await window.electron.calculateFileHash(model.filePath);
            } catch (hashError) {
              console.error(`Error calculating hash for ${model.filePath}:`, hashError);
              // Continue even if hash calculation fails
            }
          }

          thumbnail = null;
          
        } catch (error) {
          console.error(`Failed to generate thumbnail for ${model.filePath}:`, error);
          // Do not persist typed STL/3MF placeholders — that blocks retries (common on Docker timeouts).
          try {
            await window.electron.saveThumbnail(model.filePath, '3d.png');
          } catch (saveError) {
            console.error(`Failed to save default thumbnail for ${model.filePath}:`, saveError);
          }
        } finally {
          processedInBatch++;
          processedCount = processedInBatch;
          const absoluteProcessed = progressOffset + processedInBatch;
          generatedThumbnailsCount = absoluteProcessed;
          
          // Update progress
          if (hasProgressUI) {
            const progress = Math.floor((absoluteProcessed / progressTotal) * 100);
            activeProgressBar.style.width = `${progress}%`;
            activeProgressText.textContent = `Processing ${absoluteProcessed}/${progressTotal} (${progress}%)`;
          }
          if (overlay && !isCancelled) {
            overlay.update(absoluteProcessed, progressTotal);
          }
          if (!isCancelled) {
            await reportHeadlessProgress(absoluteProcessed, progressTotal);
          }

          // Between models: yield + occasional soft GC. Soft dispose only —
          // never forceContextLoss (restarts GPU process → Skia OOM log storms).
          if (maxConcurrentThumbnails === 1) {
            await new Promise((r) => setTimeout(r, 25));
            if (processedInBatch % 15 === 0 && window.thumbnailRenderer) {
              await window.thumbnailRenderer.reset();
              await new Promise((r) => setTimeout(r, 50));
            } else if (typeof gc === 'function' && processedInBatch % 5 === 0) {
              try { gc(); } catch (_) { /* ignore */ }
            }
          }
        }
      };
      
      // Process models with concurrency control
      while (modelQueue.length > 0 && !isCancelled && !(cancelRef && cancelRef.cancelled)) {
        if (cancelRef && cancelRef.cancelled) {
          isCancelled = true;
          break;
        }
        // Fill up to max concurrent thumbnails
        while (activePromises.size < maxConcurrentThumbnails && modelQueue.length > 0) {
          const model = modelQueue.shift();
          const promise = processModel(model).finally(() => {
            activePromises.delete(promise);
          });
          activePromises.add(promise);
        }

        if (hasProgressUI && progressTotal > 0) {
          const done = Math.min(generatedThumbnailsCount, progressTotal);
          activeProgressText.textContent = `Processing ${done}/${progressTotal} (${activePromises.size} active)`;
        }
        
        // Wait for at least one promise to complete before continuing
        if (activePromises.size > 0) {
          await Promise.race(Array.from(activePromises));
        }
      }
      
      // Wait for any remaining active promises to complete
      if (activePromises.size > 0) {
        await Promise.all(Array.from(activePromises));
      }

      if (cancelRef && cancelRef.cancelled) {
        isCancelled = true;
      }

      // Update final progress
      const finalProcessed = progressOffset + processedInBatch;
      if (hasProgressUI && !isCancelled && finalProcessed >= progressTotal) {
        activeProgressBar.style.width = '100%';
        activeProgressText.textContent = `Completed ${progressTotal}/${progressTotal} (100%)`;
      }
      if (overlay && !isCancelled && finalProcessed >= progressTotal) {
        overlay.update(progressTotal, progressTotal);
      }
      if (!isCancelled && finalProcessed >= progressTotal) {
        await reportHeadlessProgress(progressTotal, progressTotal, 'Finished.');
      }
      
    } catch (error) {
      console.error('Error in thumbnail generation:', error);
      if (headless) throw error;
    } finally {
      // Hide progress section after a short delay
      if (hasProgressUI) {
        setTimeout(() => {
             progressSection.classList.add('hidden');
        }, 2000);
      }
      if (overlay) {
        overlay.complete(isCancelled ? 'Stopped.' : 'Finished.');
      }
    }

    return { cancelled: isCancelled, count: models.length };
  }

  window.generateThumbnailsForModels = generateThumbnailsForModels;

  // Hidden Docker worker: once the generator exists, skip the rest of this UI init path
  // (virtual grid / library load) so it does not compete for RAM with bulk thumbs.
  if (await isServerThumbnailWorkerContext()) {
    console.log('[Server thumbnails] Worker window: generateThumbnails ready; skipping remaining UI init');
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

/** Select every model the current filters show (not only the rendered cards). */
async function selectAllVisibleModels() {
  try {
    const getFilteredModels = await waitForGetCombinedFilteredModels();
    const filteredModels = await getFilteredModels();
    window.selection.set(filteredModels.map((model) => model && model.filePath).filter(Boolean));
  } catch (error) {
    console.error('Error selecting all models:', error);
  }
}

/** Clear Selection in the multi-edit panel (stays in multi-edit mode). */
function clearMultiSelection() {
  window.selection.clear();
  clearMultiEditFormFields();
}



function isMobileUiActive() {
  return document.body.classList.contains('mobile-ui');
}

function clearMobileTileFocus() {
  document.querySelectorAll('.is-mobile-focus').forEach((el) => el.classList.remove('is-mobile-focus'));
}

function focusMobileTile(fileElement) {
  clearMobileTileFocus();
  fileElement.classList.add('is-mobile-focus');
}

function selectSingleModel(fileElement, filePath) {
  window.selection.set([filePath]);
}

function isGridBackgroundClickTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('dialog, .modal, #html-context-menu, #html-context-menu-backdrop')) return false;
  if (target.closest('.file-item, .parent-model-group, .list-view-header')) return false;
  if (target.closest('.sidebar, #folder-rail, #folder-tree-popover, .grid-view-selector')) return false;
  if (target.closest('#model-details, #bundle-details, #multi-edit-panel')) return false;
  if (target.closest('button, a, input, select, textarea, label')) return false;
  return Boolean(
    target.classList.contains('file-grid') ||
    target.classList.contains('virtual-spacer') ||
    target.classList.contains('virtual-content') ||
    target.closest('.file-grid')
  );
}

function isFileGridScrollbarClick(event, grid) {
  if (!grid) return false;
  const rect = grid.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  return x >= grid.clientWidth || y >= grid.clientHeight;
}

function clearGridItemSelection() {
  currentModelDetailsAbort = true;
  currentModelDetailsPath = null;
  window.selection.clear();
  clearMobileTileFocus();
  document.getElementById('model-details')?.classList.add('hidden');
  window.detailsFields?.clear();
  const bundlePanel = document.getElementById('bundle-details');
  if (bundlePanel && !bundlePanel.classList.contains('hidden') && typeof hideBundleDetailsPanel === 'function') {
    hideBundleDetailsPanel();
  }
}

function bindGridBackgroundDeselect() {
  const grid = document.querySelector('.file-grid');
  if (!grid || grid._backgroundDeselectBound) return;
  grid._backgroundDeselectBound = true;
  grid.addEventListener('click', (event) => {
    if (isMultiSelectMode) return;
    if (isFileGridScrollbarClick(event, grid)) return;
    if (!isGridBackgroundClickTarget(event.target)) return;
    clearGridItemSelection();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindGridBackgroundDeselect);
} else {
  bindGridBackgroundDeselect();
}

function highlightModelWithoutDetails(filePath) {
  if (filePath) window.selection.set([filePath]);
}

function openModelDetailsFromTile(fileElement, filePath) {
  if (fileElement?._suppressTap) return;
  if (isMultiSelectMode) {
    toggleModelSelection(fileElement, filePath);
    return;
  }
  selectSingleModel(fileElement, filePath);
  showModelDetails(filePath);
}

function openModelPreviewFromTile(filePath) {
  if (typeof window.openPreview === 'function') {
    window.openPreview(filePath);
  }
}

/** A plain click on a card: select it and show its details, or toggle it in multi-edit. */
async function toggleModelSelection(fileElement, filePath) {
  if (fileElement?._suppressTap) return;
  if (isMultiSelectMode) {
    window.selection.toggle(filePath);
    return;
  }
  if (window.selection.size === 1 && window.selection.has(filePath)) {
    // Clicking the selected card again unselects it and closes its details.
    window.selection.clear();
    document.getElementById('model-details')?.classList.add('hidden');
    return;
  }
  window.selection.set([filePath]);
  showModelDetails(filePath);
}

// NOTE: loadModel function is defined earlier in the file (around line 2840)
// This duplicate has been removed to use the enhanced version that checks for embedded images


/** True when a thumbnail data-URL is effectively empty (transparent / clipped render). */
function isMostlyEmptyThumbnailDataUrl(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
      resolve(true);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const w = Math.min(64, img.width || 64);
        const h = Math.min(64, img.height || 64);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(false);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        const pixels = ctx.getImageData(0, 0, w, h).data;
        let opaque = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 12) opaque += 1;
        }
        // Less than 0.5% opaque pixels ≈ blank (model clipped or failed).
        resolve(opaque < w * h * 0.005);
      } catch (error) {
        resolve(false);
      }
    };
    img.onerror = () => resolve(true);
    img.src = dataUrl;
  });
}

function handleContextLost(event) {
  event.preventDefault();
  
  // Properly clean up resources
  if (scene) {
    scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        if (Array.isArray(object.material)) {
          object.material.forEach(material => material.dispose());
        } else {
          object.material.dispose();
        }
      }
    });
    scene.clear();
  }
  
  renderer = null;
  scene = null;
  camera = null;
}

function handleContextRestored() {
  console.log('WebGL context restored');
  // Renderer will be recreated on next render
}

// Update showSpinner function to show progress section instead
function showProgressBars() {
  const progressSection = document.getElementById('progress-section');
  const progressBar = document.getElementById('progress-bar');
  const renderProgressBar = document.getElementById('render-progress-bar');
  const progressText = document.getElementById('progress-text');
  const renderProgressText = document.getElementById('render-progress-text');
  
  progressSection.classList.remove('hidden');
  progressBar.style.width = '0%';
  renderProgressBar.style.width = '0%';
  progressText.textContent = '0 / 0 files';
  renderProgressText.textContent = '0 / 0 models';
}

// Update hideSpinner function
function hideProgressBars() {
  const progressSection = document.getElementById('progress-section');
  progressSection.classList.add('hidden');
}

// Update function signature to include background and isStlHomeScan parameters
const HIDE_SKIPPED_FILE_SIZE_NOTICE_KEY = 'hideSkippedFileSizeNotice';

function skippedFileSizeNoticeMessage(count) {
  if (count === 1) {
    return '1 file was skipped because it is larger than the max file size. You can set the max file size under Settings > Performance.';
  }
  return `${count} files were skipped because they are larger than the max file size. You can set the max file size under Settings > Performance.`;
}

async function maybeShowSkippedFileSizeNotice(count) {
  const skipped = Number(count) || 0;
  if (skipped <= 0) return;
  if (!window.electron || typeof window.electron.getSetting !== 'function' || typeof window.electron.showMessageBox !== 'function') {
    return;
  }
  const hidden = await window.electron.getSetting(HIDE_SKIPPED_FILE_SIZE_NOTICE_KEY);
  if (hidden === '1') return;
  const result = await window.electron.showMessageBox({
    type: 'info',
    buttons: ['Okay', 'Never show again'],
    defaultId: 0,
    cancelId: 0,
    title: 'Files Skipped',
    message: skippedFileSizeNoticeMessage(skipped)
  });
  if (result && result.response === 1 && typeof window.electron.saveSetting === 'function') {
    await window.electron.saveSetting(HIDE_SKIPPED_FILE_SIZE_NOTICE_KEY, '1');
  }
}

async function scanAndRenderDirectory(directoryPath, background = false, isStlHomeScan = false, scanUiOptions = null) {
  const suppressSizeNotice = !!(scanUiOptions && scanUiOptions.suppressSizeNotice);
  const progressSection = document.getElementById('progress-section');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const renderProgressContainer = document.getElementById('render-progress-container');
  const renderProgressBar = document.getElementById('render-progress-bar');
  const renderProgressText = document.getElementById('render-progress-text');
  const stopButton = document.getElementById('stop-thumbnail-generation');
  const container = background ? document.createElement('div') : document.querySelector('.file-grid');
  
  // Flag to track if the process has been cancelled
  let isCancelled = false;
  
  // Function to handle stop button click
  const handleStopClick = () => {
    isCancelled = true;
    renderProgressText.textContent = 'Stopping...';
    console.log('Thumbnail generation cancelled by user');
  };
  
  // Add event listener to stop button
  stopButton.addEventListener('click', handleStopClick);

  // When a background scan finds new models, we show the same "New Models" dialog as a foreground scan;
  // then skip the duplicate performCombinedSearch in finally (see skipBackgroundFinallyRefresh).
  let skipBackgroundFinallyRefresh = false;

  try {
    if (background) {
      window.disableGridRefresh = true;
      console.log('Background scan: grid refresh disabled');
    }
    if (!background) {
      progressSection.classList.remove('hidden');
      progressContainer.classList.remove('hidden');
      renderProgressContainer.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = 'Gathering files...';
      stopButton.style.display = 'block';
    }

    // Use file extension to determine file type
    const isValidFile = (filename, size) => {
      const ext = filename.toLowerCase().split('.').pop();
      const maxSize = MAX_FILE_SIZE_MB * 1024 * 1024;
      return (ext === 'stl' || ext === '3mf') && size <= maxSize;
    };

    // Store scan start time for filtering newly added models
    const scanStartTime = new Date().toISOString();
    
    // Update the scan directory call to use the new validation and cancellation
    const scanOptions = isStlHomeScan ? { isStlHomeScan: true } : {};
    const scanResult = await window.electron.scanDirectory(directoryPath, scanOptions);
    const { files, totalFiles, newFilesCount, cancelScan } = scanResult || { files: [], totalFiles: 0, newFilesCount: 0 };
    const skippedDueToSize = Number(scanResult && scanResult.skippedDueToSize) || 0;
    
    if (isCancelled) {
      if (cancelScan) cancelScan(); // Cancel the scan if possible
      throw new Error('Operation cancelled by user.');
    }
    
    if (!files || files.length === 0) {
      if (!background) {
        progressBar.style.width = '100%';
        progressText.textContent = '';
        renderProgressBar.style.width = '100%';
        renderProgressText.textContent = '';
      }
      console.log('No files found in directory:', directoryPath);
      if (!suppressSizeNotice) {
        await maybeShowSkippedFileSizeNotice(skippedDueToSize);
      }
      return { skippedDueToSize };
    }

    console.log('Scanned files:', totalFiles);

    const allModels = await window.electron.getAllModels();
    const existingFiles = new Set(allModels.map(model => model.filePath));
    const existingThumbnails = new Map(allModels.map(model => [model.filePath, model.thumbnail]));

    if (!background) {
      progressBar.style.width = '0%';
      progressText.textContent = `Processing ${files.length} files...`;
    }

    const newFiles = files.filter(file => !existingFiles.has(file.filePath));
    
    // Use a more efficient approach for saving models
    if (newFiles.length > 0) {
      const fileProgressUpdate = (completed) => {
        if (!background) {
          const progress = (completed / newFiles.length) * 100;
          progressBar.style.width = `${progress}%`;
          progressText.textContent = `${completed} / ${newFiles.length} files`;
        }
      };

      // Process files in larger batches for better performance
      const saveBatchSize = 50; // Increased from 10
      for (let i = 0; i < newFiles.length; i += saveBatchSize) {
        if (isCancelled) {
          throw new Error('Operation cancelled by user.');
        }
        
        const batch = newFiles.slice(i, Math.min(i + saveBatchSize, newFiles.length));
        const modelDataBatch = batch.map(file => ({
          filePath: file.filePath,
          fileName: file.fileName,
          hash: file.hash,
          size: file.size,
          modifiedDate: file.mtime
        }));
        
        // Save models in batch for better performance
        await window.electron.saveModelBatch(modelDataBatch);
        fileProgressUpdate(Math.min(i + saveBatchSize, newFiles.length));
      }
    }

    if (!background) {
      progressBar.style.width = '100%';
    }

    // Include files that have no thumbnail or only the default placeholder (new inserts have null)
    const filesNeedingThumbnails = files.filter(file => {
      const thumb = existingThumbnails.get(file.filePath);
      return !thumb || thumb === '3d.png' || (typeof thumb === 'string' && thumb.trim() === '');
    });
    const deferScanThumbnails =
      filesNeedingThumbnails.length > DEFER_SCAN_BATCH_THUMBNAILS_THRESHOLD;

    if (!background) {
      if (filesNeedingThumbnails.length > 0) {
        progressText.textContent = deferScanThumbnails
          ? ''
          : `${filesNeedingThumbnails.length} models found`;
      } else {
        progressText.textContent = '';
      }
      renderProgressBar.style.width = '0%';
      renderProgressText.textContent = deferScanThumbnails
        ? 'Thumbnails will load as you scroll'
        : `0 / ${filesNeedingThumbnails.length} models`;
      if (!deferScanThumbnails) {
        container.innerHTML = '';
      }
    }

    if (filesNeedingThumbnails.length > 0 && deferScanThumbnails) {
      if (!background) {
        renderProgressBar.style.width = '100%';
        renderProgressText.textContent = `${filesNeedingThumbnails.length} models — open the grid to generate previews`;
      }
      window._scanThumbnailProgress = null;
      console.log(
        `[scan] Deferred ${filesNeedingThumbnails.length} thumbnails (threshold ${DEFER_SCAN_BATCH_THUMBNAILS_THRESHOLD}); lazy queue will render visible items.`
      );
    } else if (filesNeedingThumbnails.length > 0) {
      console.log(
        `[scan] Generating thumbnails for ${filesNeedingThumbnails.length} models (first: ${filesNeedingThumbnails[0].filePath})`
      );
      let completedThumbnails = 0;
      const thumbnailProgressUpdate = (completed) => {
        if (!background) {
          const progress = (completed / filesNeedingThumbnails.length) * 100;
          renderProgressBar.style.width = `${progress}%`;
          renderProgressText.textContent = `${completed} / ${filesNeedingThumbnails.length} models`;
        }
      };
      // So progress bar advances with every thumbnail completion (scan or grid), not only scan tasks
      window._scanThumbnailProgress = {
        completed: 0,
        total: filesNeedingThumbnails.length,
        onComplete() {
          this.completed++;
          const c = Math.min(this.completed, this.total);
          if (!background) {
            const progress = (c / this.total) * 100;
            renderProgressBar.style.width = `${progress}%`;
            renderProgressText.textContent = `${c} / ${this.total} models`;
          }
        }
      };

      // Improved thumbnail generation with concurrency control and cancellation
      // Higher concurrency in Server/Docker mode to compensate for slower file system operations
      const serverMode = await window.electron.isServerMode().catch(() => false);
      const maxConcurrentThumbnails = serverMode ? 10 : 5; // Higher concurrency in server/Docker mode
      const thumbnailQueue = [...filesNeedingThumbnails];
      const activePromises = new Set();
      
      while (thumbnailQueue.length > 0 && !isCancelled) {
        // Fill up to max concurrent thumbnails
        while (activePromises.size < maxConcurrentThumbnails && thumbnailQueue.length > 0) {
          const file = thumbnailQueue.shift();
          
          const promise = (async () => {
            try {
              const existing = existingThumbnails.get(file.filePath);
              if (existing && existing !== '3d.png' && (typeof existing !== 'string' || existing.trim() !== '')) {
                console.log(`Thumbnail found for ${file.filePath} in database. Skipping render.`);
                return;
              }
              
              // Add code to actually render the thumbnail
              // Use the same thumbnail generation code that's in renderFile
              const fileExtension = file.filePath.split('.').pop().toLowerCase();
              let thumbnail = null;
              
              if (isEmbeddedImagePreviewExt(fileExtension)) {
                try {
                  const images = await extractEmbeddedPreviewImages(file.filePath, fileExtension);
                  if (images && images.length > 0) {
                    console.log(`[DEBUG] Found ${images.length} embedded image(s) in ${fileExtension.toUpperCase()}: ${file.filePath}`);
                    // Add all images to model's thumbnails at once using batch function
                    const addResult = await window.electron.addMultipleThumbnails(file.filePath, images);
                    // Use first image as thumbnail for display
                    thumbnail = images[0];
                    console.log(`[DEBUG] Added ${images.length} images to thumbnails for ${file.filePath}`);
                    
                    // If we're in detailed view and added multiple thumbnails, update the DOM item
                    if (addResult && addResult.success && addResult.thumbnailCount > 1 && currentGridView === 'detailed') {
                      // Update the existing item to show navigation controls
                      setTimeout(async () => {
                        try {
                          const allFileItems = document.querySelectorAll('.file-item');
                          const normalizedPath = normalizePathForComparison(file.filePath);
                          for (const fileItem of allFileItems) {
                            const itemPath = fileItem.getAttribute('data-filepath') || fileItem.dataset.filepath;
                            const normalizedItemPath = normalizePathForComparison(itemPath);
                            if (normalizedItemPath === normalizedPath && fileItem.classList.contains('file-item-detailed')) {
                              // Get updated model with all thumbnails
                              const updatedModel = await window.electron.getModel(file.filePath);
                              if (updatedModel) {
                                const container = document.querySelector('.file-grid');
                                if (container && container.currentModels) {
                                  // Update the model in the array
                                  const modelIndex = container.currentModels.findIndex(m => 
                                    normalizePathForComparison(m.filePath) === normalizedPath
                                  );
                                  if (modelIndex >= 0) {
                                    container.currentModels[modelIndex] = updatedModel;
                                    // The React grid card redraws from the updated model.
                                    // Trigger re-render
                                    if (container.renderVisibleItemsFn) {
                                      container.renderVisibleItemsFn();
                                    }
                                    console.log(`[DEBUG] Updated DOM item for ${file.filePath} to show navigation controls`);
                                  }
                                }
                              }
                              break;
                            }
                          }
                        } catch (updateError) {
                          console.error(`[DEBUG] Error updating DOM for ${file.filePath}:`, updateError);
                        }
                      }, 300);
                    }
                  } else {
                    console.log(`[DEBUG] No embedded images found in 3MF: ${file.filePath}`);
                  }
                } catch (imageError) {
                  console.error('Error checking for embedded image:', imageError);
                }
              }
              
              if (!thumbnail) {
                thumbnail = await new Promise((resolve, reject) => {
                  renderQueue.push({
                    filePath: file.filePath,
                    container: document.createElement('div'), // Dummy container (not in DOM)
                    existingThumbnail: null,
                    resolve,
                    reject,
                    // Must survive pruneDisconnectedRenderTasks — dummy is never isConnected.
                    retainDetached: true,
                    thumbPriority: THUMB_PRIORITY_BACKGROUND
                  });
                  processRenderQueue();
                });
                
                if (thumbnail) {
                  await window.electron.saveThumbnail(file.filePath, thumbnail);
                }
              }
              
              // Calculate and save hash during thumbnail generation (file is already being read)
              if (!file.hash || file.hash === '') {
                try {
                  await window.electron.calculateFileHash(file.filePath);
                } catch (hashError) {
                  console.error(`Error calculating hash for ${file.filePath}:`, hashError);
                  // Continue even if hash calculation fails
                }
              }
            } catch (error) {
              console.error('Error caching thumbnail:', error);
            } finally {
              if (!window._scanThumbnailProgress) {
                completedThumbnails++;
                thumbnailProgressUpdate(completedThumbnails);
              }
              activePromises.delete(promise);
            }
          })();
          
          activePromises.add(promise);
        }
        
        // Wait for at least one promise to complete before continuing
        if (activePromises.size > 0) {
          await Promise.race(Array.from(activePromises));
        }
        
        // Check for cancellation after each batch
        if (isCancelled) {
          console.log('Thumbnail generation cancelled, stopping process');
          window._scanThumbnailProgress = null;
          break;
        }
      }
      
      // Wait for any remaining active promises to complete
      if (activePromises.size > 0) {
        await Promise.all(Array.from(activePromises));
      }
      window._scanThumbnailProgress = null;
    } else {
      if (!background) {
        renderProgressBar.style.width = '100%';
        renderProgressText.textContent = 'All thumbnails up to date';
      }
    }
    
    // Foreground scans: reset filter UI and counts. Background scans (Docker STL Home polling, etc.) skip this.
    if (!background) {
      window.clearAllLibraryFilters?.();

      const totalInDb = await window.electron.getTotalModelCount();
      await updateModelCounts(totalInDb);
    }

    // "New Models Found" prompt: run for any scan that reported new inserts (including background/server STL Home).
    if (newFilesCount > 0) {
      if (background) {
        window.disableGridRefresh = false;
      }
      const result = await window.electron.showMessageBox({
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        title: 'New Models Found',
        message: `${newFilesCount} new model(s) found, would you like to see them?`
      });

      if (background) {
        skipBackgroundFinallyRefresh = true;
      }

      if (result.response === 0) {
        // User clicked "Yes" - apply dateAdded filter to show only newly added models
        // Every filter off, only the models this scan added.
        window.libraryFilters?.showAddedSince(scanStartTime);

        if (typeof window.performCombinedSearch === 'function') {
          await window.performCombinedSearch();
        } else {
          const filteredModels = await window.electron.getModelsFiltered({
            dateAdded: scanStartTime
          });
          await renderFiles(filteredModels);
        }
      } else {
        window.dateAddedFilter = null;
        if (typeof window.performCombinedSearch === 'function') {
          await window.performCombinedSearch();
        } else {
          const sortSelect = document.getElementById('sort-select');
          const fallbackModels = await window.electron.getAllModels(
            sortSelect ? sortSelect.value : 'date-desc',
            0
          );
          await renderFiles(fallbackModels);
        }
      }
    } else if (!background) {
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch();
      } else {
        const sortSelect = document.getElementById('sort-select');
        const fallbackModels = await window.electron.getAllModels(
          sortSelect ? sortSelect.value : 'date-desc',
          0
        );
        await renderFiles(fallbackModels);
      }
    }
    if (!suppressSizeNotice) {
      await maybeShowSkippedFileSizeNotice(skippedDueToSize);
    }
    return { skippedDueToSize };
  } catch (error) {
    console.error('Error scanning directory:', error);
    window._scanThumbnailProgress = null;
    if (!background) {
      renderProgressText.textContent = `Error: ${error.message}`;
      // Show alert for UNC path validation errors
      if (error.message && error.message.includes('UNC path')) {
        alert(`Error: ${error.message}\n\nIn server mode, all file paths must be UNC paths (e.g., \\\\server\\share\\path\\to\\file.stl)`);
      }
    }
  } finally {
    window._scanThumbnailProgress = null;
    // Clean up event listener
    stopButton.removeEventListener('click', handleStopClick);
    window.folderTree?.refresh().catch(() => {});
    
    if (!background) {
      progressSection.classList.add('hidden');
    } else {
      window.disableGridRefresh = false;
      console.log('Background scan complete: grid refresh re-enabled');
      if (skipBackgroundFinallyRefresh) {
        console.log('Background scan: grid already refreshed after New Models dialog');
      } else {
        // Refresh the grid so models show without requiring a page reload (docker/server mode)
        if (typeof window.performCombinedSearch === 'function') {
          window.performCombinedSearch().catch(err => console.error('Background scan post-refresh:', err));
        } else {
          window.electron.getAllModels().then((models) => {
            if (typeof window.renderFiles === 'function') window.renderFiles(models);
          }).catch(err => console.error('Background scan post-refresh:', err));
        }
      }
    }
  }
}

// Process 2: Model Display and Management
async function refreshModelDisplay() {
  try {
    if (typeof window.performCombinedSearch === 'function') {
      await window.performCombinedSearch({ force: true });
      return;
    }
    const getFilteredModels = await waitForGetCombinedFilteredModels();
    const models = await getFilteredModels();
    await displayModels(models);
  } catch (error) {
    console.error('Error refreshing model display:', error);
  }
}

// ==================== Modified displayModels() to use the virtual grid ====================
async function displayModels(files) {
  // Keep behavior aligned with renderFiles (handleFilterChange uses this path, not renderFiles)
  if (shouldSyncSelectionWithFilteredList()) {
    syncSelectionWithFilteredModels(files);
  }
  const gridFiles = dedupeModelsForVirtualGrid(files || []);
  renderVirtualGrid(gridFiles);
  if (shouldSyncSelectionWithFilteredList()) {
    syncSelectionWithFilteredModels(files);
  }
  await updateModelCounts(gridFiles.length);
}




// Add this near the top with other constants
const GC_INTERVAL = 100; // Number of models to process before garbage collection

// Update the renderFiles function to handle pagination
async function renderFiles(files, skipThumbnail = false, viewEntireLibrary = false) {
  if (window.disableGridRefresh) {
    console.log('Grid refresh is disabled, skipping renderFiles');
    return;
  }
  
  // Defensive: If dateAddedFilter is active and we're being called with many models,
  // filter them to preserve the "new models" view
  // This prevents something from bypassing performCombinedSearch and showing all models
  // BUT: Only apply this if the user hasn't actively cleared filters (check if search/filters are empty)
  const filterState = window.libraryFilters?.state();
  const hasActiveUserFilters = !!filterState && (filterState.tokens.length > 0 || filterState.designer.length > 0
    || filterState.tags.length > 0 || !!filterState.fileType);
  
  if (window.dateAddedFilter && files.length > 10 && !hasActiveUserFilters) {
    console.warn('renderFiles called with', files.length, 'models while dateAddedFilter is active! Filtering to preserve new models view...');
    const filterDate = new Date(window.dateAddedFilter);
    const originalCount = files.length;
    files = files.filter(model => {
      if (!model.dateAdded) return false;
      const modelDate = new Date(model.dateAdded);
      return modelDate >= filterDate;
    });
    console.log('Filtered from', originalCount, 'to', files.length, 'models');
  }

  // search.js replaces filter controls and only calls performCombinedSearch — selection was not cleared.
  // Drop selection and details when the current model(s) are not in the filtered result (skip progressive full-library loads).
  if (shouldSyncSelectionWithFilteredList()) {
    syncSelectionWithFilteredModels(files);
  }

  // Use the new virtual grid implementation for better performance
  const gridFiles = dedupeModelsForVirtualGrid(files || []);
  renderVirtualGrid(gridFiles);

  // Run again after the grid exists: path/name resolution and DOM can differ; catches stale selection UI
  if (shouldSyncSelectionWithFilteredList()) {
    syncSelectionWithFilteredModels(files);
  }

  // Update counts
  await updateModelCounts(gridFiles.length);
}

// Helper function to wait for window.getCombinedFilteredModels to be available
// This handles the case where search.js module hasn't finished loading yet
async function waitForGetCombinedFilteredModels(maxWait = 5000) {
  const startTime = Date.now();
  while (!window.getCombinedFilteredModels && (Date.now() - startTime) < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!window.getCombinedFilteredModels) {
    throw new Error('getCombinedFilteredModels function not available after waiting. search.js may not have loaded properly.');
  }
  return window.getCombinedFilteredModels;
}


async function processRenderQueue() {
  if (window._serverBulkThumbnailJobActive) {
    // Drain only after the bulk job ends; do not start WebGL work meanwhile.
    return;
  }
  if (isProcessingQueue || renderQueue.length === 0 || activeRenders >= effectiveMaxConcurrentRenders()) {
    return;
  }

  isProcessingQueue = true;

  try {
    // Start up to effectiveMaxConcurrentRenders() tasks in parallel (don't await inside loop)
    while (renderQueue.length > 0 && activeRenders < effectiveMaxConcurrentRenders()) {
      const task = dequeueNextRenderTask();
      if (!task) break;
      activeRenders++;

      if (task.filePath) activeThumbnailRenders.add(task.filePath);

      (async () => {
        try {
          const result = await renderModelToPNG(task.filePath, task.container, task.existingThumbnail, {
            retainDetached: !!task.retainDetached
          });
          task.resolve(result);
          // So progress bar stays in sync with visible thumbnails (scan and grid share the same queue)
          if (window._scanThumbnailProgress && typeof window._scanThumbnailProgress.onComplete === 'function') {
            window._scanThumbnailProgress.onComplete();
          }
        } catch (error) {
          if (!isBenignThumbnailDropError(error)) {
            console.error(`Render task failed: ${error.message}`);
          }
          const isWebGLHardFail = /Error creating WebGL context/i.test(error && error.message ? error.message : '');
          if (isWebGLHardFail) {
            // Do not requeue forever when the GPU/WebGL stack cannot create a context.
            task.reject(error);
          } else if (isBenignThumbnailDropError(error)) {
            if (typeof task.reject === 'function') task.reject(error);
          } else {
            // Retry once after longer delay
            setTimeout(() => enqueueRenderTask(task), 2000);
          }
        } finally {
          if (task.filePath) activeThumbnailRenders.delete(task.filePath);
          activeRenders--;
          const pauseMs = isLowPriorityThumbnailTask(task) ? RENDER_DELAY_BACKGROUND : RENDER_DELAY;
          await new Promise(resolve => setTimeout(resolve, pauseMs));
          if (renderQueue.length > 0) {
            setTimeout(processRenderQueue, 0);
          }
        }
      })();
    }
  } finally {
    isProcessingQueue = false;
    if (renderQueue.length > 0) {
      const backlogMs = renderQueueHasOnlyLowPriorityWork() ? 350 : 100;
      setTimeout(processRenderQueue, backlogMs);
    }
  }
}

async function renderModelToPNG(filePath, container, existingThumbnail, options = {}) {
  const retainDetached = !!(options && options.retainDetached);
  const startTime = Date.now();
  console.log(`[DEBUG] renderModelToPNG: Start rendering ${filePath}`);
  if (existingThumbnail) {
    const img = document.createElement('img');
    img.src = existingThumbnail;
    img.style.width = '250px';
    img.style.height = '250px';
    container.innerHTML = '';
    container.appendChild(img);
    return existingThumbnail;
  }

  // URL-only models (from Chrome extension) have no file to render; show placeholder
  if (filePath && filePath.startsWith('url::')) {
    const img = document.createElement('img');
    img.src = '3d.png';
    img.style.width = '250px';
    img.style.height = '250px';
    container.innerHTML = '';
    container.appendChild(img);
    return '3d.png';
  }

  // For 3MF files, check for embedded images BEFORE 3D rendering
  // Handle ZIP entries: get extension from entry path if it's a ZIP entry
  let fileExtension;
  if (filePath.includes('::')) {
    // ZIP entry: get extension from the entry part after ::
    const entryPath = filePath.split('::')[1];
    fileExtension = entryPath.split('.').pop().toLowerCase();
  } else {
    fileExtension = filePath.split('.').pop().toLowerCase();
  }
  
  if (isEmbeddedImagePreviewExt(fileExtension)) {
    try {
      // Scroll hydrate only needs a few top-scoring plate/cover images.
      // Fetching every embedded PNG over the WebSocket bridge OOMs Docker on large libraries.
      const images = await extractEmbeddedPreviewImages(
        filePath,
        fileExtension,
        fileExtension === '3mf' ? { maxImages: 3, quiet: true } : { quiet: true }
      );
      // Cell scrolled away while we extracted — abandon (will re-queue if it returns).
      // Scan/batch jobs use a detached dummy container on purpose (retainDetached).
      if (container && !container.isConnected && !retainDetached) {
        return null;
      }
      if (images && images.length > 0) {
        // Add all images to model's thumbnails at once using batch function
        let result = null;
        try {
          result = await window.electron.addMultipleThumbnails(filePath, images);
          if (container && !container.isConnected && !retainDetached) {
            return images[0];
          }

          // Keep the loaded model in step, so its grid card shows the images (and the carousel).
          if (result && result.success) {
            const grid = document.querySelector('.file-grid');
            const normalizedPath = normalizePathForComparison(filePath);
            const loaded = Array.isArray(grid?.currentModels)
              ? grid.currentModels.find((m) => m && normalizePathForComparison(m.filePath) === normalizedPath)
              : null;
            if (loaded) {
              loaded.thumbnail = result.thumbnailString || images.join('::');
              loaded.hasThumbnail = true;
              loaded.hasMultipleThumbnails = images.length > 1;
              syncPrimaryThumbnailCacheFromThumbnailString(filePath, loaded.thumbnail);
              refreshLibraryGrid();
            }
          }
        } catch (error) {
          console.error('Error adding multiple thumbnails:', error);
        }
        // Use first image for display
        const firstImage = images[0];
        const img = document.createElement('img');
        img.src = firstImage;
        img.style.width = '250px';
        img.style.height = '250px';
        container.innerHTML = '';
        container.appendChild(img);
        return firstImage;
      }
    } catch (imageError) {
      console.error('Error checking for embedded image:', imageError);
    }
  }

  // Image-only types already tried extract above. No mesh path exists — stop retrying
  // (returning 3d.png used to scheduleVisibleThumbnailHydrate forever).
  if (isImageOnlyPreviewExt(fileExtension)) {
    markImageOnlyPreviewMiss(filePath);
    const dataUrl = generateTypedPlaceholder(fileExtension);
    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.width = '250px';
    img.style.height = '250px';
    container.innerHTML = '';
    container.appendChild(img);
    return dataUrl;
  }
  if (!isRenderable3dExtension(fileExtension) && fileExtension !== 'svg') {
    const dataUrl = generateTypedPlaceholder(fileExtension);
    const img = document.createElement('img');
    img.src = dataUrl;
    img.style.width = '250px';
    img.style.height = '250px';
    container.innerHTML = '';
    container.appendChild(img);
    return dataUrl;
  }

  // SVG: try to load file and show as image; on failure use typed placeholder
  if (fileExtension === 'svg') {
    try {
      const buf = await window.electron.readModelFile(filePath);
      if (buf && (buf instanceof ArrayBuffer || buf.byteLength)) {
        const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
        const decoder = new TextDecoder();
        const svgText = decoder.decode(bytes);
        const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        const img = document.createElement('img');
        img.style.width = '250px';
        img.style.height = '250px';
        container.innerHTML = '';
        container.appendChild(img);
        img.src = dataUrl;
        return dataUrl;
      }
    } catch (e) { /* ignore */ }
    const fallback = generateTypedPlaceholder('svg');
    const img = document.createElement('img');
    img.src = fallback;
    img.style.width = '250px';
    img.style.height = '250px';
    container.innerHTML = '';
    container.appendChild(img);
    return fallback;
  }

  // The 3D render is TypeScript on three.js (src/web/thumbnails/render.ts).
  const showImage = (src, alt) => {
    const img = document.createElement('img');
    img.src = src;
    img.style.width = '250px';
    img.style.height = '250px';
    if (alt) img.alt = alt;
    container.innerHTML = '';
    container.appendChild(img);
  };
  let imgData;
  try {
    // Split 3MF (MeshyAI / Bambu Production Extension) can be 100MB+ of XML.
    imgData = await window.thumbnailRenderer.render(filePath, {
      timeoutMs: fileExtension === '3mf' ? 120000 : 30000,
      contextReuse: maxContextReuseCount,
      lighting: window.currentRenderLighting !== undefined ? window.currentRenderLighting : true,
      stillWanted: () => !container || container.isConnected || retainDetached
    });
  } catch (error) {
    const noWebGL = window.thumbnailRenderer?.isWebGLUnavailable(error);
    console.error(noWebGL ? 'WebGL unavailable, using placeholder:' : 'Error rendering model:', error && error.message ? error.message : error);
    showImage(generateCorruptedPlaceholder(), noWebGL ? 'WebGL unavailable' : 'Model may be corrupted');
    // Return null so callers do not persist failure art as a "real" thumbnail.
    return null;
  }
  // Cell recycled / scrolled away during load — abandon; visible hydrate will re-queue.
  if (container && !container.isConnected && !retainDetached) return null;
  if (!imgData) {
    // Nothing to draw (zip container, url, or an embedded image is used instead).
    showImage('3d.png');
    return '3d.png';
  }
  showImage(imgData);
  return imgData;
}




/** Progressive chunks are a partial result set — do not clear selection until search.js finishes the load. */
function shouldSyncSelectionWithFilteredList() {
  if (window._progressiveLibraryLoadActive) return false;
  return !!window.libraryFiltersAreActive?.();
}

function clearModelDetailsSidebar() {
    currentModelDetailsPath = null;
  currentModelDetailsAbort = true;
  setDetailsPath(null);
  window.detailsFields?.clear();
  window.detailsNotes?.clear();
  window.detailsPrint?.clear();
  window.detailsFilaments?.clear();
}

/**
 * Run when filter/search inputs change the result set — synchronously, before any await.
 * search.js cannot access window.selection; post-render sync alone loses races to showModelDetails().
 */
function resetFilterSelectionAndDetails() {
  currentModelDetailsAbort = true;
  window.selection.clear();

  const multiEditPanel = document.getElementById('multi-edit-panel');
  if (multiEditPanel && !multiEditPanel.classList.contains('hidden')) {
    multiEditPanel.classList.add('hidden');
    const detailsPanel = document.getElementById('model-details');
    if (detailsPanel) detailsPanel.classList.remove('hidden');
    const editModeToggle = document.getElementById('edit-mode-toggle');
    if (editModeToggle) {
      editModeToggle.textContent = 'Multi-Edit Mode';
      editModeToggle.classList.remove('active');
    }
    isMultiSelectMode = false;
  }

  clearModelDetailsSidebar();
}

/** True if sidebar + selection state is consistent with the current filtered grid rows. */
function isSidebarShowingModelInFilteredList(files, filteredSet) {
  const list = Array.isArray(files) ? files : [];
  const paths = [
    currentModelDetailsPath,
    document.getElementById('path-tree-container')?.getAttribute('data-file-path')
  ].filter(Boolean);
  const mn = document.getElementById('model-name')?.value?.trim();
  const hasSidebarContent = paths.length > 0 || !!mn || window.selection.size > 0;
  if (!hasSidebarContent) return true;
  if (list.length === 0) return false;

  const pathOrSelectionOk =
    paths.some((p) => filteredSet.has(normalizePathForComparison(p))) ||
    Array.from(window.selection).some((p) =>
      filteredSet.has(normalizePathForComparison(p))
    );
  if (pathOrSelectionOk) return true;

  if (mn) {
    return list.some(
      (f) =>
        f &&
        f.fileName &&
        (f.fileName === mn || mn === f.fileName || mn.endsWith(f.fileName))
    );
  }
  return false;
}

function syncSelectionWithFilteredModels(files) {
  const list = Array.isArray(files) ? files : [];
  const filteredSet = new Set(
    list.filter((f) => f && f.filePath).map((f) => normalizePathForComparison(f.filePath))
  );

  window.selection.retain((path) => filteredSet.has(normalizePathForComparison(path)));

  if (isMultiSelectMode && window.selection.size === 0) {
    exitMultiEditMode();
    return;
  }

  if (!isSidebarShowingModelInFilteredList(files, filteredSet)) {
    clearModelDetailsSidebar();
  }

}



/** Ctrl/Cmd-click on a card: start multi-edit with it, or toggle it in multi-edit. */
async function handleFileClick(event, filePath) {
  const multiToggle = isMultiSelectMode || event.ctrlKey || event.metaKey;
  if (!multiToggle) {
    window.selection.set([filePath]);
    exitMultiEditPanelOnly();
    showModelDetails(filePath);
    return;
  }
  event.preventDefault();
  if (!isMultiSelectMode) {
    window.selection.set([filePath]);
    enterMultiEditMode();
    return;
  }
  window.selection.toggle(filePath);
  if (window.selection.size === 0) exitMultiEditMode();
}

/** Back to single selection: hide the multi-edit panel without touching the selection. */
function exitMultiEditPanelOnly() {
  isMultiSelectMode = false;
  document.getElementById('multi-edit-panel')?.classList.add('hidden');
  const toggle = document.getElementById('edit-mode-toggle');
  if (toggle) {
    toggle.textContent = 'Multi-Edit Mode';
    toggle.classList.remove('active');
  }
}

// Navigate to next/previous model in detail view (called from keydown when details visible)
function navigateDetailView(direction) {
  const detailsPanel = document.getElementById('model-details');
  if (!detailsPanel || detailsPanel.classList.contains('hidden')) return false;
  const items = Array.from(document.querySelectorAll('.file-item'));
  if (items.length === 0) return false;
  const currentPath = getCurrentModelFilePath() || currentModelDetailsPath || '';
  const normalizedCurrent = currentPath ? normalizePathForComparison(currentPath) : '';
  let index = -1;
  if (normalizedCurrent) {
    index = items.findIndex(item => {
      const p = item.getAttribute('data-filepath') || item.dataset.filepath || '';
      return p && normalizePathForComparison(p) === normalizedCurrent;
    });
  }
  if (index < 0) index = items.findIndex(item => item.classList.contains('selected'));
  if (index < 0) index = 0;
  const nextIndex = direction === 'next' ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= items.length) return false;
  const target = items[nextIndex];
  const filePath = target.getAttribute('data-filepath') || target.dataset.filepath;
  if (!filePath) return false;
  window.selection.set([filePath]);
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showModelDetails(filePath);
  return true;
}

/** What the keyboard shortcuts (src/web/KeyboardShortcutsDialog.tsx) ask of this file. */
window.shortcutHost = {
  multiEdit: () => isMultiSelectMode,
  exitMultiEdit: () => exitMultiEditMode(),
  navigate: (direction) => navigateDetailView(direction),
  toggleMultiEdit: (fromDetails) => {
    const enterMultiBtn = document.getElementById('enter-multi-edit-button');
    if (enterMultiBtn && fromDetails) enterMultiBtn.click();
    else document.getElementById('edit-mode-toggle')?.click();
  },
  selectAll: async () => {
    await selectAllVisibleModels();
    if (!isMultiSelectMode && window.selection.size > 0) enterMultiEditMode();
    else if (isMultiSelectMode) showMultiEditPanel();
  }
};

// Update populateModelDesignerDropdown to handle multiple dropdowns
/** Reload the designer pickers (details panel and multi-edit panel are React). */
async function populateModelDesignerDropdown() {
  window.detailsFields?.reloadOptions();
  window.multiEdit?.reloadOptions();
}

async function populateDesignerDropdown() {
  window.libraryFilters?.reloadOptions(); // React (src/web/filters/Sidebar.tsx)
}

// Add these new functions
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const context = this; // Store the context
    const later = () => {
      timeout = null; // Clear timeout identifier
      func.apply(context, args); // Call the original function with correct context and args
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
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
// skipSave: use when populating tags from DB (showModelDetails / loadModelTags) to avoid redundant saves
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

/** Set tag filter dropdown and refresh the grid (same path as Filter menu; works with getModelsFiltered in Electron and server bridge). */
async function applyTagFilterFromModelClick(tagName) {
  const trimmed = (tagName && String(tagName).trim()) || '';
  if (!trimmed) return;
  resetFilterSelectionAndDetails();
  window.setTagMultiFilter?.([trimmed]);
  await window.performCombinedSearch?.({ force: true });
}

// Add this function to populate the tag filter dropdown
async function populateTagFilter() {
  window.libraryFilters?.reloadOptions();
}


async function parseSourceUrl(url) {
  try {
    if (!url.includes('thangs.com')) return null;

    // Fetch the page content
    const pageData = await window.electron.fetchThangsPage(url);
    if (!pageData) return null;

    const { modelTitle, designerName } = pageData;

    console.log('Parsed page data:', { modelTitle, designerName });
    return {
      designer: designerName || null,
      parentModel: modelTitle || null
    };
  } catch (error) {
    console.error('Error parsing source URL:', error);
    return null;
  }
}

// Fix syntax error in formatFileSize function
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Helper function to create SVG icon element
function createSVGIcon(svgString, size = 16) {
  const iconContainer = document.createElement('div');
  iconContainer.style.display = 'inline-flex';
  iconContainer.style.alignItems = 'center';
  iconContainer.style.justifyContent = 'center';
  iconContainer.style.width = `${size}px`;
  iconContainer.style.height = `${size}px`;
  iconContainer.style.flexShrink = '0';
  iconContainer.style.marginRight = '6px';
  iconContainer.innerHTML = svgString;
  return iconContainer;
}

/** List view: column visibility, widths, and order (persisted via listViewColumnLayout) */
const LIST_VIEW_COLUMN_DEFS = [
  { id: 'name', label: 'Name', defaultWidth: 140, min: 80, max: 800 },
  { id: 'size', label: 'Size', defaultWidth: 75, min: 50, max: 200 },
  { id: 'dateadded', label: 'Date Added', defaultWidth: 110, min: 90, max: 240 },
  { id: 'directory', label: 'Parent Directory', defaultWidth: 150, min: 90, max: 500 },
  { id: 'designer', label: 'Designer', defaultWidth: 120, min: 60, max: 400 },
  { id: 'parentmodel', label: 'Parent Model', defaultWidth: 120, min: 60, max: 400 },
  { id: 'printed', label: 'Print Status', defaultWidth: 140, min: 100, max: 260 },
  { id: 'tags', label: 'Tags', defaultWidth: 180, min: 80, max: 600 },
  { id: 'archive', label: 'Archive', defaultWidth: 100, min: 70, max: 200 }
];

let listViewColumnState = null;
let listViewColumnsPopoverEl = null;

function getDefaultListViewColumnOrder() {
  return LIST_VIEW_COLUMN_DEFS.map(col => col.id);
}

function normalizeListViewColumnOrder(savedOrder) {
  const known = getDefaultListViewColumnOrder();
  const knownSet = new Set(known);
  const order = [];
  if (Array.isArray(savedOrder)) {
    for (const id of savedOrder) {
      if (typeof id === 'string' && knownSet.has(id) && !order.includes(id)) {
        order.push(id);
      }
    }
  }
  for (const id of known) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

function getDefaultListViewColumnState() {
  const visibility = {};
  const widths = {};
  for (const col of LIST_VIEW_COLUMN_DEFS) {
    visibility[col.id] = true;
    widths[col.id] = col.defaultWidth;
  }
  return { visibility, widths, order: getDefaultListViewColumnOrder() };
}

function mergeListViewColumnState(saved) {
  const base = getDefaultListViewColumnState();
  if (!saved || typeof saved !== 'object') return base;
  if (saved.visibility && typeof saved.visibility === 'object') {
    for (const col of LIST_VIEW_COLUMN_DEFS) {
      if (typeof saved.visibility[col.id] === 'boolean') {
        base.visibility[col.id] = saved.visibility[col.id];
      }
    }
  }
  if (saved.widths && typeof saved.widths === 'object') {
    for (const col of LIST_VIEW_COLUMN_DEFS) {
      const w = saved.widths[col.id];
      if (typeof w === 'number' && Number.isFinite(w)) {
        base.widths[col.id] = Math.round(Math.max(col.min, Math.min(col.max, w)));
      }
    }
  }
  base.order = normalizeListViewColumnOrder(saved.order);
  // Old default width (100) clips the longer "Print Status" label.
  if (!Array.isArray(saved.order) && saved.widths && saved.widths.printed === 100) {
    base.widths.printed = 130;
  }
  return base;
}

function ensureListViewColumnState() {
  if (!listViewColumnState) {
    listViewColumnState = getDefaultListViewColumnState();
  }
  return listViewColumnState;
}

function listViewColDisplayMode(_colId) {
  return 'flex';
}

function applyListViewColumnToElement(el, colId) {
  if (!el || !colId) return;
  const state = ensureListViewColumnState();
  const def = LIST_VIEW_COLUMN_DEFS.find(c => c.id === colId);
  if (!def) return;
  const visible = state.visibility[colId] !== false;
  const w = state.widths[colId] ?? def.defaultWidth;
  if (!visible) {
    el.style.display = 'none';
    return;
  }
  el.style.display = listViewColDisplayMode(colId);
  el.style.flex = `0 0 ${w}px`;
  el.style.flexShrink = '0';
  el.style.width = `${w}px`;
  el.style.minWidth = `${w}px`;
  el.style.maxWidth = `${w}px`;
  el.style.overflow = 'hidden';
  el.style.boxSizing = 'border-box';
}

function isListViewColumnRow(el) {
  return !!(el && (el.classList.contains('list-view-header-info') || el.classList.contains('file-info')));
}

function applyListViewColumnOrderToSubtree(root) {
  if (!root) return;
  const state = ensureListViewColumnState();
  const rank = new Map((state.order || []).map((id, i) => [id, i]));
  const parents = new Set();
  root.querySelectorAll('[data-list-col]').forEach(el => {
    const parent = el.parentElement;
    if (isListViewColumnRow(parent)) parents.add(parent);
  });
  parents.forEach(parent => {
    const cols = Array.from(parent.children).filter(el => el.hasAttribute('data-list-col'));
    if (cols.length < 2) return;
    cols.sort((a, b) => {
      const ra = rank.has(a.getAttribute('data-list-col')) ? rank.get(a.getAttribute('data-list-col')) : 999;
      const rb = rank.has(b.getAttribute('data-list-col')) ? rank.get(b.getAttribute('data-list-col')) : 999;
      return ra - rb;
    });
    cols.forEach(el => parent.appendChild(el));
  });
}

function sharedGroupChildValue(children, getter) {
  const values = [];
  for (const child of children || []) {
    const raw = getter(child);
    const value = raw == null ? '' : String(raw).trim();
    if (value && !values.includes(value)) values.push(value);
  }
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  return 'Multiple';
}

function summarizeListViewGroupColumns(groupRecord) {
  const children = groupRecord?.children || [];
  let totalSize = 0;
  let hasSize = false;
  let latestDateMs = null;
  for (const child of children) {
    const size = Number(child?.size);
    if (Number.isFinite(size) && size > 0) {
      totalSize += size;
      hasSize = true;
    }
    const dateRaw = child?.dateAdded || child?.modifiedDate;
    if (dateRaw) {
      const ms = new Date(dateRaw).getTime();
      if (Number.isFinite(ms) && (latestDateMs == null || ms > latestDateMs)) {
        latestDateMs = ms;
      }
    }
  }

  const firstPath = children.find(child => child?.filePath)?.filePath || '';
  const pathForDirectory = firstPath.includes('::') ? firstPath.split('::')[0] : firstPath;
  const directory = pathForDirectory ? getDirectoryDisplayLabel(pathForDirectory) : '';
  const directoryFull = pathForDirectory
    ? (getParentDirectoryFullPath(pathForDirectory) || directory)
    : '';

  return {
    size: hasSize ? formatFileSize(totalSize) : '',
    dateAdded: latestDateMs != null
      ? new Date(latestDateMs).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '',
    dateAddedTitle: latestDateMs != null ? new Date(latestDateMs).toLocaleString() : '',
    directory,
    directoryFull,
    designer: sharedGroupChildValue(children, child => child.designer),
    parentModel: groupRecord?.groupKind === 'parentModel'
      ? (groupRecord.groupLabel || '')
      : sharedGroupChildValue(children, child => child.parentModel)
  };
}

function applyListViewColumnLayoutToSubtree(root) {
  if (!root) return;
  root.querySelectorAll('[data-list-col]').forEach(el => {
    applyListViewColumnToElement(el, el.getAttribute('data-list-col'));
  });
  applyListViewColumnOrderToSubtree(root);
}

function applyListViewColumnLayoutToGrid() {
  const grid = document.querySelector('.file-grid');
  if (!grid) return;
  applyListViewColumnLayoutToSubtree(grid);
}

async function persistListViewColumnState() {
  if (!window.electron?.saveSetting) return;
  const state = ensureListViewColumnState();
  try {
    await window.electron.saveSetting(
      'listViewColumnLayout',
      JSON.stringify({
        visibility: state.visibility,
        widths: state.widths,
        order: state.order
      })
    );
  } catch (err) {
    console.error('Error saving list view column layout:', err);
  }
}

async function loadListViewColumnStateFromStore() {
  try {
    if (!window.electron?.getSetting) {
      listViewColumnState = getDefaultListViewColumnState();
      return;
    }
    const raw = await window.electron.getSetting('listViewColumnLayout');
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      listViewColumnState = mergeListViewColumnState(parsed);
    } else {
      listViewColumnState = getDefaultListViewColumnState();
    }
  } catch (e) {
    console.warn('loadListViewColumnStateFromStore:', e);
    listViewColumnState = getDefaultListViewColumnState();
  }
  applyListViewColumnLayoutToGrid();
}

function closeListViewColumnsPopover() {
  if (listViewColumnsPopoverEl) {
    listViewColumnsPopoverEl.remove();
    listViewColumnsPopoverEl = null;
  }
}

function syncPreviewSizeSwitcherActive() {
  const wrap = document.getElementById('preview-size-switcher');
  if (!wrap) return;
  wrap.querySelectorAll('[data-preview-size]').forEach(b => {
    b.classList.toggle('active', b.dataset.previewSize === currentPreviewTileSize);
  });
}

function updateListViewColumnsToolbarButton() {
  const btn = document.getElementById('list-view-columns-toolbar-btn');
  if (btn) btn.hidden = currentGridView !== 'list';
  const previewSwitcher = document.getElementById('preview-size-switcher');
  if (previewSwitcher) {
    const showPreviewSizer = currentGridView === 'preview';
    previewSwitcher.hidden = !showPreviewSizer;
    if (showPreviewSizer) {
      previewSwitcher.style.display = '';
    } else {
      previewSwitcher.style.display = 'none';
    }
    previewSwitcher.setAttribute('aria-hidden', showPreviewSizer ? 'false' : 'true');
    syncPreviewSizeSwitcherActive();
  }
  document.querySelector('.grid-view-selector')?.classList.toggle('preview-view-active', currentGridView === 'preview');
}
window.updateListViewColumnsToolbarButton = updateListViewColumnsToolbarButton;

function toggleListViewColumnsPopover(anchorBtn) {
  if (listViewColumnsPopoverEl) {
    closeListViewColumnsPopover();
    return;
  }
  ensureListViewColumnState();
  const pop = document.createElement('div');
  pop.className = 'list-view-columns-popover';
  pop.setAttribute('role', 'menu');
  const hint = document.createElement('div');
  hint.className = 'list-view-columns-popover-hint';
  hint.textContent = 'Drag column headers to reorder. Drag a column edge to resize.';
  pop.appendChild(hint);
  const colsById = new Map(LIST_VIEW_COLUMN_DEFS.map(col => [col.id, col]));
  normalizeListViewColumnOrder(listViewColumnState.order).forEach(colId => {
    const col = colsById.get(colId);
    if (!col) return;
    const row = document.createElement('label');
    row.className = 'list-view-columns-popover-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.colId = col.id;
    cb.checked = listViewColumnState.visibility[col.id] !== false;
    const span = document.createElement('span');
    span.textContent = col.label;
    row.appendChild(cb);
    row.appendChild(span);
    cb.addEventListener('change', () => {
      listViewColumnState.visibility[col.id] = cb.checked;
      applyListViewColumnLayoutToGrid();
      persistListViewColumnState();
    });
    pop.appendChild(row);
  });
  const rect = anchorBtn.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.zIndex = '10050';
  document.body.appendChild(pop);
  listViewColumnsPopoverEl = pop;
  requestAnimationFrame(() => {
    const onDoc = (ev) => {
      if (!listViewColumnsPopoverEl || listViewColumnsPopoverEl.contains(ev.target) || anchorBtn.contains(ev.target)) {
        return;
      }
      closeListViewColumnsPopover();
      document.removeEventListener('mousedown', onDoc, true);
    };
    document.addEventListener('mousedown', onDoc, true);
  });
}

function attachListViewColumnResizeHandle(wrapEl, colId) {
  const def = LIST_VIEW_COLUMN_DEFS.find(c => c.id === colId);
  if (!def || !wrapEl) return;
  const handle = document.createElement('div');
  handle.className = 'list-view-col-resize-handle';
  handle.title = 'Drag to resize';
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    ensureListViewColumnState();
    const startX = e.clientX;
    const startW = listViewColumnState.widths[colId] ?? def.defaultWidth;
    function onMove(ev) {
      const dx = ev.clientX - startX;
      let nw = startW + dx;
      nw = Math.max(def.min, Math.min(def.max, nw));
      listViewColumnState.widths[colId] = Math.round(nw);
      applyListViewColumnLayoutToGrid();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistListViewColumnState();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  wrapEl.appendChild(handle);
}

function clearListViewColumnDropIndicators(headerInfo) {
  if (!headerInfo) return;
  headerInfo.querySelectorAll('.list-view-col-drop-before, .list-view-col-drop-after').forEach(el => {
    el.classList.remove('list-view-col-drop-before', 'list-view-col-drop-after');
  });
}

function getListViewColumnDropTarget(headerInfo, clientX, fromId) {
  const wraps = Array.from(headerInfo.children).filter(el => {
    return el.hasAttribute('data-list-col')
      && el.style.display !== 'none'
      && el.getAttribute('data-list-col') !== fromId;
  });
  if (wraps.length === 0) return null;
  for (const el of wraps) {
    const rect = el.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return { el, id: el.getAttribute('data-list-col'), place: 'before' };
    }
  }
  const last = wraps[wraps.length - 1];
  return { el: last, id: last.getAttribute('data-list-col'), place: 'after' };
}

function reorderListViewColumn(fromId, targetId, place) {
  const state = ensureListViewColumnState();
  const current = normalizeListViewColumnOrder(state.order);
  if (fromId === targetId) return false;
  const order = current.filter(id => id !== fromId);
  let idx = order.indexOf(targetId);
  if (idx < 0) return false;
  if (place === 'after') idx += 1;
  order.splice(idx, 0, fromId);
  const unchanged = order.length === current.length && order.every((id, i) => id === current[i]);
  if (unchanged) return false;
  state.order = order;
  return true;
}

function suppressClickAfterColumnReorder(wrapEl) {
  const suppress = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    wrapEl.removeEventListener('click', suppress, true);
  };
  wrapEl.addEventListener('click', suppress, true);
}

function attachListViewColumnReorderOnHeader(headerInfo) {
  if (!headerInfo || headerInfo.dataset.colReorderAttached === '1') return;
  headerInfo.dataset.colReorderAttached = '1';
  headerInfo.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.list-view-col-resize-handle')) return;
    const wrap = e.target.closest('[data-list-col]');
    if (!wrap || wrap.parentElement !== headerInfo) return;
    const fromId = wrap.getAttribute('data-list-col');
    if (!fromId) return;

    const startX = e.clientX;
    let dragging = false;
    let dropTarget = null;

    function onMove(ev) {
      if (!dragging && Math.abs(ev.clientX - startX) < 8) return;
      if (!dragging) {
        dragging = true;
        wrap.classList.add('is-dragging');
        document.body.classList.add('list-view-col-reorder-active');
      }
      ev.preventDefault();
      dropTarget = getListViewColumnDropTarget(headerInfo, ev.clientX, fromId);
      clearListViewColumnDropIndicators(headerInfo);
      if (dropTarget?.el) {
        dropTarget.el.classList.add(
          dropTarget.place === 'before' ? 'list-view-col-drop-before' : 'list-view-col-drop-after'
        );
      }
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      clearListViewColumnDropIndicators(headerInfo);
      wrap.classList.remove('is-dragging');
      document.body.classList.remove('list-view-col-reorder-active');
      if (!dragging || !dropTarget) return;
      suppressClickAfterColumnReorder(wrap);
      if (reorderListViewColumn(fromId, dropTarget.id, dropTarget.place)) {
        applyListViewColumnLayoutToGrid();
        persistListViewColumnState();
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Function to create list view header
// Helper function to create a sortable header
function createSortableHeader(label, sortKey, width, options = {}) {
  const header = document.createElement('div');
  header.className = 'sortable-header';
  header.dataset.sortKey = sortKey;
  header.style.flexShrink = '0';
  header.style.width = width;
  header.style.fontSize = '12px';
  header.style.fontWeight = '600';
  header.style.color = '#aaa';
  header.style.textTransform = 'uppercase';
  header.style.letterSpacing = '0.5px';
  header.style.cursor = 'pointer';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '6px';
  header.style.userSelect = 'none';
  if (options.textAlign) {
    header.style.justifyContent = options.textAlign === 'center' ? 'center' : 'flex-start';
  }
  
  // Create label container
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  header.appendChild(labelSpan);
  
  // Create sort indicator container
  const sortIndicator = document.createElement('span');
  sortIndicator.className = 'sort-indicator';
  sortIndicator.style.display = 'inline-flex';
  sortIndicator.style.alignItems = 'center';
  sortIndicator.style.marginLeft = '4px';
  sortIndicator.style.opacity = '0';
  sortIndicator.style.transition = 'opacity 0.2s ease';
  header.appendChild(sortIndicator);
  
  // Add click handler
  header.addEventListener('click', async () => {
    const sortSelect = document.getElementById('sort-select');
    if (!sortSelect) return;
    
    const currentSort = sortSelect.value;
    let newSort;
    
    // Determine new sort based on current state
    if (currentSort === `${sortKey}-asc`) {
      newSort = `${sortKey}-desc`;
    } else if (currentSort === `${sortKey}-desc`) {
      newSort = `${sortKey}-asc`;
    } else {
      // Default to ascending when clicking a new column
      newSort = `${sortKey}-asc`;
    }
    
    window.libraryFilters?.setSort(newSort);
    document.querySelector('.list-view-header')?.updateSortIndicators?.();
  });
  
  // Add hover effect
  header.addEventListener('mouseenter', () => {
    if (!header.classList.contains('sort-active')) {
      header.style.color = '#fff';
      sortIndicator.style.opacity = '0.5';
    }
  });
  
  header.addEventListener('mouseleave', () => {
    if (!header.classList.contains('sort-active')) {
      header.style.color = '#aaa';
      sortIndicator.style.opacity = '0';
    }
  });
  
  // Function to update sort indicator based on current sort
  header.updateSortIndicator = function(currentSort) {
    if (currentSort === `${sortKey}-asc` || currentSort === `${sortKey}-desc`) {
      header.classList.add('sort-active');
      header.style.color = '#fff';
      sortIndicator.style.opacity = '1';
      
      // Update arrow direction
      if (currentSort === `${sortKey}-asc`) {
        sortIndicator.innerHTML = '↑';
        sortIndicator.title = 'Sorted ascending';
      } else {
        sortIndicator.innerHTML = '↓';
        sortIndicator.title = 'Sorted descending';
      }
    } else {
      header.classList.remove('sort-active');
      header.style.color = '#aaa';
      sortIndicator.style.opacity = '0';
      sortIndicator.innerHTML = '';
      sortIndicator.title = '';
    }
  };
  
  return header;
}

function createListViewHeader() {
  ensureListViewColumnState();
  const header = document.createElement('div');
  header.className = 'list-view-header';
  header.style.display = 'flex';
  header.style.flexDirection = 'row';
  header.style.alignItems = 'center';
  header.style.gap = '12px';
  header.style.padding = '8px 12px';
  header.style.height = '36px';
  header.style.borderBottom = '2px solid rgba(255, 255, 255, 0.1)';
  header.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
  header.style.position = 'sticky';
  header.style.top = '0';
  header.style.zIndex = '10';
  header.style.marginBottom = '4px';
  
  // Thumbnail column header (spacer matches list-row thumb + margin)
  const thumbnailHeader = document.createElement('div');
  thumbnailHeader.className = 'list-view-thumb-spacer';
  thumbnailHeader.style.flexShrink = '0';
  thumbnailHeader.style.width = '60px';
  thumbnailHeader.style.height = '20px';
  header.appendChild(thumbnailHeader);
  
  // File info container (matches fileInfo structure)
  const headerInfo = document.createElement('div');
  headerInfo.className = 'list-view-header-info';
  headerInfo.style.flex = '1';
  headerInfo.style.display = 'flex';
  headerInfo.style.flexDirection = 'row';
  headerInfo.style.alignItems = 'center';
  headerInfo.style.gap = '12px';
  headerInfo.style.minWidth = '0';
  
  // Name column header (sortable)
  const nameWrap = document.createElement('div');
  nameWrap.className = 'list-view-col';
  nameWrap.dataset.listCol = 'name';
  nameWrap.style.position = 'relative';
  const nameHeader = createSortableHeader('Name', 'name', '100%');
  nameHeader.style.width = '100%';
  nameWrap.appendChild(nameHeader);
  attachListViewColumnResizeHandle(nameWrap, 'name');
  headerInfo.appendChild(nameWrap);
  
  // Size column header (sortable)
  const sizeWrap = document.createElement('div');
  sizeWrap.className = 'list-view-col';
  sizeWrap.dataset.listCol = 'size';
  sizeWrap.style.position = 'relative';
  const sizeHeader = createSortableHeader('Size', 'size', '100%', { textAlign: 'center' });
  sizeHeader.style.width = '100%';
  sizeWrap.appendChild(sizeHeader);
  attachListViewColumnResizeHandle(sizeWrap, 'size');
  headerInfo.appendChild(sizeWrap);
  
  // Date Added column header (sortable)
  const dateAddedWrap = document.createElement('div');
  dateAddedWrap.className = 'list-view-col';
  dateAddedWrap.dataset.listCol = 'dateadded';
  dateAddedWrap.style.position = 'relative';
  const dateAddedHeader = createSortableHeader('Date Added', 'dateadded', '100%', { textAlign: 'center' });
  dateAddedHeader.style.width = '100%';
  dateAddedWrap.appendChild(dateAddedHeader);
  attachListViewColumnResizeHandle(dateAddedWrap, 'dateadded');
  headerInfo.appendChild(dateAddedWrap);
  
  // Parent Directory column header (sortable - sorts by filePath)
  const directoryHeaderContainer = document.createElement('div');
  directoryHeaderContainer.className = 'list-view-col';
  directoryHeaderContainer.dataset.listCol = 'directory';
  directoryHeaderContainer.style.position = 'relative';
  directoryHeaderContainer.style.display = 'flex';
  directoryHeaderContainer.style.alignItems = 'center';
  directoryHeaderContainer.style.cursor = 'pointer';
  directoryHeaderContainer.style.userSelect = 'none';
  const folderIcon = createSVGIcon('<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="#aaa"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z"/></svg>', 16);
  directoryHeaderContainer.appendChild(folderIcon);
  const directoryHeader = createSortableHeader('Parent Directory', 'directory', 'auto');
  directoryHeader.style.flex = '1';
  directoryHeader.style.minWidth = '0';
  // Make the container clickable - forward clicks to the header
  directoryHeaderContainer.addEventListener('click', (e) => {
    // If click is on the icon, trigger the header's click handler
    if (e.target === folderIcon || folderIcon.contains(e.target)) {
      directoryHeader.click();
    }
  });
  directoryHeaderContainer.appendChild(directoryHeader);
  attachListViewColumnResizeHandle(directoryHeaderContainer, 'directory');
  headerInfo.appendChild(directoryHeaderContainer);
  
  // Designer column header (sortable with icon)
  const designerWrap = document.createElement('div');
  designerWrap.className = 'list-view-col';
  designerWrap.dataset.listCol = 'designer';
  designerWrap.style.position = 'relative';
  const designerHeader = document.createElement('div');
  designerHeader.className = 'sortable-header';
  designerHeader.dataset.sortKey = 'designer';
  designerHeader.style.flexShrink = '0';
  designerHeader.style.width = '100%';
  designerHeader.style.fontSize = '12px';
  designerHeader.style.fontWeight = '600';
  designerHeader.style.color = '#aaa';
  designerHeader.style.textTransform = 'uppercase';
  designerHeader.style.letterSpacing = '0.5px';
  designerHeader.style.cursor = 'pointer';
  designerHeader.style.display = 'flex';
  designerHeader.style.alignItems = 'center';
  designerHeader.style.gap = '6px';
  designerHeader.style.userSelect = 'none';
  
  const designerIcon = createSVGIcon('<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="#a855f7"><path d="m352-522 86-87-56-57-44 44-56-56 43-44-45-45-87 87 159 158Zm328 329 87-87-45-45-44 43-56-56 43-44-57-56-86 86 158 159Zm24-567 57 57-57-57ZM290-120H120v-170l175-175L80-680l200-200 216 216 151-152q12-12 27-18t31-6q16 0 31 6t27 18l53 54q12 12 18 27t6 31q0 16-6 30.5T816-647L665-495l215 215L680-80 465-295 290-120Zm-90-80h56l392-391-57-57-391 392v56Zm420-419-29-29 57 57-28-28Z"/></svg>', 16);
  designerHeader.appendChild(designerIcon);
  
  const designerLabel = document.createElement('span');
  designerLabel.textContent = 'Designer';
  designerHeader.appendChild(designerLabel);
  
  const designerSortIndicator = document.createElement('span');
  designerSortIndicator.className = 'sort-indicator';
  designerSortIndicator.style.display = 'inline-flex';
  designerSortIndicator.style.alignItems = 'center';
  designerSortIndicator.style.marginLeft = '4px';
  designerSortIndicator.style.opacity = '0';
  designerSortIndicator.style.transition = 'opacity 0.2s ease';
  designerHeader.appendChild(designerSortIndicator);
  
  // Add click handler
  designerHeader.addEventListener('click', async () => {
    const sortSelect = document.getElementById('sort-select');
    if (!sortSelect) return;
    
    const currentSort = sortSelect.value;
    let newSort;
    
    if (currentSort === 'designer-asc') {
      newSort = 'designer-desc';
    } else if (currentSort === 'designer-desc') {
      newSort = 'designer-asc';
    } else {
      newSort = 'designer-asc';
    }
    
    window.libraryFilters?.setSort(newSort);
    document.querySelector('.list-view-header')?.updateSortIndicators?.();
  });
  
  // Add hover effect
  designerHeader.addEventListener('mouseenter', () => {
    if (!designerHeader.classList.contains('sort-active')) {
      designerHeader.style.color = '#fff';
      designerSortIndicator.style.opacity = '0.5';
    }
  });
  
  designerHeader.addEventListener('mouseleave', () => {
    if (!designerHeader.classList.contains('sort-active')) {
      designerHeader.style.color = '#aaa';
      designerSortIndicator.style.opacity = '0';
    }
  });
  
  // Function to update sort indicator
  designerHeader.updateSortIndicator = function(currentSort) {
    if (currentSort === 'designer-asc' || currentSort === 'designer-desc') {
      designerHeader.classList.add('sort-active');
      designerHeader.style.color = '#fff';
      designerSortIndicator.style.opacity = '1';
      
      if (currentSort === 'designer-asc') {
        designerSortIndicator.innerHTML = '↑';
        designerSortIndicator.title = 'Sorted ascending';
      } else {
        designerSortIndicator.innerHTML = '↓';
        designerSortIndicator.title = 'Sorted descending';
      }
    } else {
      designerHeader.classList.remove('sort-active');
      designerHeader.style.color = '#aaa';
      designerSortIndicator.style.opacity = '0';
      designerSortIndicator.innerHTML = '';
      designerSortIndicator.title = '';
    }
  };
  
  designerWrap.appendChild(designerHeader);
  attachListViewColumnResizeHandle(designerWrap, 'designer');
  headerInfo.appendChild(designerWrap);
  
  // Parent Model column header (sortable)
  const parentWrap = document.createElement('div');
  parentWrap.className = 'list-view-col';
  parentWrap.dataset.listCol = 'parentmodel';
  parentWrap.style.position = 'relative';
  const parentModelHeader = createSortableHeader('Parent Model', 'parentmodel', '100%');
  parentModelHeader.style.width = '100%';
  parentWrap.appendChild(parentModelHeader);
  attachListViewColumnResizeHandle(parentWrap, 'parentmodel');
  headerInfo.appendChild(parentWrap);
  
  // Print Status column header (sortable)
  const printedWrap = document.createElement('div');
  printedWrap.className = 'list-view-col';
  printedWrap.dataset.listCol = 'printed';
  printedWrap.style.position = 'relative';
  const printedHeader = createSortableHeader('Print Status', 'printstatus', '100%', { textAlign: 'center' });
  printedHeader.style.width = '100%';
  printedWrap.appendChild(printedHeader);
  attachListViewColumnResizeHandle(printedWrap, 'printed');
  headerInfo.appendChild(printedWrap);
  
  // Tags column header (not easily sortable - tags are in a separate table)
  const tagsHeader = document.createElement('div');
  tagsHeader.className = 'list-view-col';
  tagsHeader.dataset.listCol = 'tags';
  tagsHeader.style.position = 'relative';
  tagsHeader.style.display = 'flex';
  tagsHeader.style.alignItems = 'center';
  const tagsIcon = createSVGIcon('<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="#aaa"><path d="M240-120q-33 0-56.5-23.5T160-200v-480q0-33 23.5-56.5T240-760h120l80 80h320q33 0 56.5 23.5T820-600v400q0 33-23.5 56.5T740-120H240Zm0-80h500v-400H447l-80-80H240v480Zm0 0v-480 480Zm280-240q17 0 28.5-11.5T560-480q0-17-11.5-28.5T520-520q-17 0-28.5 11.5T480-480q0 17 11.5 28.5T520-440Zm-160 0q17 0 28.5-11.5T400-480q0-17-11.5-28.5T360-520q-17 0-28.5 11.5T320-480q0 17 11.5 28.5T360-440Zm320 0q17 0 28.5-11.5T720-480q0-17-11.5-28.5T680-520q-17 0-28.5 11.5T640-480q0 17 11.5 28.5T680-440ZM520-280q17 0 28.5-11.5T560-320q0-17-11.5-28.5T520-360q-17 0-28.5 11.5T480-320q0 17 11.5 28.5T520-280Zm-160 0q17 0 28.5-11.5T400-320q0-17-11.5-28.5T360-360q-17 0-28.5 11.5T320-320q0 17 11.5 28.5T360-280Zm320 0q17 0 28.5-11.5T720-320q0-17-11.5-28.5T680-360q-17 0-28.5 11.5T640-320q0 17 11.5 28.5T680-280Z"/></svg>', 16);
  tagsHeader.appendChild(tagsIcon);
  const tagsText = document.createElement('span');
  tagsText.textContent = 'Tags';
  tagsText.style.fontSize = '12px';
  tagsText.style.fontWeight = '600';
  tagsText.style.color = '#aaa';
  tagsText.style.textTransform = 'uppercase';
  tagsText.style.letterSpacing = '0.5px';
  tagsText.style.marginLeft = '6px';
  tagsHeader.appendChild(tagsText);
  attachListViewColumnResizeHandle(tagsHeader, 'tags');
  headerInfo.appendChild(tagsHeader);
  
  // Archive column header (with icon, not sortable)
  const archiveWrap = document.createElement('div');
  archiveWrap.className = 'list-view-col';
  archiveWrap.dataset.listCol = 'archive';
  archiveWrap.style.position = 'relative';
  const archiveHeader = document.createElement('div');
  archiveHeader.style.display = 'flex';
  archiveHeader.style.alignItems = 'center';
  archiveHeader.style.justifyContent = 'center';
  archiveHeader.style.width = '100%';
  const archiveIcon = createSVGIcon('<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="#aaa"><path d="M640-480v-80h80v80h-80Zm0 80h-80v-80h80v80Zm0 80v-80h80v80h-80ZM447-640l-80-80H160v480h400v-80h80v80h160v-400H640v80h-80v-80H447ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80v-480 480Z"/></svg>', 16);
  archiveHeader.appendChild(archiveIcon);
  const archiveText = document.createElement('span');
  archiveText.textContent = 'Archive';
  archiveText.style.fontSize = '12px';
  archiveText.style.fontWeight = '600';
  archiveText.style.color = '#aaa';
  archiveText.style.textTransform = 'uppercase';
  archiveText.style.letterSpacing = '0.5px';
  archiveText.style.marginLeft = '6px';
  archiveHeader.appendChild(archiveText);
  archiveWrap.appendChild(archiveHeader);
  attachListViewColumnResizeHandle(archiveWrap, 'archive');
  headerInfo.appendChild(archiveWrap);
  attachListViewColumnReorderOnHeader(headerInfo);
  
  header.appendChild(headerInfo);
  
  // Store references to sortable headers for updating indicators
  header.sortableHeaders = {
    name: nameHeader,
    size: sizeHeader,
    dateadded: dateAddedHeader,
    directory: directoryHeader,
    designer: designerHeader,
    parentmodel: parentModelHeader,
    printed: printedHeader
  };
  
  // Function to update all sort indicators
  header.updateSortIndicators = function() {
    const currentSort = window.libraryFilters?.state().sort || 'date-desc';
    
    // Update each sortable header's indicator
    Object.values(header.sortableHeaders).forEach(sortableHeader => {
      if (sortableHeader && sortableHeader.updateSortIndicator) {
        sortableHeader.updateSortIndicator(currentSort);
      }
    });
  };
  
  // Initial update of sort indicators
  header.updateSortIndicators();
  applyListViewColumnLayoutToSubtree(header);
  
  return header;
}




// Add license filter population with null checks
async function populateLicenseFilter() {
  window.libraryFilters?.reloadOptions();
}

// After De-Dup (src/web/DedupDialog.tsx) deleted files: clear the selection and reload the grid.
window.refreshAfterDedupDelete = async function refreshAfterDedupDelete() {
  window.selection.clear();
  const sortSelect = document.getElementById('sort-select');
  await renderFiles(await window.electron.getAllModels(sortSelect ? sortSelect.value : 'date-desc'));
};

// Add a separate function for generating thumbnails
async function generateThumbnail(file) {
  try {
    const filePath = (typeof file === 'string') ? file : file.filePath;
    if (!filePath) {
      throw new Error("generateThumbnail: filePath is undefined");
    }

    // 1. Try to get embedded thumbnail for 3MF / LYS / F3D / ChiTuBox / VOXL
    const pathForExt = filePath.includes('::') ? (filePath.split('::')[1] || '') : filePath;
    const thumbExt = pathForExt.split('.').pop().toLowerCase();
    if (isImageOnlyPreviewExt(thumbExt)) {
        console.log(`[DEBUG] generateThumbnail: Attempting to extract embedded preview for ${filePath}`);
        try {
            const images = await extractEmbeddedPreviewImages(filePath, thumbExt);
            if (images && images.length > 0) {
                const validImages = images.filter(
                  (im) => typeof im === 'string' && im.startsWith('data:image')
                );
                if (validImages.length > 0) {
                    await window.electron.addMultipleThumbnails(filePath, validImages);
                    try {
                      await window.electron.calculateFileHash(filePath);
                    } catch (hashError) {
                      console.error(`Error calculating hash for ${filePath}:`, hashError);
                    }
                    return validImages[0];
                }
            }
        } catch (e) {
            console.error(`Error extracting ${thumbExt.toUpperCase()} thumbnail:`, e);
        }
        // Retryable sentinel — do not persist typed F3D/ChiTuBox/VOXL art.
        await window.electron.saveThumbnail(filePath, '3d.png');
        return '3d.png';
    }
    if (thumbExt === 'lys') {
        console.log(`[DEBUG] generateThumbnail: Attempting to extract embedded preview for ${filePath}`);
        try {
            const images = await extractLYSThumbnail(filePath);
            if (images && images.length > 0) {
                const validImages = images.filter(
                  (im) => typeof im === 'string' && im.startsWith('data:image')
                );
                if (validImages.length > 0) {
                    await window.electron.addMultipleThumbnails(filePath, validImages);
                    try {
                      await window.electron.calculateFileHash(filePath);
                    } catch (hashError) {
                      console.error(`Error calculating hash for ${filePath}:`, hashError);
                    }
                    return validImages[0];
                }
            }
        } catch (e) {
            console.error('Error extracting LYS thumbnail:', e);
        }
    }

    if (filePath.toLowerCase().endsWith('.3mf')) {
        console.log(`[DEBUG] generateThumbnail: Attempting to extract embedded thumbnail for ${filePath}`);
        try {
            const images = await extract3MFThumbnail(filePath);
            if (images && images.length > 0) {
                const validImages = images.filter(
                  (im) => typeof im === 'string' && im.startsWith('data:image')
                );
                if (validImages.length > 0) {
                    const firstImage = validImages[0];
                    console.log(
                      `[DEBUG] generateThumbnail: SUCCESS - Saving ${validImages.length} embedded image(s) for ${filePath}`
                    );
                    await window.electron.addMultipleThumbnails(filePath, validImages);

                    try {
                      await window.electron.calculateFileHash(filePath);
                    } catch (hashError) {
                      console.error(`Error calculating hash for ${filePath}:`, hashError);
                    }

                    return firstImage;
                } else {
                    console.log(`[DEBUG] generateThumbnail: Invalid image format for ${filePath}`);
                }
            } else {
                console.log(`[DEBUG] generateThumbnail: No embedded images found for ${filePath}`);
            }
        } catch (e) {
            console.error('Error extracting 3MF thumbnail:', e);
        }
    }

    // Use the exposed function to get file stats
    const stats = await window.electron.getFileStats(filePath);
    const fileSizeInMB = stats.size / (1024 * 1024);
    
    if (fileSizeInMB > MAX_FILE_SIZE_MB) {
      debugLog(`Skipping thumbnail generation for ${filePath} (${fileSizeInMB.toFixed(2)}MB > ${MAX_FILE_SIZE_MB}MB)`);
      console.warn(`Skipping thumbnail generation for ${filePath} (${fileSizeInMB.toFixed(2)}MB > ${MAX_FILE_SIZE_MB}MB)`);
      await window.electron.saveThumbnail(filePath, '3d.png');
      return '3d.png';
    }

    // Create a temporary container for rendering (not in DOM — retainDetached required)
    const tempContainer = document.createElement('div');
    
    // Call renderModelToPNG directly instead of renderThumbnail
    const thumbnail = await renderModelToPNG(filePath, tempContainer, null, {
      retainDetached: true
    });

    if (!thumbnail || isFailurePlaceholderThumbnail(thumbnail)) {
      // Leave as default so hasThumbnail stays false and Docker can retry later.
      return '3d.png';
    }

    await window.electron.saveThumbnail(filePath, thumbnail);
    
    // Calculate and save hash during thumbnail generation (file is already being read)
    try {
      await window.electron.calculateFileHash(filePath);
    } catch (hashError) {
      console.error(`Error calculating hash for ${filePath}:`, hashError);
      // Continue even if hash calculation fails
    }
    
    return thumbnail;
  } catch (error) {
    console.error(`Error generating thumbnail for ${file.filePath || file}:`, error);
    return '3d.png';
  }
}

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

// Resolve which file path(s) a context menu should operate on.
// If the right-clicked item is part of a multi-selection, use the whole selection.
function resolveContextMenuFilePaths(clickedFilePath) {
  const selected = Array.from(window.selection).filter(Boolean);
  const clickedSelected = clickedFilePath && window.selection.has(clickedFilePath);

  if (selected.length > 1 && clickedSelected) {
    return selected;
  }

  // Multi-edit mode with a selection: operate on all selected even if the click
  // target path format differs slightly from the Set entry.
  if (isMultiSelectMode && selected.length > 1) {
    return selected;
  }

  if (clickedFilePath) return [clickedFilePath];
  return selected.length ? selected : [];
}

// Add this function near other file rendering functions
function suppressTileTap(fileElement, ms = 600) {
  if (!fileElement) return;
  fileElement._suppressTap = true;
  clearTimeout(fileElement._suppressTapTimer);
  fileElement._suppressTapTimer = setTimeout(() => {
    fileElement._suppressTap = false;
  }, ms);
}

function wasTileTapSuppressed(fileElement, e) {
  if (!fileElement?._suppressTap) return false;
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  return true;
}

function addContextMenuHandler(fileElement, filePath) {
  // Remove any existing context menu handler to avoid duplicates
  fileElement.removeEventListener('contextmenu', fileElement._contextMenuHandler);
  
  // Create the handler function
  const handler = async (e) => {
    // A touch long-press is followed by a tap; a mouse right-click is not.
    if (e.pointerType !== 'mouse') suppressTileTap(fileElement);
    e.preventDefault(); // Prevent default context menu
    
    // For list view, ensure the entire element is clickable
    // Check if the click is on this element or any of its children
    const target = e.target;
    if (!fileElement.contains(target) && target !== fileElement) {
      return; // Click was outside the element
    }
    
    e.stopPropagation(); // Prevent event bubbling after we've handled it
    
    // Get click coordinates for positioning HTML menu
    const x = e.clientX;
    const y = e.clientY;
    
    // If the right-clicked item is part of a multi-selection, operate on all selected.
    // Otherwise use the single right-clicked file.
    const paths = resolveContextMenuFilePaths(filePath);
    await window.contextMenu?.show(paths.length > 1 ? paths : (paths[0] || filePath), x, y);
  };
  
  // Store handler reference for potential removal
  fileElement._contextMenuHandler = handler;
  
  // Use capture phase for list view to catch events on child elements
  // For other views, use bubble phase
  const useCapture = fileElement.classList.contains('file-item-list');
  fileElement.addEventListener('contextmenu', handler, useCapture);

  attachTileLongPress(fileElement, (x, y) => {
    handler({
      preventDefault() {},
      stopPropagation() {},
      clientX: x,
      clientY: y,
      target: fileElement
    });
  });
}

function attachTileLongPress(fileElement, onLongPress) {
  fileElement.removeEventListener('touchstart', fileElement._longPressStart);
  fileElement.removeEventListener('touchmove', fileElement._longPressMove);
  fileElement.removeEventListener('touchend', fileElement._longPressEnd);
  fileElement.removeEventListener('touchcancel', fileElement._longPressEnd);
  let longPressTimer = null;
  let longPressX = 0;
  let longPressY = 0;
  fileElement._longPressStart = (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    longPressX = t.clientX;
    longPressY = t.clientY;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      suppressTileTap(fileElement);
      onLongPress(longPressX, longPressY);
    }, 550);
  };
  fileElement._longPressMove = (e) => {
    if (!longPressTimer || !e.touches || !e.touches[0]) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - longPressX) > 14 || Math.abs(t.clientY - longPressY) > 14) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  fileElement._longPressEnd = (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (fileElement._suppressTap && e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
  };
  fileElement.addEventListener('touchstart', fileElement._longPressStart, { passive: true });
  fileElement.addEventListener('touchmove', fileElement._longPressMove, { passive: true });
  fileElement.addEventListener('touchend', fileElement._longPressEnd);
  fileElement.addEventListener('touchcancel', fileElement._longPressEnd);
  fileElement.addEventListener('click', (e) => {
    wasTileTapSuppressed(fileElement, e);
  }, true);
}

// Update the exit multi-edit mode functionality
/** Leave multi-edit mode: clear the selection and show the (empty) details panel. */
function exitMultiEditMode() {
  window.selection.clear();
  isMultiSelectMode = false;
  document.getElementById('multi-edit-panel')?.classList.add('hidden');
  document.getElementById('model-details')?.classList.remove('hidden');
  const toggle = document.getElementById('edit-mode-toggle');
  if (toggle) {
    toggle.textContent = 'Multi-Edit Mode';
    toggle.classList.remove('active');
  }
  // A details load still in flight must not fill the panel again.
  currentModelDetailsPath = null;
  currentModelDetailsAbort = true;
  setDetailsPath(null);
  window.detailsFields?.clear();
  window.detailsNotes?.clear();
  window.detailsPrint?.clear();
  window.detailsFilaments?.clear();
}

/** Show the multi-edit panel for the current selection. */
function enterMultiEditMode() {
  isMultiSelectMode = true;
  const toggle = document.getElementById('edit-mode-toggle');
  if (toggle) {
    toggle.textContent = 'Exit Multi-Edit Mode';
    toggle.classList.add('active');
  }
  document.getElementById('model-details')?.classList.add('hidden');
  const panel = document.getElementById('multi-edit-panel');
  panel?.classList.remove('hidden');
  showMultiEditPanel();
  requestAnimationFrame(() => panel?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// Update the edit mode toggle handler

// Update the exit button handler
document.getElementById('edit-mode-toggle')?.addEventListener('click', () => {
  if (isMultiSelectMode) exitMultiEditMode();
  else enterMultiEditMode();
});

// The details panel's button: start multi-edit with the shown model selected.
document.getElementById('enter-multi-edit-button')?.addEventListener('click', () => {
  const current = getCurrentModelFilePath();
  if (current) window.selection.add(current);
  enterMultiEditMode();
});

// Add these configurations at the top of your file
const RENDER_CONFIG = {
  THUMBNAIL_SIZE: 250,
  MAX_CACHE_SIZE: 1000,
  CHUNK_SIZE: 5,
  JPEG_QUALITY: 0.8,
  CLEANUP_INTERVAL: 60000
};


// Searchable list dialog functionality
/** onPick: hand the picked value (or null when cancelled) to the caller instead of a select. */
async function showSearchableListDialog(fieldType, targetSelectId, mode = 'filter', containerId = null, isRemove = false, onPick = null) {
  const dialog = document.getElementById('searchable-list-dialog');
  const titleElement = document.getElementById('searchable-list-title');
  const searchInput = document.getElementById('searchable-list-search');
  const itemsList = document.getElementById('searchable-list-items');
  const cancelButton = document.getElementById('searchable-list-cancel');
  
  if (!dialog || !titleElement || !searchInput || !itemsList) {
    console.error('Searchable list dialog elements not found');
    return;
  }
  
  // Set title based on field type
  const titles = {
    designer: 'Select Designer',
    parent: 'Select Parent Model',
    license: 'Select License',
    tag: isRemove ? 'Remove Tag' : 'Select Tag',
    filament: isRemove ? 'Remove Filament' : 'Select Filament'
  };
  titleElement.textContent = titles[fieldType] || 'Select Item';
  
  // Clear previous content
  searchInput.value = '';
  itemsList.innerHTML = '';
  
  // Fetch data based on field type
  let items = [];
  let filamentValueByLabel = null;
  try {
    switch (fieldType) {
      case 'designer':
        items = await window.electron.getDesigners();
        break;
      case 'parent':
        items = await window.electron.getParentModels();
        // Remove duplicates
        items = [...new Set(items.filter(p => p))];
        break;
      case 'license':
        items = await window.electron.getLicenses();
        break;
      case 'tag':
        if (isRemove && targetSelectId === 'multi-tag-remove-select') {
          // For remove tags, get tags from selected files only
          if (window.selection.size === 0) {
            items = [];
          } else {
            const filePaths = Array.from(window.selection);
            const tagPromises = filePaths.map(async (filePath) => {
              try {
                const model = await window.electron.getModel(filePath);
                return model && model.tags ? (Array.isArray(model.tags) ? model.tags : []) : [];
              } catch (error) {
                console.error(`Error loading tags for ${filePath}:`, error);
                return [];
              }
            });
            const allTagsArrays = await Promise.all(tagPromises);
            // Collect unique tags
            const uniqueTags = new Set();
            allTagsArrays.forEach(tags => {
              if (Array.isArray(tags)) {
                tags.forEach(tag => {
                  if (tag && typeof tag === 'string') {
                    const normalizedTag = tag.trim();
                    if (normalizedTag) {
                      uniqueTags.add(normalizedTag);
                    }
                  }
                });
              }
            });
            items = Array.from(uniqueTags);
          }
        } else {
          // For add tags, get all tags
          const tags = await window.electron.getAllTags();
          items = tags.map(t => t.name);
        }
        break;
      case 'filament':
        if (isRemove && targetSelectId === 'multi-filament-remove-select') {
          if (typeof window.selection === 'undefined' || window.selection.size === 0) {
            items = [];
          } else {
            const filePaths = Array.from(window.selection);
            const lists = await Promise.all(filePaths.map(async (filePath) => {
              try {
                const model = await window.electron.getModel(filePath);
                return Array.isArray(model?.filaments) ? model.filaments : [];
              } catch (error) {
                return [];
              }
            }));
            const byId = new Map();
            lists.flat().forEach((f) => {
              if (f && f.id != null && !byId.has(String(f.id))) byId.set(String(f.id), f);
            });
            items = Array.from(byId.values());
          }
        } else {
          const filaments = await window.electron.getAllFilaments();
          items = filaments || [];
        }
        break;
      default:
        console.error('Unknown field type:', fieldType);
        return;
    }
    
    if (fieldType === 'filament') {
      filamentValueByLabel = new Map();
      items = (items || []).map((f) => {
        const id = String(f && f.id != null ? f.id : f);
        const label = (typeof window.formatFilamentLabel === 'function' && f && typeof f === 'object')
          ? window.formatFilamentLabel(f)
          : String(f && f.name ? f.name : id);
        filamentValueByLabel.set(label, id);
        return label;
      });
    }

    // Sort items alphabetically
    items.sort((a, b) => a.localeCompare(b));
    
    // Filter out empty values
    items = items.filter(item => item && item.trim() !== '');
    
    if (items.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No items found';
      li.style.color = '#888';
      li.style.cursor = 'default';
      itemsList.appendChild(li);
    } else {
      // Render items
      renderListItems(items, itemsList, '');
    }
  } catch (error) {
    console.error('Error fetching items for searchable list:', error);
    const li = document.createElement('li');
    li.textContent = 'Error loading items';
    li.style.color = '#ff4444';
    li.style.cursor = 'default';
    itemsList.appendChild(li);
    return;
  }
  
  let picked = false;
  if (onPick) {
    dialog.addEventListener('close', () => { if (!picked) onPick(null); }, { once: true });
  }

  // Handle item selection
  const handleItemClick = async (itemValue) => {
    if (onPick) {
      picked = true;
      dialog.close();
      onPick(filamentValueByLabel ? (filamentValueByLabel.get(itemValue) || itemValue) : itemValue);
      return;
    }
    dialog.close();
    
    const targetSelect = document.getElementById(targetSelectId);
    if (!targetSelect) {
      console.error('Target select element not found:', targetSelectId);
      return;
    }

    try {
      const resolvedValue = filamentValueByLabel ? (filamentValueByLabel.get(itemValue) || itemValue) : itemValue;
      targetSelect.value = resolvedValue;
    
      // For remove tags, trigger the remove handler
      if (isRemove && targetSelectId === 'multi-tag-remove-select') {
        // Trigger the change event which will call handleRemoveTagSelect
        targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (isRemove && targetSelectId === 'multi-filament-remove-select') {
        targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (fieldType === 'tag' && mode !== 'filter' && containerId) {
        // For tags in edit mode, use addTagToModel
        await addTagToModel(itemValue, containerId);
        targetSelect.value = '';
        if (typeof populateTagSelect === 'function') {
          await populateTagSelect(targetSelectId, containerId);
        }
      } else if (fieldType === 'filament' && mode !== 'filter' && containerId) {
        if (typeof window.addFilamentToModel === 'function') {
          await window.addFilamentToModel({ id: Number(resolvedValue) }, containerId);
        }
        targetSelect.value = '';
      } else if (mode === 'edit' || mode === 'multi') {
        // For edit/multi mode, trigger auto-save
        const fieldMap = {
          designer: 'designer',
          parent: 'parentModel',
          license: 'license'
        };
      
        if (fieldMap[fieldType]) {
          const filePath = mode === 'edit' ? getCurrentModelFilePath() : null;
          if (mode === 'multi') {
            autoSaveMultipleModels(fieldMap[fieldType], itemValue);
          } else if (filePath) {
            autoSaveModel(fieldMap[fieldType], itemValue, filePath);
          }
        }
      
        // Trigger change event after setting value
        targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (mode === 'filter') {
        // For filter mode, trigger filter update
        targetSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (error) {
      console.error('Error applying searchable list selection:', error);
    }
  };
  
  // Render list items function
  function renderListItems(itemsToRender, listElement, searchTerm) {
    listElement.innerHTML = '';
    
    if (itemsToRender.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No items found';
      li.style.color = '#888';
      li.style.cursor = 'default';
      listElement.appendChild(li);
      return;
    }
    
    itemsToRender.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      li.addEventListener('click', () => handleItemClick(item));
      listElement.appendChild(li);
    });
  }
  
  // Handle search input with debounce
  let searchTimeout;
  const handleSearch = (e) => {
    const searchTerm = e.target.value;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const filtered = items.filter(item => 
        item.toLowerCase().includes(searchTerm.toLowerCase())
      );
      renderListItems(filtered, itemsList, searchTerm);
    }, 200);
  };
  
  searchInput.addEventListener('input', handleSearch);
  
  // Handle cancel button
  const handleCancel = () => {
    dialog.close();
  };
  cancelButton.addEventListener('click', handleCancel);
  
  // Close on Escape key
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      dialog.close();
    }
  };
  dialog.addEventListener('keydown', handleKeyDown);
  
  // Clean up event listeners when dialog closes
  dialog.addEventListener('close', () => {
    searchInput.removeEventListener('input', handleSearch);
    cancelButton.removeEventListener('click', handleCancel);
    dialog.removeEventListener('keydown', handleKeyDown);
  }, { once: true });
  
  // Show dialog
  dialog.showModal();
  
  // Focus search input
  requestAnimationFrame(() => {
    searchInput.focus();
  });
}

// Helper function to get current model file path
function getCurrentModelFilePath() {
  const modelDetails = document.getElementById('model-details');
  if (modelDetails && !modelDetails.classList.contains('hidden')) {
    const pathContainer = document.getElementById('path-tree-container');
    if (pathContainer && pathContainer.dataset.filePath) {
      return pathContainer.dataset.filePath;
    }
  }
  return null;
}

// Initialize List button event listeners
function initializeListButtons() {
  document.querySelectorAll('.list-button').forEach(button => {
    // React screens (the details panel) handle their own list buttons and own those nodes.
    if (!button.dataset.field) return;
    // Remove existing listeners to avoid duplicates
    const newButton = button.cloneNode(true);
    button.parentNode.replaceChild(newButton, button);
    
    newButton.addEventListener('click', async () => {
      const fieldType = newButton.dataset.field;
      const targetSelectId = newButton.dataset.target;
      const mode = newButton.dataset.mode || 'filter';
      const containerId = newButton.dataset.container || null;
      const isRemove = newButton.dataset.remove === 'true';
      
      await showSearchableListDialog(fieldType, targetSelectId, mode, containerId, isRemove);
    });
  });
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
    // Initialize performance settings inline
    try {
      // Get the stored max file size value
      const maxFileSize = await window.electron.getSetting('maxFileSizeMB');
      if (maxFileSize) {
        MAX_FILE_SIZE_MB = parseInt(maxFileSize);
      }
    } catch (error) {
      console.error('Error initializing performance settings:', error);
    }
    

    
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

// Add implementation of autoSaveModel function
async function autoSaveModel(field, value, filePath) {
  try {
    if (!filePath) {
      console.error('No file path provided for autoSaveModel');
      return;
    }
    
    const model = await window.electron.getModel(filePath);
    if (!model) {
      console.error(`Model not found for ${filePath}`);
      return;
    }
    
    // Update the specified field
    model[field] = value;
    
    // Save the updated model
    await window.electron.saveModel(model);
    
    // If this was called from the details panel, update the displayed file
    await updateModelElement(filePath);
    
    // Also update the checkbox in the model details panel if it's showing this model
    if (field === 'printed' || field === 'printStatus') {
      const currentModelPath = getCurrentModelFilePath() || 
        document.querySelector('.model-details')?.getAttribute('data-filepath');
      if (currentModelPath === filePath && window.PrintHistory) {
        const updated = await window.electron.getModel(filePath);
        if (updated) await window.PrintHistory.populateDetails(updated);
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error in autoSaveModel for field ${field}:`, error);
    return false;
  }
}

window.autoSaveModel = autoSaveModel;

// Add implementation of autoSaveMultipleModels function
async function autoSaveMultipleModels(field, value, options = {}) {
  try {
    // No models selected
    if (window.selection.size === 0) {
      console.warn('No models selected for autoSaveMultipleModels');
      return false; // Indicate failure/no-op
    }
    
    // Handle designer field default value (will be reapplied next)
    if (field === 'designer' && !value) {
      value = 'Unknown';
    }
    
    // Create a copy of window.selection to avoid issues if the set changes during iteration
    const modelsToUpdate = Array.from(window.selection);
    console.log(`autoSaveMultipleModels: Updating ${modelsToUpdate.length} models for field ${field}`);
    
    // Load all models in parallel for better performance
    const modelLoadPromises = modelsToUpdate.map(async (filePath, index) => {
      try {
        console.log(`[${index}] Loading model: ${filePath}`);
        const model = await window.electron.getModel(filePath);
        if (model) {
          console.log(`[${index}] Successfully loaded model: ${filePath}`);
          return { filePath, model };
        } else {
          console.warn(`[${index}] Could not find model for ${filePath} during autoSaveMultipleModels`);
          return null;
        }
      } catch (error) {
        console.error(`[${index}] Error loading model ${filePath} in autoSaveMultipleModels:`, error);
        return null;
      }
    });
    
    // Wait for all models to load in parallel
    const loadedModels = await Promise.all(modelLoadPromises);
    console.log(`Loaded ${loadedModels.length} models, ${loadedModels.filter(r => r !== null).length} successful`);
    
    // Filter out null results and prepare updates
    const modelUpdates = [];
    for (let i = 0; i < loadedModels.length; i++) {
      const result = loadedModels[i];
      if (result) {
        const { filePath, model } = result;
        console.log(`[${i}] Processing model update for: ${filePath}`);
        // Special handling for tags - MERGE or REPLACE based on options
        if (field === 'tags') {
          const newTags = Array.isArray(value) ? value : []; 
          if (options.replaceTags) {
            // Replace tags completely (used when removing tags)
            model.tags = newTags.sort();
            console.log(`[${i}] Replacing tags with: ${newTags.join(', ')}`);
          } else {
            // Merge tags (used when adding tags)
            const existingTags = Array.isArray(model.tags) ? model.tags : [];
            // Combine, filter out duplicates, and sort
            const allTags = [...new Set([...existingTags, ...newTags])].sort(); 
            model.tags = allTags;
            console.log(`[${i}] Merging tags. Existing: ${existingTags.join(', ')}, New: ${newTags.join(', ')}, Result: ${allTags.join(', ')}`);
          }
        } else if (field === 'filaments') {
          const toId = (v) => (v && typeof v === 'object' ? Number(v.id) : Number(v));
          const newIds = (Array.isArray(value) ? value : []).map(toId).filter((id) => Number.isInteger(id) && id > 0);
          if (options.replaceFilaments) {
            model.filaments = newIds;
          } else {
            const existing = (Array.isArray(model.filaments) ? model.filaments : []).map(toId).filter((id) => Number.isInteger(id) && id > 0);
            model.filaments = [...new Set([...existing, ...newIds])];
          }
        } else {
          // Handle other fields
          model[field] = value;
        }
        
        modelUpdates.push({ filePath, model });
        console.log(`[${i}] Added to batch: ${filePath}, field ${field} = ${value}`);
      } else {
        console.warn(`[${i}] Skipping null result at index ${i}`);
      }
    }
    console.log(`Prepared ${modelUpdates.length} models for batch update`);
    
    // Save all models in a single bulk update
    if (modelUpdates.length > 0) {
      const modelDataBatch = modelUpdates.map(({ model }) => model);
      try {
        // Use bulk update for better performance - single transaction
        console.log(`Attempting bulk update for ${modelDataBatch.length} models`);
        const success = await window.electron.updateModelsBatch(modelDataBatch);
        if (!success) {
          throw new Error('Bulk update returned false');
        }
        console.log(`Successfully bulk updated ${modelDataBatch.length} models`);
      } catch (error) {
        console.error(`Error in bulk update for ${modelUpdates.length} models:`, error);
        console.log('Falling back to individual saves');
        // Fallback to individual saves if bulk update fails
        const savePromises = modelUpdates.map(({ model }) => 
          window.electron.saveModel(model).catch(err => {
            console.error(`Error saving model ${model.filePath}:`, err);
            return null;
          })
        );
        await Promise.all(savePromises);
      }
    }
    
    // The React grid cards redraw from the merged models.
    modelUpdates.forEach(({ model }) => mergeModelIntoGridCurrentModels({ ...model }));
    refreshLibraryGrid();

    console.log(`Finished autoSaveMultipleModels for field ${field}. Updated ${modelsToUpdate.length} models.`);
    return true;
  } catch (error) {
    console.error(`Error in autoSaveMultipleModels for field ${field}:`, error);
    return false;
  }
}

// Helper function to get the current model file path
function getModelFilePath() {
  // First try to get it from the path tree container
  const currentPath = getCurrentModelFilePath();
  if (currentPath) {
    return currentPath;
  }
  
  // Fallback: try to get it from the model-path input (for backwards compatibility)
  const pathInput = document.getElementById('model-path');
  if (pathInput && pathInput.value) {
    return pathInput.value;
  }
  
  // Then try to get it from the model-details data attribute
  const detailsPanel = document.querySelector('.model-details');
  if (detailsPanel && detailsPanel.getAttribute('data-filepath')) {
    return detailsPanel.getAttribute('data-filepath');
  }
  
  return null;
}

// Helper function to clear all multi-edit form fields
function clearMultiEditFormFields() {
  window.multiEdit?.open();
}

// Add this code to set up event handlers for multi-edit mode controls
/** The multi-edit panel was shown: reset its form (React, src/web/details/MultiEditPanel.tsx). */
async function showMultiEditPanel() {
  window.multiEdit?.open();
}

// Update the edit mode toggle handler to call showMultiEditPanel when entering multi-edit mode



function normalizeModelRatingValue(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 5) return 5;
  return n;
}

async function bulkSaveModelsEngagement(filePaths, field, value) {
  if (!filePaths || !filePaths.length) return false;
  const updates = [];
  for (const filePath of filePaths) {
    try {
      const model = await window.electron.getModel(filePath);
      if (!model) continue;
      model[field] = value;
      updates.push(model);
    } catch (err) {
      console.error('bulkSaveModelsEngagement load error:', filePath, err);
    }
  }
  if (!updates.length) return false;
  try {
    const success = await window.electron.updateModelsBatch(updates);
    if (success) {
      for (const m of updates) {
        await updateModelElement(m.filePath);
      }
    }
    return success;
  } catch (err) {
    console.error('bulkSaveModelsEngagement save error:', err);
    return false;
  }
}

// Analyze models to determine which metadata fields have data
function analyzeModelFields(models) {
  const fieldAnalysis = {
    hasDesigner: false,
    hasSource: false,
    hasParentModel: false,
    hasLicense: false,
    hasTags: false
  };
  
  if (!models || models.length === 0) {
    return fieldAnalysis;
  }
  
  for (const model of models) {
    if (model.designer && model.designer.trim()) {
      fieldAnalysis.hasDesigner = true;
    }
    if (model.source && model.source.trim()) {
      fieldAnalysis.hasSource = true;
    }
    if (model.parentModel && model.parentModel.trim()) {
      fieldAnalysis.hasParentModel = true;
    }
    if (model.license && model.license.trim()) {
      fieldAnalysis.hasLicense = true;
    }
    if (model.tags && Array.isArray(model.tags) && model.tags.length > 0) {
      fieldAnalysis.hasTags = true;
    }
    
    // If all fields are found, we can break early for performance
    if (fieldAnalysis.hasDesigner && fieldAnalysis.hasSource && 
        fieldAnalysis.hasParentModel && fieldAnalysis.hasLicense && fieldAnalysis.hasTags) {
      break;
    }
  }
  
  return fieldAnalysis;
}

/** Merge field-visibility flags (progressive load: only analyze appended tail). */
function mergeModelFieldAnalysis(base, delta) {
  return {
    hasDesigner: base.hasDesigner || delta.hasDesigner,
    hasSource: base.hasSource || delta.hasSource,
    hasParentModel: base.hasParentModel || delta.hasParentModel,
    hasLicense: base.hasLicense || delta.hasLicense,
    hasTags: base.hasTags || delta.hasTags
  };
}

/** True when `next` is `prev` with extra rows appended in the same order (progressive library load). */
function isProgressiveModelListExtension(prevModels, nextModels) {
  if (!prevModels.length || nextModels.length <= prevModels.length) return false;
  const key = (m) => (m.id != null && m.id !== '') ? m.id : m.filePath;
  for (let i = 0; i < prevModels.length; i++) {
    if (key(prevModels[i]) !== key(nextModels[i])) return false;
  }
  return true;
}

const parentModelExpandedGroups = new Set();
const zipArchiveExpandedGroups = new Set();
const bundleExpandedGroups = new Set();

/** Group expanded or collapsed: lay the grid out again. */
function invalidateVirtualGridLayoutCache() {
  window.libraryGrid?.refresh();
}
let groupThumbnailPreferencesLoaded = false;
let groupThumbnailPreferencesLoading = null;
const groupThumbnailPreferences = {};
/** Survives virtual-grid card recycle so folder/ZIP icons don't flash 3d.png forever. */
const groupThumbnailCache = new Map();

function childHasStoredThumbnail(child) {
  if (!child) return false;
  const primary = getPrimaryThumbnailFromString(child.thumbnail);
  if (primary && !isFailurePlaceholderThumbnail(primary)) return true;
  return Boolean(child.hasThumbnail) && Number(child.hasThumbnail) !== 0;
}

function rememberGroupThumbnails(groupKey, thumbnails) {
  if (!groupKey) return;
  const valid = (thumbnails || []).filter((t) => t && t !== '3d.png' && !isFailurePlaceholderThumbnail(t));
  if (valid.length === 0) return;
  groupThumbnailCache.set(groupKey, valid.slice(0, MAX_GROUP_CAROUSEL_THUMBNAILS));
}

function getCachedGroupThumbnails(groupKey) {
  if (!groupKey || !groupThumbnailCache.has(groupKey)) return [];
  return groupThumbnailCache.get(groupKey).slice();
}

/** Goes up when group images change, so React group cards load them again. */
let groupThumbnailVersion = 0;

function invalidateGroupThumbnailCache(groupKey = null) {
  if (groupKey) groupThumbnailCache.delete(groupKey);
  else groupThumbnailCache.clear();
  groupThumbnailVersion += 1;
}

async function filterNonEmptyThumbnails(thumbs) {
  const out = [];
  for (const t of thumbs || []) {
    if (!t || t === '3d.png' || isFailurePlaceholderThumbnail(t)) continue;
    if (await isMostlyEmptyThumbnailDataUrl(t)) continue;
    out.push(t);
  }
  return out;
}

async function loadGroupThumbnailPreferences() {
  if (groupThumbnailPreferencesLoaded) return;
  if (groupThumbnailPreferencesLoading) {
    await groupThumbnailPreferencesLoading;
    return;
  }
  groupThumbnailPreferencesLoading = (async () => {
  groupThumbnailPreferencesLoaded = true;
  try {
    if (!window.electron?.getSetting) return;
    const raw = await window.electron.getSetting('groupThumbnailPreferences');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      Object.assign(groupThumbnailPreferences, parsed);
    }
  } catch (error) {
    console.error('Failed to load group thumbnail preferences:', error);
  }
  })();
  await groupThumbnailPreferencesLoading;
  groupThumbnailPreferencesLoading = null;
}

async function saveGroupThumbnailPreferences() {
  try {
    if (!window.electron?.saveSetting) return;
    await window.electron.saveSetting('groupThumbnailPreferences', JSON.stringify(groupThumbnailPreferences));
  } catch (error) {
    console.error('Failed to save group thumbnail preferences:', error);
  }
}

function getParentModelGroupLabel(model) {
  return model?.parentModel ? String(model.parentModel).trim() : '';
}

function getParentModelGroupKey(parentModel) {
  return String(parentModel || '').trim().toLocaleLowerCase();
}

/** Cap group-card carousels so large folders don't become 1/500+ counters. */
const MAX_GROUP_CAROUSEL_THUMBNAILS = 12;
/** Cap the manage-thumbnails picker; one primary image per child is enough. */
const MAX_GROUP_MANAGE_THUMBNAILS = 48;

function getPrimaryThumbnailFromString(thumbnailString) {
  if (!thumbnailString || thumbnailString === '3d.png') return null;
  const primary = String(thumbnailString)
    .split('::')
    .find((t) => t && t !== '3d.png');
  return primary || null;
}

function getParentModelThumbnails(children, groupKey = '') {
  const thumbnails = [];
  const seen = new Set();

  // One primary thumbnail per child — not every embedded 3MF image.
  for (const child of children || []) {
    if (thumbnails.length >= MAX_GROUP_CAROUSEL_THUMBNAILS) break;
    const primary = getPrimaryThumbnailFromString(child.thumbnail);
    if (!primary || seen.has(primary)) continue;
    seen.add(primary);
    thumbnails.push(primary);
  }

  const preferred = groupThumbnailPreferences[groupKey];
  if (preferred) {
    const preferredIndex = thumbnails.indexOf(preferred);
    if (preferredIndex > 0) {
      thumbnails.splice(preferredIndex, 1);
      thumbnails.unshift(preferred);
    } else if (preferredIndex < 0 && preferred !== '3d.png') {
      thumbnails.unshift(preferred);
      if (thumbnails.length > MAX_GROUP_CAROUSEL_THUMBNAILS) {
        thumbnails.length = MAX_GROUP_CAROUSEL_THUMBNAILS;
      }
    }
  }

  return thumbnails;
}

/**
 * A group card's images: one per child, the preferred one first. Calls onImages as more arrive
 * (cache, inline data, stored thumbnails, then a render of the first child). Stops when isStale().
 */
async function loadGroupThumbnails(children, groupKey, onImages, isStale) {
  if (!window.electron) return;

  const applyThumbs = async (thumbs, { paint = true } = {}) => {
    const valid = await filterNonEmptyThumbnails(thumbs);
    if (valid.length === 0) return false;
    rememberGroupThumbnails(groupKey, valid);
    if (paint && !isStale()) onImages(valid);
    return true;
  };

  // Grid rows omit thumbnail blobs — prefer cache, then any inline data, then IPC.
  // Drop clipped/transparent leftovers from the old far-plane bug.
  let thumbnails = await filterNonEmptyThumbnails(getCachedGroupThumbnails(groupKey));
  if (thumbnails.length === 0) {
    groupThumbnailCache.delete(groupKey);
    thumbnails = await filterNonEmptyThumbnails(
      getParentModelThumbnails(children, groupKey)
    );
  }
  const seen = new Set(thumbnails);
  if (thumbnails.length > 0) {
    await applyThumbs(thumbnails);
  }
  if (thumbnails.length >= MAX_GROUP_CAROUSEL_THUMBNAILS) return;

  const candidates = (children || []).filter((child) => child.filePath);
  const withStored = candidates.filter((c) => childHasStoredThumbnail(c));
  const withoutStored = candidates.filter((c) => !childHasStoredThumbnail(c));
  const ordered = withStored.concat(withoutStored);

  const fetchPrimaryForChild = async (child) => {
    const tryThumb = async (value) => {
      const primary = getPrimaryThumbnailFromString(value) ||
        (value && value !== '3d.png' ? value : null);
      if (!primary || isFailurePlaceholderThumbnail(primary)) return null;
      if (await isMostlyEmptyThumbnailDataUrl(primary)) return null;
      return primary;
    };

    const inline = await tryThumb(child.thumbnail);
    if (inline) return inline;
    try {
      if (typeof fetchPrimaryThumbnailForGrid === 'function') {
        const single = await fetchPrimaryThumbnailForGrid(child.filePath);
        if (single) return single;
      } else if (window.electron.getThumbnail) {
        const single = await window.electron.getThumbnail(child.filePath);
        const primary = await tryThumb(single);
        if (primary) return primary;
      }
      if (window.electron.getModel) {
        const fullModel = await window.electron.getModel(child.filePath);
        return tryThumb(fullModel?.thumbnail);
      }
    } catch (error) {
      // Best-effort
    }
    return null;
  };

  const firstWave = ordered.slice(0, Math.min(6, MAX_GROUP_CAROUSEL_THUMBNAILS));
  if (firstWave.length > 0) {
    const results = await Promise.all(firstWave.map((child) => fetchPrimaryForChild(child)));
    if (isStale()) return;
    for (const primary of results) {
      if (!primary || seen.has(primary)) continue;
      seen.add(primary);
      thumbnails.push(primary);
      if (thumbnails.length >= MAX_GROUP_CAROUSEL_THUMBNAILS) break;
    }
    if (thumbnails.length > 0) {
      await applyThumbs(thumbnails);
    }
  }
  if (thumbnails.length >= MAX_GROUP_CAROUSEL_THUMBNAILS || isStale()) return;

  for (const child of ordered.slice(firstWave.length)) {
    if (isStale()) return;
    if (thumbnails.length >= MAX_GROUP_CAROUSEL_THUMBNAILS) break;
    const primary = await fetchPrimaryForChild(child);
    if (!primary || seen.has(primary)) continue;
    seen.add(primary);
    thumbnails.push(primary);
    await applyThumbs(thumbnails);
  }

  if (!isStale() && thumbnails.length > 0) {
    await applyThumbs(thumbnails);
    return;
  }

  if (!isStale() && thumbnails.length === 0 && candidates.length > 0 && typeof renderModelToPNG === 'function') {
    try {
      // Detached temp container — must retainDetached or post-load isConnected check aborts.
      const tempContainer = document.createElement('div');
      const rendered = await renderModelToPNG(candidates[0].filePath, tempContainer, null, {
        retainDetached: true
      });
      if (isStale()) return;
      if (rendered && rendered !== '3d.png' && !isFailurePlaceholderThumbnail(rendered) && !(await isMostlyEmptyThumbnailDataUrl(rendered))) {
        thumbnails.push(rendered);
        await applyThumbs(thumbnails);
        if (window.electron.saveThumbnail) {
          await window.electron.saveThumbnail(candidates[0].filePath, rendered);
        }
      }
    } catch (error) {
      // Keep the placeholder if rendering fallback fails.
    }
  }
}

async function collectThumbnailsForGroup(groupRecord) {
  const thumbnails = [];
  const seen = new Set();
  const addThumb = (thumb) => {
    if (!thumb || thumb === '3d.png' || seen.has(thumb)) return false;
    if (thumbnails.length >= MAX_GROUP_MANAGE_THUMBNAILS) return false;
    seen.add(thumb);
    thumbnails.push(thumb);
    return true;
  };

  for (const child of (groupRecord.children || [])) {
    if (thumbnails.length >= MAX_GROUP_MANAGE_THUMBNAILS) break;

    // One representative image per child for the picker.
    const inlinePrimary = getPrimaryThumbnailFromString(child.thumbnail);
    if (inlinePrimary) {
      addThumb(inlinePrimary);
      continue;
    }

    try {
      if (window.electron?.getThumbnail) {
        const single = await window.electron.getThumbnail(child.filePath);
        if (addThumb(getPrimaryThumbnailFromString(single) || single)) continue;
      }
      if (window.electron?.getModel) {
        const full = await window.electron.getModel(child.filePath);
        addThumb(getPrimaryThumbnailFromString(full?.thumbnail));
      }
    } catch (error) {
      // keep collecting from remaining children
    }
  }

  const preferred = groupThumbnailPreferences[groupRecord.groupKey];
  if (preferred) {
    const preferredIndex = thumbnails.indexOf(preferred);
    if (preferredIndex > 0) {
      thumbnails.splice(preferredIndex, 1);
      thumbnails.unshift(preferred);
    } else if (preferredIndex < 0 && preferred !== '3d.png') {
      thumbnails.unshift(preferred);
      if (thumbnails.length > MAX_GROUP_MANAGE_THUMBNAILS) {
        thumbnails.length = MAX_GROUP_MANAGE_THUMBNAILS;
      }
    }
  }

  return thumbnails;
}

function getBundleContainerPath(groupRecord) {
  const first = groupRecord?.children?.[0];
  if (!first?.filePath) {
    return { path: '', kind: 'folder' };
  }
  const bundleKind = first.bundleKind || deriveBundleFieldsForModel(first).bundleKind;
  if (bundleKind === 'zip' || first.filePath.includes('::')) {
    return { path: parseZipPath(first.filePath).zipPath, kind: 'zip' };
  }
  const sep = Math.max(first.filePath.lastIndexOf('/'), first.filePath.lastIndexOf('\\'));
  return { path: sep >= 0 ? first.filePath.slice(0, sep) : first.filePath, kind: 'folder' };
}

let currentBundleDetailsGroupKey = null;

function hideBundleDetailsPanel() {
  const panel = document.getElementById('bundle-details');
  if (panel) panel.classList.add('hidden');
  currentBundleDetailsGroupKey = null;
  window.bundleDetails?.clear();
  const container = document.querySelector('.file-grid');
  if (container?.renderVisibleItemsFn) container.renderVisibleItemsFn();
}

async function showBundleDetails(groupRecord) {
  if (!groupRecord?.children?.length) return;

  currentBundleDetailsGroupKey = groupRecord.groupKey;

  document.getElementById('model-details')?.classList.add('hidden');
  document.getElementById('multi-edit-panel')?.classList.add('hidden');
  window.collapseSidebarFilters?.();

  const panel = document.getElementById('bundle-details');
  if (!panel) return;
  panel._bundleRecord = groupRecord;

  // The panel's title and body are React (src/web/details/BundleDetails.tsx).
  const kind = groupRecord.children[0]?.bundleKind
    || deriveBundleFieldsForModel(groupRecord.children[0]).bundleKind
    || 'folder';
  window.bundleDetails?.show({ record: groupRecord, kind, containerPath: getBundleContainerPath(groupRecord).path || '' });

  panel.classList.remove('hidden');
  // After React has drawn the panel's body.
  requestAnimationFrame(() => panel.scrollIntoView({ behavior: 'smooth', block: 'start' }));

  const grid = document.querySelector('.file-grid');
  if (grid?.renderVisibleItemsFn) grid.renderVisibleItemsFn();
}


function parseTagInput(tagInput) {
  return String(tagInput || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .filter((tag, index, array) => array.indexOf(tag) === index);
}

function getGroupChildModelIds(groupRecord) {
  return (groupRecord?.children || [])
    .map((child) => Number(child?.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function normalizeTagNameList(tags) {
  if (!Array.isArray(tags)) return [];
  const names = tags
    .map((tag) => (typeof tag === 'string' ? tag : (tag?.name || tag)))
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

async function getGroupTagNames(groupRecord) {
  const ids = getGroupChildModelIds(groupRecord);
  if (ids.length && typeof window.electron.getGroupTags === 'function') {
    try {
      const names = await window.electron.getGroupTags(ids);
      return normalizeTagNameList(names);
    } catch (error) {
      console.error('Failed loading group tags:', error);
    }
  }
  const modelsWithTags = await getGroupModelsWithTags(groupRecord);
  const union = new Set();
  for (const entry of modelsWithTags) {
    normalizeTagNameList(entry.tags).forEach((tag) => union.add(tag));
  }
  return Array.from(union).sort((a, b) => a.localeCompare(b));
}

/** Add or remove tags on every model of a bundle, and update their cards. */
async function applyBundleTagChange(groupRecord, { addTags = [], removeTags = [] } = {}) {
  if (!groupRecord?.children?.length) {
    console.error('No archive group selected for tagging');
    return false;
  }

  const addSet = new Set(normalizeTagNameList(addTags));
  const removeSet = new Set(normalizeTagNameList(removeTags));
  if (!addSet.size && !removeSet.size) return false;

  const modelsWithTags = await getGroupModelsWithTags(groupRecord);
  if (!modelsWithTags.length) return false;

  const modelDataBatch = [];
  for (const { model, tags } of modelsWithTags) {
    const next = new Set(normalizeTagNameList(tags));
    addSet.forEach((tag) => next.add(tag));
    removeSet.forEach((tag) => next.delete(tag));
    model.tags = Array.from(next).sort((a, b) => a.localeCompare(b));
    modelDataBatch.push(model);
  }

  try {
    const success = await window.electron.updateModelsBatch(modelDataBatch);
    if (!success) throw new Error('Bulk update returned false');
  } catch (error) {
    console.error('Error saving archive tags, falling back to individual saves:', error);
    for (const model of modelDataBatch) {
      try {
        await window.electron.saveModel(model);
      } catch (saveError) {
        console.error('Error saving archive child tags:', model.filePath, saveError);
      }
    }
  }

  const gridContainer = document.querySelector('.file-grid');
  if (gridContainer?.currentModels) {
    const byPath = new Map(
      modelDataBatch.map((model) => [normalizePathForComparison(model.filePath), model])
    );
    for (let i = 0; i < gridContainer.currentModels.length; i++) {
      const existing = gridContainer.currentModels[i];
      const updated = byPath.get(normalizePathForComparison(existing?.filePath || existing?.id || ''));
      if (updated) gridContainer.currentModels[i] = { ...existing, ...updated };
    }
    invalidateVirtualGridLayoutCache(gridContainer);
  }
  if (gridContainer?.renderVisibleItemsFn) gridContainer.renderVisibleItemsFn();
  return true;
}

async function getGroupModelsWithTags(groupRecord) {
  const children = groupRecord.children || [];
  const result = [];
  for (const child of children) {
    try {
      const model = await window.electron.getModel(child.filePath);
      if (!model) continue;
      const tags = Array.isArray(model.tags)
        ? model.tags.map(tag => (typeof tag === 'string' ? tag : (tag?.name || tag))).filter(Boolean)
        : [];
      result.push({ model, tags });
    } catch (error) {
      console.error('Failed loading model for group tag update:', child.filePath, error);
    }
  }
  return result;
}

async function updateGroupTags(groupRecord, mode = 'merge') {
  const modelsWithTags = await getGroupModelsWithTags(groupRecord);
  if (!modelsWithTags.length) {
    await window.electron.showMessage('Group Tags', 'No models found in this group.');
    return;
  }

  const commonTags = modelsWithTags
    .map(entry => new Set(entry.tags))
    .reduce((acc, set) => {
      if (!acc) return new Set(set);
      return new Set([...acc].filter(tag => set.has(tag)));
    }, null);
  const defaultInput = commonTags && commonTags.size > 0 ? Array.from(commonTags).sort().join(', ') : '';

  const input = await window.electron.showInputDialog({
    title: mode === 'replace' ? 'Replace Group Tags' : 'Add Tags to Group',
    message: `Enter comma-separated tags for group "${groupRecord?.groupLabel || groupRecord?.parentModel || ''}"`,
    defaultValue: defaultInput,
    placeholder: 'e.g. Functional, Mechanical, MMU'
  });

  if (!input || !String(input).trim()) {
    return;
  }

  const requestedTags = parseTagInput(input);
  if (!requestedTags.length) {
    await window.electron.showMessage('Group Tags', 'No valid tags provided.');
    return;
  }

  for (const { model, tags } of modelsWithTags) {
    const nextTags = mode === 'replace'
      ? requestedTags
      : Array.from(new Set([...(tags || []), ...requestedTags])).sort((a, b) => a.localeCompare(b));
    model.tags = nextTags;
    await window.electron.saveModel(model);
  }

  const container = document.querySelector('.file-grid');
  if (container?.renderVisibleItemsFn) container.renderVisibleItemsFn();
  await window.electron.showMessage(
    'Group Tags Updated',
    `Updated tags for ${modelsWithTags.length} model${modelsWithTags.length === 1 ? '' : 's'} in "${groupRecord?.groupLabel || groupRecord?.parentModel || ''}".`
  );
}

// The grid is React (src/web/grid/): LibraryGrid lays out and virtualizes the cards, ModelCard and
// GroupCard draw them. renderVirtualGrid hands it the model list; window.gridHost is what the
// cards ask of this file (thumbnail queue, selection, menus, filters, saving).
function renderVirtualGrid(models) {
  const container = document.querySelector('.file-grid');
  if (!container) return;

  const previousView = container._virtualGridView;
  const view = currentGridView;
  const viewChanged = !!(previousView && previousView !== view);
  const focusSelection = !!(
    window.gridRefresh &&
    window.gridRefresh.shouldFocusSelectionOnViewSwitch(previousView, view, window.selection.size > 0)
  );

  models = dedupeModelsForVirtualGrid(models || []);
  pruneBundleExpandedGroups(models);
  pruneParentModelExpandedGroups(models);
  pruneZipArchiveExpandedGroups(models);

  if (!groupThumbnailPreferencesLoaded) {
    loadGroupThumbnailPreferences().then(() => window.libraryGrid?.refresh()).catch(() => {});
  }

  const currentModels = container.currentModels || [];
  // Detect append-only updates before comparing every id (sorting all ids per page froze big libraries).
  const progressiveAppend =
    currentModels.length > 0 &&
    models.length > currentModels.length &&
    isProgressiveModelListExtension(currentModels, models);

  if (progressiveAppend) {
    const prevAnalysis = window.modelFieldAnalysis || analyzeModelFields(currentModels);
    if (prevAnalysis.hasDesigner && prevAnalysis.hasSource && prevAnalysis.hasParentModel &&
        prevAnalysis.hasLicense && prevAnalysis.hasTags) {
      window.modelFieldAnalysis = prevAnalysis;
    } else {
      window.modelFieldAnalysis = mergeModelFieldAnalysis(prevAnalysis, analyzeModelFields(models.slice(currentModels.length)));
    }
  } else {
    window.modelFieldAnalysis = analyzeModelFields(models);
  }

  let modelsChanged = false;
  if (!progressiveAppend) {
    const ids = (list) => list.map((m) => m.id || m.filePath);
    const currentIds = ids(currentModels);
    const nextIds = ids(models);
    modelsChanged = JSON.stringify(currentIds) !== JSON.stringify(nextIds)
      || JSON.stringify([...currentIds].sort()) !== JSON.stringify([...nextIds].sort());
  }

  const rebuild = modelsChanged || viewChanged || !previousView;
  if (!rebuild) {
    // Same cards as before: keep the images they already loaded (list queries leave the
    // blobs out), as the previous grid kept its card DOM between refreshes.
    const loaded = new Map(currentModels.map((m) => [m && (m.id || m.filePath), m]));
    for (const model of models) {
      const previous = loaded.get(model && (model.id || model.filePath));
      if (!previous || previous === model || model.thumbnail || !previous.thumbnail) continue;
      model.thumbnail = previous.thumbnail;
      if (previous.hasMultipleThumbnails) model.hasMultipleThumbnails = true;
    }
  }
  if (rebuild) {
    clearFileItemPathIndex();
  }
  container.currentModels = models;
  container._virtualGridView = view;
  // Callers repaint with container.renderVisibleItemsFn() after editing currentModels in place.
  container.renderVisibleItemsFn = refreshLibraryGrid;
  showLibraryGrid({ rebuild, focusSelection });
}

function refreshLibraryGrid() {
  window.libraryGrid?.refresh();
}

function showLibraryGrid(options) {
  if (window.libraryGrid) {
    window.libraryGrid.show(options);
  } else {
    // The React grid mounts after this script; it picks this up.
    window._pendingGridShow = { rebuild: true, focusSelection: !!options.focusSelection };
  }
}

// ---- Group cards (src/web/grid/GroupCard.tsx) ----

function groupExpandedSet(record) {
  if (record.groupKind === 'bundle') return bundleExpandedGroups;
  if (record.groupKind === 'zip') return zipArchiveExpandedGroups;
  return parentModelExpandedGroups;
}

const isBundleGroupRecord = (record) => record.groupKind === 'bundle' || record.groupKind === 'zip';

/** Expand or collapse a group; collapsing the bundle whose details are open closes them. */
function toggleGridGroup(record) {
  const expanded = groupExpandedSet(record);
  if (expanded.has(record.groupKey)) {
    expanded.delete(record.groupKey);
    if (isBundleGroupRecord(record) && currentBundleDetailsGroupKey === record.groupKey) {
      hideBundleDetailsPanel();
      return;
    }
  } else {
    expanded.add(record.groupKey);
  }
  refreshLibraryGrid();
}

function expandGridGroupAndShowDetails(record) {
  const expanded = groupExpandedSet(record);
  if (!expanded.has(record.groupKey)) {
    expanded.add(record.groupKey);
    refreshLibraryGrid();
  }
  if (isBundleGroupRecord(record)) showBundleDetails(record);
}

/** Click on a group card: collapse it, or expand it and show the bundle's details. */
function clickGridGroup(record, view, card) {
  if (wasTileTapSuppressed(card, null)) return;
  if (isMobileUiActive() && view === 'preview') {
    expandGridGroupAndShowDetails(record);
    return;
  }
  if (groupExpandedSet(record).has(record.groupKey)) toggleGridGroup(record);
  else expandGridGroupAndShowDetails(record);
}

/** Right-click and long-press menu for a group (Preview, and the actions for its models). */
function bindGridGroupMenu(card, record) {
  card.addEventListener('contextmenu', async (event) => {
    if (event.pointerType !== 'mouse') suppressTileTap(card);
    event.preventDefault();
    event.stopPropagation();
    const paths = (record.children || []).map((c) => c && c.filePath).filter(Boolean);
    if (!paths.length) return;
    const bundle = isBundleGroupRecord(record);
    const fileIdentifier = bundle || paths.length > 1
      ? { filePaths: paths, groupLabel: record.groupLabel || 'Group', previewAsBundle: true }
      : paths[0];
    try {
      await window.contextMenu?.show(fileIdentifier, event.clientX, event.clientY);
    } catch (error) {
      console.error('Error showing context menu for group:', error);
    }
  });
  attachTileLongPress(card, (x, y) => {
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
}

/**
 * Queue a browser-side thumbnail render for a React grid card. `slot` is an empty element in the
 * card: the queue drops the job when it leaves the page and ranks it by its position.
 * On success the model is updated (or keeps images it already had) and the grid refreshes.
 */
function ensureCardThumbnailQueued(model, slot, thumbPriority) {
  if (window._serverBulkThumbnailJobActive) return;
  if (!model || !model.filePath || !slot || model.hasThumbnail) return;
  const filePath = model.filePath;
  if (hasImageOnlyPreviewMiss(filePath)) return;

  const queued = findQueuedThumbnailTask(filePath);
  if (queued) {
    queued.container = slot;
    if (thumbPriority != null) queued.thumbPriority = thumbPriority;
    pendingThumbnails.add(filePath);
    return;
  }
  if (activeThumbnailRenders.has(filePath)) {
    pendingThumbnails.add(filePath);
    return;
  }
  // A pending bit with no job is stale (a drop raced it): queue again.
  pendingThumbnails.add(filePath);
  enqueueRenderTask({
    filePath,
    container: slot,
    thumbPriority: thumbPriority != null ? thumbPriority : 0,
    resolve: async (thumbnail) => {
      pendingThumbnails.delete(filePath);
      if (!thumbnail || thumbnail === '3d.png' || isFailurePlaceholderThumbnail(thumbnail)) {
        if (hasImageOnlyPreviewMiss(filePath)) {
          refreshLibraryGrid(); // the card shows the typed placeholder
          return;
        }
        // Failure art shows in this card only; it is never saved, so a reload retries.
        if (thumbnail && isFailurePlaceholderThumbnail(thumbnail)) {
          model._failedThumbnail = thumbnail;
          refreshLibraryGrid();
          return;
        }
        scheduleVisibleThumbnailHydrate();
        return;
      }
      if (await isMostlyEmptyThumbnailDataUrl(thumbnail)) {
        scheduleVisibleThumbnailHydrate();
        return;
      }
      // Never overwrite real images saved meanwhile (3MF embeds, images the user added).
      let existingRaw = '';
      try {
        existingRaw = (await window.electron.getModel(filePath))?.thumbnail || '';
      } catch (_) { /* save ours */ }
      const existing = typeof existingRaw === 'string'
        ? existingRaw.split('::').filter((t) => t && t !== '3d.png' && t.startsWith('data:image') && !isFailurePlaceholderThumbnail(t))
        : [];
      if (existing.length > 0) {
        model.thumbnail = existingRaw;
        model.hasMultipleThumbnails = existing.length > 1;
        syncPrimaryThumbnailCacheFromThumbnailString(filePath, existingRaw);
      } else {
        model.thumbnail = thumbnail;
        model.hasMultipleThumbnails = false;
        invalidatePrimaryThumbnailCache(filePath);
        setCachedPrimaryThumbnail(filePath, thumbnail);
        try {
          await window.electron.saveThumbnail(filePath, thumbnail);
        } catch (_) { /* shown anyway */ }
      }
      model.hasThumbnail = true;
      delete model._failedThumbnail;
      invalidateGroupThumbnailCache();
      refreshLibraryGrid();
    },
    reject: (error) => {
      if (isBenignThumbnailDropError(error)) {
        scheduleVisibleThumbnailHydrate();
        return;
      }
      pendingThumbnails.delete(filePath);
      console.error(`Failed to generate thumbnail for ${filePath}`, error);
      scheduleVisibleThumbnailHydrate();
    }
  });
  processRenderQueue();
}

/** Filter the grid to the folder a model is in (a ZIP entry's folder inside its archive). */
async function filterGridByModelDirectory(filePath) {
  let directory = '';
  if (filePath.includes('::')) {
    const [zipPath, entryPath] = filePath.split('::');
    const entryParent = entryPath.split(/[/\\]/).slice(0, -1).join('/');
    directory = entryParent ? `${zipPath}::${entryParent}` : zipPath;
  } else {
    const lastSlash = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
    directory = lastSlash > 0 ? filePath.substring(0, lastSlash) : '';
  }
  await window.folderTree?.show(directory);
}

const tagNameList = (tags) => (Array.isArray(tags) ? tags : [])
  .map((t) => (typeof t === 'string' ? t : (t && (t.name || t)) || ''))
  .filter(Boolean)
  .sort((a, b) => String(a).localeCompare(String(b)));

/** What the React grid (src/web/grid/LibraryGrid.tsx, ModelCard.tsx) asks of this file. */
window.gridHost = {
  models: () => document.querySelector('.file-grid')?.currentModels || [],
  view: () => currentGridView,
  previewSize: () => currentPreviewTileSize,
  mobileColumns: () => mobileLibraryColumns(),
  expanded: () => ({ bundles: bundleExpandedGroups, parentModels: parentModelExpandedGroups }),
  createListHeader: () => createListViewHeader(),
  isSelected: (filePath) => window.selection.has(filePath),
  afterPaint: () => {
    const content = document.querySelector('.file-grid .virtual-content');
    if (content) bindFileItemPathIndex(content);
    pruneDisconnectedRenderTasks();
    refreshThumbnailQueuePriorities();
    processRenderQueue();
  },
  bottomChrome: () => (document.body.classList.contains('mobile-ui')
    ? (document.getElementById('mobile-bottom-nav')?.offsetHeight || 72)
    : 0),

  // Model cards
  isMobile: () => isMobileUiActive(),
  isNew: (model) => isModelNew(model),
  directoryLabel: (filePath) => getDirectoryDisplayLabel(filePath),
  directoryFullPath: (filePath) => getParentDirectoryFullPath(filePath),
  formatSize: (bytes) => formatFileSize(bytes),
  fetchPrimaryThumbnail: (filePath) => fetchPrimaryThumbnailForGrid(filePath),
  cachedPrimaryThumbnail: (filePath) => {
    const cached = getCachedPrimaryThumbnail(filePath);
    return typeof cached === 'string' && cached ? cached : null;
  },
  ensureThumbnailQueued: (model, slot, priority) => ensureCardThumbnailQueued(model, slot, priority),
  loadAllThumbnails: async (model) => {
    try {
      const all = await window.electron.getAllThumbnails(model.filePath);
      const valid = (all || []).filter((t) => t && typeof t === 'string' && t !== '3d.png' && t.startsWith('data:image'));
      if (valid.length < 2) return;
      model.thumbnail = valid.join('::');
      model.hasMultipleThumbnails = true;
      model.hasThumbnail = true;
      syncPrimaryThumbnailCacheFromThumbnailString(model.filePath, model.thumbnail);
      refreshLibraryGrid();
    } catch (_) { /* the primary image stays */ }
  },
  setDefaultThumbnail: async (model, index) => {
    await window.electron.setDefaultThumbnail(model.filePath, index);
    const updated = await window.electron.getModel(model.filePath);
    if (updated && updated.thumbnail) {
      model.thumbnail = updated.thumbnail;
      syncPrimaryThumbnailCacheFromThumbnailString(model.filePath, updated.thumbnail);
      refreshLibraryGrid();
    }
  },
  isFailurePlaceholder: (thumbnail) => isFailurePlaceholderThumbnail(thumbnail),
  imageOnlyMiss: (filePath) => hasImageOnlyPreviewMiss(filePath),
  typedPlaceholder: (filePath) => generateTypedPlaceholder(extensionFromModelPath(filePath)),
  bulkThumbnailJobActive: () => !!window._serverBulkThumbnailJobActive,
  cardClick: (event, card, filePath, view) => {
    if (wasTileTapSuppressed(card, event)) return;
    if (event.ctrlKey || event.metaKey) {
      // handleFileClick reads currentTarget: React delegates, so hand it the card.
      handleFileClick({
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        target: event.target,
        currentTarget: card,
        preventDefault: () => event.preventDefault()
      }, filePath);
      return;
    }
    if (view === 'preview' && isMobileUiActive() && !isMultiSelectMode) {
      openModelDetailsFromTile(card, filePath);
      return;
    }
    toggleModelSelection(card, filePath);
  },
  openPreview: (card, filePath, select) => {
    if (select && card) selectSingleModel(card, filePath);
    openModelPreviewFromTile(filePath);
  },
  bindCardMenu: (card, filePath) => addContextMenuHandler(card, filePath),
  showCardMenu: async (filePath, x, y) => {
    try {
      const paths = resolveContextMenuFilePaths(filePath);
      await window.contextMenu?.show(paths.length > 1 ? paths : (paths[0] || filePath), x, y, { showClose: true });
    } catch (error) {
      console.error('Error showing context menu:', error);
    }
  },
  filterByDirectory: (filePath) => { filterGridByModelDirectory(filePath); },
  filterBySelect: (selectId, value) => {
    window.libraryFilters?.setFromSelect(selectId, value);
    window.performCombinedSearch?.({ force: true });
  },
  filterByTag: (name) => { applyTagFilterFromModelClick(name); },
  saveField: async (filePath, field, value) => !!(await autoSaveModel(field, value, filePath)),
  tagNames: async (model) => {
    let id = model.id;
    if (!id && model.filePath) {
      const full = await window.electron.getModel(model.filePath);
      if (full?.tags?.length) return tagNameList(full.tags);
      id = full?.id;
    }
    if (!id) return [];
    return tagNameList(await window.electron.getModelTags(id));
  },
  printBadge: (element, model) => {
    if (window.PrintHistory) {
      window.PrintHistory.applyBadge(element, model);
      window.PrintHistory.bindBadge(element, model.filePath);
    } else {
      element.className = 'print-status' + (model.printed ? ' printed' : '');
      element.textContent = model.printed ? 'Printed' : 'Not Printed';
    }
  },
  applyListColumns: (fileInfo) => applyListViewColumnLayoutToSubtree(fileInfo),

  // Group cards
  groupThumbnailVersion: () => groupThumbnailVersion,
  loadGroupThumbnails: (record, onImages) => {
    let cancelled = false;
    // Paint what is cached right away, so recycled cards do not flash the placeholder.
    const cached = getCachedGroupThumbnails(record.groupKey);
    const initial = cached.length ? cached : getParentModelThumbnails(record.children, record.groupKey);
    if (initial.length) onImages(initial.filter((t) => t && t !== '3d.png'));
    loadGroupThumbnails(record.children, record.groupKey, (images) => { if (!cancelled) onImages(images); }, () => cancelled)
      .catch(() => { /* the placeholder stays */ });
    return () => { cancelled = true; };
  },
  groupListColumns: (record) => summarizeListViewGroupColumns(record),
  groupPrintSummary: (children) => {
    const summary = window.PrintHistory?.bundleSummary(children);
    if (summary) return { printedCount: summary.printedCount, label: summary.label };
    const printedCount = children.filter((child) => Boolean(child.printed)).length;
    return { printedCount, label: `${printedCount}/${children.length} printed` };
  },
  groupTagNames: (record) => getGroupTagNames(record),
  groupClick: (record, view, card) => clickGridGroup(record, view, card),
  toggleGroup: (record) => toggleGridGroup(record),
  bindGroupMenu: (card, record) => bindGridGroupMenu(card, record),
  isBundleDetailsGroup: (groupKey) => !!currentBundleDetailsGroupKey && currentBundleDetailsGroupKey === groupKey,
  openBundlePreview: (record) => { if (typeof window.openBundlePreview === 'function') window.openBundlePreview(record); },
  saveGroupField: (filePaths, field, value) => bulkSaveModelsEngagement(filePaths, field, value)
};

/** Open a model's source URL (http or https only). */
async function openModelSourceUrl(url) {
  if (!url) {
    await window.electron.showMessage('Error', 'Please enter a source URL');
    return;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    await window.electron.showMessage('Error', 'Please enter a valid URL starting with http:// or https://');
    return;
  }
  try {
    await window.electron.openExternal(url);
  } catch (error) {
    console.error('Error opening URL:', error);
    await window.electron.showMessage('Error', 'Failed to open URL: ' + error.message);
  }
}

/** Remove one tag or filament from every selected model, keeping their others. */
async function removeFromSelectedModelsField(field, value) {
  const updates = [];
  for (const filePath of Array.from(window.selection)) {
    try {
      const model = await window.electron.getModel(filePath);
      if (!model) continue;
      if (field === 'tags') {
        const tags = tagNameList(model.tags);
        if (!tags.includes(value)) continue;
        model.tags = tags.filter((tag) => tag !== value);
      } else {
        const ids = (Array.isArray(model.filaments) ? model.filaments : [])
          .map((f) => Number(f && typeof f === 'object' ? f.id : f))
          .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.includes(Number(value))) continue;
        model.filaments = ids.filter((id) => id !== Number(value));
      }
      updates.push(model);
    } catch (error) {
      console.error('Error loading model for removal:', filePath, error);
    }
  }
  if (!updates.length) return;
  await window.electron.updateModelsBatch(updates);
  updates.forEach((model) => mergeModelIntoGridCurrentModels(model));
  refreshLibraryGrid();
}

/** What the sidebar filters (src/web/filters/Sidebar.tsx) ask of this file. */
window.sidebarHost = {
  pickFromList: (field) => new Promise((resolve) => {
    showSearchableListDialog(field, null, 'filter', null, false, resolve);
  }),
  resetSelection: () => resetFilterSelectionAndDetails(),
  sortChanged: () => { document.querySelector('.list-view-header')?.updateSortIndicators?.(); }
};

/** What the multi-edit panel (src/web/details/MultiEditPanel.tsx) asks of this file. */
window.multiEditHost = {
  selectedPaths: () => Array.from(window.selection),
  exit: () => exitMultiEditMode(),
  selectAllVisible: () => selectAllVisibleModels(),
  clearSelection: () => clearMultiSelection(),
  saveField: async (field, value) => !!(await autoSaveMultipleModels(field, value)),
  removeFromSelected: (field, value) => removeFromSelectedModelsField(field, value),
  pickFromList: (field, remove) => new Promise((resolve) => {
    const target = remove ? (field === 'tag' ? 'multi-tag-remove-select' : 'multi-filament-remove-select') : null;
    showSearchableListDialog(field, target, 'multi', null, !!remove, resolve);
  }),
  openSource: (url) => { openModelSourceUrl(url); }
};

/** What the bundle panel (src/web/details/BundleDetails.tsx) asks of this file. */
window.bundleHost = {
  openModel: (filePath) => { showModelDetails(filePath); },
  tagNames: (record) => getGroupTagNames(record),
  changeTags: (record, change) => applyBundleTagChange(record, change),
  pickTag: () => new Promise((resolve) => {
    showSearchableListDialog('tag', null, 'edit', null, false, resolve);
  }),
  tagCreated: async () => {
    try {
      await populateTagFilter();
      await populateTagSelect();
      window.detailsFields?.reloadOptions();
      window.reloadTagManager?.();
    } catch (error) {
      console.error('Error refreshing tag pickers:', error);
    }
  }
};

/** What the details panel's React fields (src/web/details/DetailsFields.tsx) ask of this file. */
window.detailsHost = {
  saveField: async (filePath, field, value) => !!(await autoSaveModel(field, value, filePath)),
  pickFromList: (field) => new Promise((resolve) => {
    showSearchableListDialog(field, null, 'edit', null, false, resolve);
  }),
  openSource: (url) => { openModelSourceUrl(url); },
  valuesChanged: async (kind) => {
    try {
      if (kind === 'designer') {
        await populateDesignerDropdown();
        await populateModelDesignerDropdown(null, 'multi-designer');
      } else if (kind === 'parentModel') {
        await populateParentModelFilter();
        await populateParentModelDropdown(null, 'multi-parent');
      } else if (kind === 'license') {
        await populateLicenseFilter();
        await populateModelLicenseDropdown(null, 'multi-license');
      } else if (kind === 'tag') {
        await populateTagFilter();
        await populateTagSelect();
        window.reloadTagManager?.();
      }
    } catch (error) {
      console.error('Error refreshing pickers:', error);
    }
  }
};



window.renderFiles = renderFiles;
window.displayModels = displayModels;
window.syncSelectionWithFilteredModels = syncSelectionWithFilteredModels;
window.resetFilterSelectionAndDetails = resetFilterSelectionAndDetails;
window.clearModelDetailsSidebar = clearModelDetailsSidebar;
ithFilteredModels = syncSelectionWithFilteredModels;
window.resetFilterSelectionAndDetails = resetFilterSelectionAndDetails;
window.clearModelDetailsSidebar = clearModelDetailsSidebar;
