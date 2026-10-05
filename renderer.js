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


function mobileLibraryColumns() {
  if (!document.body?.classList.contains('mobile-ui')) return 0;
  if (document.body.classList.contains('mobile-ui-wide')) return 3;
  if (window.matchMedia('(orientation: landscape)').matches) return 3;
  return 2;
}

/** Lay the grid out again from the models it shows (the view or tile size changed). */
function rebuildGridFromLoadedModels() {
  const container = document.querySelector('.file-grid');
  const models = container?.currentModels ? [...container.currentModels] : null;
  if (container) container.currentModels = null;
  if (models && models.length) renderVirtualGrid(models);
  else window.performCombinedSearch?.();
}

const DEFAULT_SORT = 'dateAdded DESC'; // Show newest models by default

// The selection is window.selection (src/web/selection.ts); cards and the multi-edit panel follow it.
let isMultiSelectMode = false;


// Helper function to parse zip path format
function parseZipPath(filePath) {
  if (filePath.includes('::')) {
    const [zipPath, entryPath] = filePath.split('::');
    return { zipPath, entryPath, isZipEntry: true };
  }
  return { zipPath: filePath, entryPath: null, isZipEntry: false };
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

// Flag to prevent multiple clear-new-flag confirmations from showing
let isClearingNewFlags = false;

function isServerThumbnailWorkerContext() {
  if (typeof window.electron?.isServerThumbnailWorker !== 'function') {
    return Promise.resolve(false);
  }
  return window.electron.isServerThumbnailWorker().catch(() => false);
}

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
    window.thumbnails.syncFromField(filePath, updatedModel.thumbnail);

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
  if (typeof bindGridBackgroundDeselect === 'function') {
    bindGridBackgroundDeselect();
  }
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
    initializeListButtons();
  });

  // Remove the other DOMContentLoaded listener that's adding filter change handlers

  await initializeTags();
  initializeListButtons();


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
    highlightModelWithoutDetails(filePath);
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


// The list view's group rows (src/web/grid/GroupCard.tsx): values shared by every model in the group.
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
  if (primary && !window.thumbnails.isFailure(primary)) return true;
  return Boolean(child.hasThumbnail) && Number(child.hasThumbnail) !== 0;
}

function rememberGroupThumbnails(groupKey, thumbnails) {
  if (!groupKey) return;
  const valid = (thumbnails || []).filter((t) => t && t !== '3d.png' && !window.thumbnails.isFailure(t));
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
    if (!t || t === '3d.png' || window.thumbnails.isFailure(t)) continue;
    if (await window.thumbnails.isMostlyEmpty(t)) continue;
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
      if (!primary || window.thumbnails.isFailure(primary)) return null;
      if (await window.thumbnails.isMostlyEmpty(primary)) return null;
      return primary;
    };

    const inline = await tryThumb(child.thumbnail);
    if (inline) return inline;
    try {
      const single = await window.thumbnails.fetchPrimary(child.filePath);
      if (single) return single;
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

  if (!isStale() && thumbnails.length === 0 && candidates.length > 0) {
    try {
      const { image: rendered, stored } = await window.thumbnails.make(candidates[0].filePath);
      if (isStale()) return;
      if (rendered && rendered !== '3d.png' && !window.thumbnails.isFailure(rendered) && !(await window.thumbnails.isMostlyEmpty(rendered))) {
        thumbnails.push(rendered);
        await applyThumbs(thumbnails);
        if (!stored) await window.thumbnails.saveIfReal(candidates[0].filePath, rendered);
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
// cards ask of this file (selection, menus, filters, saving).
function renderVirtualGrid(models) {
  const container = document.querySelector('.file-grid');
  if (!container) return;

  const previousView = container._virtualGridView;
  const view = window.getGridView().view;
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
  rebuild: () => rebuildGridFromLoadedModels(),
  mobileColumns: () => mobileLibraryColumns(),
  expanded: () => ({ bundles: bundleExpandedGroups, parentModels: parentModelExpandedGroups }),
  isSelected: (filePath) => window.selection.has(filePath),
  afterPaint: () => {
    const content = document.querySelector('.file-grid .virtual-content');
    if (content) bindFileItemPathIndex(content);
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
