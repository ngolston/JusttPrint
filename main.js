const database = require('./src/core/database');
const { app, ipcMain, shell } = require('./src/server/runtime');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { Worker } = require('worker_threads');
const { deriveBundleFromFilePath } = require('./bundle-keys');
const spoolman = require('./spoolman');
const printEvents = require('./print-events');
const printerManager = require('./printer-manager');
const { buildFolderForest, directoryFilterLikePrefix } = require('./folder-tree-lib');
const {
  registerMcpRoutes,
  buildMcpClientConfig,
  listToolDefinitions,
  SERVER_NAME: MCP_SERVER_NAME
} = require('./mcp-server');
const serverTls = require('./server-tls');
const extensionInbox = require('./extension-inbox');
const { buildSlicerSpawnSpec, launchSlicerProcess, invalidSlicerPathError } = require('./slicer-launch');
const { registerHelperBundleRoute } = require('./helper/install-bundle');
const { createServerAuth, SECRET_SETTING_KEYS, MIN_PASSWORD_LENGTH, parseTrustProxy, parseCookies, SESSION_COOKIE: SESSION_COOKIE_NAME } = require('./server-auth');
const { settingsFromEnv, SECRET_ENV } = require('./env-settings');
const { releasesApiUrl, releasesPageUrl, latestVersionFromReleases, PROJECT_URL } = require('./src/server/releases');
const { createClientDialogs, RESPONSE_CHANNEL: DIALOG_RESPONSE_CHANNEL } = require('./src/server/client-dialogs');

// Message boxes and prompts the server shows in the browser that made the request.
const clientDialogs = createClientDialogs();
const { isServableStaticPath, isLibraryPathAllowed, assertNetworkIpcArgs, assertMcpToolArgs } = require('./server-paths');
const {
  normalizeExcludeNames,
  shouldSkipDirectoryName,
  shouldSkipFileName,
  shouldSkipEntryPath,
  compileExcludeDirs,
  isExcludedPath
} = require('./scan-skip');
const { clampFolderLevels } = require('./library-context');
const { applyFolderTagsToModels: applyFolderTagsInDb, shouldAutoTagNewScanFiles } = require('./folder-tags');
const { repairModelTags } = require('./db-repair');
const {
  planOrganize,
  withFreeSpace,
  readFreeBytes,
  runOrganizePlan,
  pathsAreSame
} = require('./organize-library');

// 3MF preview worker/caching
const preview3mfWorkers = new Map();
const preview3mfCache = new Map();
const PREVIEW_3MF_CACHE_LIMIT = 1;
const PREVIEW_3MF_MAX_FILE_SIZE_MB = Math.max(
  10,
  Number.parseInt(process.env.PRINTVENTORY_PREVIEW_3MF_MAX_FILE_SIZE_MB || '200', 10) || 200
);
const PREVIEW_3MF_WORKER_MEMORY_MB = Math.max(
  512,
  Number.parseInt(process.env.PRINTVENTORY_PREVIEW_3MF_WORKER_MEMORY_MB || '2048', 10) || 2048
);
const PREVIEW_3MF_MAX_DISK_CACHE_MB = Math.max(
  50,
  Number.parseInt(process.env.PRINTVENTORY_PREVIEW_3MF_MAX_DISK_CACHE_MB || '150', 10) || 150
);

function getPreview3mfCacheDir() {
  return path.join(app.getPath('userData'), '3mf-preview-cache');
}

function createPreview3mfWorker(workerPath) {
  return new Worker(workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: PREVIEW_3MF_WORKER_MEMORY_MB,
      maxYoungGenerationSizeMb: Math.min(256, Math.floor(PREVIEW_3MF_WORKER_MEMORY_MB / 4))
    }
  });
}

function terminatePreview3mfWorker(entry) {
  if (!entry?.worker) return;
  try {
    entry.worker.terminate();
  } catch (error) {
    console.error('Error terminating 3MF preview worker:', error);
  }
}

function formatPreview3mfError(error) {
  const msg = error?.message || String(error || 'Failed to parse 3MF');
  if (msg.includes('ERR_WORKER_OUT_OF_MEMORY') || msg.includes('heap out of memory')) {
    return 'Preview ran out of memory while processing this model. Try closing other previews first, or restart the app.';
  }
  return msg;
}

function cancelAllPreview3mfWorkers(exceptRequestId = null) {
  for (const [id, entry] of preview3mfWorkers.entries()) {
    if (exceptRequestId && id === exceptRequestId) continue;
    terminatePreview3mfWorker(entry.entry);
    entry.reject?.(new Error('Preview cancelled'));
    if (entry.cleanup) {
      Promise.resolve(entry.cleanup()).catch(() => {});
    }
    preview3mfWorkers.delete(id);
  }
}

function trimPreview3mfMemoryCache() {
  while (preview3mfCache.size > PREVIEW_3MF_CACHE_LIMIT) {
    const oldestKey = preview3mfCache.keys().next().value;
    preview3mfCache.delete(oldestKey);
  }
}

function serializePreview3mfForDisk(json) {
  return JSON.stringify(json, (_key, value) => {
    if (ArrayBuffer.isView(value)) {
      return Array.from(value);
    }
    return value;
  });
}

// Typed arrays become { "0": n, "1": n, ... } under JSON.stringify, which
// THREE.ObjectLoader treats as empty buffers. Convert to plain arrays so
// server-mode WebSocket transport and disk/memory caches stay consistent.
function normalizePreview3mfTypedArrays(json) {
  if (!json || !Array.isArray(json.geometries)) return json;
  for (const geometry of json.geometries) {
    const data = geometry && geometry.data;
    if (!data) continue;
    if (data.attributes) {
      for (const key of Object.keys(data.attributes)) {
        const attr = data.attributes[key];
        if (attr && attr.array != null && !Array.isArray(attr.array)) {
          attr.array = ArrayBuffer.isView(attr.array)
            ? Array.from(attr.array)
            : Object.values(attr.array);
        }
      }
    }
    if (data.index && data.index.array != null && !Array.isArray(data.index.array)) {
      data.index.array = ArrayBuffer.isView(data.index.array)
        ? Array.from(data.index.array)
        : Object.values(data.index.array);
    }
  }
  return json;
}

function jsonStringifyForWs(payload) {
  return JSON.stringify(payload, (_key, value) => {
    if (ArrayBuffer.isView(value)) {
      return Array.from(value);
    }
    return value;
  });
}
const JSZip = require('jszip');
const {
  extractZipEntryBuffer,
  findZipEntry,
  withZipFileLock,
  isFragileZipError
} = require('./zip-extract');
const os = require('os');
const https = require('https');
const {
  compressThumbnailBlob,
  compressDataUrl,
  needsCompression,
  THUMBNAIL_MAX_STORED_CHARS,
  THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS
} = require('./thumbnail-compress');
const { extractLysPreviewEntry } = require('./extract-lys-preview');
const { extractF3dPreviewEntry } = require('./extract-f3d-preview');
const { extractChituboxPreviewEntry } = require('./extract-chitubox-preview');
const { extractVoxlPreviewEntry } = require('./extract-voxl-preview');

// Additional file types for scan/library (alphabetical by label). id used in settings; extensions for scan/filter.
const ADDITIONAL_FILE_TYPES_CATALOG = [
  { id: '3ds', label: '3DS (.3ds)', extensions: ['.3ds'] },
  { id: 'amf', label: 'AMF (.amf)', extensions: ['.amf'] },
  { id: 'blender', label: 'Blender (.blender)', extensions: ['.blender'] },
  { id: 'chitubox', label: 'ChiTuBox (.chitubox)', extensions: ['.chitubox'] },
  { id: 'dae', label: 'DAE (.dae)', extensions: ['.dae'] },
  { id: 'dxf', label: 'DXF (.dxf)', extensions: ['.dxf'] },
  { id: 'dwg', label: 'DWG (.dwg)', extensions: ['.dwg'] },
  { id: 'fbx', label: 'FBX (.fbx)', extensions: ['.fbx'] },
  { id: 'f3d', label: 'F3D (.f3d)', extensions: ['.f3d'] },
  { id: 'f3z', label: 'F3Z (.f3z)', extensions: ['.f3z'] },
  { id: 'gcode', label: 'G-code (.gcode)', extensions: ['.gcode'] },
  { id: 'igs', label: 'IGES (.igs/.iges)', extensions: ['.igs', '.iges'] },
  { id: 'lys', label: 'LYS/LYT (.lys/.lyt)', extensions: ['.lys', '.lyt'] },
  { id: 'obj', label: 'OBJ (.obj)', extensions: ['.obj'] },
  { id: 'ply', label: 'PLY (.ply)', extensions: ['.ply'] },
  { id: 'step', label: 'STEP (.step/.stp)', extensions: ['.step', '.stp'] },
  { id: 'svg', label: 'SVG (.svg)', extensions: ['.svg'] },
  { id: 'voxl', label: 'VOXL (.voxl)', extensions: ['.voxl'] },
  { id: 'x3d', label: 'X3D (.x3d)', extensions: ['.x3d'] }
];

function getScanExtensions(selectedIds) {
  const extSet = new Set(['.stl', '.3mf']);
  if (selectedIds && Array.isArray(selectedIds)) {
    for (const id of selectedIds) {
      const entry = ADDITIONAL_FILE_TYPES_CATALOG.find(e => e.id === id);
      if (entry) entry.extensions.forEach(ext => extSet.add(ext));
    }
  }
  return Array.from(extSet);
}

function getSupportedExtensionsForLibrary(db) {
  const setting = db && db.prepare ? db.prepare('SELECT value FROM settings WHERE key = ?').get('scanAdditionalFileTypes') : null;
  let selectedIds = [];
  try {
    if (setting && setting.value) selectedIds = JSON.parse(setting.value);
  } catch (e) { /* ignore */ }
  return getScanExtensions(selectedIds);
}

function getExtensionsForFileTypeFilter(fileTypeValue) {
  if (!fileTypeValue || fileTypeValue === 'zip') return null;
  const lower = fileTypeValue.toLowerCase();
  if (lower === 'stl') return ['.stl'];
  if (lower === '3mf') return ['.3mf'];
  const entry = ADDITIONAL_FILE_TYPES_CATALOG.find(e => e.id === lower || e.extensions.some(ext => ext.slice(1) === lower));
  return entry ? entry.extensions : [`.${lower}`];
}
const express = require('express');
const WebSocket = require('ws');

// Near the top of the file, add this line
const { version } = require('./package.json');

const DEBUG = false; // Set to true for development/debugging
const PING_INTERVAL = 30000; // 30 seconds

function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

// Server mode detection
let httpServer = null;
let httpServerEpoch = 0;
let http80Server = null;
let wss = null; // WebSocket server
let wsClients = null; // WebSocket clients Set
let letsEncryptRenewInFlight = false;

// Store pending context menu actions for server mode (browser access)
const pendingContextMenus = new Map();
let contextMenuRequestIdCounter = 0;

// The handlers the WebSocket dispatcher calls: every ipcMain.handle(...), from any module,
// lands in this one map, whatever order the modules load in.
const ipcHandlerRegistry = ipcMain._handlers;


// Check if running in Docker container
function isDockerContainer() {
  // Check for Docker environment indicators
  const hasDockerenv = fs.existsSync('/.dockerenv');
  const hasCgroup = fs.existsSync('/proc/self/cgroup');
  const cgroupContainsDocker = hasCgroup && fs.readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
  const result = hasDockerenv || cgroupContainsDocker;
  return result;
}

/** Library files are absolute container paths (e.g. /mnt/models/part.stl). */
function validateUncPath(path, operation = 'operation') {
  if (isUrlModel(path)) {
    return; // URL-only models (from extension) have no file path to validate
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`${operation}: expected an absolute path inside the container (e.g. /mnt/models/part.stl), got "${path}".`);
  }
}



function getTlsCertsDir() {
  try {
    return path.join(app.getPath('userData'), 'certs');
  } catch (_) {
    return path.join(process.cwd(), 'certs');
  }
}

function resolveAppTls() {
  return serverTls.resolveServerTls({
    getSetting: getSettingValueOr,
    certsDir: getTlsCertsDir()
  });
}

/**
 * Optional TLS for server mode. Env PRINTVENTORY_TLS_* / SSL_* overrides UI settings.
 */
function loadOptionalServerTlsOptions() {
  return resolveAppTls().options || null;
}

function persistSetting(key, value) {
  if (!database.db) throw new Error('Database is not initialized');
  database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value == null ? '' : String(value));
}

function formatPort80BindError(err) {
  if (!err) return 'Failed to bind port 80.';
  if (err.code === 'EACCES') {
    return 'Could not bind port 80 (permission denied). Let\'s Encrypt HTTP-01 and HTTP redirect need port 80. Run as administrator/root, or in Docker publish 80:80.';
  }
  if (err.code === 'EADDRINUSE') {
    return 'Port 80 is already in use. Stop the other listener or disable HTTP-01 / redirect.';
  }
  return err.message || 'Failed to bind port 80.';
}

function stopPort80Server() {
  return new Promise((resolve) => {
    if (!http80Server) {
      resolve();
      return;
    }
    const server = http80Server;
    http80Server = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      server.close(() => finish());
    } catch (_) {
      finish();
      return;
    }
    setTimeout(finish, 2000);
  });
}

function startPort80Server() {
  return new Promise((resolve, reject) => {
    if (http80Server) {
      resolve();
      return;
    }
    const http = require('http');
    const server = http.createServer((req, res) => {
      serverTls.handleAcmeOrRedirectRequest(req, res, {
        getSetting: getSettingValueOr,
        appPort: getAppListenPort(),
        tlsActive: !!resolveAppTls().options
      });
    });
    server.once('error', (err) => {
      http80Server = null;
      const message = formatPort80BindError(err);
      serverTls.setLastTlsError(message);
      reject(new Error(message));
    });
    server.listen(80, '0.0.0.0', () => {
      http80Server = server;
      console.log('[TLS] HTTP listener on 0.0.0.0:80 (ACME HTTP-01 / optional redirect)');
      resolve();
    });
  });
}

async function syncPort80Server() {
  if (!serverTls.shouldBindAcmeHttpPort(getSettingValueOr)) {
    await stopPort80Server();
    return { running: false };
  }
  await startPort80Server();
  return { running: true };
}

/**
 * Proxy Puter AI chat requests server-side to avoid CORS (api.puter.com only allows https://puter.com).
 * The browser still uses Puter.js for authentication/captcha; only the drivers/call is proxied.
 */
function registerPuterAiProxyRoute(expressApp) {
  expressApp.post('/api/puter-ai/chat', express.json({ limit: '50mb' }), async (req, res) => {
    try {
      const { prompt, imageUrl, model, authToken } = req.body || {};
      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required' });
        return;
      }

      let args;
      if (imageUrl && typeof imageUrl === 'string') {
        const isVideo = /\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(imageUrl) || imageUrl.startsWith('data:video/');
        const mediaBlock = isVideo ? { video_url: { url: imageUrl } } : { image_url: { url: imageUrl } };
        args = {
          vision: true,
          messages: [{ content: [prompt, mediaBlock] }],
          model: model || 'gpt-5-nano'
        };
      } else {
        args = {
          messages: [{ content: prompt }],
          model: model || 'gpt-5-nano'
        };
      }

      const puterBody = JSON.stringify({
        interface: 'puter-chat-completion',
        driver: 'ai-chat',
        test_mode: false,
        method: 'complete',
        args,
        auth_token: authToken || undefined
      });

      const puterResponse = await fetch('https://api.puter.com/drivers/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;actually=json',
          'Origin': 'https://puter.com',
          'Referer': 'https://puter.com/'
        },
        body: puterBody
      });

      let data;
      const puterRawBody = await puterResponse.text();
      try {
        data = puterRawBody ? JSON.parse(puterRawBody) : {};
      } catch (parseErr) {
        res.status(502).json({ error: `Invalid response from Puter API (${puterResponse.status})`, details: puterRawBody.slice(0, 500) });
        return;
      }

      if (!puterResponse.ok || data.success === false) {
        const errMsg = data?.error?.message || data?.message || `Puter API error (${puterResponse.status})`;
        const code = data?.error?.code || data?.code;
        res.status(puterResponse.status >= 400 ? puterResponse.status : 500).json({ error: errMsg, code, details: data });
        return;
      }

      const result = data.result;
      let chatText;
      if (typeof result === 'string') {
        chatText = result;
      } else if (result?.message?.content) {
        chatText = result.message.content;
      } else if (typeof result?.text === 'string') {
        chatText = result.text;
      } else if (result != null) {
        chatText = JSON.stringify(result);
      } else {
        chatText = '';
      }

      res.json({ response: chatText });
    } catch (err) {
      console.error('[Puter AI Proxy] Error:', err);
      res.status(500).json({ error: err.message || 'Puter AI proxy error' });
    }
  });
}

// HTTP Server Function
function startHttpServer(port = 5000, localhostOnly = false, options = {}) {
  const expressApp = express();
  const PORT = typeof port === 'number' ? port : parseInt(port, 10) || 5000;
  const HOST = localhostOnly ? '127.0.0.1' : '0.0.0.0';
  const forcePlainHttp = !!(options && options.forcePlainHttp);

  // Same-origin CORS, login, then everything else requires a session or API token.
  const auth = getServerAuth();
  auth.ensureCredentials();
  expressApp.disable('x-powered-by');
  // Behind a reverse proxy, req.ip (login rate limit) comes from X-Forwarded-For only when trusted.
  expressApp.set('trust proxy', parseTrustProxy(process.env.PRINTVENTORY_TRUST_PROXY));
  expressApp.use((req, res, next) => {
    // No script-src yet: the UI still relies on inline scripts and onclick handlers.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  expressApp.use(auth.cors);
  expressApp.use(auth.rejectForeignOrigins);
  expressApp.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version });
  });
  auth.registerRoutes(expressApp, express);
  expressApp.use(auth.requireAuth);

  // JSON body parser for extension upload (large payloads for base64 file)
  expressApp.use(express.json({ limit: '50mb' }));
  registerMcpRoutes(expressApp, getMcpToolContext());
  registerPuterAiProxyRoute(expressApp);

  // Serve static files from the application directory
  const appDir = __dirname;
  // Ensure renderer.js, styles.css, images, and server-bridge.js are served
  // Without this, the browser won't load app scripts and buttons won't work

  /** Inject server-bridge before the first app script (same order as static index.html). */
  function injectBridgeIntoIndexHtml(htmlData, bridgeCode, bridgeReadError) {
    const bridgeScript = bridgeReadError
      ? '<script src="/server-bridge.js"></script>'
      : `<script>
// Server bridge initialization
try {
${bridgeCode}
} catch (error) {
  console.error('[Bridge] Error initializing server bridge:', error);
  if (typeof window !== 'undefined' && !window.electron) {
    window.electron = {};
    window.electron.on = function() {};
    window.electron.send = function() {};
    console.warn('[Bridge] Created fallback window.electron object');
  }
}
</script>`;
    const appScriptRegex = /(<script(?:\s+type=["']module["'])?\s+src=["'](?:search|renderer|slicer|preview|guide)\.js["'][^>]*>)/i;
    if (appScriptRegex.test(htmlData)) {
      return htmlData.replace(appScriptRegex, `${bridgeScript}\n$1`);
    }
    if (htmlData.includes('<script type="module" src="search.js"></script>')) {
      return htmlData.replace('<script type="module" src="search.js"></script>', `${bridgeScript}\n<script type="module" src="search.js"></script>`);
    }
    if (htmlData.includes('<script src="renderer.js"></script>')) {
      return htmlData.replace('<script src="renderer.js"></script>', `${bridgeScript}\n<script src="renderer.js"></script>`);
    }
    if (htmlData.includes('</body>')) {
      return htmlData.replace('</body>', `${bridgeScript}\n</body>`);
    }
    return htmlData;
  }
  
  // CRITICAL: Inject server-bridge.js route handler BEFORE express.static
  // This ensures the route handler runs and injects the bridge code
  // Inject server-bridge.js into HTML for server mode
  expressApp.get('/', (req, res) => {
    const htmlPath = path.join(appDir, 'index.html');
    const bridgePath = path.join(appDir, 'server-bridge.js');
    
    fs.readFile(htmlPath, 'utf8', (err, htmlData) => {
      if (err) {
        res.status(500).send('Error loading index.html');
        return;
      }
      
      fs.readFile(bridgePath, 'utf8', (err, bridgeCode) => {
        if (err) {
          console.error('Error loading server-bridge.js, falling back to script tag:', err);
        }
        res.send(injectBridgeIntoIndexHtml(htmlData, bridgeCode, !!err));
      });
    });
  });
  
  // Add middleware to set proper MIME types for JavaScript modules
  expressApp.use((req, res, next) => {
    // Set proper Content-Type for JavaScript modules
    if (req.path.endsWith('.js')) {
      // Check if it's requested as a module (from script type="module")
      // or if it's search.js, slicer.js which are known modules
      if (req.path.includes('search.js') || req.path.includes('slicer.js') || 
          req.get('Accept')?.includes('application/javascript') ||
          req.get('Accept')?.includes('text/javascript')) {
        res.type('application/javascript');
      } else {
        res.type('application/javascript');
      }
    }
    next();
  });

  // Now register static file serving AFTER the route handler
  // This ensures the route handler takes precedence for the root path
  expressApp.use(staticWebAssetsOnly(express.static(appDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.webmanifest') || filePath.endsWith('manifest.json')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
      if (filePath.endsWith('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
      }
      if (filePath.endsWith(`${path.sep}sw.js`) || filePath.endsWith('/sw.js') || filePath.endsWith('sw.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (/\.(js|css|html|webmanifest)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  })));

  // Serve files via HTTP for server mode (UNC paths or Docker-mounted paths)
  expressApp.get('/api/file/*', (req, res) => {
    try {
      // Extract file path from URL (everything after /api/file/)
      const filePath = decodeURIComponent(req.path.replace('/api/file/', ''));
      if (!libraryPathAllowed(filePath)) {
        res.status(403).send('File is outside the library folders');
        return;
      }
      
      // Library paths are absolute container paths. A client path (e.g. C:\ from the extension) is not on the server.
      if (!filePath.startsWith('/')) {
        res.status(404).setHeader('X-File-Not-On-Server', '1').send('File not on server (the path is on another computer).');
        return;
      }
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        res.status(404).send('File not found');
        return;
      }
      
      // Set appropriate content type
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.stl': 'application/octet-stream',
        '.3mf': 'application/octet-stream',
        '.zip': 'application/zip',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.obj': 'application/octet-stream',
        '.svg': 'image/svg+xml',
        '.step': 'application/octet-stream',
        '.stp': 'application/octet-stream',
        '.3ds': 'application/octet-stream',
        '.amf': 'application/octet-stream',
        '.dae': 'application/octet-stream',
        '.ply': 'application/octet-stream',
        '.x3d': 'application/octet-stream',
        '.blender': 'application/octet-stream',
        '.dxf': 'application/octet-stream',
        '.dwg': 'application/octet-stream',
        '.fbx': 'application/octet-stream',
        '.f3d': 'application/octet-stream',
        '.f3z': 'application/octet-stream',
        '.chitubox': 'application/octet-stream',
        '.voxl': 'application/octet-stream',
        '.gcode': 'application/octet-stream',
        '.igs': 'application/octet-stream',
        '.iges': 'application/octet-stream',
        '.lys': 'application/octet-stream',
        '.lyt': 'application/octet-stream'
      };
      
      if (mimeTypes[ext]) {
        res.setHeader('Content-Type', mimeTypes[ext]);
      }
      
      // Stream the file
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      
      fileStream.on('error', (error) => {
        console.error('Error serving file:', error);
        if (!res.headersSent) {
          res.status(500).send('Error reading file');
        }
      });
    } catch (error) {
      console.error('Error in file serving endpoint:', error);
      res.status(500).send('Error serving file');
    }
  });

  registerHelperBundleRoute(expressApp, appDir);

  // Download endpoint for server mode - handles both regular files and zip entries
  expressApp.get('/api/download/*', async (req, res) => {
    try {
      // Extract file path from URL (everything after /api/download/)
      const filePath = decodeURIComponent(req.path.replace('/api/download/', ''));
      
      // Check if this is a zip entry
      const pathInfo = parseZipPath(filePath);
      if (!libraryPathAllowed(pathInfo.isZipEntry ? pathInfo.zipPath : filePath)) {
        res.status(403).send('File is outside the library folders');
        return;
      }
      let actualFilePath = filePath;
      let fileName = path.basename(filePath);
      let fileData = null;
      
      if (pathInfo.isZipEntry) {
        // Extract zip entry to temp file and stream it
        try {
          const tempPath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
          actualFilePath = tempPath;
          fileName = path.basename(pathInfo.entryPath);
        } catch (error) {
          console.error('Error extracting zip entry:', error);
          res.status(500).send('Error extracting file from zip');
          return;
        }
      }
      
      // Library, backup and extract-temp paths are all absolute container paths.
      if (!actualFilePath.startsWith('/')) {
        res.status(400).send('Invalid path: expected an absolute path');
        return;
      }

      // Check if file exists
      if (!fs.existsSync(actualFilePath)) {
        res.status(404).send('File not found');
        return;
      }
      
      // Set appropriate content type
      const ext = path.extname(fileName).toLowerCase();
      const mimeTypes = {
        '.stl': 'application/octet-stream',
        '.3mf': 'application/octet-stream',
        '.zip': 'application/zip',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.obj': 'application/octet-stream',
        '.svg': 'image/svg+xml',
        '.step': 'application/octet-stream',
        '.stp': 'application/octet-stream',
        '.3ds': 'application/octet-stream',
        '.amf': 'application/octet-stream',
        '.dae': 'application/octet-stream',
        '.ply': 'application/octet-stream',
        '.x3d': 'application/octet-stream',
        '.blender': 'application/octet-stream',
        '.dxf': 'application/octet-stream',
        '.dwg': 'application/octet-stream',
        '.fbx': 'application/octet-stream',
        '.f3d': 'application/octet-stream',
        '.f3z': 'application/octet-stream',
        '.chitubox': 'application/octet-stream',
        '.voxl': 'application/octet-stream',
        '.gcode': 'application/octet-stream',
        '.igs': 'application/octet-stream',
        '.iges': 'application/octet-stream',
        '.lys': 'application/octet-stream',
        '.lyt': 'application/octet-stream'
      };
      
      if (mimeTypes[ext]) {
        res.setHeader('Content-Type', mimeTypes[ext]);
      }
      
      // Set Content-Disposition header to trigger download with proper filename
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      
      // Stream the file
      const fileStream = fs.createReadStream(actualFilePath);
      fileStream.pipe(res);
      
      fileStream.on('error', (error) => {
        console.error('Error serving download:', error);
        if (!res.headersSent) {
          res.status(500).send('Error reading file');
        }
      });
      
      // Clean up temp file after streaming (for zip entries)
      if (pathInfo.isZipEntry) {
        fileStream.on('end', () => {
          setTimeout(() => {
            cleanupExtractTempFile(actualFilePath).catch(() => {});
          }, 1000);
        });
      }
    } catch (error) {
      console.error('Error in download endpoint:', error);
      res.status(500).send('Error serving download');
    }
  });

  // Serve static assets
  expressApp.use(staticWebAssetsOnly(express.static(appDir, {
    setHeaders: (res, filePath) => {
      // Set proper MIME types
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp',
        '.wasm': 'application/wasm'
      };
      if (mimeTypes[ext]) {
        res.setHeader('Content-Type', mimeTypes[ext]);
      }
      if (path.basename(filePath) === 'sw.js') {
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (['.js', '.css', '.html', '.webmanifest'].includes(ext)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  })));

  // Handle 404 - serve index.html for SPA routing (with bridge injection)
  expressApp.get('*', (req, res) => {
    // Missing static files: express.static already called next(); respond or the client hangs (blocks parser on <script src>)
    if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|bmp|webp|json|webmanifest|map)$/)) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    
    const htmlPath = path.join(appDir, 'index.html');
    const bridgePath = path.join(appDir, 'server-bridge.js');
    
    fs.readFile(htmlPath, 'utf8', (err, htmlData) => {
      if (err) {
        res.status(500).send('Error loading index.html');
        return;
      }
      
      fs.readFile(bridgePath, 'utf8', (err, bridgeCode) => {
        if (err) {
          console.error('Error loading server-bridge.js for SPA fallback, using script tag:', err);
        }
        res.send(injectBridgeIntoIndexHtml(htmlData, bridgeCode, !!err));
      });
    });
  });

  const tlsResolved = forcePlainHttp ? { options: null, source: 'none' } : resolveAppTls();
  const tlsOptions = tlsResolved.options || null;
  const useTls = !!tlsOptions;

  // Start server (returns Promise so callers can catch bind errors, e.g. macOS entitlement)
  const serverPromise = new Promise((resolve, reject) => {
    const scheme = useTls ? 'https' : 'http';
    if (localhostOnly) {
      console.log(`[Local HTTP] Starting server on ${scheme}://${HOST}:${PORT}...`);
    }

    const onListening = () => {
      if (localhostOnly) {
        console.log(`[Local HTTP] Server listening at ${scheme}://${HOST}:${PORT}`);
        if (useTls) {
          console.log(`[Local HTTP] TLS enabled (source: ${tlsResolved.source}) for Browser Extension / MCP`);
        }
        syncPort80Server().catch((err) => {
          console.warn('[TLS] Port 80 listener:', err.message);
        });
      } else {
        console.log(`Printventory server mode started`);
        console.log(`Server running at ${scheme}://${HOST}:${PORT}`);
        // The Docker HEALTHCHECK reads this to find the port and scheme (both can change in Settings).
        try {
          fs.writeFileSync(path.join(os.tmpdir(), 'printventory-listen.json'), JSON.stringify({ port: PORT, scheme }));
        } catch (err) {
          console.warn('Could not write listen info for the health check:', err.message);
        }
        console.log(`Access from remote browsers: ${scheme}://<your-ip>:${PORT}`);
        if (useTls) {
          console.log(`TLS enabled (source: ${tlsResolved.source}): browser will use wss:// for the Printventory bridge (same port).`);
        }
        if (!localhostOnly) {
          syncPort80Server().catch((err) => {
            console.warn('[TLS] Port 80 listener:', err.message);
          });
        }
        console.log(`Server mode requires UNC paths for all file operations`);
      }
      resolve();
    };

    console.log(`[Server] Binding ${scheme}://${HOST}:${PORT} (tls source: ${tlsResolved.source || 'none'})`);
    httpServerEpoch += 1;
    if (useTls) {
      httpServer = https.createServer(tlsOptions, expressApp);
      httpServer.listen(PORT, HOST, onListening);
    } else {
      httpServer = expressApp.listen(PORT, HOST, onListening);
    }

    httpServer.on('error', (err) => {
      console.error('[Local HTTP] Server failed to bind:', err.message);
      console.error('[Local HTTP] Code:', err.code, '— If EACCES on macOS, add com.apple.security.network.server to entitlements and rebuild.');
      httpServer = null;
      reject(err);
    });
  });

  // Create WebSocket server for IPC bridge
  wss = new WebSocket.Server({
    server: httpServer,
    verifyClient: (info, done) => {
      const result = getServerAuth().verifyUpgrade(info.req);
      if (!result.ok) console.warn(`[Server] WebSocket rejected: ${result.reason}`);
      done(result.ok, result.status, result.reason);
    }
  });
  const pendingRequests = new Map();
  wsClients = new Set(); // Track all connected clients

  wss.on('connection', (ws, req) => {
    const isThumbnailWorker = isThumbnailWorkerRequest(req);
    console.log(isThumbnailWorker ? 'Thumbnail worker connected' : 'WebSocket client connected');
    wsClients.add(ws);
    if (isThumbnailWorker) thumbnailWorkerWs = ws;

    // Bound concurrent IPC work per client. Unbounded Promise.all-style floods
    // (tens of thousands of getThumbnail calls) otherwise stall past client timeouts.
    const MAX_WS_IPC_CONCURRENT = 24;
    let wsIpcInFlight = 0;
    const wsIpcWaiters = [];
    const wsIpcDebug = process.env.PRINTVENTORY_WS_IPC_DEBUG === '1';

    function acquireWsIpcSlot() {
      if (wsIpcInFlight < MAX_WS_IPC_CONCURRENT) {
        wsIpcInFlight++;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        wsIpcWaiters.push(resolve);
      });
    }

    function releaseWsIpcSlot() {
      const next = wsIpcWaiters.shift();
      if (next) {
        next();
      } else {
        wsIpcInFlight = Math.max(0, wsIpcInFlight - 1);
      }
    }

    ws.on('message', async (message) => {
      let parsed;
      try {
        parsed = JSON.parse(message.toString());
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
        try {
          ws.send(JSON.stringify({ type: 'error', error: error.message }));
        } catch (_) { /* ignore */ }
        return;
      }

      const { id, channel, args, type } = parsed;

      // Fire-and-forget sends / special events: handle immediately (no IPC slot).
      const isFireAndForget = type === 'send' || (type === 'event' && (channel === 'puter-ai-chat-response' || channel === DIALOG_RESPONSE_CHANNEL));
      if (!isFireAndForget) {
        await acquireWsIpcSlot();
      }

      try {
        // A browser answered a dialog the server asked it to show.
        if (type === 'event' && channel === DIALOG_RESPONSE_CHANNEL) {
          const [dialogId, dialogResult] = args || [];
          clientDialogs.handleResponse(ws, dialogId, dialogResult);
          return;
        }

        // Handle puter-ai-chat-response events from WebSocket clients (server mode)
        if (type === 'event' && channel === 'puter-ai-chat-response') {
          const [requestId, result] = args || [];
          console.log('[Puter AI] Received response via WebSocket event, requestId:', requestId, 'has result:', !!result, 'has error:', !!(result && result.error));
          const pending = puterPendingRequests.get(requestId);
          if (pending) {
            console.log('[Puter AI] Found pending request, resolving');
            puterPendingRequests.delete(requestId);
            if (result && result.error) {
              pending.reject(new Error(result.error));
            } else {
              pending.resolve(result ? result.response : null);
            }
          } else {
            console.warn('[Puter AI] No pending request found for requestId:', requestId, 'Total pending:', puterPendingRequests.size);
          }
          return; // Don't process as regular event
        }
        
        // Handle event sends (fire and forget) - these are events, not IPC handlers
        if (type === 'send') {
          // Special handling for puter-ai-chat-response: route to pending request
          if (channel === 'puter-ai-chat-response') {
            const [requestId, result] = args || [];
            console.log('[Puter AI] Received response via WebSocket send, requestId:', requestId, 'has result:', !!result, 'has error:', !!(result && result.error));
            const pending = puterPendingRequests.get(requestId);
            if (pending) {
              console.log('[Puter AI] Found pending request, resolving');
              puterPendingRequests.delete(requestId);
              if (result && result.error) {
                pending.reject(new Error(result.error));
              } else {
                pending.resolve(result ? result.response : null);
              }
            } else {
              console.warn('[Puter AI] No pending request found for requestId:', requestId, 'Total pending:', puterPendingRequests.size);
            }
            return; // Don't broadcast or process as regular event
          }
          
          // These are events that should be broadcast to all clients
          // In server mode, broadcast to all WebSocket clients
          // In normal mode, trigger the ipcMain.on() handler which sends to the renderer
          if (global.broadcastEvent) {
            // Broadcast to all WebSocket clients (they'll receive as type: 'event')
            global.broadcastEvent(channel, ...(args || []));
          } else {
            // In normal mode, trigger the ipcMain.on() handler
            // Create a mock event object to trigger the handler
            const mockEvent = {
              sender: null
            };
            
            // Get all listeners for this channel and trigger them
            const listeners = ipcMain.listeners(channel);
            if (listeners.length > 0) {
              listeners.forEach(listener => {
                try {
                  listener(mockEvent, ...(args || []));
                } catch (error) {
                  console.error(`Error in ipcMain.on('${channel}') handler:`, error);
                }
              });
            }
          }
          return; // Don't try to handle as IPC call
        }

        // Browsers may only pass paths inside the library (see server-paths.js).
        try {
          assertNetworkIpcArgs(channel, args || [], networkPathContext());
        } catch (guardError) {
          console.warn(`[Server] Refused ${channel}: ${guardError.message}`);
          ws.send(JSON.stringify({ id, type: 'error', error: guardError.message }));
          return;
        }

        // Call IPC handlers directly instead of through hidden window
        // This is more reliable and faster
        try {
          // Create a mock event object for IPC handlers
          const mockEvent = {
            sender: {
              send: (eventChannel, ...eventArgs) => {
                // Broadcast event to all WebSocket clients in server mode
                if (global.broadcastEvent) {
                  global.broadcastEvent(eventChannel, ...eventArgs);
                } else {
                  // Send event back via WebSocket to this specific client
                  ws.send(jsonStringifyForWs({
                    type: 'event',
                    channel: eventChannel,
                    args: eventArgs
                  }));
                }
              }
            },
            // Add wsClient for server mode so createPuterIPCHandler can use it
            wsClient: ws,
            // Set for every call that arrives over the network (any mode)
            fromNetwork: true
          };
          
          // Check if handler exists in registry (for direct invocation)
          const handler = ipcHandlerRegistry.get(channel);
          if (handler) {
            // Call the handler directly - much faster and more reliable
            try {
              // args is already the list of handler parameters after `event`
              // (e.g. showContextMenu([p1,p2,p3]) → args = [[p1,p2,p3]]).
              // Do NOT unwrap a sole nested array — that turns an intentional
              // array argument into separate params and only the first is kept
              // (broke multi-select Generate Tags / context menu).
              const flatArgs = args || [];
              if (wsIpcDebug) {
                console.log('[WebSocket] Handler found for channel:', channel, 'Raw args:', args, 'Args length:', args?.length, 'Args type:', typeof args);
                console.log('[WebSocket] Calling handler with flatArgs:', flatArgs, 'Length:', flatArgs.length);
              }
              const result = await handler(mockEvent, ...flatArgs);
              
              // Convert ArrayBuffer to base64 for WebSocket transmission
              let serializedResult = result;
              if (result instanceof ArrayBuffer) {
                const buffer = Buffer.from(result);
                serializedResult = {
                  __arrayBuffer: true,
                  data: buffer.toString('base64'),
                  byteLength: result.byteLength
                };
              } else if (result && result.buffer instanceof ArrayBuffer) {
                // Handle TypedArray (Uint8Array, etc.)
                const buffer = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
                serializedResult = {
                  __arrayBuffer: true,
                  data: buffer.toString('base64'),
                  byteLength: result.byteLength
                };
              }
              
              ws.send(jsonStringifyForWs({
                id,
                type: 'result',
                result: serializedResult
              }));
            } catch (error) {
              console.error(`Error in handler for '${channel}':`, error);
              ws.send(JSON.stringify({
                id,
                type: 'error',
                error: error.message || String(error)
              }));
            }
          } else {
            throw new Error(`IPC handler '${channel}' not found`);
          }
        } catch (error) {
          console.error('Error executing IPC call:', error);
          ws.send(JSON.stringify({
            id,
            type: 'error',
            error: error.message || String(error)
          }));
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
        try {
          ws.send(JSON.stringify({
            type: 'error',
            error: error.message
          }));
        } catch (_) { /* ignore */ }
      } finally {
        if (!isFireAndForget) {
          releaseWsIpcSlot();
        }
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      wsClients.delete(ws);
      clientDialogs.dropClient(ws);
      if (thumbnailWorkerWs === ws) thumbnailWorkerWs = null;
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      wsClients.delete(ws);
    });
  });
  
  // Broadcast events to all WebSocket clients
  function broadcastEvent(channel, ...args) {
    const message = jsonStringifyForWs({
      type: 'event',
      channel,
      args
    });
    wsClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Error broadcasting event:', error);
        }
      }
    });
  }
  
  // Store broadcast function globally for use in IPC handlers
  global.broadcastEvent = broadcastEvent;
  
  // Helper function to send events (works in both normal and server mode)
  global.sendEvent = function(event, channel, ...args) {
    if (global.broadcastEvent) {
      global.broadcastEvent(channel, ...args);
    } else if (event && event.sender) {
      event.sender.send(channel, ...args);
    }
  };

  // Bind errors are handled in the Promise above (reject). Server-mode callers should catch and exit.
  return serverPromise;
}

/**
 * Serve the Electron desktop UI over http://127.0.0.1 so third-party scripts (e.g. Puter.js)
 * are not loaded from file://, which they reject and replace with an intrusive error page.
 */


// Stop HTTP server function
function stopHttpServer() {
  return new Promise((resolve) => {
    if (!httpServer) {
      console.log('HTTP server is not running');
      resolve();
      return;
    }

    const epoch = httpServerEpoch;
    const server = httpServer;
    console.log('Stopping HTTP server...');

    // Close all WebSocket connections gracefully
    if (wsClients && wsClients.size > 0) {
      console.log(`Closing ${wsClients.size} WebSocket connection(s)...`);
      wsClients.forEach((ws) => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Server restarting');
          }
        } catch (error) {
          console.error('Error closing WebSocket connection:', error);
        }
      });
      wsClients.clear();
    }

    // Close WebSocket server
    if (wss) {
      try {
        wss.close(() => {
          console.log('WebSocket server closed');
        });
      } catch (error) {
        console.error('Error closing WebSocket server:', error);
      }
      wss = null;
    }

    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch (_) { /* ignore */ }
    }

    // Close HTTP server
    server.close(() => {
      console.log('HTTP server closed');
      if (httpServerEpoch === epoch) {
        httpServer = null;
        wsClients = null;
        global.broadcastEvent = null;
        global.sendEvent = null;
      }
      resolve();
    });

    // Force close after timeout if graceful shutdown doesn't complete
    setTimeout(() => {
      if (httpServerEpoch !== epoch) return;
      if (httpServer === server) {
        console.log('Force closing HTTP server...');
        try {
          server.close();
        } catch (error) {
          console.error('Error force closing server:', error);
        }
        httpServer = null;
        wsClients = null;
        wss = null;
        global.broadcastEvent = null;
        global.sendEvent = null;
        resolve();
      }
    }, 5000);
  });
}

function getSettingValueOr(key, fallback) {
  try {
    if (!database.db) return fallback;
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && row.value !== '') return row.value;
  } catch (_) { /* ignore */ }
  return fallback;
}

let serverAuth = null;

/** Login, API token and download tokens for the HTTP/WebSocket server. */
function getServerAuth() {
  if (!serverAuth) {
    serverAuth = createServerAuth({
      getSetting: (key) => getSettingValueOr(key, null),
      setSetting: (key, value) => {
        database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      },
      extraOrigins: () => {
        const origins = String(process.env.PRINTVENTORY_ALLOWED_ORIGINS || '')
          .split(',').map((origin) => origin.trim()).filter(Boolean);
        return origins;
      }
    });
  }
  return serverAuth;
}

/** Only hand out web assets from the app folder (never server code, config or secrets). */
function staticWebAssetsOnly(staticHandler) {
  return (req, res, next) => (isServableStaticPath(req.path) ? staticHandler(req, res, next) : next());
}

/** Library roots and folders that network callers (browser, MCP) are checked against. */
function networkPathContext() {
  let generatedDir = '';
  try {
    generatedDir = path.dirname(getDatabasePath());
  } catch (_) { /* db not ready */ }
  let dataDir = '';
  try {
    dataDir = app.getPath('userData');
  } catch (_) { /* app not ready */ }
  return {
    roots: [...getLibraryRootPaths(), ...readScannedDirectorySetting()],
    generatedDir,
    appDir: __dirname,
    dataDir,
    isExtractTemp: (candidate) => isPrintventoryExtractTempPath(candidate),
    realpath: (candidate) => fs.realpathSync.native(candidate),
    isKnownModel: (candidate) => !!(database.db && database.db.prepare('SELECT 1 FROM models WHERE filePath = ? LIMIT 1').get(candidate))
  };
}

/** /api/file and /api/download only serve library files, plus backups and exports. */
function libraryPathAllowed(filePath) {
  return isLibraryPathAllowed(filePath, networkPathContext());
}

let databaseClosedOnQuit = false;

/**
 * Last step of every normal quit (docker stop, closing the window, Ctrl+C): Chromium turns
 * SIGTERM/SIGINT into an app quit, so Node signal handlers never run. will-quit handlers are
 * synchronous and finish before exit. Statements are synchronous too, so no write is cut off.
 */
function closeDatabaseOnQuit() {
  if (databaseClosedOnQuit) return;
  databaseClosedOnQuit = true;
  stopThumbnailWorkerBrowser();
  try {
    if (serverThumbnailJob.status === 'running') serverThumbnailJob.cancelRequested = true;
  } catch (_) { /* job state not initialized */ }
  try {
    if (wsClients) wsClients.forEach((client) => { try { client.close(1001, 'Server shutting down'); } catch (_) { /* ignore */ } });
    if (httpServer) httpServer.close();
  } catch (error) {
    console.warn('[Quit] Closing connections:', error.message);
  }
  try {
    if (database.db && database.db.open) {
      database.db.pragma('wal_checkpoint(TRUNCATE)');
      database.db.close();
      // A plain copy is consistent only after the checkpoint and close.
      fs.copyFileSync(getDatabasePath(), path.join(app.getPath('userData'), 'backup_printventory.db'));
      console.log('[Quit] Database closed and backed up.');
    }
  } catch (error) {
    console.error('[Quit] Closing the database:', error);
  }
}

app.on('will-quit', closeDatabaseOnQuit);

let extensionInboxTimer = null;
let extensionInboxImporting = false;

function getExtensionInboxDirectory() {
  return extensionInbox.resolveInboxDirectory(getSettingValueOr('extensionInboxDirectory', ''));
}

function getExtensionInboxDirectories() {
  const custom = (getSettingValueOr('extensionInboxDirectory', '') || '').trim();
  return extensionInbox.uniqueInboxDirectories([
    custom || null,
    extensionInbox.defaultInboxDirectory(),
    extensionInbox.inboxDirectoryBesideDatabase(getDatabasePath())
  ]);
}

function recordExtensionInboxStatus(result, reason) {
  const payload = {
    at: new Date().toISOString(),
    reason: reason || null,
    imported: result.imported || 0,
    failed: result.failed || 0,
    skipped: result.skipped || 0,
    errors: (result.errors || []).slice(0, 5)
  };
  persistSetting('extensionInboxLastStatus', JSON.stringify(payload));
}

async function runExtensionInboxImport(reason) {
  if (extensionInboxImporting) {
    return { imported: 0, failed: 0, skipped: 0, errors: [], busy: true };
  }
  extensionInboxImporting = true;
  try {
    const result = await extensionInbox.importInboxMany({
      inboxDirs: getExtensionInboxDirectories(),
      saveModel
    });
    if (result.imported || result.failed || reason === 'manual' || reason === 'startup') {
      recordExtensionInboxStatus(result, reason);
    }
    if (result.imported > 0) {
      try {
        if (typeof global.broadcastEvent === 'function') {
          global.broadcastEvent('refresh-grid');
        }
      } catch (e) {
        console.warn('[Extension inbox] refresh-grid failed:', e.message);
      }
    }
    if (result.imported || result.failed) {
      console.log('[Extension inbox]', reason, 'imported', result.imported, 'failed', result.failed);
    }
    return result;
  } catch (err) {
    console.error('[Extension inbox] import failed:', err);
    return { imported: 0, failed: 0, skipped: 0, errors: [err.message || String(err)] };
  } finally {
    extensionInboxImporting = false;
  }
}

function startExtensionInboxWatcher() {
  if (extensionInboxTimer) return;
  runExtensionInboxImport('startup').catch((e) => console.error('[Extension inbox] startup:', e));
  extensionInboxTimer = setInterval(() => {
    runExtensionInboxImport('interval').catch((e) => console.error('[Extension inbox] interval:', e));
  }, extensionInbox.POLL_INTERVAL_MS);
  if (typeof extensionInboxTimer.unref === 'function') extensionInboxTimer.unref();
}

function parseListenPort(value, fallback = 5000) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function getConfiguredHttpPort() {
  return parseListenPort(getSettingValueOr('browserExtensionPort', '5000'), 5000);
}

function getEnvServerListenPort() {
  const raw = process.env.PRINTVENTORY_PORT;
  if (raw == null || String(raw).trim() === '') return null;
  const parsed = parseListenPort(raw, 0);
  return parsed > 0 ? parsed : null;
}

function envOverridesSettings() {
  return process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === '1'
    || process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === 'true';
}

function getServerListenPort() {
  const envPort = getEnvServerListenPort();
  if (envPort && envOverridesSettings()) return envPort;
  return parseListenPort(getSettingValueOr('serverHttpPort', envPort ? String(envPort) : '5000'), 5000);
}

function getAppListenPort() {
  return getServerListenPort();
}

function localHttpServerShouldRun() {
  return true;
}

function getHttpServerListenPort() {
  if (!httpServer) return null;
  try {
    const addr = httpServer.address();
    if (addr && typeof addr === 'object' && addr.port) return addr.port;
  } catch (_) { /* ignore */ }
  return null;
}

function collectLanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets || {})) {
    for (const net of nets[name] || []) {
      if (!net || net.internal) continue;
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.address) out.push(net.address);
    }
  }
  return out;
}

async function syncLocalHttpServer(port) {
  return { success: true, running: true, port: getHttpServerListenPort() || getAppListenPort() };
}

function getMcpConnectionInfo() {
  const port = getHttpServerListenPort() || getConfiguredHttpPort();
  const enabled = true;
  const running = !!httpServer;
  const lanAddresses = collectLanAddresses();
  const scheme = resolveAppTls().options ? 'https' : 'http';
  const localUrl = `${scheme}://127.0.0.1:${port}/mcp`;
  const urls = [`${scheme}://<server-host>:${port}/mcp`, localUrl, ...lanAddresses.map((ip) => `${scheme}://${ip}:${port}/mcp`)];
  const primaryUrl = (lanAddresses[0] ? `${scheme}://${lanAddresses[0]}:${port}/mcp` : `${scheme}://0.0.0.0:${port}/mcp`);
  return {
    serverMode: true,
    enabled,
    running,
    port,
    url: primaryUrl,
    urls,
    clientConfig: buildMcpClientConfig(`${scheme}://<server-host>:${port}/mcp`, getServerAuth().apiToken()),
    tools: listToolDefinitions().map((t) => t.name),
    serverName: MCP_SERVER_NAME
  };
}

ipcMain.handle('get-server-access-info', async () => ({
  apiToken: getServerAuth().apiToken(),
  passwordFromEnv: !!process.env.PRINTVENTORY_PASSWORD,
  minPasswordLength: MIN_PASSWORD_LENGTH
}));

ipcMain.handle('set-server-password', async (event, currentPassword, newPassword) => {
  if (process.env.PRINTVENTORY_PASSWORD) {
    throw new Error('The password is set by PRINTVENTORY_PASSWORD. Change it there and restart.');
  }
  const auth = getServerAuth();
  // The desktop window may reset a forgotten password; browsers must know the current one.
  if (event && event.fromNetwork && !auth.verifyPassword(currentPassword)) {
    throw new Error('Current password is wrong');
  }
  auth.setPassword(newPassword);
  // Open sockets were authorized with the old password; drop them so every browser logs in again.
  setTimeout(() => {
    if (wsClients) {
      wsClients.forEach((client) => {
        try { client.close(4001, 'Password changed'); } catch (_) { /* ignore */ }
      });
    }
  }, 1500);
  return { success: true };
});

ipcMain.handle('regenerate-server-api-token', async () => ({
  apiToken: getServerAuth().regenerateApiToken()
}));

function resolveModelForMcp(args) {
  if (!args) throw new Error('Provide id or filePath');
  if (args.filePath) {
    const model = getModelByFilePath(args.filePath);
    if (!model) throw new Error(`Model not found for filePath: ${args.filePath}`);
    return model;
  }
  if (args.id != null && args.id !== '') {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid model id');
    const model = getModelById(id);
    if (!model) throw new Error(`Model not found for id: ${id}`);
    return model;
  }
  throw new Error('Provide id or filePath');
}

function normalizeMcpTagNames(raw) {
  const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = String(item && typeof item === 'object' && item.name != null ? item.name : item || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function getModelTagNamesForMcp(modelId) {
  return database.db.prepare(`
    SELECT t.name FROM tags t
    JOIN model_tags mt ON mt.tag_id = t.id
    WHERE mt.model_id = ?
    ORDER BY t.name COLLATE NOCASE
  `).all(modelId).map((row) => row.name);
}

function resolveTagForMcp(args) {
  if (!args) throw new Error('Provide tag id or name');
  if (args.id != null && args.id !== '') {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid tag id');
    const tag = database.db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id);
    if (!tag) throw new Error(`Tag not found for id: ${id}`);
    return tag;
  }
  const name = String(args.name || '').trim();
  if (!name) throw new Error('Provide tag id or name');
  const tag = database.db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(name);
  if (!tag) throw new Error(`Tag not found: ${name}`);
  return tag;
}

function renameTagForMcp(args) {
  const tag = resolveTagForMcp(args);
  const newName = String(args && args.newName || '').trim();
  if (!newName) throw new Error('newName is required');
  if (newName.toLowerCase() === String(tag.name).toLowerCase()) {
    if (newName !== tag.name) {
      database.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName, tag.id);
    }
    return { success: true, id: tag.id, name: newName, merged: false };
  }
  const existing = database.db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(newName);
  if (existing && existing.id !== tag.id) {
    database.db.transaction(() => {
      const rows = database.db.prepare('SELECT model_id FROM model_tags WHERE tag_id = ?').all(tag.id);
      const insert = database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)');
      for (const row of rows) insert.run(row.model_id, existing.id);
      database.db.prepare('DELETE FROM model_tags WHERE tag_id = ?').run(tag.id);
      database.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
      if (existing.name !== newName) {
        database.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName, existing.id);
      }
    })();
    return { success: true, id: existing.id, name: newName, merged: true, deletedId: tag.id };
  }
  database.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName, tag.id);
  return { success: true, id: tag.id, name: newName, merged: false };
}

const MCP_METADATA_TYPES = new Set(['designer', 'parentModel', 'license']);

function renameMetadataForMcp(args) {
  const type = String(args && args.type || '').trim();
  const oldName = String(args && args.oldName || '').trim();
  const newName = String(args && args.newName || '').trim();
  if (!MCP_METADATA_TYPES.has(type)) throw new Error('type must be designer, parentModel, or license');
  if (!oldName || !newName) throw new Error('oldName and newName are required');
  const existing = database.db.prepare(`
    SELECT COUNT(*) as count FROM models
    WHERE ${type} = ? AND ${type} IS NOT NULL AND ${type} != ''
  `).get(newName);
  const existingCount = existing ? existing.count : 0;
  const result = database.db.prepare(`UPDATE models SET ${type} = ? WHERE ${type} = ?`).run(newName, oldName);
  return {
    success: true,
    updated: result.changes,
    merged: existingCount > 0,
    existingCount
  };
}

function deleteMetadataForMcp(args) {
  const type = String(args && args.type || '').trim();
  const name = String(args && args.name || '').trim();
  if (!MCP_METADATA_TYPES.has(type)) throw new Error('type must be designer, parentModel, or license');
  if (!name) throw new Error('name is required');
  const result = database.db.prepare(`UPDATE models SET ${type} = NULL WHERE ${type} = ?`).run(name);
  return { success: true, updated: result.changes };
}

function requireMcpConfirm(args, action) {
  if (!args || args.confirm !== true) {
    throw new Error(`Refusing ${action}. Pass confirm: true to proceed.`);
  }
}

function mcpIpcEvent() {
  return { sender: { send() {} } };
}

/** Event for work the server starts itself: progress goes to every connected browser. */
function serverIpcEvent() {
  return {
    sender: {
      send(channel, ...args) {
        if (global.broadcastEvent) global.broadcastEvent(channel, ...args);
      }
    }
  };
}

let serverStlHomeTimer = null;
let serverStlHomeScanRunning = false;

/** STL Home scan run by the server (on Node there is no hidden window to start it). */
async function runServerStlHomeScan(reason) {
  if (serverStlHomeScanRunning) return;
  const dirs = readStlHomeDirectories();
  if (!dirs.length) return;
  serverStlHomeScanRunning = true;
  try {
    let newModels = 0;
    for (const dir of dirs) {
      try {
        const result = await scanDirectoryHandler(serverIpcEvent(), dir, { isStlHomeScan: true });
        const found = Number(result && result.newFilesCount) || 0;
        newModels += found;
        console.log(`[STL Home] ${reason} scan of ${dir}: ${found} new`);
      } catch (error) {
        console.error(`[STL Home] ${reason} scan of ${dir} failed:`, error.message);
      }
    }
    if (global.broadcastEvent) global.broadcastEvent('refresh-grid');
    if (newModels > 0 && thumbnailWorkerReady() && serverThumbnailJob.status !== 'running') {
      startServerThumbnailJobInternal('missing').catch((error) => console.error('[STL Home] thumbnail job:', error.message));
    }
  } finally {
    serverStlHomeScanRunning = false;
  }
}

// --- Thumbnail worker on Node: headless Chromium running the web UI as a worker client ---
const THUMBNAIL_WORKER_COOKIE = 'pv_worker';
const thumbnailWorkerSecret = crypto.randomBytes(24).toString('hex');
let thumbnailWorkerWs = null;
let thumbnailWorkerBrowser = null;
let thumbnailWorkerRestartTimer = null;

function isThumbnailWorkerRequest(req) {
  const cookies = parseCookies(req && req.headers && req.headers.cookie);
  const value = cookies[THUMBNAIL_WORKER_COOKIE];
  return !!value && value.length === thumbnailWorkerSecret.length
    && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(thumbnailWorkerSecret));
}

/** Chromium flags: software WebGL (SwiftShader) unless PRINTVENTORY_CHROMIUM_ARGS replaces them. */
function thumbnailWorkerChromiumArgs() {
  const custom = String(process.env.PRINTVENTORY_CHROMIUM_ARGS || '').trim();
  const gpu = custom
    ? custom.split(/\s+/)
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  return ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', ...gpu];
}

async function startThumbnailWorkerBrowser() {
  if (thumbnailWorkerBrowser) return;
  const port = getHttpServerListenPort();
  if (!port) return;
  const scheme = resolveAppTls().options ? 'https' : 'http';
  const origin = `${scheme}://127.0.0.1:${port}`;
  try {
    const executablePath = process.env.PRINTVENTORY_CHROMIUM || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      acceptInsecureCerts: true,
      args: thumbnailWorkerChromiumArgs()
    });
    thumbnailWorkerBrowser = browser;
    browser.on('disconnected', () => {
      thumbnailWorkerBrowser = null;
      thumbnailWorkerWs = null;
      if (databaseClosedOnQuit) return;
      console.warn('[Thumbnail worker] Chromium stopped; restarting in 10 seconds');
      clearTimeout(thumbnailWorkerRestartTimer);
      thumbnailWorkerRestartTimer = setTimeout(() => {
        startThumbnailWorkerBrowser().catch((error) => console.error('[Thumbnail worker] restart:', error.message));
      }, 10000);
    });
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[Thumbnail worker] page error:', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('[Thumbnail worker]', message.text().slice(0, 300));
    });
    await browser.setCookie(
      { name: SESSION_COOKIE_NAME, value: getServerAuth().issueSessionToken(), domain: '127.0.0.1', path: '/', httpOnly: true },
      { name: THUMBNAIL_WORKER_COOKIE, value: thumbnailWorkerSecret, domain: '127.0.0.1', path: '/', httpOnly: true }
    );
    await page.goto(`${origin}/?pv-thumbnail-worker=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    console.log('[Thumbnail worker] Headless Chromium started');
  } catch (error) {
    thumbnailWorkerBrowser = null;
    console.error('[Thumbnail worker] Could not start Chromium:', error.message);
  }
}

function stopThumbnailWorkerBrowser() {
  clearTimeout(thumbnailWorkerRestartTimer);
  const browser = thumbnailWorkerBrowser;
  thumbnailWorkerBrowser = null;
  if (browser) {
    try {
      const child = browser.process();
      if (child) child.kill('SIGKILL');
    } catch (_) { /* already gone */ }
  }
}

/** First scan at startup, then every stlHomeUpdateFrequency minutes (default 60). */
function startServerStlHomeScans() {
  runServerStlHomeScan('startup').catch((error) => console.error('[STL Home] startup scan:', error));
  const minutes = parseInt(getSettingValueOr('stlHomeUpdateFrequency', '60'), 10) || 60;
  serverStlHomeTimer = setInterval(() => {
    runServerStlHomeScan('scheduled').catch((error) => console.error('[STL Home] scheduled scan:', error));
  }, minutes * 60 * 1000);
}

function filtersFromMcpArgs(args) {
  if (!args) return null;
  const filters = {};
  for (const key of ['search', 'designer', 'tags', 'directory', 'fileType', 'printed']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') filters[key] = args[key];
  }
  return Object.keys(filters).length ? filters : null;
}

function resolveMcpFilePaths(args) {
  const paths = [];
  const seen = new Set();
  const addPath = (filePath) => {
    const p = String(filePath || '').trim();
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };
  if (Array.isArray(args && args.filePaths)) args.filePaths.forEach(addPath);
  if (args && args.filePath) addPath(args.filePath);
  const ids = [];
  if (args && args.id != null) ids.push(args.id);
  if (Array.isArray(args && args.ids)) ids.push(...args.ids);
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) continue;
    const model = getModelById(id);
    if (model) addPath(model.filePath);
  }
  return paths;
}

function diskPathForExistCheck(filePath) {
  if (isUrlModel(filePath)) return { kind: 'url', path: filePath };
  const zip = parseZipPath(filePath);
  if (zip && zip.isZipEntry) return { kind: 'zip', path: zip.zipPath, filePath };
  return { kind: 'file', path: filePath };
}

function pathExistsOnDisk(filePath) {
  const info = diskPathForExistCheck(filePath);
  if (info.kind === 'url') return true;
  try {
    fs.accessSync(info.path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function removeModelsFromLibraryByPaths(filePaths) {
  const { removed, missing } = deleteModelsByFilePaths(filePaths);
  if (removed.length) {
    if (global.broadcastEvent)
      global.broadcastEvent('refresh-grid');
  }
  return { success: true, removedCount: removed.length, removed, missing };
}

function getMcpToolContext() {
  return {
    // MCP is always a network caller: same path rules as the browser.
    assertToolArgs: (name, args) => assertMcpToolArgs(name, args, networkPathContext()),
    getVersion: () => version,
    searchModels: async (filters) => {
      const models = await getModelsFilteredHandler(null, {
        search: filters.search,
        designer: filters.designer,
        tags: filters.tags,
        directory: filters.directory,
        fileType: filters.fileType,
        printed: filters.printed,
        limit: filters.limit,
        offset: filters.offset
      });
      return {
        count: Array.isArray(models) ? models.length : 0,
        models: models || []
      };
    },
    getModel: async (args) => {
      const includeThumbnails = !!args.includeThumbnails;
      let model = null;
      if (args.id != null && args.id !== '') {
        model = getModelById(Number(args.id), { includeThumbnail: includeThumbnails });
      } else if (args.filePath) {
        model = getModelByFilePath(args.filePath, { includeThumbnail: includeThumbnails });
      } else {
        throw new Error('Provide id or filePath');
      }
      if (!model) return null;
      const tags = database.db.prepare(`
        SELECT t.name FROM tags t
        JOIN model_tags mt ON mt.tag_id = t.id
        WHERE mt.model_id = ?
      `).all(model.id).map((t) => t.name);
      const filaments = getFilamentsForModel(model.id);
      if (!includeThumbnails) {
        const stored = readThumbnailColumn(model.filePath);
        applyThumbnailFlags(Object.assign(model, { thumbnail: stored }));
        delete model.thumbnail;
      }
      return { ...model, tags, filaments: filaments || [] };
    },
    updateModel: async (args) => {
      const existing = resolveModelForMcp(args);
      const payload = {
        id: existing.id,
        filePath: existing.filePath,
        fileName: existing.fileName,
        designer: existing.designer,
        source: existing.source,
        notes: existing.notes,
        printed: existing.printed,
        printStatus: existing.print_status,
        parentModel: existing.parentModel,
        license: existing.license,
        rating: existing.rating,
        favorite: existing.favorite
      };
      for (const key of ['designer', 'source', 'notes', 'license', 'parentModel', 'printStatus', 'rating', 'favorite', 'tags', 'filaments']) {
        if (args[key] !== undefined) payload[key] = args[key];
      }
      await saveModel(payload);
      return { success: true, id: existing.id, filePath: existing.filePath };
    },
    getLibraryStats: async () => {
      const handler = ipcHandlerRegistry.get('get-stats');
      return handler({ sender: { send() {} } });
    },
    getFolderTree: async () => {
      const handler = ipcHandlerRegistry.get('get-folder-tree');
      return handler({ sender: { send() {} } });
    },
    listTags: async () => getAllTagsHandler(),
    addTag: async (name) => {
      const tagName = String(name || '').trim();
      if (!tagName) throw new Error('Tag name is required');
      return saveTagHandler(null, tagName);
    },
    renameTag: async (args) => renameTagForMcp(args),
    deleteTag: async (args) => {
      const tag = resolveTagForMcp(args);
      const modelCount = database.db.prepare('SELECT COUNT(*) as count FROM model_tags WHERE tag_id = ?').get(tag.id)?.count || 0;
      await deleteTagHandler(null, tag.id);
      return { success: true, id: tag.id, name: tag.name, unlinkedModels: modelCount };
    },
    addModelTags: async (args) => {
      const model = resolveModelForMcp(args);
      const toAdd = normalizeMcpTagNames(args.tags);
      if (!toAdd.length) throw new Error('tags is required');
      const current = getModelTagNamesForMcp(model.id);
      const have = new Set(current.map((name) => name.toLowerCase()));
      const next = current.slice();
      for (const name of toAdd) {
        if (have.has(name.toLowerCase())) continue;
        have.add(name.toLowerCase());
        next.push(name);
      }
      await saveModel({ id: model.id, filePath: model.filePath, fileName: model.fileName, tags: next });
      return { success: true, id: model.id, filePath: model.filePath, tags: getModelTagNamesForMcp(model.id) };
    },
    removeModelTags: async (args) => {
      const model = resolveModelForMcp(args);
      const toRemove = new Set(normalizeMcpTagNames(args.tags).map((name) => name.toLowerCase()));
      if (!toRemove.size) throw new Error('tags is required');
      const next = getModelTagNamesForMcp(model.id).filter((name) => !toRemove.has(name.toLowerCase()));
      await saveModel({ id: model.id, filePath: model.filePath, fileName: model.fileName, tags: next });
      return { success: true, id: model.id, filePath: model.filePath, tags: next };
    },
    listFilaments: async () => getAllFilamentsHandler(),
    saveFilament: async (filament) => saveFilamentHandler(null, filament),
    deleteFilament: async (filamentId) => {
      const id = Number(filamentId);
      if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid filament id');
      const existing = database.db.prepare('SELECT id, name FROM filaments WHERE id = ?').get(id);
      if (!existing) throw new Error(`Filament not found for id: ${id}`);
      await deleteFilamentHandler(null, id);
      return { success: true, id: existing.id, name: existing.name };
    },
    setModelFilaments: async (args) => {
      const model = resolveModelForMcp(args);
      const ids = normalizeFilamentIds(args.filaments);
      if (ids == null) throw new Error('filaments is required');
      replaceModelFilaments(model.id, ids);
      return { success: true, id: model.id, filePath: model.filePath, filaments: getFilamentsForModel(model.id) };
    },
    getPrintEvents: async (args) => {
      const model = resolveModelForMcp(args);
      return { id: model.id, filePath: model.filePath, events: printEvents.getPrintEvents(database.db, model.id) };
    },
    logPrintEvent: async (args) => {
      const model = resolveModelForMcp(args);
      return printEvents.logPrintEvent(database.db, {
        modelId: model.id,
        filePath: model.filePath,
        outcome: args.outcome,
        quantity: args.quantity,
        printedAt: args.printedAt,
        notes: args.notes,
        filamentIds: args.filamentIds,
        parts: args.parts
      });
    },
    deletePrintEvent: async (eventId) => printEvents.deletePrintEvent(database.db, eventId),
    listParentModels: async () => {
      const rows = database.db.prepare("SELECT DISTINCT parentModel FROM models WHERE parentModel IS NOT NULL AND parentModel != ''").all();
      return rows.map((row) => row.parentModel);
    },
    renameMetadata: async (args) => renameMetadataForMcp(args),
    deleteMetadata: async (args) => deleteMetadataForMcp(args),
    listDesigners: async () => {
      const handler = ipcHandlerRegistry.get('get-designers');
      return handler({ sender: { send() {} } });
    },
    listLicenses: async () => {
      const handler = ipcHandlerRegistry.get('get-licenses');
      return handler({ sender: { send() {} } });
    },
    getModelsMissingThumbnails: async (limit) => {
      const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      return database.db.prepare(`
        SELECT id, filePath, fileName, size, designer
        FROM models
        WHERE thumbnail IS NULL OR thumbnail = '' OR thumbnail = '3d.png'
        ORDER BY fileName COLLATE NOCASE ASC
        LIMIT ?
      `).all(cap);
    },
    getThumbnails: async (args) => {
      const model = resolveModelForMcp(args);
      const stored = loadThumbnailForModel(model.filePath) || '';
      const thumbnails = parseThumbnails(stored);
      return { id: model.id, filePath: model.filePath, count: thumbnails.length, thumbnails };
    },
    setThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      await saveThumbnail(model.filePath, args.image);
      const payload = { filePath: model.filePath, thumbnailCount: 1, hasMultiple: false, newImageIsDefault: true };
      if (global.broadcastEvent)
        global.broadcastEvent('thumbnail-added', payload);
      return { success: true, id: model.id, filePath: model.filePath };
    },
    addThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      const handler = ipcHandlerRegistry.get('add-thumbnail');
      await handler({ sender: { send() {} } }, model.filePath, args.image);
      return { success: true, id: model.id, filePath: model.filePath };
    },
    setDefaultThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      const index = parseInt(args.index, 10);
      if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
      const stored = readThumbnailColumn(model.filePath);
      if (!stored) throw new Error('Model has no thumbnails');
      const updated = setDefaultThumbnailIndex(stored, index);
      await saveThumbnail(model.filePath, updated);
      const thumbs = parseThumbnails(updated);
      const payload = { filePath: model.filePath, thumbnailCount: thumbs.length, defaultChanged: true };
      if (global.broadcastEvent)
        global.broadcastEvent('thumbnail-default-changed', payload);
      return { success: true, id: model.id, filePath: model.filePath, thumbnailCount: thumbs.length };
    },
    deleteThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      const index = parseInt(args.index, 10);
      if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
      const stored = readThumbnailColumn(model.filePath);
      if (!stored) throw new Error('Model has no thumbnails');
      const thumbnails = parseThumbnails(stored).filter((t) => t && t !== '3d.png' && t.length > 0 && String(t).startsWith('data:image'));
      if (thumbnails.length <= 1) throw new Error('Cannot delete thumbnail: model must have at least one thumbnail');
      if (index >= thumbnails.length) throw new Error('Invalid thumbnail index');
      if (index === 0) throw new Error('Cannot delete the active thumbnail');
      thumbnails.splice(index, 1);
      await saveThumbnail(model.filePath, thumbnails.join('::'));
      const payload = { filePath: model.filePath, thumbnailCount: thumbnails.length };
      if (global.broadcastEvent)
        global.broadcastEvent('thumbnail-deleted', payload);
      return { success: true, id: model.id, filePath: model.filePath, thumbnailCount: thumbnails.length };
    },
    findDuplicates: async (args) => {
      const filters = filtersFromMcpArgs(args);
      const groups = await getDuplicatesHandler(mcpIpcEvent(), { includeZip: !!args.includeZip, filters });
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200);
      const list = Array.isArray(groups) ? groups : [];
      return {
        groupCount: list.length,
        returned: Math.min(list.length, limit),
        truncated: list.length > limit,
        groups: list.slice(0, limit)
      };
    },
    getHashStatus: async (args) => {
      const filters = filtersFromMcpArgs(args);
      return {
        generating: !!isGeneratingHashes,
        missingHash: countModelsNeedingHash({ includeSha256: false, filters }),
        missingOrSha256: countModelsNeedingHash({ includeSha256: true, filters })
      };
    },
    calculateMissingHashes: async (args) => generateMissingHashesHandler(mcpIpcEvent(), filtersFromMcpArgs(args)),
    checkFilesExist: async (args) => {
      let paths = Array.isArray(args.filePaths) ? args.filePaths.map((p) => String(p || '').trim()).filter(Boolean) : [];
      const scanningLibrary = paths.length === 0;
      if (scanningLibrary) {
        const cap = Math.min(Math.max(parseInt(args.limit, 10) || 500, 1), 2000);
        paths = database.db.prepare('SELECT filePath FROM models ORDER BY fileName COLLATE NOCASE LIMIT ?').all(cap).map((r) => r.filePath);
      }
      const missingOnly = args.missingOnly !== undefined ? !!args.missingOnly : scanningLibrary;
      const results = [];
      let missingCount = 0;
      for (const filePath of paths) {
        const exists = pathExistsOnDisk(filePath);
        if (!exists) missingCount += 1;
        if (missingOnly && exists) continue;
        results.push({ filePath, exists });
      }
      return { checked: paths.length, missingCount, results };
    },
    getAllMetadata: async () => database.db.prepare(`
      SELECT 'designer' as type, designer as name, COUNT(*) as model_count
      FROM models
      WHERE designer IS NOT NULL AND designer != ''
      GROUP BY designer
      UNION ALL
      SELECT 'parentModel' as type, parentModel as name, COUNT(*) as model_count
      FROM models
      WHERE parentModel IS NOT NULL AND parentModel != ''
      GROUP BY parentModel
      UNION ALL
      SELECT 'license' as type, license as name, COUNT(*) as model_count
      FROM models
      WHERE license IS NOT NULL AND license != ''
      GROUP BY license
      ORDER BY type, name
    `).all(),
    pull3mfMetadata: async (args) => {
      let filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide filePaths, filePath, or id');
      const threeMFFiles = filePaths.filter((fp) => {
        const target = fp.includes('::') ? (fp.split('::')[1] || '') : fp;
        return path.extname(target).toLowerCase() === '.3mf';
      });
      if (!threeMFFiles.length) throw new Error('No 3MF files provided');
      const modelsWithData = [];
      for (const filePath of threeMFFiles) {
        const model = getModelByFilePath(filePath, { includeThumbnail: false });
        if (!model) continue;
        const hasData = (model.designer && String(model.designer).trim()) ||
          (model.parentModel && String(model.parentModel).trim()) ||
          (model.notes && String(model.notes).trim()) ||
          (model.license && String(model.license).trim());
        if (hasData) {
          modelsWithData.push({ filePath, fileName: model.fileName, designer: model.designer, parentModel: model.parentModel, license: model.license });
        }
      }
      if (modelsWithData.length && !args.overwrite) {
        return {
          success: false,
          needsOverwrite: true,
          message: `${modelsWithData.length} model(s) already have metadata. Pass overwrite: true to replace it.`,
          modelsWithData
        };
      }
      const results = [];
      let successCount = 0;
      let errorCount = 0;
      let noMetadataCount = 0;
      for (const filePath of threeMFFiles) {
        try {
          const metadata = await extract3MFMetadata(filePath);
          const filteredMetadata = filter3MFMetadataBySettings(metadata);
          if (filteredMetadata && (filteredMetadata.designer || filteredMetadata.parentModel || filteredMetadata.notes || filteredMetadata.license)) {
            const existingModel = getModelByFilePath(filePath, { includeThumbnail: false });
            if (!existingModel) {
              results.push({ filePath, success: false, error: 'Model not in library' });
              errorCount += 1;
              continue;
            }
            database.db.prepare(`
              UPDATE models SET designer = ?, parentModel = ?, notes = ?, license = ? WHERE filePath = ?
            `).run(
              filteredMetadata.designer || null,
              filteredMetadata.parentModel || null,
              filteredMetadata.notes || null,
              filteredMetadata.license || null,
              filePath
            );
            results.push({ filePath, success: true, action: 'updated' });
            successCount += 1;
          } else {
            results.push({ filePath, success: false, error: 'No metadata found in 3MF file' });
            noMetadataCount += 1;
          }
        } catch (error) {
          results.push({ filePath, success: false, error: error.message });
          errorCount += 1;
        }
      }
      return { success: true, processed: threeMFFiles.length, successCount, errorCount, noMetadataCount, results };
    },
    generateTags: async (args) => {
      const model = resolveModelForMcp(args);
      const tags = await generateTagsHandler(mcpIpcEvent(), model.filePath);
      const suggested = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
      if (!args.apply || !suggested.length) {
        return { id: model.id, filePath: model.filePath, tags: suggested, applied: false };
      }
      const current = getModelTagNamesForMcp(model.id);
      const have = new Set(current.map((name) => name.toLowerCase()));
      const next = current.slice();
      for (const name of suggested) {
        if (have.has(name.toLowerCase())) continue;
        have.add(name.toLowerCase());
        next.push(name);
      }
      if (!have.has('ai tagged')) next.push('AI Tagged');
      await saveModel({ id: model.id, filePath: model.filePath, fileName: model.fileName, tags: next });
      return { id: model.id, filePath: model.filePath, tags: getModelTagNamesForMcp(model.id), suggested, applied: true };
    },
    updateModelsBatch: async (models) => {
      if (!Array.isArray(models) || !models.length) throw new Error('models is required');
      const batch = models.map((item) => {
        const existing = resolveModelForMcp(item);
        const payload = { filePath: existing.filePath };
        for (const key of ['designer', 'source', 'notes', 'license', 'parentModel', 'printStatus', 'rating', 'favorite', 'tags', 'filaments']) {
          if (item[key] !== undefined) payload[key] = item[key];
        }
        return payload;
      });
      await updateModelsBatch(batch);
      return { success: true, count: batch.length };
    },
    logPrintEventsBatch: async (args) => {
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length && !(Array.isArray(args.modelIds) && args.modelIds.length)) {
        throw new Error('Provide filePaths, filePath, id, ids, or modelIds');
      }
      return printEvents.logPrintEventsBatch(database.db, {
        filePaths,
        modelIds: args.modelIds,
        outcome: args.outcome,
        quantity: args.quantity,
        printedAt: args.printedAt,
        notes: args.notes,
        filamentIds: args.filamentIds,
        parts: args.parts
      });
    },
    getModelsByDirectory: async (args) => {
      const directory = String(args.directory || '').trim();
      if (!directory) throw new Error('directory is required');
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);
      const models = database.db.prepare(`
        SELECT ${MODEL_LIST_COLUMNS} FROM models
        WHERE REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?
        ORDER BY fileName COLLATE NOCASE
        LIMIT ?
      `).all(directoryScanPrefixSqlParam(directory), limit);
      return { count: models.length, models };
    },
    scanDirectory: async (args) => {
      let directory = String(args.directory || '').trim();
      if (!directory) {
        directory = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value
          || readStlHomeDirectories()[0]
          || '';
      }
      if (!directory) throw new Error('directory is required (no last-scanned folder is saved)');
      const result = await scanDirectoryHandler(mcpIpcEvent(), directory, {});
      return { success: true, directory, ...result };
    },
    removeModel: async (args) => {
      requireMcpConfirm(args, 'remove_model');
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide id, filePath, ids, or filePaths');
      return removeModelsFromLibraryByPaths(filePaths);
    },
    trashFile: async (args) => {
      requireMcpConfirm(args, 'trash_file');
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide id, filePath, ids, or filePaths');
      const trashed = [];
      const failed = [];
      for (const filePath of filePaths) {
        try {
          if (filePath.includes('::')) {
            failed.push({ filePath, error: 'Zip entries cannot be trashed; use remove_model to drop the library row.' });
            continue;
          }
          validateUncPath(filePath, 'trash-file');
          if (!isUrlModel(filePath)) {
            await shell.trashItem(filePath.replace(/\\/g, '/'));
          }
          const result = removeModelsFromLibraryByPaths([filePath]);
          trashed.push(...result.removed);
          if (result.missing.length) failed.push({ filePath, error: 'Not in library' });
        } catch (error) {
          failed.push({ filePath, error: error.message });
        }
      }
      return { success: failed.length === 0, trashedCount: trashed.length, trashed, failed };
    },
    listSlicers: async () => {
      const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
      if (!tableExists) return [];
      return database.db.prepare('SELECT * FROM slicers').all();
    },
    openInSlicer: async (args) => {
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide id, filePath, or filePaths');
      return openFileInSlicerHandler(mcpIpcEvent(), {
        filePaths,
        slicerId: args.slicerId,
        slicerName: args.slicerName
      });
    },
    moveFiles: async (args) => {
      requireMcpConfirm(args, 'move_files');
      const destinationFolder = String(args.destinationFolder || '').trim();
      if (!destinationFolder) throw new Error('destinationFolder is required');
      const filePaths = Array.isArray(args.filePaths) ? args.filePaths.filter(Boolean) : [];
      if (!filePaths.length) throw new Error('filePaths is required');
      const moved = [];
      for (const filePath of filePaths) {
        if (String(filePath).includes('::')) throw new Error(`Cannot move zip entry: ${filePath}`);
        validateUncPath(filePath, 'move-files');
        if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
        const newDestination = path.join(destinationFolder, path.basename(filePath));
        await fs.promises.rename(filePath, newDestination);
        database.db.prepare('UPDATE models SET filePath = ? WHERE filePath = ?').run(newDestination, filePath);
        moved.push({ from: filePath, to: newDestination });
      }
      if (global.broadcastEvent)
        global.broadcastEvent('refresh-grid');
      return { success: true, moved };
    },
    exportLibrary: async (args) => {
      const exportData = buildLibraryExportData();
      const destPath = String(args.destPath || '').trim() || path.join(
        path.dirname(getDatabasePath()),
        `printventory-library-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      );
      await fs.promises.writeFile(destPath, JSON.stringify(exportData, null, 2), 'utf8');
      return { success: true, filePath: destPath, modelCount: exportData.models.length };
    },
    backupDatabase: async (args) => {
      const dbPath = getDatabasePath();
      const destPath = String(args.destPath || '').trim() || path.join(
        path.dirname(dbPath),
        `printventory-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
      );
      if (path.resolve(destPath) === path.resolve(dbPath)) {
        throw new Error('destPath cannot be the live database file');
      }
      if (database.db && database.db.open && typeof database.db.backup === 'function') {
        await database.db.backup(destPath);
      } else {
        await fs.promises.copyFile(dbPath, destPath);
      }
      return { success: true, filePath: destPath };
    },
    syncSpoolmanFilaments: async (args) => syncSpoolmanFilamentsHandler(mcpIpcEvent(), args.url, args.token)
  };
}

function listenWithTimeout(startPromise, ms) {
  return Promise.race([
    startPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Server did not start listening within ${ms}ms`)), ms);
    })
  ]);
}

async function restartHttpServerNow() {
  const localhostOnly = false;
  const port = getAppListenPort();
  console.log('[Server] Restarting listener on', localhostOnly ? '127.0.0.1' : '0.0.0.0', port);
  await stopHttpServer();
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    await listenWithTimeout(startHttpServer(port, localhostOnly), 8000);
    console.log('[Server] Listener restarted');
    const scheme = resolveAppTls().options ? 'https' : 'http';
    return {
      success: true,
      message: `Server restarted at ${scheme}://<host>:${port}. Reopen the UI with that scheme.`
    };
  } catch (error) {
    console.error('[Server] Restart bind failed:', error.message);
    if (httpServer) {
      try {
        if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
        httpServer.close();
      } catch (_) { /* ignore */ }
      httpServer = null;
    }
    if (resolveAppTls().options) {
      console.error('[Server] Falling back to HTTP');
      try {
        await listenWithTimeout(startHttpServer(port, localhostOnly, { forcePlainHttp: true }), 8000);
        return {
          success: false,
          message: 'Could not start HTTPS; the server is back on HTTP. ' + error.message
        };
      } catch (fallbackErr) {
        console.error('[Server] HTTP fallback failed:', fallbackErr.message);
        return { success: false, message: fallbackErr.message };
      }
    }
    return { success: false, message: error.message || 'Failed to restart server' };
  }
}

// Menu "Restart Server": reply on WebSocket first, then bounce the listener.
async function restartHttpServer() {
  setTimeout(() => {
    restartHttpServerNow().catch((error) => {
      console.error('Error during server restart:', error);
    });
  }, 100);
  return { success: true, message: 'Server restart initiated' };
}

let isGeneratingHashes = false; // Track hash generation state
let isHashGenerationScheduled = false;
let isCompressingThumbnailsBackground = false;
const THUMBNAIL_MIGRATION_DELAY_MS = Math.max(
  15000,
  Number.parseInt(process.env.PRINTVENTORY_THUMBNAIL_MIGRATION_DELAY_MS || '30000', 10) || 30000
);
const THUMBNAIL_MIGRATION_MAX_PER_SESSION = Math.max(
  25,
  Number.parseInt(process.env.PRINTVENTORY_THUMBNAIL_MIGRATION_MAX_PER_SESSION || '200', 10) || 200
);
const THUMBNAIL_MIGRATION_YIELD_MS = 25;

function scheduleBackgroundThumbnailCompression(reason) {
  setTimeout(() => {
    compressExistingThumbnailsInBackground(reason).catch((error) => {
      console.error('Background thumbnail compression failed:', error);
    });
  }, THUMBNAIL_MIGRATION_DELAY_MS);
}

function getThumbnailStoredLength(filePath) {
  if (!database.db || !filePath) return 0;
  const row = database.db.prepare('SELECT LENGTH(thumbnail) AS len FROM models WHERE filePath = ?').get(filePath);
  return row?.len ?? 0;
}

function clearThumbnailForPath(filePath, reason) {
  if (!database.db || !filePath) return false;
  try {
    const result = database.db.prepare('UPDATE models SET thumbnail = NULL WHERE filePath = ?').run(filePath);
    if (result.changes > 0) {
      console.warn(`Cleared thumbnail for ${filePath}${reason ? ` (${reason})` : ''}`);
    }
    return result.changes > 0;
  } catch (error) {
    console.error(`Failed to clear thumbnail for ${filePath}:`, error);
    return false;
  }
}

function purgeCorruptThumbnailsOnly(maxChars = THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS) {
  if (!database.db) return 0;
  try {
    const result = database.db.prepare(`
      UPDATE models
      SET thumbnail = NULL
      WHERE thumbnail IS NOT NULL
        AND LENGTH(thumbnail) > ?
    `).run(maxChars);
    if (result.changes > 0) {
      console.warn(`Cleared ${result.changes} thumbnail(s) over ${maxChars} chars (corrupt/oversized safeguard)`);
    }
    return result.changes;
  } catch (error) {
    console.error('Failed to clear corrupt thumbnails:', error);
    return 0;
  }
}

function readThumbnailColumn(filePath, { allowOversized = false } = {}) {
  if (!database.db || !filePath) return null;
  const storedLength = getThumbnailStoredLength(filePath);
  if (storedLength <= 0) return null;
  if (!allowOversized && storedLength > THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS) {
    return null;
  }
  try {
    const row = database.db.prepare('SELECT thumbnail FROM models WHERE filePath = ?').get(filePath);
    return row?.thumbnail ?? null;
  } catch (error) {
    console.error(`Failed to read thumbnail for ${filePath}:`, error);
    return null;
  }
}

async function compressExistingThumbnailsInBackground(reason) {
  if (isCompressingThumbnailsBackground || !database.db) return;
  isCompressingThumbnailsBackground = true;
  try {
    purgeCorruptThumbnailsOnly();

    const rows = database.db.prepare(`
      SELECT filePath, LENGTH(thumbnail) AS thumbLen
      FROM models
      WHERE thumbnail IS NOT NULL AND thumbnail != '' AND thumbnail != '3d.png'
        AND thumbnail LIKE 'data:image%'
        AND LENGTH(thumbnail) > ?
      ORDER BY LENGTH(thumbnail) DESC
    `).all(THUMBNAIL_MAX_STORED_CHARS);

    if (rows.length === 0) return;

    const batch = rows.slice(0, THUMBNAIL_MIGRATION_MAX_PER_SESSION);
    const remaining = rows.length - batch.length;
    console.log(
      `Migrating ${batch.length} legacy thumbnail(s) (${reason || 'startup'})` +
      (remaining > 0 ? `; ${remaining} deferred to a later session` : '') +
      '...'
    );

    let updated = 0;
    for (const row of batch) {
      try {
        const allowOversized = row.thumbLen > THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS;
        const thumbnail = readThumbnailColumn(row.filePath, { allowOversized });
        if (!thumbnail) continue;

        const parts = thumbnail.includes('::') ? thumbnail.split('::').filter(Boolean) : [thumbnail];
        const needsWork = parts.some((part) => needsCompression(part));
        if (!needsWork) continue;

        const { value, changed } = compressThumbnailBlob(thumbnail);
        if (changed) {
          database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(value, row.filePath);
          updated++;
        }
      } catch (rowError) {
        console.error(`Thumbnail migration failed for ${row.filePath}:`, rowError);
      }
      await new Promise((resolve) => setTimeout(resolve, THUMBNAIL_MIGRATION_YIELD_MS));
    }
    if (updated > 0) {
      console.log(`Thumbnail migration complete: ${updated}/${batch.length} model(s) updated`);
    }
  } finally {
    isCompressingThumbnailsBackground = false;
  }
}

function ensureThumbnailCompressedOnLoad(filePath, thumbnailString) {
  try {
    const { value, changed } = compressThumbnailBlob(thumbnailString);
    if (changed) {
      database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(value, filePath);
    }
    return value;
  } catch (error) {
    console.error(`Failed to compress thumbnail for ${filePath}:`, error);
    return thumbnailString;
  }
}

function loadThumbnailForModel(filePath) {
  try {
    const thumbnail = readThumbnailColumn(filePath);
    if (!thumbnail) return null;
    return ensureThumbnailCompressedOnLoad(filePath, thumbnail);
  } catch (error) {
    console.error(`Failed to load thumbnail for ${filePath}:`, error);
    return null;
  }
}

const MODEL_DETAIL_COLUMNS = 'id, filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, hash, size, license, modifiedDate, dateAdded, isNew, rating, favorite, bundleKey, bundleLabel, bundleKind';

/** List queries omit thumbnail blobs; these flags are computed without returning the column. */
const MODEL_LIST_THUMB_FLAGS =
  "CASE WHEN thumbnail IS NOT NULL AND thumbnail != '' AND thumbnail != '3d.png' THEN 1 ELSE 0 END AS hasThumbnail, " +
  "CASE WHEN thumbnail IS NOT NULL AND INSTR(thumbnail, '::') > 0 THEN 1 ELSE 0 END AS hasMultipleThumbnails";
const MODEL_LIST_THUMB_FLAGS_QUALIFIED =
  "CASE WHEN models.thumbnail IS NOT NULL AND models.thumbnail != '' AND models.thumbnail != '3d.png' THEN 1 ELSE 0 END AS hasThumbnail, " +
  "CASE WHEN models.thumbnail IS NOT NULL AND INSTR(models.thumbnail, '::') > 0 THEN 1 ELSE 0 END AS hasMultipleThumbnails";
const MODEL_LIST_COLUMNS = `${MODEL_DETAIL_COLUMNS}, ${MODEL_LIST_THUMB_FLAGS}`;
const MODEL_LIST_COLUMNS_QUALIFIED =
  `models.id, models.filePath, models.fileName, models.designer, models.source, models.notes, models.printed, models.print_status, models.print_count, models.last_printed_at, models.parentModel, models.hash, models.size, models.license, models.modifiedDate, models.dateAdded, models.isNew, models.rating, models.favorite, models.bundleKey, models.bundleLabel, models.bundleKind, ${MODEL_LIST_THUMB_FLAGS_QUALIFIED}`;

function applyThumbnailFlags(row) {
  if (!row) return row;
  const t = row.thumbnail;
  row.hasThumbnail = !!(t && t !== '' && t !== '3d.png');
  row.hasMultipleThumbnails = !!(t && typeof t === 'string' && t.includes('::'));
  return row;
}

function getModelByFilePath(filePath, { includeThumbnail = false } = {}) {
  if (!database.db || !filePath) return null;
  const row = database.db.prepare(`SELECT ${MODEL_DETAIL_COLUMNS} FROM models WHERE filePath = ?`).get(filePath);
  if (!row) return null;
  if (includeThumbnail) {
    row.thumbnail = loadThumbnailForModel(filePath);
    applyThumbnailFlags(row);
  }
  return row;
}

function getModelById(modelId, { includeThumbnail = false } = {}) {
  if (!database.db || modelId == null) return null;
  const row = database.db.prepare(`SELECT ${MODEL_DETAIL_COLUMNS} FROM models WHERE id = ?`).get(modelId);
  if (!row) return null;
  if (includeThumbnail) {
    row.thumbnail = loadThumbnailForModel(row.filePath);
    applyThumbnailFlags(row);
  }
  return row;
}

function scheduleBackgroundHashGeneration(reason) {
  if (isGeneratingHashes || isHashGenerationScheduled) return;
  isHashGenerationScheduled = true;
  // Defer well past first paint / initial thumb wave so UNC I/O is not contended at cold start.
  const delayMs = reason === 'startup' ? 45000 : 500;
  setTimeout(async () => {
    if (isGeneratingHashes) {
      isHashGenerationScheduled = false;
      return;
    }
    try {
      await calculateMissingHashesInternal(null);
      console.log(`Background hash generation completed (${reason || 'auto'})`);
    } catch (error) {
      console.error('Background hash generation failed:', error);
    } finally {
      isHashGenerationScheduled = false;
    }
  }, delayMs);
}

// IPC handler to expose server mode
ipcMain.handle('is-server-mode', () => {
  return true;
});

// IPC handler to restart server
ipcMain.handle('restart-server', async () => {
  return await restartHttpServer();
});

function flushSettingsToDisk() {
  try {
    if (!database.db) return;
    database.db.pragma('synchronous = FULL');
    database.db.prepare('PRAGMA wal_checkpoint(FULL)').run();
  } catch (_) { /* ignore */ }
}

function persistTlsSettingsFromPayload(payload) {
  const mode = String(payload.tlsMode || serverTls.TLS_MODES.OFF);
  persistSetting('tlsMode', mode);
  persistSetting('tlsCertPath', payload.tlsCertPath || '');
  persistSetting('tlsKeyPath', payload.tlsKeyPath || '');
  persistSetting('tlsCaPath', payload.tlsCaPath || '');
  persistSetting('tlsDomain', payload.tlsDomain || '');
  persistSetting('tlsEmail', payload.tlsEmail || '');
  persistSetting('tlsAgreeTos', payload.tlsAgreeTos ? '1' : '0');
  persistSetting('tlsUseStaging', payload.tlsUseStaging ? '1' : '0');
  persistSetting('tlsRedirectHttp', payload.tlsRedirectHttp ? '1' : '0');
  if (payload.serverHttpPort != null && payload.serverHttpPort !== '') {
    persistSetting('serverHttpPort', String(parseListenPort(payload.serverHttpPort, getServerListenPort())));
  }
  flushSettingsToDisk();
}

function getTlsStatusForUi() {
  const resolved = resolveAppTls();
  const payload = serverTls.getTlsStatusPayload({
    getSetting: getSettingValueOr,
    certsDir: getTlsCertsDir(),
    serverMode: true,
    scheme: resolved.options ? 'https' : 'http',
    appPort: getAppListenPort()
  });
  payload.portEnvOverride = !!(getEnvServerListenPort() && envOverridesSettings());
  return payload;
}

async function reloadTlsHttpListener() {
  const port = getAppListenPort();
  const scheme = resolveAppTls().options ? 'https' : 'http';
  setTimeout(() => {
    restartHttpServerNow().catch((error) => {
      console.error('[TLS] Listener reload failed:', error);
    });
  }, 300);
  return {
    success: true,
    running: true,
    port,
    message: `Settings saved. The listener is restarting at ${scheme}://<host>:${port}. If the page drops, open that URL (self-signed certs need a browser trust exception).`
  };
}

async function ensurePort80ForAcme() {
  try {
    await startPort80Server();
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function maybeRenewLetsEncryptCertificate() {
  if (letsEncryptRenewInFlight) return;
  if (serverTls.hasEnvTlsOverride()) return;
  if (getSettingValueOr('tlsMode', 'off') !== serverTls.TLS_MODES.LETSENCRYPT) return;

  const live = serverTls.getLiveCertPaths(getTlsCertsDir());
  let needsIssue = true;
  if (fs.existsSync(live.certPath)) {
    try {
      needsIssue = serverTls.certificateNeedsRenewal(fs.readFileSync(live.certPath));
    } catch (_) {
      needsIssue = true;
    }
  }
  if (!needsIssue) return;

  letsEncryptRenewInFlight = true;
  try {
    const port80 = await ensurePort80ForAcme();
    if (!port80.success) {
      serverTls.setLastTlsError(port80.message);
      return;
    }
    console.log('[TLS] Renewing Let\'s Encrypt certificate...');
    await serverTls.obtainLetsEncryptCertificate({
      certsDir: getTlsCertsDir(),
      domain: getSettingValueOr('tlsDomain', ''),
      email: getSettingValueOr('tlsEmail', ''),
      agreeTos: getSettingValueOr('tlsAgreeTos', '0') === '1',
      useStaging: getSettingValueOr('tlsUseStaging', '0') === '1'
    });
    await reloadTlsHttpListener();
  } catch (err) {
    serverTls.setLastTlsError(err.message || 'Let\'s Encrypt renewal failed');
    console.warn('[TLS] Renewal failed:', err.message);
  } finally {
    letsEncryptRenewInFlight = false;
  }
}

ipcMain.handle('get-tls-status', async () => {
  return getTlsStatusForUi();
});

ipcMain.handle('apply-tls-settings', async (_event, payload = {}) => {
  if (serverTls.hasEnvTlsOverride()) {
    return {
      success: false,
      message: 'TLS is overridden by PRINTVENTORY_TLS_CERT / PRINTVENTORY_TLS_KEY (or SSL_*). Unset those environment variables to use this UI.',
      status: getTlsStatusForUi()
    };
  }

  try {
    const mode = String(payload.tlsMode || serverTls.TLS_MODES.OFF);
    if (payload.serverHttpPort != null && String(payload.serverHttpPort).trim() !== '') {
      const requested = parseInt(payload.serverHttpPort, 10);
      if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
        throw new Error('Listen port must be between 1 and 65535.');
      }
      if (requested === 80 && (mode === serverTls.TLS_MODES.LETSENCRYPT || payload.tlsRedirectHttp)) {
        throw new Error('Port 80 is reserved for Let\'s Encrypt HTTP-01 and HTTP redirect. Choose a different listen port.');
      }
    }
    persistTlsSettingsFromPayload(payload || {});
    const listenPort = getAppListenPort();
    if (listenPort === 80 && (mode === serverTls.TLS_MODES.LETSENCRYPT || payload.tlsRedirectHttp)) {
      throw new Error('Port 80 is reserved for Let\'s Encrypt HTTP-01 and HTTP redirect. Choose a different listen port.');
    }

    if (mode === serverTls.TLS_MODES.CUSTOM) {
      const certPath = String(payload.tlsCertPath || '').trim();
      const keyPath = String(payload.tlsKeyPath || '').trim();
      if (!certPath || !keyPath) {
        throw new Error('Certificate and key file paths are required for a custom certificate.');
      }
      const loaded = serverTls.readPemTlsOptions(certPath, keyPath, payload.tlsCaPath || '');
      if (!loaded) {
        throw new Error('Certificate or key file was not found. Use an absolute path visible to the server (or container).');
      }
    }

    if (mode === serverTls.TLS_MODES.LETSENCRYPT) {
      const live = serverTls.getLiveCertPaths(getTlsCertsDir());
      const haveCert = fs.existsSync(live.certPath) && fs.existsSync(live.keyPath);
      const shouldIssue = !!payload.issueNow || !haveCert;
      if (shouldIssue) {
        const port80 = await ensurePort80ForAcme();
        if (!port80.success) throw new Error(port80.message);
        await serverTls.obtainLetsEncryptCertificate({
          certsDir: getTlsCertsDir(),
          domain: payload.tlsDomain,
          email: payload.tlsEmail,
          agreeTos: !!payload.tlsAgreeTos,
          useStaging: !!payload.tlsUseStaging
        });
      }
    }

    if (mode === serverTls.TLS_MODES.SELFSIGNED) {
      const managed = serverTls.getSelfSignedPaths(getTlsCertsDir());
      if (!fs.existsSync(managed.certPath) || !fs.existsSync(managed.keyPath)) {
        await serverTls.generateSelfSignedCertificate({
          certsDir: getTlsCertsDir(),
          hostname: String(payload.tlsDomain || '').trim() || 'localhost'
        });
      }
    }

    serverTls.setLastTlsError(null);
    await syncPort80Server().catch((err) => {
      if (mode === serverTls.TLS_MODES.LETSENCRYPT || payload.tlsRedirectHttp) {
        throw err;
      }
    });
    const restart = await reloadTlsHttpListener();
    if (!restart.success) throw new Error(restart.message);
    return { success: true, message: restart.message, status: getTlsStatusForUi() };
  } catch (err) {
    serverTls.setLastTlsError(err.message);
    return { success: false, message: err.message || 'Failed to apply TLS settings', status: getTlsStatusForUi() };
  }
});

ipcMain.handle('generate-self-signed-cert', async (_event, payload = {}) => {
  if (serverTls.hasEnvTlsOverride()) {
    return { success: false, message: 'TLS is overridden by environment variables.' };
  }
  try {
    const hostname = String(payload.hostname || payload.tlsDomain || '').trim();
    const generated = await serverTls.generateSelfSignedCertificate({
      certsDir: getTlsCertsDir(),
      hostname
    });
    persistSetting('tlsMode', serverTls.TLS_MODES.SELFSIGNED);
    persistSetting('tlsDomain', hostname);
    if (payload.tlsRedirectHttp != null) {
      persistSetting('tlsRedirectHttp', payload.tlsRedirectHttp ? '1' : '0');
    }
    if (payload.serverHttpPort != null && payload.serverHttpPort !== '') {
      persistSetting('serverHttpPort', String(parseListenPort(payload.serverHttpPort, getServerListenPort())));
    }
    flushSettingsToDisk();
    serverTls.setLastTlsError(null);
    await syncPort80Server().catch(() => {});
    const restart = await reloadTlsHttpListener();
    if (!restart.success) throw new Error(restart.message);
    return {
      success: true,
      message: 'Self-signed certificate generated (includes localhost and 127.0.0.1). Browsers and Chrome will warn until you trust it. ' + (restart.message || ''),
      status: getTlsStatusForUi(),
      paths: generated
    };
  } catch (err) {
    serverTls.setLastTlsError(err.message);
    return { success: false, message: err.message || 'Failed to generate certificate', status: getTlsStatusForUi() };
  }
});

// Handle single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('Another instance is already running. Quitting...');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {});

  // Create the main window and initialize the app
  app.whenReady().then(async () => {
    try {
      // Initialize database first
      if (!initializeDatabase()) {
        console.error('Database Error: Failed to initialize database. The application will now quit.');
        app.quit();
        return;
      }

      // Reset the version check flag on startup
      database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'versionCheckPerformedOnStartup');

      // Update the current version in the database
      try {
        database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(version, 'currentVersion');
        console.log('Updated currentVersion in database to:', version);
      } catch (versionError) {
        console.error('Error updating currentVersion in database:', versionError);
      }

      // STL_HOME: seed from env when the setting is empty, or always when
      // PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1 (legacy Docker behavior). Otherwise UI changes persist
      // across container restarts instead of being overwritten every startup.
      applyStlHomeEnvIfNeeded(process.env.STL_HOME);
      applyStlHomeExcludeEnvIfNeeded(process.env.STL_HOME_EXCLUDE);
      applyDockerEnvSettingIfNeeded('serverHttpPort', process.env.PRINTVENTORY_PORT);
      applyEnvSettings();

      // Clear leftover zip-extract temps off the critical path (can readdir a busy OS temp)
      setImmediate(() => {
        try {
          ensureExtractTempDir();
        } catch (_) { /* ignore */ }
        cleanupExtractTempDirectory({ maxAgeMs: 0, includeLegacyOsTempRoot: false }).catch((tempCleanupErr) => {
          console.warn('Extract temp cleanup on startup failed:', tempCleanupErr.message);
        });
      });

      try {
        await startHttpServer(getAppListenPort(), false); // listen on all interfaces
      } catch (err) {
        console.error('Server mode: failed to bind:', err.message);
        process.exit(1);
      }
      setImmediate(() => {
        maybeRenewLetsEncryptCertificate().catch((renewErr) => {
          console.warn('[TLS] Startup renewal skipped:', renewErr.message);
        });
      });
      // Thumbnails render in headless Chromium; STL Home scans run in the server.
      await startThumbnailWorkerBrowser();
      startServerStlHomeScans();
      // Schedule background hash generation for any existing models with missing hashes
      scheduleBackgroundHashGeneration('startup');
      scheduleBackgroundThumbnailCompression('startup');
      setTimeout(() => {
        try {
          verifyDatabaseIntegrity();
        } catch (e) {
          console.error('Deferred database integrity check failed:', e);
        }
      }, 3000);

      startExtensionInboxWatcher();

    } catch (error) {
      console.error('Startup Error: Failed to start application properly:', error);
      app.quit();
    }
  });

  // Add this function to handle app updates
  app.on('ready', () => {
    // Stop listeners and temp files on quit. The database backup happens in will-quit.
    app.on('before-quit', async () => {
      try {
        await stopPort80Server();
      } catch (error) {
        console.error('Error stopping TLS HTTP-01 listener:', error);
      }
      try {
        await cleanupExtractTempDirectory({ maxAgeMs: 0 });
      } catch (error) {
        console.warn('Extract temp cleanup on quit failed:', error.message);
      }
    });
  });
}

// Add this function to initialize the database
function initializeDatabase() {
  try {
    const dbPath = getDatabasePath();
    console.log(`Initializing database at ${dbPath}`);
    
    // Create database directory if it doesn't exist
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    // Initialize database
    database.db = new Database(dbPath);
    
    // Enable foreign keys
    database.db.pragma('foreign_keys = ON');
    
    // Create tables in sequence
    database.db.transaction(() => {
      // Create models table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filePath TEXT UNIQUE,
          fileName TEXT,
          designer TEXT,
          source TEXT,
          notes TEXT,
          printed INTEGER,
          print_status TEXT DEFAULT 'unprinted',
          print_count INTEGER DEFAULT 0,
          last_printed_at DATETIME,
          thumbnail TEXT,
          parentModel TEXT,
          hash TEXT,
          size INTEGER,
          license TEXT,
          modifiedDate DATETIME,
          dateAdded DATETIME,
          isNew INTEGER DEFAULT 1,
          rating INTEGER DEFAULT 0,
          favorite INTEGER DEFAULT 0,
          bundleKey TEXT,
          bundleLabel TEXT,
          bundleKind TEXT
      )`).run();

      // Create tags table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE
      )`).run();

      // Create model_tags table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS model_tags (
          model_id INTEGER,
          tag_id INTEGER,
          FOREIGN KEY(model_id) REFERENCES models(id),
          FOREIGN KEY(tag_id) REFERENCES tags(id),
          PRIMARY KEY(model_id, tag_id)
      )`).run();
      
      // Create settings table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
      )`).run();
      
      // Create slicers table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS slicers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL
      )`).run();
      
      // Create indexes for better performance
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_filepath ON models(filePath)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_filename ON models(fileName)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_designer ON models(designer)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_tags_tag_id ON model_tags(tag_id)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_tags_model_id ON model_tags(model_id)').run();

      database.db.prepare(`CREATE TABLE IF NOT EXISTS filaments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          vendor TEXT,
          material TEXT,
          color_hex TEXT,
          diameter REAL,
          spoolman_id INTEGER UNIQUE,
          source TEXT NOT NULL DEFAULT 'manual'
      )`).run();
      database.db.prepare(`CREATE TABLE IF NOT EXISTS model_filaments (
          model_id INTEGER,
          filament_id INTEGER,
          FOREIGN KEY(model_id) REFERENCES models(id),
          FOREIGN KEY(filament_id) REFERENCES filaments(id),
          PRIMARY KEY(model_id, filament_id)
      )`).run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_name ON filaments(name)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_spoolman_id ON filaments(spoolman_id)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_filament_id ON model_filaments(filament_id)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_model_id ON model_filaments(model_id)').run();
      
      // Single-column indexes for sorting and filtering
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_size ON models(size)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_modifieddate ON models(modifiedDate)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_license ON models(license)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_parentmodel ON models(parentModel)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_printed ON models(printed)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_hash ON models(hash)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_thumbnail ON models(thumbnail)').run();
      
      // Composite indexes for common query patterns
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_designer_filename ON models(designer, fileName)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_license_modifieddate ON models(license, modifiedDate)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_printed_modifieddate ON models(printed, modifiedDate)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_parentmodel_modifieddate ON models(parentModel, modifiedDate)').run();
    })();
    
    // Migrate existing database: add dateAdded column if it doesn't exist
    // This must run before creating indexes on dateAdded
    migrateDateAddedColumn();
    migrateIsNewColumn();
    migrateRatingFavoriteColumns();
    migrateBundleColumns();
    migratePrintLifecycleColumns();
    clearFailurePlaceholderThumbnails();
    
    // Create index for dateAdded after migration (in case it was just added)
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_dateadded ON models(dateAdded)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_isnew ON models(isNew)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_rating ON models(rating)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_favorite ON models(favorite)').run();
    
    // Clean up any database objects that reference models_old (from old migrations)
    cleanupModelsOldReferences();
    
    // Repair model_tags table to fix any foreign key issues
    repairModelTagsTable();
    
    // Check and create slicers table if it doesn't exist
    ensureSlicersTableExists();
    ensureFilamentsTablesExist();
    ensurePartsTablesExist();
    
    // Initialize default settings
    initializeDefaultSettings();

    // Integrity / orphan cleanup: deferred in app.whenReady so startup is not blocked (see setTimeout there)

    return true;
  } catch (err) {
    console.error('Error initializing database:', err);
    console.error(`Database Error: failed to initialize the database at ${getDatabasePath()}: ${err.message}. Check that the data folder is writable (PUID/PGID).`);
    return false;
  }
}

// Add migration function for dateAdded column
function migrateDateAddedColumn() {
  try {
    console.log('Checking for dateAdded column migration...');
    
    // Check if dateAdded column exists
    const tableInfo = database.db.prepare("PRAGMA table_info(models)").all();
    const hasDateAdded = tableInfo.some(col => col.name === 'dateAdded');
    
    if (!hasDateAdded) {
      console.log('dateAdded column not found. Adding it...');
      
      // Add the column
      database.db.prepare('ALTER TABLE models ADD COLUMN dateAdded DATETIME').run();
      
      // For existing records, set dateAdded = modifiedDate as fallback, or current timestamp if modifiedDate is null
      database.db.prepare(`
        UPDATE models 
        SET dateAdded = COALESCE(modifiedDate, datetime('now'))
        WHERE dateAdded IS NULL
      `).run();
      
      console.log('dateAdded column added and existing records updated');
    } else {
      console.log('dateAdded column already exists');
    }
    
    return true;
  } catch (error) {
    console.error('Error migrating dateAdded column:', error);
    return false;
  }
}

/** Add isNew column for "new until edited" badge; existing rows are not new. */
function migrateIsNewColumn() {
  try {
    console.log('Checking for isNew column migration...');
    const tableInfo = database.db.prepare('PRAGMA table_info(models)').all();
    const hasIsNew = tableInfo.some(col => col.name === 'isNew');
    if (!hasIsNew) {
      console.log('isNew column not found. Adding it...');
      database.db.prepare('ALTER TABLE models ADD COLUMN isNew INTEGER DEFAULT 1').run();
      database.db.prepare('UPDATE models SET isNew = 0').run();
      console.log('isNew column added; existing models marked as not new');
    } else {
      console.log('isNew column already exists');
    }
    return true;
  } catch (error) {
    console.error('Error migrating isNew column:', error);
    return false;
  }
}

/** Add rating (0-5) and favorite (0/1) columns for model engagement. */
function migrateRatingFavoriteColumns() {
  try {
    console.log('Checking for rating/favorite column migration...');
    const tableInfo = database.db.prepare('PRAGMA table_info(models)').all();
    const hasRating = tableInfo.some(col => col.name === 'rating');
    const hasFavorite = tableInfo.some(col => col.name === 'favorite');
    if (!hasRating) {
      console.log('rating column not found. Adding it...');
      database.db.prepare('ALTER TABLE models ADD COLUMN rating INTEGER DEFAULT 0').run();
      database.db.prepare('UPDATE models SET rating = 0 WHERE rating IS NULL').run();
    }
    if (!hasFavorite) {
      console.log('favorite column not found. Adding it...');
      database.db.prepare('ALTER TABLE models ADD COLUMN favorite INTEGER DEFAULT 0').run();
      database.db.prepare('UPDATE models SET favorite = 0 WHERE favorite IS NULL').run();
    }
    return true;
  } catch (error) {
    console.error('Error migrating rating/favorite columns:', error);
    return false;
  }
}

function migratePrintLifecycleColumns() {
  try {
    printEvents.migratePrintLifecycle(database.db);
    printerManager.ensurePrinterSchema(database.db);
    return true;
  } catch (error) {
    console.error('Error migrating print lifecycle columns:', error);
    return false;
  }
}

/** Zip bundle columns for grouped browsing (folder siblings are not bundled). */
function migrateBundleColumns() {
  try {
    console.log('Checking for bundle column migration...');
    const tableInfo = database.db.prepare('PRAGMA table_info(models)').all();
    const names = new Set(tableInfo.map((col) => col.name));
    const additions = [
      ['bundleKey', 'TEXT'],
      ['bundleLabel', 'TEXT'],
      ['bundleKind', 'TEXT'],
    ];
    for (const [col, ddl] of additions) {
      if (!names.has(col)) {
        database.db.prepare(`ALTER TABLE models ADD COLUMN ${col} ${ddl}`).run();
        console.log(`Added models.${col}`);
      }
    }
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_bundlekey ON models(bundleKey)').run();

    // After the one-shot zip-only migration, skip the heavy folder-clear + backfill work.
    // New scans/saves already persist bundle fields; remaining NULL keys are intentional for non-zips.
    const migrationDone = database.db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get('bundleMigrationZipOnlyComplete')?.value;
    if (migrationDone === '1') {
      return true;
    }

    // Clear legacy folder bundles — only ZIP archives should group via bundle fields.
    const cleared = database.db.prepare(`
      UPDATE models
      SET bundleKey = NULL, bundleLabel = NULL, bundleKind = NULL
      WHERE bundleKind = 'folder'
         OR (bundleKey IS NOT NULL AND lower(bundleKey) LIKE 'folder:%')
    `).run();
    if (cleared.changes > 0) {
      console.log(`Cleared folder bundle fields for ${cleared.changes} model(s)`);
    }

    // Only backfill zip entries still missing keys. Non-zip models correctly stay NULL;
    // selecting all NULL rows re-wrote the whole library on every cold start.
    const rows = database.db.prepare(`
      SELECT id, filePath FROM models
      WHERE (bundleKey IS NULL OR bundleKey = '')
        AND instr(filePath, '::') > 0
        AND filePath NOT LIKE 'url::%'
    `).all();
    if (rows.length > 0) {
      const update = database.db.prepare(
        'UPDATE models SET bundleKey = ?, bundleLabel = ?, bundleKind = ? WHERE id = ?'
      );
      const backfill = database.db.transaction(() => {
        for (const row of rows) {
          const bundle = deriveBundleFromFilePath(row.filePath);
          if (!bundle.bundleKey) continue;
          update.run(bundle.bundleKey, bundle.bundleLabel || null, bundle.bundleKind || null, row.id);
        }
      });
      backfill();
      console.log(`Backfilled bundle fields for ${rows.length} zip model(s)`);
    }

    database.db.prepare(
      `INSERT INTO settings (key, value) VALUES ('bundleMigrationZipOnlyComplete', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    return true;
  } catch (error) {
    console.error('Error migrating bundle columns:', error);
    return false;
  }
}

/**
 * One-shot: clear tiny data-URL thumbs left by Docker/server load failures.
 * Failure placeholders (typed "STL" / "Model may be corrupted") are ~2–8KB data URLs;
 * real WebGL renders are almost always larger. Resetting to 3d.png clears hasThumbnail
 * so the grid can regenerate.
 */
function clearFailurePlaceholderThumbnails() {
  try {
    const done = database.db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get('failurePlaceholderThumbCleanupComplete')?.value;
    if (done === '1') return true;

    console.log('Clearing likely failure-placeholder thumbnails (one-shot)...');
    const cleared = database.db.prepare(`
      UPDATE models
      SET thumbnail = '3d.png'
      WHERE thumbnail IS NOT NULL
        AND thumbnail LIKE 'data:image%'
        AND length(thumbnail) < 12000
    `).run();
    if (cleared.changes > 0) {
      console.log(`Reset ${cleared.changes} small data-URL thumbnail(s) to 3d.png for regeneration`);
    }

    database.db.prepare(
      `INSERT INTO settings (key, value) VALUES ('failurePlaceholderThumbCleanupComplete', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    return true;
  } catch (error) {
    console.error('Error clearing failure-placeholder thumbnails:', error);
    return false;
  }
}

function normalizeModelRating(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 5) return 5;
  return n;
}

// Add this function to clean up any database objects referencing models_old
function cleanupModelsOldReferences() {
  try {
    console.log('Checking for database objects referencing models_old...');
    
    // Check for triggers that reference models_old
    const triggers = database.db.prepare(`
      SELECT name, sql 
      FROM sqlite_master 
      WHERE type='trigger' 
      AND (sql LIKE '%models_old%' OR sql LIKE '%modelsOld%')
    `).all();
    
    if (triggers.length > 0) {
      console.log(`Found ${triggers.length} trigger(s) referencing models_old. Removing them...`);
      for (const trigger of triggers) {
        try {
          database.db.prepare(`DROP TRIGGER IF EXISTS ${trigger.name}`).run();
          console.log(`Removed trigger: ${trigger.name}`);
        } catch (error) {
          console.error(`Error removing trigger ${trigger.name}:`, error);
        }
      }
    }
    
    // Check for views that reference models_old
    const views = database.db.prepare(`
      SELECT name, sql 
      FROM sqlite_master 
      WHERE type='view' 
      AND (sql LIKE '%models_old%' OR sql LIKE '%modelsOld%')
    `).all();
    
    if (views.length > 0) {
      console.log(`Found ${views.length} view(s) referencing models_old. Removing them...`);
      for (const view of views) {
        try {
          database.db.prepare(`DROP VIEW IF EXISTS ${view.name}`).run();
          console.log(`Removed view: ${view.name}`);
        } catch (error) {
          console.error(`Error removing view ${view.name}:`, error);
        }
      }
    }
    
    // Check for indexes that reference models_old (unlikely but possible)
    const indexes = database.db.prepare(`
      SELECT name 
      FROM sqlite_master 
      WHERE type='index' 
      AND name LIKE '%models_old%'
    `).all();
    
    if (indexes.length > 0) {
      console.log(`Found ${indexes.length} index(es) referencing models_old. Removing them...`);
      for (const index of indexes) {
        try {
          database.db.prepare(`DROP INDEX IF EXISTS ${index.name}`).run();
          console.log(`Removed index: ${index.name}`);
        } catch (error) {
          console.error(`Error removing index ${index.name}:`, error);
        }
      }
    }
    
    console.log('Finished cleaning up models_old references');
    return true;
  } catch (error) {
    console.error('Error cleaning up models_old references:', error);
    return false;
  }
}

function repairModelTagsTable() {
  try {
    return repairModelTags(database.db).ok;
  } catch (error) {
    console.error('Error repairing model_tags table:', error);
    return false;
  }
}

// Add this function after repairModelTagsTable
function initializeDefaultSettings() {
  try {
    console.log('Initializing default settings...');
    
    // Check if settings table exists
    const tableExists = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!tableExists) {
      database.db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    }

    // Define default settings
    const defaultSettings = [
      { key: 'tosAcceptedDate', value: null },
      { key: 'theme', value: 'light' },
      { key: 'apiKey', value: null },
      { key: 'aiModel', value: 'gpt-5-nano' },
      { key: 'maxThumbnailSize', value: '300' },
      { key: 'maxConcurrentRenders', value: '3' },
      { key: 'lastVersionCheck', value: new Date().toISOString() },
      { key: 'currentVersion', value: version }, // Use imported version from package.json
      { key: 'versionCheckPerformedOnStartup', value: 'false' }, // New setting for version check tracking
      { key: 'autoUpdateCheck', value: '1' }, // '0' turns off the automatic version check
      { key: 'enableZipArchives', value: '0' }, // ZIP archive support disabled by default
      { key: 'scanAdditionalFileTypes', value: '[]' }, // JSON array of catalog ids for additional scan types (e.g. ["obj","step"])
      { key: 'scanExcludeFolders', value: '' }, // Extra folder names to skip while scanning, one per line
      { key: 'stlHomeDirectories', value: '[]' }, // JSON array of directories scanned as STL Home
      { key: 'stlHomeExcludeDirectories', value: '[]' }, // JSON array of directories skipped by STL Home scans
      { key: 'aiTagFolderLevels', value: '2' }, // Parent folders sent to AI tagging and used by Tag from Folder
      { key: 'autoTagFromFolderOnScan', value: '0' }, // Add folder-name tags to files a scan newly inserts. No AI.
      { key: 'aiTagMaxTags', value: '10' }, // Maximum number of AI-generated tags
      { key: 'aiTagUseCategories', value: '0' }, // Use category-based tagging
      { key: 'aiTagMergeStrategy', value: 'merge' }, // How to merge AI tags: 'replace', 'merge', 'append'
      { key: 'aiTagAllowRetagging', value: '0' }, // Allow re-tagging even if "AI Tagged" exists
      { key: 'aiTagConcurrency', value: '3' }, // Number of concurrent tag generation requests
      { key: 'enableBrowserExtension', value: '0' }, // Legacy: extension no longer starts the local HTTP server
      { key: 'browserExtensionPort', value: '5000' }, // Port for MCP local server (default 5000)
      { key: 'extensionInboxDirectory', value: '' }, // Empty = Downloads/PrintventoryInbox
      { key: 'extensionInboxLastStatus', value: '' },
      { key: 'enableMcpServer', value: '0' }, // MCP listener disabled by default in desktop mode
      { key: 'spoolmanUrl', value: '' },
      { key: 'spoolmanApiToken', value: '' },
      { key: 'tlsMode', value: 'off' },
      { key: 'tlsCertPath', value: '' },
      { key: 'tlsKeyPath', value: '' },
      { key: 'tlsCaPath', value: '' },
      { key: 'tlsDomain', value: '' },
      { key: 'tlsEmail', value: '' },
      { key: 'tlsAgreeTos', value: '0' },
      { key: 'tlsUseStaging', value: '0' },
      { key: 'tlsRedirectHttp', value: '0' },
    ];
    
    // Insert default settings if they don't exist
    const insertStmt = database.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    
    for (const setting of defaultSettings) {
      insertStmt.run(setting.key, setting.value);
    }

    // Usage tracking was removed; drop its settings from older databases.
    database.db.prepare("DELETE FROM settings WHERE key IN ('CollectUsage', 'ClientId')").run();

    console.log('Default settings initialized');
    return true;
  } catch (error) {
    console.error('Error initializing default settings:', error);
    return false;
  }
}



ipcMain.handle('load-directory', async () => {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath');
    return row ? row.value : null;
  } catch (error) {
    console.error('Error loading directory:', error);
    throw error;
  }
});

ipcMain.handle('save-directory', async (event, directoryPath) => {
  try {
    database.db.prepare(`
      INSERT INTO settings (key, value) 
      VALUES (?, ?) 
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('directoryPath', directoryPath);
    return true;
  } catch (error) {
    console.error('Error saving directory:', error);
    throw error;
  }
});

ipcMain.handle('open-file-dialog', async (event) => {
  // Test mode: use fixed path so Playwright/Cline can run scan without native dialog (desktop: C:\temp, server/docker: /test)
  const testPath = process.env.PRINTVENTORY_TEST_SCAN_PATH;
  if (testPath && typeof testPath === 'string') {
    return [testPath];
  }
  const folder = await askForFolder(event, { title: 'Scan Directory' });
  return folder ? [folder] : null;
});

// Update the calculateFileHash function to be more robust and handle zip entries
async function calculateFileHash(filePath) {
  // Check if this is a zip entry
  const pathInfo = parseZipPath(filePath);

  if (pathInfo.isZipEntry) {
    // Hash zip entries from the extracted buffer — avoids temp files and extra I/O.
    try {
      const zipPath = resolveReadableDiskPath(pathInfo.zipPath) || pathInfo.zipPath;
      const entryData = await extractZipEntryBuffer(zipPath, pathInfo.entryPath);
      const fileHash = crypto.createHash('md5').update(entryData).digest('hex');
      debugLog(`Generated hash for ${filePath}: ${fileHash}`);
      return fileHash;
    } catch (error) {
      console.error(`Error extracting zip entry for hashing: ${filePath}`, error);
      throw new Error(`Failed to extract zip entry for hashing: ${error.message}`);
    }
  }

  const actualFilePath = resolveReadableDiskPath(filePath) || filePath;

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(actualFilePath);

    stream.on('error', err => {
      console.error(`Error reading file for hashing: ${actualFilePath}`, err);
      reject(err);
    });

    stream.on('data', chunk => {
      try {
        hash.update(chunk);
      } catch (err) {
        console.error(`Error updating hash for file: ${actualFilePath}`, err);
        reject(err);
      }
    });

    stream.on('end', () => {
      try {
        const fileHash = hash.digest('hex');
        debugLog(`Generated hash for ${filePath}: ${fileHash}`);
        resolve(fileHash);
      } catch (err) {
        console.error(`Error generating final hash for file: ${filePath}`, err);
        reject(err);
      }
    });
  });
}

// Update the isValidFile function to get the max file size from settings
async function getMaxFileSize() {
  try {
    const maxFileSize = await database.db.prepare('SELECT value FROM settings WHERE key = ?').get('maxFileSizeMB');
    return maxFileSize ? parseInt(maxFileSize.value) * 1024 * 1024 : 50 * 1024 * 1024;
  } catch (error) {
    console.error('Error getting max file size:', error);
    return 50 * 1024 * 1024; // Default to 50MB if there's an error
  }
}

// Add this helper function
function normalizePath(filepath) {
  return filepath.replace(/\\/g, '/');
}

// Match library paths against a scanned directory prefix. Stored paths often use '\' on Windows while
// scan roots are normalized with forward slashes; naive LIKE would fail to pair them.
function directoryScanPrefixSqlParam(scanDirectoryPath) {
  return normalizePath(scanDirectoryPath).replace(/\/$/, '').toLowerCase() + '%';
}

// Apply path-based metadata for STL Home scan: segments from root (From Root) or from model up (From Model).
// Only sets designer/parentModel when current value is empty. Uses pathMetadataStlHomeEnabled, pathMetadataStlHomeDirection,
// pathMetadataUseDesigner, pathMetadataUseParentModel, pathMetadataDesignerIndex, pathMetadataParentModelIndex.
function applyPathMetadataFromSegments(scanRootPath, filePaths) {
  if (!database.db || !database.db.prepare) return;
  const enabledRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataStlHomeEnabled');
  if (!enabledRow || enabledRow.value !== '1') return;
  const directionRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataStlHomeDirection');
  const fromRoot = directionRow?.value === 'fromRoot';
  const useDesigner = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataUseDesigner');
  const useParentModel = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataUseParentModel');
  const designerIndexRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataDesignerIndex');
  const parentModelIndexRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataParentModelIndex');
  const applyDesigner = useDesigner?.value === '1';
  const applyParentModel = useParentModel?.value === '1';
  if (!applyDesigner && !applyParentModel) return;
  const rawDesigner = parseInt(designerIndexRow?.value, 10);
  const rawParent = parseInt(parentModelIndexRow?.value, 10);
  const designerIndex = Math.max(0, Number.isInteger(rawDesigner) ? rawDesigner : 0);
  const parentModelIndex = Math.max(0, Number.isInteger(rawParent) ? rawParent : 0);
  const getModel = database.db.prepare('SELECT id, designer, parentModel FROM models WHERE filePath = ?');
  const updateModel = database.db.prepare('UPDATE models SET designer = ?, parentModel = ? WHERE id = ?');
  const normalizedRoot = normalizePath(scanRootPath).replace(/\/$/, '');
  const rootSegment = normalizedRoot.split('/').filter(Boolean).pop() || '';
  for (const filePath of filePaths) {
    let relativeDir;
    if (filePath.includes('::')) {
      const entryPath = filePath.split('::')[1] || '';
      relativeDir = path.dirname(entryPath);
    } else {
      const normalizedFile = normalizePath(filePath);
      const relative = path.relative(normalizedRoot, normalizedFile);
      relativeDir = path.dirname(relative);
    }
    const segmentsRootToFile = normalizePath(relativeDir).split('/').filter(Boolean);
    // From Root: level 0 = STL Home, 1 = first folder under it, ... From Model: level 0 = parent of file, 1 = grandparent, ...
    const segments = fromRoot ? [rootSegment, ...segmentsRootToFile] : segmentsRootToFile.slice().reverse();
    const derivedDesigner = applyDesigner && segments.length > designerIndex ? segments[designerIndex] : null;
    const derivedParentModel = applyParentModel && segments.length > parentModelIndex ? segments[parentModelIndex] : null;
    const model = getModel.get(filePath);
    if (!model) continue;
    const currentDesigner = model.designer == null || String(model.designer).trim() === '' ? null : model.designer;
    const currentParentModel = model.parentModel == null || String(model.parentModel).trim() === '' ? null : model.parentModel;
    const newDesigner = (currentDesigner == null && derivedDesigner) ? derivedDesigner : currentDesigner;
    const newParentModel = (currentParentModel == null && derivedParentModel) ? derivedParentModel : currentParentModel;
    if (newDesigner !== currentDesigner || newParentModel !== currentParentModel) {
      updateModel.run(newDesigner || null, newParentModel || null, model.id);
    }
  }
}

// Helper function to check if a zip entry exists
async function checkZipEntryExists(zipPath, entryPath) {
  try {
    if (!fs.existsSync(zipPath)) {
      return false;
    }
    return await withZipFileLock(zipPath, async () => {
      const StreamZip = require('node-stream-zip');
      const zip = new StreamZip.async({ file: zipPath });
      try {
        const entries = await zip.entries();
        return findZipEntry(entries, entryPath) != null;
      } finally {
        await zip.close();
      }
    });
  } catch (error) {
    console.error(`Error checking zip entry existence for ${zipPath}::${entryPath}:`, error);
    return false;
  }
}

// Update the removeNonExistentFiles function
async function removeNonExistentFiles(scanDirectoryPath, window = null, excludeDirectories = null) {
  try {
    const excluded = compileExcludeDirs(excludeDirectories, scanDirectoryPath);
    // OPTIMIZATION: Only query models in the scanned directory using SQL instead of loading all models
    // This dramatically reduces memory usage and improves performance, especially for large databases
    const prefixParam = directoryScanPrefixSqlParam(scanDirectoryPath);

    // Query only models under this directory: unify '\' and '/' so LIKE sees the same prefix as scanDirectoryPath.
    const modelsInDirectory = database.db.prepare(`
      SELECT filePath, id FROM models
      WHERE REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?
    `).all(prefixParam);
    
    if (modelsInDirectory.length === 0) {
      return 0; // No models in this directory, nothing to check
    }
    
    const filesToDelete = [];
    const scanExcludeNames = getScanExcludeNames();
    
    // OPTIMIZATION: Batch file existence checks with concurrency limit
    // This prevents overwhelming the file system, especially in Docker/network share scenarios
    // Sequential checks were causing massive slowdowns (10-100ms per file in Docker)
    const MAX_CONCURRENT_CHECKS = 20; // Limit concurrent file system operations
    const checkPromises = [];
    
    for (let i = 0; i < modelsInDirectory.length; i += MAX_CONCURRENT_CHECKS) {
      const batch = modelsInDirectory.slice(i, i + MAX_CONCURRENT_CHECKS);
      const batchPromises = batch.map(async (model) => {
        if (isExcludedPath(model.filePath, excluded)) return;
        if (isSkippedLibraryPath(model.filePath, scanExcludeNames)) {
          filesToDelete.push({
            filePath: model.filePath,
            id: model.id,
            reason: 'skipped'
          });
          return;
        }
        const pathInfo = parseZipPath(model.filePath);
        let fileExists = false;
        
        if (pathInfo.isZipEntry) {
          // For zip entries, check if the zip file exists and the entry exists within it
          try {
            fileExists = await checkZipEntryExists(pathInfo.zipPath, pathInfo.entryPath);
          } catch (error) {
            console.error(`Error checking zip entry ${model.filePath}:`, error);
            fileExists = false;
          }
        } else {
          // For regular files, check if the file exists
          try {
            // First try the path as stored
            try {
              await fs.promises.access(model.filePath, fs.constants.F_OK);
              fileExists = true;
            } catch (accessError) {
              // If access fails, try normalizing the path (handles forward/backslash issues)
              const normalizedPath = path.normalize(model.filePath);
              if (normalizedPath !== model.filePath) {
                try {
                  await fs.promises.access(normalizedPath, fs.constants.F_OK);
                  fileExists = true;
                } catch (normalizedError) {
                  fileExists = false;
                }
              } else {
                fileExists = false;
              }
            }
          } catch (error) {
            console.error(`Error checking file existence for ${model.filePath}:`, error);
            fileExists = false;
          }
        }
        
        if (!fileExists) {
          debugLog(`File marked as non-existent: ${model.filePath}`);
          filesToDelete.push({
            filePath: model.filePath,
            id: model.id,
            reason: 'missing'
          });
        }
      });
      
      // Wait for this batch to complete before starting the next batch
      await Promise.all(batchPromises);
    }

    // If there are files to delete, show confirmation dialog
    if (filesToDelete.length > 0) {
      // Auto-remove in server mode - use transaction for better performance
      database.db.transaction(() => {
        deleteModelsByIds(filesToDelete.map((file) => file.id));
      })();
      console.log(`Server mode: Removed ${filesToDelete.length} missing or skipped files from library`);
      return filesToDelete.length; // Return early in server mode to avoid duplicate deletion
    }

    // Proceed with deletion if user confirmed or if there were no files to delete
    const removedCount = database.db.transaction(() => {
      deleteModelsByIds(filesToDelete.map((fileInfo) => fileInfo.id));
      return filesToDelete.length;
    })();

    if (removedCount > 0) {
      console.log(`Removed ${removedCount} non-existent files from directory ${scanDirectoryPath}`);
    }
    
    return removedCount;
  } catch (error) {
    console.error('Error removing non-existent files:', error);
    throw error;
  }
}

function readStlHomeExcludeDirectories() {
  try {
    if (!database.db) return [];
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeExcludeDirectories');
    if (!row || !row.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String(entry).trim()).filter(Boolean);
  } catch (error) {
    console.error('Invalid stlHomeExcludeDirectories setting:', error);
    return [];
  }
}

function scanPathIsUnderStlHome(directoryPath) {
  try {
    const homes = readStlHomeDirectories();
    if (!homes.length) return false;
    return isExcludedPath(directoryPath, compileExcludeDirs(homes));
  } catch (_) {
    return false;
  }
}

function stlHomeExcludeDirectoriesForScan(directoryPath, options) {
  const excludes = readStlHomeExcludeDirectories();
  if (!excludes.length) return [];
  if (options && options.isStlHomeScan) return excludes;
  if (scanPathIsUnderStlHome(directoryPath)) return excludes;
  return [];
}

// Update the scan-directory handler to use a more efficient scanning process
async function scanDirectoryHandler(event, directoryPath, options = {}) {
  try {
    // Validate UNC path in server mode
    try {
      validateUncPath(directoryPath, 'scan-directory');
    } catch (validationError) {
      throw new Error(validationError.message);
    }
    
    rememberScannedDirectory(directoryPath);
    debugLog('Starting directory scan:', directoryPath);
    const maxFileSize = await getMaxFileSize();
    const excludeDirectories = stlHomeExcludeDirectoriesForScan(directoryPath, options);
    
    // Read enableZipArchives and scanAdditionalFileTypes from database
    const zipSetting = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
    const enableZipArchives = zipSetting && zipSetting.value === '1';
    let scanExtensions = ['.stl', '.3mf'];
    try {
      const scanTypesSetting = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('scanAdditionalFileTypes');
      if (scanTypesSetting && scanTypesSetting.value) {
        const selectedIds = JSON.parse(scanTypesSetting.value);
        if (Array.isArray(selectedIds)) scanExtensions = getScanExtensions(selectedIds);
      }
    } catch (e) { /* ignore */ }
    
    // First, remove any non-existent files from the scanned directory
    // Pass the window so we can show a confirmation dialog if needed (null in server mode)
    const window = null;
    const removedCount = await removeNonExistentFiles(directoryPath, window, excludeDirectories);
    if (removedCount > 0) {
      event.sender.send('db-cleanup', {
        message: `Removed ${removedCount} non-existent files from directory ${directoryPath}`
      });
    }

    return new Promise((resolve, reject) => {
      // Use scan-worker.js for scanning (supports zip files)
      const workerPath = path.join(__dirname, 'scan-worker.js');

      // Verify the worker file exists before creating the worker
      if (!fs.existsSync(workerPath)) {
        reject(new Error(`scan-worker.js not found at: ${workerPath}`));
        return;
      }
      
      const worker = new Worker(workerPath);

      // Preserve existing hash when scan doesn't provide one (worker sends null to avoid slow scans).
      // Otherwise every scan would overwrite hashes with '' and trigger full hash regeneration on each start.
      const updateExisting = database.db.prepare(`
        UPDATE models 
        SET hash = COALESCE(NULLIF(?, ''), hash),
            size = ?,
            modifiedDate = ?,
            bundleKey = ?,
            bundleLabel = ?,
            bundleKind = ?
        WHERE filePath = ?
      `);

      const insertNew = database.db.prepare(`
        INSERT INTO models (
          filePath, fileName, hash, size, modifiedDate, dateAdded, isNew,
          bundleKey, bundleLabel, bundleKind
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);

      const ingestState = {
        files: [],
        existingFilePaths: new Set(),
        newFilesCount: 0,
        newFilePaths: []
      };
      let ingestChain = Promise.resolve();
      const enqueueIngest = (task) => {
        ingestChain = ingestChain.then(task);
        return ingestChain;
      };

      const fileModifiedIso = (file) => {
        if (file.mtime instanceof Date) return file.mtime.toISOString();
        if (typeof file.mtime === 'string' && file.mtime) return file.mtime;
        return new Date().toISOString();
      };

      const ingestFileBatch = (batch) => enqueueIngest(() => {
        if (!batch || batch.length === 0) return;

        const unknown = [];
        for (const file of batch) {
          if (!ingestState.existingFilePaths.has(file.filePath)) {
            unknown.push(file.filePath);
          }
        }
        const existenceCheckBatchSize = 500;
        for (let i = 0; i < unknown.length; i += existenceCheckBatchSize) {
          const pathBatch = unknown.slice(i, i + existenceCheckBatchSize);
          const placeholders = pathBatch.map(() => '?').join(',');
          const existing = database.db.prepare(`SELECT filePath FROM models WHERE filePath IN (${placeholders})`).all(...pathBatch);
          existing.forEach(row => ingestState.existingFilePaths.add(row.filePath));
        }

        database.db.transaction(() => {
          for (const file of batch) {
            const bundle = deriveBundleFromFilePath(file.filePath);
            const modifiedDate = fileModifiedIso(file);
            if (ingestState.existingFilePaths.has(file.filePath)) {
              updateExisting.run(
                file.hash || '',
                file.size,
                modifiedDate,
                bundle.bundleKey || null,
                bundle.bundleLabel || null,
                bundle.bundleKind || null,
                file.filePath
              );
            } else {
              insertNew.run(
                file.filePath,
                file.fileName,
                file.hash || '',
                file.size,
                modifiedDate,
                new Date().toISOString(),
                bundle.bundleKey || null,
                bundle.bundleLabel || null,
                bundle.bundleKind || null
              );
              ingestState.newFilesCount++;
              ingestState.newFilePaths.push(file.filePath);
              ingestState.existingFilePaths.add(file.filePath);
            }
            ingestState.files.push(file);
          }
        })();

        try {
          event.sender.send('db-progress', {
            total: ingestState.files.length,
            processed: ingestState.files.length
          });
        } catch (_) { /* sender may be gone */ }
      });

      // Set up worker message handling
      worker.on('message', async (message) => {
        if (message.type === 'progress') {
          // Send progress to renderer
          event.sender.send('scan-progress', {
            processed: message.processed
          });
        } else if (message.type === 'batch') {
          ingestFileBatch(message.files);
        } else if (message.type === 'done') {
          try {
            if (Array.isArray(message.result?.files) && message.result.files.length > 0) {
              ingestFileBatch(message.result.files);
            }
            await ingestChain;

            const files = ingestState.files;
            const totalFiles = message.result.totalFiles;
            const newFilesCount = ingestState.newFilesCount;
            const skippedDueToSize = Number(message.result.skippedDueToSize) || 0;
            const allFilePaths = files.map(f => f.filePath);

            worker.terminate();

            // STL Home scan with path metadata: set designer/parent from folder segments (from model level up) when enabled
            if (options.isStlHomeScan && Array.isArray(allFilePaths) && allFilePaths.length > 0) {
              try {
                applyPathMetadataFromSegments(directoryPath, allFilePaths);
              } catch (pathMetaErr) {
                console.error('Path metadata from folder (STL Home):', pathMetaErr);
              }
            }

            if (ingestState.newFilePaths.length > 0) {
              try {
                applyFolderTagsToNewScanFiles(ingestState.newFilePaths);
              } catch (tagErr) {
                console.error('Tag from Folder on newly scanned files:', tagErr);
              }
            }

            resolve({ files, totalFiles, newFilesCount, skippedDueToSize });

            scheduleBackgroundHashGeneration('scan-directory');

            // Send refresh-grid event to update the UI after scanning completes
            // Use setTimeout to ensure the promise resolves first and database is fully updated
            setTimeout(() => {
              if (global.broadcastEvent) {
                global.broadcastEvent('refresh-grid');
              } else {
                event.sender.send('refresh-grid');
              }
            }, 100);
          } catch (error) {
            worker.terminate();
            reject(error);
          }
        } else if (message.type === 'error') {
          worker.terminate();
          reject(new Error(message.error));
        }
      });

      // Handle worker errors
      worker.on('error', (error) => {
        worker.terminate();
        reject(error);
      });

      // Handle worker exit
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      // Start the worker - pass node_modules path so worker can find dependencies
      const nodeModulesPath = path.join(__dirname, 'node_modules');

      worker.postMessage({ 
        directoryPath, 
        maxFileSize, 
        enableZipArchives,
        scanExtensions,
        excludeFolderNames: Array.from(getScanExcludeNames()),
        excludeDirectories,
        nodeModulesPath: nodeModulesPath
      });
    });

  } catch (error) {
    console.error('Error in scan-directory handler:', error);
    throw error;
  }
}
ipcMain.handle('scan-directory', scanDirectoryHandler);
ipcHandlerRegistry.set('scan-directory', scanDirectoryHandler);

ipcMain.handle('get-model', async (event, filePath) => {
  try {
    const model = getModelByFilePath(filePath, { includeThumbnail: true });
    if (!model) return null;

    // Get tags for this model
    const tags = database.db.prepare(`
      SELECT t.name 
      FROM tags t 
      JOIN model_tags mt ON mt.tag_id = t.id 
      WHERE mt.model_id = ?
    `).all(model.id).map(t => t.name);

    const filaments = getFilamentsForModel(model.id);

    // Parse any JSON fields
    return {
      ...model,
      tags: tags || [],
      filaments: filaments || []
    };
  } catch (error) {
    console.error('Error getting model:', error);
    throw error;
  }
});

// Update the save-model handler to not store tags in the models table
ipcMain.handle('save-model', async (event, modelData) => {
  return await saveModel(modelData);
});


ipcMain.handle('save-model-batch', async (event, modelDataBatch) => {
  return await saveModelBatch(modelDataBatch);
});

ipcMain.handle('update-models-batch', async (event, modelDataBatch) => {
  return await updateModelsBatch(modelDataBatch);
});

ipcMain.handle('save-thumbnail', async (event, filePath, thumbnail) => {
  try {
    await saveThumbnail(filePath, thumbnail);
    return true;
  } catch (error) {
    console.error('Error saving thumbnail:', error);
    throw error;
  }
});

ipcMain.handle('get-designers', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT designer FROM models WHERE designer IS NOT NULL AND designer != ''").all();
    return rows.map(row => row.designer);
  } catch (error) {
    console.error('Error getting designers:', error);
    throw error;
  }
});

ipcMain.handle('get-licenses', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT license FROM models WHERE license IS NOT NULL AND license != ''").all();
    return rows.map(row => row.license);
  } catch (error) {
    console.error('Error getting licenses:', error);
    throw error;
  }
});

ipcMain.handle('get-models-by-designer', async (event, designer) => {
  try {
    const rows = database.db.prepare(`
      SELECT id, filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, hash, size, license, modifiedDate, dateAdded, isNew, rating, favorite
      FROM models WHERE designer = ?
    `).all(designer);
    return rows.map((row) => ({
      ...row,
      thumbnail: loadThumbnailForModel(row.filePath)
    }));
  } catch (error) {
    console.error('Error getting models by designer:', error);
    throw error;
  }
});



const getAllModelsHandler = async (event, sortOption, limit = 0) => {
  try {
    // Determine the ORDER BY clause based on sortOption.
    let orderClause = "";
    switch (sortOption) {
      case "name-asc":
        orderClause = "ORDER BY fileName ASC";
        break;
      case "name-desc":
        orderClause = "ORDER BY fileName DESC";
        break;
      case "size-asc":
        orderClause = "ORDER BY size ASC";
        break;
      case "size-desc":
        orderClause = "ORDER BY size DESC";
        break;
      case "date-asc":
        orderClause = "ORDER BY modifiedDate ASC";
        break;
      case "date-desc":
        orderClause = "ORDER BY modifiedDate DESC";
        break;
      case "dateadded-asc":
        orderClause = "ORDER BY dateAdded ASC";
        break;
      case "dateadded-desc":
        orderClause = "ORDER BY dateAdded DESC";
        break;
      case "rating-asc":
        orderClause = "ORDER BY rating ASC, fileName ASC";
        break;
      case "rating-desc":
        orderClause = "ORDER BY rating DESC, fileName ASC";
        break;
      case "printed-asc":
      case "printed-desc":
      case "printstatus-asc":
      case "printstatus-desc":
      case "printcount-asc":
      case "printcount-desc":
      case "lastprinted-asc":
      case "lastprinted-desc":
        orderClause = printEvents.printSortOrderClause(sortOption);
        break;
      default:
        orderClause = "ORDER BY modifiedDate DESC";
        break;
    }

const selectCols = MODEL_LIST_COLUMNS;

    let models;
    if (limit === 0) {
      // When limit is 0, load all models without a limit
      models = database.db.prepare(`SELECT ${selectCols} FROM models ${orderClause}`).all();
    } else {
      models = database.db.prepare(`SELECT ${selectCols} FROM models ${orderClause} LIMIT ?`).all(limit);
    }
    return models;
  } catch (error) {
    console.error("Error in getAllModels IPC:", error);
    return [];
  }
};
ipcMain.handle('get-all-models', getAllModelsHandler);
ipcHandlerRegistry.set('get-all-models', getAllModelsHandler);

/** Normalize filter payload: single string or array of strings */
function normalizeFilterValueList(primaryArr, legacyStr) {
  const out = [];
  if (Array.isArray(primaryArr)) {
    for (const x of primaryArr) {
      if (x != null && String(x).trim() !== '') out.push(String(x).trim());
    }
  }
  if (out.length === 0 && legacyStr != null && String(legacyStr).trim() !== '') {
    out.push(String(legacyStr).trim());
  }
  return out;
}

function normalizeTagNameList(filters) {
  if (Array.isArray(filters.tags) && filters.tags.length) {
    return filters.tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (filters.tag) return [String(filters.tag).trim()].filter(Boolean);
  return [];
}

/** One positive LIKE/EXISTS fragment for a search clause.
 *  filters.searchIncludeNotes false omits notes from field "all" only. Explicit field "notes" always searches notes.
 *  When the flag is absent, the saved searchIncludeNotes setting is used (default on).
 */
function searchIncludeNotesEnabled(filters) {
  if (filters && filters.searchIncludeNotes !== undefined && filters.searchIncludeNotes !== null && filters.searchIncludeNotes !== '') {
    const v = filters.searchIncludeNotes;
    if (v === false || v === 0 || v === '0' || v === 'false') return false;
    return true;
  }
  return getSettingValueOr('searchIncludeNotes', '1') !== '0';
}

function appendAllFieldsSearchSql(params, term, includeNotes) {
  const notesClause = includeNotes ? "LOWER(COALESCE(notes, '')) LIKE ? OR\n          " : '';
  if (includeNotes) {
    params.push(term, term, term, term, term, term, term, term, term, term, term);
  } else {
    params.push(term, term, term, term, term, term, term, term, term, term);
  }
  return `(
          LOWER(COALESCE(fileName, '')) LIKE ? OR 
          LOWER(COALESCE(designer, '')) LIKE ? OR 
          LOWER(COALESCE(parentModel, '')) LIKE ? OR 
          ${notesClause}LOWER(COALESCE(filePath, '')) LIKE ? OR
          LOWER(COALESCE(source, '')) LIKE ? OR
          LOWER(COALESCE(license, '')) LIKE ? OR
          EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND LOWER(t.name) LIKE ?) OR
          EXISTS (SELECT 1 FROM model_filaments mf INNER JOIN filaments f ON f.id = mf.filament_id WHERE mf.model_id = models.id AND (
            LOWER(COALESCE(f.name, '')) LIKE ? OR LOWER(COALESCE(f.vendor, '')) LIKE ? OR LOWER(COALESCE(f.material, '')) LIKE ?
          ))
        )`;
}

function pushSearchClauseFragment(field, rawValue, params, filters) {
  const term = `%${String(rawValue).toLowerCase()}%`;
  switch (field) {
    case 'fileName':
      params.push(term);
      return 'LOWER(COALESCE(fileName, \'\')) LIKE ?';
    case 'designer':
      params.push(term);
      return 'LOWER(COALESCE(designer, \'\')) LIKE ?';
    case 'parentModel':
      params.push(term);
      return 'LOWER(COALESCE(parentModel, \'\')) LIKE ?';
    case 'notes':
      params.push(term);
      return 'LOWER(COALESCE(notes, \'\')) LIKE ?';
    case 'filePath':
      params.push(term);
      return 'LOWER(COALESCE(filePath, \'\')) LIKE ?';
    case 'source':
      params.push(term);
      return 'LOWER(COALESCE(source, \'\')) LIKE ?';
    case 'license':
      params.push(term);
      return 'LOWER(COALESCE(license, \'\')) LIKE ?';
    case 'tag':
      params.push(term);
      return 'EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND LOWER(t.name) LIKE ?)';
    case 'filament':
      params.push(term, term, term);
      return `EXISTS (SELECT 1 FROM model_filaments mf INNER JOIN filaments f ON f.id = mf.filament_id WHERE mf.model_id = models.id AND (
        LOWER(COALESCE(f.name, '')) LIKE ? OR LOWER(COALESCE(f.vendor, '')) LIKE ? OR LOWER(COALESCE(f.material, '')) LIKE ?
      ))`;
    default:
      return appendAllFieldsSearchSql(params, term, searchIncludeNotesEnabled(filters));
  }
}

function sanitizeSearchTokensForCompile(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    if (x.t === 'clause') {
      const val = String(x.value || '').trim();
      if (!val) continue;
      const field = String(x.field || 'all').trim() || 'all';
      out.push({ t: 'clause', field, value: val });
    } else if (x.t === 'op' && (x.op === 'AND' || x.op === 'OR')) {
      out.push({ t: 'op', op: x.op });
    } else if (x.t === 'not') {
      out.push({ t: 'not' });
    } else if (x.t === 'filter') {
      const kind = String(x.kind || '').trim();
      if (!kind || !['designer', 'license', 'parentModel', 'tag', 'filament', 'fileType', 'printed', 'isNew', 'favorite', 'rating', 'ratingMin'].includes(kind)) continue;
      const valRaw = String(x.value != null ? x.value : '').trim();
      if (kind === 'printed') {
        const allowed = ['printed', 'not-printed', 'unprinted', 'want', 'queued', 'printing', 'failed', 'ever-printed', 'never-printed'];
        if (!allowed.includes(valRaw)) continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'isNew') {
        if (valRaw !== 'new' && valRaw !== 'not-new') continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'favorite') {
        if (valRaw !== 'favorited' && valRaw !== 'not-favorited') continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'rating') {
        if (valRaw !== 'unrated' && !/^[1-5]$/.test(valRaw)) continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (kind === 'ratingMin') {
        if (!/^[1-5]$/.test(valRaw)) continue;
        out.push({ t: 'filter', kind, value: valRaw });
      } else if (!valRaw) {
        continue;
      } else {
        const ftNorm = kind === 'fileType' && valRaw.toLowerCase() === 'zip' ? 'zip' : valRaw;
        out.push({ t: 'filter', kind, value: ftNorm });
      }
    } else if (x.t === 'filterMulti') {
      const kind = String(x.kind || '').trim();
      if (!kind || !['designer', 'license', 'parentModel', 'tag', 'filament'].includes(kind)) continue;
      const vals = Array.isArray(x.values) ? x.values.map((v) => String(v).trim()).filter(Boolean) : [];
      if (vals.length === 0) continue;
      const combine = String(x.combine || 'OR').toUpperCase() === 'AND' ? 'AND' : 'OR';
      out.push({ t: 'filterMulti', kind, values: vals, combine });
    }
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    if (a.t === 'op' && b.t === 'op' && a.op === b.op) {
      out.splice(i, 1);
      i--;
    }
  }
  while (out.length && (out[out.length - 1].t === 'op' || out[out.length - 1].t === 'not')) {
    out.pop();
  }
  return out;
}

/** SQL fragment for a sidebar filter serialized into searchTokens ({ t: filter | filterMulti }). */
function compileSidebarFilterClauseToSQL(tok, filters, params) {
  if (tok.t === 'filterMulti') {
    const combine = tok.combine === 'AND' ? 'AND' : 'OR';
    if (tok.kind === 'designer') {
      const cond = [];
      pushEqualityListCondition(cond, params, 'designer', tok.values.slice(), combine, !!filters.designerInverted, true);
      return cond[0] || '1';
    }
    if (tok.kind === 'license') {
      const cond = [];
      pushEqualityListCondition(cond, params, 'license', tok.values.slice(), combine, !!filters.licenseInverted, false);
      return cond[0] || '1';
    }
    if (tok.kind === 'parentModel') {
      const cond = [];
      pushEqualityListCondition(cond, params, 'parentModel', tok.values.slice(), combine, !!filters.parentModelInverted, false);
      return cond[0] || '1';
    }
    if (tok.kind === 'tag') {
      const names = tok.values.slice();
      const f = {
        tags: names,
        tagCombine: combine,
        tagInverted: !!filters.tagInverted,
      };
      const cond = [];
      pushTagListSQL(cond, params, f);
      return cond[0] || '1';
    }
    if (tok.kind === 'filament') {
      const ids = tok.values.slice();
      const f = {
        filaments: ids,
        filamentCombine: combine,
        filamentInverted: !!filters.filamentInverted,
      };
      const cond = [];
      pushFilamentListSQL(cond, params, f);
      return cond[0] || '1';
    }
    return null;
  }
  if (tok.t !== 'filter') return null;
  if (tok.kind === 'designer' || tok.kind === 'license' || tok.kind === 'parentModel') {
    const cond = [];
    const col = tok.kind === 'designer' ? 'designer' : tok.kind === 'license' ? 'license' : 'parentModel';
    const inverted = !!(tok.kind === 'designer' ? filters.designerInverted : tok.kind === 'license' ? filters.licenseInverted : filters.parentModelInverted);
    const useLowerTrim = tok.kind === 'designer';
    pushEqualityListCondition(cond, params, col, [tok.value], 'OR', inverted, useLowerTrim);
    return cond[0] || '1';
  }
  if (tok.kind === 'tag') {
    const f = { tags: [tok.value], tagCombine: 'OR', tagInverted: !!filters.tagInverted };
    const cond = [];
    pushTagListSQL(cond, params, f);
    return cond[0] || '1';
  }
  if (tok.kind === 'filament') {
    const f = { filaments: [tok.value], filamentCombine: 'OR', filamentInverted: !!filters.filamentInverted };
    const cond = [];
    pushFilamentListSQL(cond, params, f);
    return cond[0] || '1';
  }
  if (tok.kind === 'fileType') {
    const ftVal = tok.value;
    if (!ftVal) return null;
    if (ftVal.toLowerCase() === 'zip') {
      params.push('%::%');
      return '(filePath LIKE ?)';
    }
    const exts = getExtensionsForFileTypeFilter(ftVal);
    if (!exts || exts.length === 0) {
      params.push(`%.${String(ftVal).toLowerCase()}`);
      return '(LOWER(fileName) LIKE ?)';
    }
    if (exts.length === 1) {
      params.push(`%${exts[0]}`);
      return '(LOWER(fileName) LIKE ?)';
    }
    const ph = exts.map(() => 'LOWER(fileName) LIKE ?').join(' OR ');
    params.push(...exts.map(ext => `%${ext}`));
    return `(${ph})`;
  }
  if (tok.kind === 'printed') {
    const bound = printEvents.printFilterSqlBound(tok.value);
    if (!bound) return null;
    if (bound.params.length) params.push(...bound.params);
    return bound.sql;
  }
  if (tok.kind === 'isNew') {
    if (tok.value === 'new') return '(isNew = 1)';
    if (tok.value === 'not-new') return '(isNew = 0 OR isNew IS NULL)';
    return null;
  }
  if (tok.kind === 'favorite') {
    if (tok.value === 'favorited') return '(favorite = 1)';
    if (tok.value === 'not-favorited') return '(favorite = 0 OR favorite IS NULL)';
    return null;
  }
  if (tok.kind === 'rating') {
    if (tok.value === 'unrated') return '(rating = 0 OR rating IS NULL)';
    if (/^[1-5]$/.test(tok.value)) {
      params.push(parseInt(tok.value, 10));
      return '(rating = ?)';
    }
    return null;
  }
  if (tok.kind === 'ratingMin') {
    if (/^[1-5]$/.test(tok.value)) {
      params.push(parseInt(tok.value, 10));
      return '(rating >= ?)';
    }
    return null;
  }
  return null;
}

function parseSearchPrimary(tokens, i, params, filters) {
  if (i >= tokens.length) {
    throw new Error('search expression incomplete');
  }
  const tok = tokens[i];
  if (tok.t === 'clause') {
    const frag = pushSearchClauseFragment(tok.field || 'all', tok.value, params, filters);
    return [`(${frag})`, i + 1];
  }
  if (tok.t === 'filter' || tok.t === 'filterMulti') {
    const inner = compileSidebarFilterClauseToSQL(tok, filters, params);
    if (!inner) throw new Error('search expression invalid filter');
    return [`(${inner})`, i + 1];
  }
  throw new Error('search expression expected term');
}

function parseSearchUnary(tokens, i, params, filters) {
  let negate = false;
  let j = i;
  while (j < tokens.length && tokens[j].t === 'not') {
    negate = !negate;
    j++;
  }
  const [inner, k] = parseSearchPrimary(tokens, j, params, filters);
  if (negate) {
    return [`NOT (${inner})`, k];
  }
  return [inner, k];
}

function parseSearchAnd(tokens, i, params, filters) {
  let [left, j] = parseSearchUnary(tokens, i, params, filters);
  while (j < tokens.length && tokens[j].t === 'op' && tokens[j].op === 'AND') {
    j++;
    const [right, k] = parseSearchUnary(tokens, j, params, filters);
    left = `(${left}) AND (${right})`;
    j = k;
  }
  return [left, j];
}

function parseSearchOr(tokens, i, params, filters) {
  let [left, j] = parseSearchAnd(tokens, i, params, filters);
  while (j < tokens.length && tokens[j].t === 'op' && tokens[j].op === 'OR') {
    j++;
    const [right, k] = parseSearchAnd(tokens, j, params, filters);
    left = `(${left}) OR (${right})`;
    j = k;
  }
  return [left, j];
}

function compileSearchTokensToSQL(tokens, params, filters) {
  const t = sanitizeSearchTokensForCompile(tokens);
  if (t.length === 0) return null;
  try {
    const [sql, end] = parseSearchOr(t, 0, params, filters);
    if (end !== t.length) return null;
    return sql;
  } catch (e) {
    console.warn('compileSearchTokensToSQL failed:', e.message);
    return null;
  }
}

/** Multi-value designer / parentModel / license (matches legacy single-value SQL for invert + NULL). */
function pushEqualityListCondition(conditions, params, column, values, combineOp, inverted, useLowerTrim) {
  if (!values.length) return;
  const posJoin = combineOp === 'AND' ? ' AND ' : ' OR ';
  if (!inverted) {
    const posParts = [];
    for (const v of values) {
      if (v === '__none__') {
        posParts.push(`(${column} IS NULL OR ${column} = '')`);
      } else if (useLowerTrim) {
        params.push(v);
        posParts.push(`LOWER(TRIM(${column})) = LOWER(TRIM(?))`);
      } else {
        params.push(v);
        posParts.push(`${column} = ?`);
      }
    }
    conditions.push(posParts.length === 1 ? posParts[0] : `(${posParts.join(posJoin)})`);
    return;
  }
  const negJoin = combineOp === 'OR' ? ' AND ' : ' OR ';
  const negParts = [];
  for (const v of values) {
    if (v === '__none__') {
      negParts.push(`(${column} IS NOT NULL AND ${column} != '')`);
    } else if (useLowerTrim) {
      params.push(v);
      negParts.push(`(${column} IS NULL OR ${column} = '' OR LOWER(TRIM(${column})) != LOWER(TRIM(?)))`);
    } else {
      params.push(v);
      negParts.push(`(${column} IS NULL OR ${column} = '' OR ${column} != ?)`);
    }
  }
  conditions.push(negParts.length === 1 ? negParts[0] : `(${negParts.join(negJoin)})`);
}

function pushTagListSQL(conditions, params, filters) {
  const tagNames = normalizeTagNameList(filters);
  if (!tagNames.length) return false;
  const combine = filters.tagCombine === 'AND' ? 'AND' : 'OR';
  const inverted = !!filters.tagInverted;
  let inner;
  if (combine === 'OR') {
    const ph = tagNames.map(() => '?').join(', ');
    inner = `EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND t.name IN (${ph}))`;
    params.push(...tagNames);
  } else {
    const existsParts = [];
    for (const tn of tagNames) {
      params.push(tn);
      existsParts.push(
        'EXISTS (SELECT 1 FROM model_tags mt INNER JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = models.id AND t.name = ?)'
      );
    }
    inner = `(${existsParts.join(' AND ')})`;
  }
  if (inverted) {
    conditions.push(`NOT (${inner})`);
  } else {
    conditions.push(inner);
  }
  return true;
}

function normalizeFilamentIdList(filters) {
  const raw = [];
  if (Array.isArray(filters?.filaments)) raw.push(...filters.filaments);
  else if (filters?.filament != null && filters.filament !== '') raw.push(filters.filament);
  return raw.map((v) => {
    if (v && typeof v === 'object') return Number(v.id);
    return Number(v);
  }).filter((id) => Number.isInteger(id) && id > 0);
}

function pushFilamentListSQL(conditions, params, filters) {
  const ids = normalizeFilamentIdList(filters);
  if (!ids.length) return false;
  const combine = filters.filamentCombine === 'AND' ? 'AND' : 'OR';
  const inverted = !!filters.filamentInverted;
  let inner;
  if (combine === 'OR') {
    const ph = ids.map(() => '?').join(', ');
    inner = `EXISTS (SELECT 1 FROM model_filaments mf WHERE mf.model_id = models.id AND mf.filament_id IN (${ph}))`;
    params.push(...ids);
  } else {
    const existsParts = [];
    for (const id of ids) {
      params.push(id);
      existsParts.push('EXISTS (SELECT 1 FROM model_filaments mf WHERE mf.model_id = models.id AND mf.filament_id = ?)');
    }
    inner = `(${existsParts.join(' AND ')})`;
  }
  if (inverted) {
    conditions.push(`NOT (${inner})`);
  } else {
    conditions.push(inner);
  }
  return true;
}

function buildModelFilterConditions(filters) {
  const conditions = [];
  const params = [];
  if (!filters || typeof filters !== 'object') {
    return { conditions, params };
  }

  // Designer filter (multi-value + legacy single)
    const designers = normalizeFilterValueList(filters.designers, filters.designer);
    if (designers.length) {
      pushEqualityListCondition(
        conditions,
        params,
        'designer',
        designers,
        filters.designerCombine === 'AND' ? 'AND' : 'OR',
        !!filters.designerInverted,
        true
      );
    }

    // License filter
    const licenses = normalizeFilterValueList(filters.licenses, filters.license);
    if (licenses.length) {
      pushEqualityListCondition(
        conditions,
        params,
        'license',
        licenses,
        filters.licenseCombine === 'AND' ? 'AND' : 'OR',
        !!filters.licenseInverted,
        false
      );
    }

    // Parent model filter
    const parentModels = normalizeFilterValueList(filters.parentModels, filters.parentModel);
    if (parentModels.length) {
      pushEqualityListCondition(
        conditions,
        params,
        'parentModel',
        parentModels,
        filters.parentModelCombine === 'AND' ? 'AND' : 'OR',
        !!filters.parentModelInverted,
        false
      );
    }
    
    // Print status / history filter
    if (filters.printed !== undefined && filters.printed !== 'all') {
      const bound = printEvents.printFilterSqlBound(filters.printed);
      if (bound) {
        conditions.push(bound.sql);
        if (bound.params.length) params.push(...bound.params);
      }
    }

    const normalizedIsNew =
      typeof filters.isNew === 'string' ? filters.isNew.trim().toLowerCase() : filters.isNew;
    if (
      normalizedIsNew !== undefined &&
      normalizedIsNew !== null &&
      normalizedIsNew !== '' &&
      normalizedIsNew !== 'all' &&
      normalizedIsNew !== 'undefined' &&
      normalizedIsNew !== 'null'
    ) {
      if (normalizedIsNew === 'new') {
        conditions.push("isNew = 1");
      } else if (normalizedIsNew === 'not-new') {
        conditions.push("(isNew = 0 OR isNew IS NULL)");
      }
    }

    const normalizedFavorite =
      typeof filters.favorite === 'string' ? filters.favorite.trim().toLowerCase() : filters.favorite;
    if (
      normalizedFavorite !== undefined &&
      normalizedFavorite !== null &&
      normalizedFavorite !== '' &&
      normalizedFavorite !== 'all' &&
      normalizedFavorite !== 'undefined' &&
      normalizedFavorite !== 'null'
    ) {
      if (normalizedFavorite === 'favorited') {
        conditions.push("favorite = 1");
      } else if (normalizedFavorite === 'not-favorited') {
        conditions.push("(favorite = 0 OR favorite IS NULL)");
      }
    }

    const normalizedRating =
      typeof filters.rating === 'string' ? filters.rating.trim().toLowerCase() : filters.rating;
    if (
      normalizedRating !== undefined &&
      normalizedRating !== null &&
      normalizedRating !== '' &&
      normalizedRating !== 'all' &&
      normalizedRating !== 'undefined' &&
      normalizedRating !== 'null'
    ) {
      if (normalizedRating === 'unrated') {
        conditions.push("(rating = 0 OR rating IS NULL)");
      } else if (/^[1-5]$/.test(String(normalizedRating))) {
        conditions.push("rating = ?");
        params.push(parseInt(normalizedRating, 10));
      }
    }

    const normalizedRatingMin =
      typeof filters.ratingMin === 'string' ? filters.ratingMin.trim().toLowerCase() : filters.ratingMin;
    if (
      normalizedRatingMin !== undefined &&
      normalizedRatingMin !== null &&
      normalizedRatingMin !== '' &&
      normalizedRatingMin !== 'all' &&
      normalizedRatingMin !== 'undefined' &&
      normalizedRatingMin !== 'null' &&
      /^[1-5]$/.test(String(normalizedRatingMin))
    ) {
      conditions.push("rating >= ?");
      params.push(parseInt(normalizedRatingMin, 10));
    }
    
    // File type filter
    if (filters.fileType) {
      if (filters.fileType.toLowerCase() === 'zip') {
        // For zip filter, show all models inside ZIP archives (entries with :: separator)
        conditions.push("filePath LIKE ?");
        params.push('%::%');
      } else {
        const exts = getExtensionsForFileTypeFilter(filters.fileType);
        if (exts.length === 1) {
          conditions.push("LOWER(fileName) LIKE ?");
          params.push(`%${exts[0]}`);
        } else {
          conditions.push("(" + exts.map(() => "LOWER(fileName) LIKE ?").join(" OR ") + ")");
          params.push(...exts.map(ext => `%${ext}`));
        }
      }
    }
    
    // Directory filter. Stored zip entries mix separators (`C:\lib\pack.zip::folder/part.stl`),
    // so compare a slash-normalized path instead of two LIKE patterns that each miss half the path.
    if (filters.directory) {
      const directoryPrefix = directoryFilterLikePrefix(filters.directory);
      if (directoryPrefix) {
        conditions.push("REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?");
        params.push(directoryPrefix);
      }
    }
    
    // Search: token expression (AND/OR/NOT), legacy clauses, or single string
    if (Array.isArray(filters.searchTokens) && filters.searchTokens.length) {
      const combined = compileSearchTokensToSQL(filters.searchTokens, params, filters);
      if (combined) {
        if (filters.searchInverted) {
          conditions.push(`NOT (${combined})`);
        } else {
          conditions.push(`(${combined})`);
        }
      }
    } else if (Array.isArray(filters.searchClauses) && filters.searchClauses.length) {
      const op = filters.searchClauseOp === 'OR' ? ' OR ' : ' AND ';
      const parts = [];
      for (const c of filters.searchClauses) {
        const val = c && String(c.value || '').trim();
        if (!val) continue;
        const frag = pushSearchClauseFragment(c.field || 'all', val, params, filters);
        parts.push(`(${frag})`);
      }
      if (parts.length) {
        const combined = parts.join(op);
        if (filters.searchInverted) {
          conditions.push(`NOT (${combined})`);
        } else {
          conditions.push(`(${combined})`);
        }
      }
    } else if (filters.search) {
      const frag = pushSearchClauseFragment('all', filters.search, params, filters);
      if (filters.searchInverted) {
        conditions.push(`NOT (${frag})`);
      } else {
        conditions.push(frag);
      }
    }

    pushTagListSQL(conditions, params, filters);
    pushFilamentListSQL(conditions, params, filters);

    // Date Added filter (filter by dateAdded >= specified date)
    if (filters.dateAdded) {
      conditions.push("dateAdded >= ?");
      params.push(filters.dateAdded);
    }

  return { conditions, params };
}

function sqlAndFilterConditions(conditions) {
  if (!conditions.length) return '';
  return ` AND ${conditions.join(' AND ')}`;
}

const getModelsFilteredHandler = async (event, filters) => {
  try {
    console.log('getModelsFiltered called with filters:', filters);
    console.log('Designer inverted flag:', filters.designerInverted);

    const { conditions, params } = buildModelFilterConditions(filters);

    // Build WHERE clause
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    console.log('WHERE clause built:', whereClause);
    console.log('Conditions:', conditions);
    
    // Determine ORDER BY clause based on sortOption
    let orderClause = "";
    const sortOption = filters.sortOption || 'date-desc';
    switch (sortOption) {
      case "name-asc":
        orderClause = "ORDER BY fileName ASC";
        break;
      case "name-desc":
        orderClause = "ORDER BY fileName DESC";
        break;
      case "size-asc":
        orderClause = "ORDER BY size ASC";
        break;
      case "size-desc":
        orderClause = "ORDER BY size DESC";
        break;
      case "date-asc":
        orderClause = "ORDER BY modifiedDate ASC";
        break;
      case "date-desc":
        orderClause = "ORDER BY modifiedDate DESC";
        break;
      case "dateadded-asc":
        orderClause = "ORDER BY dateAdded ASC";
        break;
      case "dateadded-desc":
        orderClause = "ORDER BY dateAdded DESC";
        break;
      case "printed-asc":
      case "printed-desc":
      case "printstatus-asc":
      case "printstatus-desc":
      case "printcount-asc":
      case "printcount-desc":
      case "lastprinted-asc":
      case "lastprinted-desc":
        orderClause = printEvents.printSortOrderClause(sortOption);
        break;
      case "rating-asc":
        orderClause = "ORDER BY rating ASC, fileName ASC";
        break;
      case "rating-desc":
        orderClause = "ORDER BY rating DESC, fileName ASC";
        break;
      case "designer-asc":
        orderClause = "ORDER BY designer ASC";
        break;
      case "designer-desc":
        orderClause = "ORDER BY designer DESC";
        break;
      case "parentmodel-asc":
        orderClause = "ORDER BY parentModel ASC";
        break;
      case "parentmodel-desc":
        orderClause = "ORDER BY parentModel DESC";
        break;
      case "directory-asc":
        orderClause = "ORDER BY filePath ASC";
        break;
      case "directory-desc":
        orderClause = "ORDER BY filePath DESC";
        break;
      default:
        orderClause = "ORDER BY modifiedDate DESC";
        break;
    }
    
const selectCols = MODEL_LIST_COLUMNS_QUALIFIED;

    // Execute query (optional limit/offset for progressive load when clearing filters in Server/Docker)
    // SQLite requires LIMIT when using OFFSET; use a large limit when only offset is set
    let query = `SELECT ${selectCols} FROM models ${whereClause} ${orderClause}`;
    const limit = filters.limit != null && filters.limit > 0 ? Math.min(Number(filters.limit), 10000) : null;
    const offset = filters.offset != null && filters.offset >= 0 ? Number(filters.offset) : null;
    if (limit != null) {
      query += ` LIMIT ${Math.floor(limit)}`;
      if (offset != null) query += ` OFFSET ${Math.floor(offset)}`;
    } else if (offset != null) {
      query += ` LIMIT 999999 OFFSET ${Math.floor(offset)}`;
    }
    console.log('Executing query:', query);
    console.log('With params:', params);
    
    const models = database.db.prepare(query).all(...params);

    console.log(`Returning ${models.length} filtered models`);
    return models;
  } catch (error) {
    console.error("Error in getModelsFiltered IPC:", error);
    throw error;
  }
};
ipcMain.handle('get-models-filtered', getModelsFilteredHandler);
ipcHandlerRegistry.set('get-models-filtered', getModelsFilteredHandler);

ipcMain.handle('get-parent-models', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT parentModel FROM models WHERE parentModel IS NOT NULL AND parentModel != ''").all();
    return rows.map(row => row.parentModel);
  } catch (error) {
    console.error('Error getting parent models:', error);
    throw error;
  }
});

async function getAllTagsHandler() {
  try {
    return database.db.prepare(`
      SELECT 
        t.id,
        t.name,
        COUNT(DISTINCT mt.model_id) as model_count
      FROM tags t
      LEFT JOIN model_tags mt ON t.id = mt.tag_id
      WHERE t.name != ''
      GROUP BY t.id, t.name
      ORDER BY t.name
    `).all();
  } catch (error) {
    console.error('Error getting tags:', error);
    throw error;
  }
}
ipcMain.handle('get-all-tags', getAllTagsHandler);
ipcHandlerRegistry.set('get-all-tags', getAllTagsHandler);

async function saveTagHandler(event, tagName) {
  try {
    database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName);
    return database.db.prepare('SELECT id, name FROM tags WHERE name = ?').get(tagName);
  } catch (error) {
    console.error('Error saving tag:', error);
    throw error;
  }
}
ipcMain.handle('save-tag', saveTagHandler);
ipcHandlerRegistry.set('save-tag', saveTagHandler);

async function renameTagHandler(event, tagId, newName) {
  try {
    return renameTagForMcp({ id: tagId, newName });
  } catch (error) {
    console.error('Error renaming tag:', error);
    throw error;
  }
}
ipcMain.handle('rename-tag', renameTagHandler);
ipcHandlerRegistry.set('rename-tag', renameTagHandler);

const { deleteFilamentHandler, getAllFilamentsHandler, getFilamentsForModel, saveFilamentHandler, syncSpoolmanFilamentsHandler } = require('./src/server/ipc/filaments');

function normalizeFilamentIds(raw) {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    let id = null;
    if (item && typeof item === 'object') id = Number(item.id);
    else id = Number(item);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function replaceModelFilaments(modelId, filamentIds) {
  database.db.prepare('DELETE FROM model_filaments WHERE model_id = ?').run(modelId);
  if (!filamentIds || filamentIds.length === 0) return;
  const insert = database.db.prepare('INSERT OR IGNORE INTO model_filaments (model_id, filament_id) VALUES (?, ?)');
  const exists = database.db.prepare('SELECT 1 FROM filaments WHERE id = ?');
  for (const id of filamentIds) {
    if (exists.get(id)) insert.run(modelId, id);
  }
}

function deleteModelJunctionRows(modelId) {
  database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);
  database.db.prepare('DELETE FROM model_filaments WHERE model_id = ?').run(modelId);
  printEvents.deletePrintRowsForModel(database.db, modelId);
}

function deleteModelsByIds(modelIds) {
  const ids = [];
  const seen = new Set();
  for (const raw of modelIds || []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return;
  const batchSize = 500;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    printEvents.deletePrintRowsForModels(database.db, batch);
    database.db.prepare(`DELETE FROM model_tags WHERE model_id IN (${placeholders})`).run(...batch);
    database.db.prepare(`DELETE FROM model_filaments WHERE model_id IN (${placeholders})`).run(...batch);
    database.db.prepare(`DELETE FROM models WHERE id IN (${placeholders})`).run(...batch);
  }
}

function deleteModelsByFilePaths(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths.filter((p) => typeof p === 'string' && p) : [];
  const removed = [];
  const found = new Set();
  if (!paths.length) return { removed, missing: [] };
  database.db.transaction(() => {
    const batchSize = 500;
    const ids = [];
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      const rows = database.db.prepare(
        `SELECT id, filePath, fileName FROM models WHERE filePath IN (${placeholders})`
      ).all(...batch);
      for (const row of rows) {
        found.add(row.filePath);
        ids.push(row.id);
        removed.push({ id: row.id, filePath: row.filePath, fileName: row.fileName });
      }
    }
    deleteModelsByIds(ids);
  })();
  return { removed, missing: paths.filter((filePath) => !found.has(filePath)) };
}

function upsertImportedFilament(filament) {
  if (!filament || typeof filament !== 'object') return null;
  const name = String(filament.name || '').trim();
  if (!name) return null;
  const vendor = String(filament.vendor || '').trim() || null;
  const material = String(filament.material || '').trim() || null;
  const colorHex = spoolman.normalizeColorHex(filament.color_hex) || null;
  const diameter = filament.diameter == null || filament.diameter === '' ? null : Number(filament.diameter);
  const spoolmanId = filament.spoolman_id != null && filament.spoolman_id !== '' ? Number(filament.spoolman_id) : null;
  const source = spoolmanId ? 'spoolman' : (filament.source === 'spoolman' ? 'spoolman' : 'manual');

  if (spoolmanId) {
    const existing = database.db.prepare('SELECT id FROM filaments WHERE spoolman_id = ?').get(spoolmanId);
    if (existing) {
      database.db.prepare(`
        UPDATE filaments SET name = ?, vendor = ?, material = ?, color_hex = ?, diameter = ?, source = 'spoolman'
        WHERE id = ?
      `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : null, existing.id);
      return existing.id;
    }
  }

  const existingManual = database.db.prepare(`
    SELECT id FROM filaments
    WHERE name = ?
      AND IFNULL(vendor, '') = IFNULL(?, '')
      AND IFNULL(material, '') = IFNULL(?, '')
      AND IFNULL(color_hex, '') = IFNULL(?, '')
      AND spoolman_id IS NULL
  `).get(name, vendor, material, colorHex);
  if (existingManual) return existingManual.id;

  const result = database.db.prepare(`
    INSERT INTO filaments (name, vendor, material, color_hex, diameter, spoolman_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : null, spoolmanId || null, source);
  return result.lastInsertRowid;
}

require('./src/server/ipc/parts');

require('./src/server/ipc/print-events');

require('./src/server/ipc/printers');

// Add error handling to the getSetting handler
async function getAdditionalFileTypesCatalogHandler() {
  return ADDITIONAL_FILE_TYPES_CATALOG;
}
ipcMain.handle('get-additional-file-types-catalog', getAdditionalFileTypesCatalogHandler);
ipcHandlerRegistry.set('get-additional-file-types-catalog', getAdditionalFileTypesCatalogHandler);

/** Get extensions (e.g. ['.obj']) for catalog ids (e.g. ['obj']). Used to find/remove models by file type. */
function getExtensionsForCatalogIds(catalogIds) {
  if (!catalogIds || !Array.isArray(catalogIds) || catalogIds.length === 0) return [];
  const extSet = new Set();
  for (const id of catalogIds) {
    const entry = ADDITIONAL_FILE_TYPES_CATALOG.find(e => e.id === id);
    if (entry) entry.extensions.forEach(ext => extSet.add(ext));
  }
  return Array.from(extSet);
}

ipcMain.handle('get-model-count-by-file-type-ids', async (event, catalogIds) => {
  try {
    const exts = getExtensionsForCatalogIds(catalogIds);
    if (exts.length === 0) return 0;
    const conditions = exts.map(() => 'LOWER(fileName) LIKE ?').join(' OR ');
    const params = exts.map(ext => `%${ext}`);
    const row = database.db.prepare(`SELECT COUNT(*) AS count FROM models WHERE ${conditions}`).get(...params);
    return row ? row.count : 0;
  } catch (error) {
    console.error('Error getting model count by file type ids:', error);
    throw error;
  }
});

ipcMain.handle('remove-models-by-file-type-ids', async (event, catalogIds) => {
  try {
    const exts = getExtensionsForCatalogIds(catalogIds);
    if (exts.length === 0) return { deleted: 0 };
    const conditions = exts.map(() => 'LOWER(fileName) LIKE ?').join(' OR ');
    const params = exts.map(ext => `%${ext}`);
    const modelRows = database.db.prepare(`SELECT id FROM models WHERE ${conditions}`).all(...params);
    const ids = modelRows.map(r => r.id);
    if (ids.length === 0) return { deleted: 0 };
    const deleted = database.db.transaction(() => {
      deleteModelsByIds(ids);
      return ids.length;
    })();
    return { deleted };
  } catch (error) {
    console.error('Error removing models by file type ids:', error);
    throw error;
  }
});

const getSettingHandler = async (event, key) => {
  try {
    if (SECRET_SETTING_KEYS.has(key)) return null;
    // Values are not logged: some are API keys, and reads happen constantly.
    const result = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return result?.value || null;
  } catch (error) {
    console.error('Error getting setting:', error);
    return null;
  }
};
ipcMain.handle('get-setting', getSettingHandler);
ipcHandlerRegistry.set('get-setting', getSettingHandler);

// Add handler to get app version directly (fallback for server mode)
ipcMain.handle('get-app-version', async () => {
  try {
    return version;
  } catch (error) {
    console.error('Error getting app version:', error);
    return null;
  }
});

// Add error handling to the saveSetting handler
const saveSettingHandler = async (event, key, value) => {
  try {
    if (SECRET_SETTING_KEYS.has(key)) {
      throw new Error(`Setting ${key} can only be changed under Server Access`);
    }
    if (!database.db) {
      console.error('Database not initialized when saving setting');
      return false;
    }
    // Log the key only: values can be API keys.
    database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    console.log('Saved setting:', key);
    return true;
  } catch (error) {
    console.error('Error saving setting:', error);
    return false;
  }
};
ipcMain.handle('save-setting', saveSettingHandler);
ipcHandlerRegistry.set('save-setting', saveSettingHandler);

ipcMain.handle('purge-thumbnails', async () => {
  try {
    database.db.prepare('UPDATE models SET thumbnail = NULL').run();
    return true;
  } catch (error) {
    console.error('Error purging thumbnails:', error);
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Server/Docker: bulk thumbnail jobs run in the hidden Electron window (WebGL),
// so browser-tab focus throttling cannot stall Generate Missing / Regenerate.
// ---------------------------------------------------------------------------
let serverThumbnailJob = {
  status: 'idle', // idle | running
  mode: null,
  cancelRequested: false
};

function broadcastThumbnailJobEvent(channel, payload) {
  if (global.broadcastEvent) {
    global.broadcastEvent(channel, payload);
  }
}

function thumbnailWorkerReady() {
  return !!(thumbnailWorkerWs && thumbnailWorkerWs.readyState === WebSocket.OPEN);
}

function sendToThumbnailWorker(channel, ...args) {
  if (!thumbnailWorkerReady()) throw new Error('Thumbnail worker is not connected yet');
  thumbnailWorkerWs.send(jsonStringifyForWs({ type: 'event', channel, args }));
  return;
}

async function startServerThumbnailJobInternal(mode) {
  if (serverThumbnailJob.status === 'running') {
    return { success: false, error: 'A thumbnail job is already running' };
  }
  if (!thumbnailWorkerReady()) {
    return { success: false, error: 'Server thumbnail worker is not ready' };
  }

  const jobMode = mode === 'all' ? 'all' : 'missing';
  serverThumbnailJob = { status: 'running', mode: jobMode, cancelRequested: false };

  try {
    if (jobMode === 'all') {
      database.db.prepare('UPDATE models SET thumbnail = NULL').run();
    }
    sendToThumbnailWorker('run-server-thumbnail-job', { mode: jobMode });
    broadcastThumbnailJobEvent('thumbnail-job-progress', {
      phase: jobMode === 'all' ? 'Starting regeneration on server...' : 'Starting generation on server...',
      processed: 0,
      total: 0,
      mode: jobMode
    });
    return { success: true, mode: jobMode };
  } catch (error) {
    serverThumbnailJob = { status: 'idle', mode: null, cancelRequested: false };
    console.error('[Server thumbnails] Failed to start job:', error);
    return { success: false, error: error.message || String(error) };
  }
}

ipcMain.handle('start-server-thumbnail-job', async (_event, options) => {
  const mode = options && options.mode === 'all' ? 'all' : 'missing';
  return startServerThumbnailJobInternal(mode);
});

ipcMain.handle('cancel-server-thumbnail-job', async () => {
  if (serverThumbnailJob.status !== 'running') {
    return { success: false, error: 'No thumbnail job running' };
  }
  serverThumbnailJob.cancelRequested = true;
  try {
    sendToThumbnailWorker('cancel-server-thumbnail-job');
  } catch (error) {
    console.warn('[Server thumbnails] Cancel notify failed:', error.message);
  }
  return { success: true };
});

ipcMain.handle('report-server-thumbnail-progress', async (_event, progress) => {
  broadcastThumbnailJobEvent('thumbnail-job-progress', progress || {});
  return true;
});

ipcMain.handle('report-server-thumbnail-complete', async (_event, result) => {
  const info = result || {};
  console.log(`[Server thumbnails] Job ${info.cancelled ? 'cancelled' : 'finished'}: ${Number(info.count) || 0} rendered`);
  serverThumbnailJob = { status: 'idle', mode: null, cancelRequested: false };
  broadcastThumbnailJobEvent('thumbnail-job-complete', result || {});
  if (global.broadcastEvent) {
    global.broadcastEvent('refresh-grid');
  }
  return true;
});

ipcMain.handle('report-server-thumbnail-error', async (_event, errorInfo) => {
  console.error('[Server thumbnails] Job failed:', (errorInfo && errorInfo.message) || 'unknown error');
  serverThumbnailJob = { status: 'idle', mode: null, cancelRequested: false };
  const message = (errorInfo && (errorInfo.message || errorInfo.error)) || String(errorInfo || 'Thumbnail job failed');
  broadcastThumbnailJobEvent('thumbnail-job-error', { error: message });
  return true;
});

ipcMain.handle('get-server-thumbnail-job-status', async () => {
  return {
    status: serverThumbnailJob.status,
    mode: serverThumbnailJob.mode,
    cancelRequested: !!serverThumbnailJob.cancelRequested
  };
});

// Update the shouldSkipDirectory function
function getScanExcludeNames() {
  try {
    if (!database.db) return new Set();
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('scanExcludeFolders');
    return normalizeExcludeNames(row && row.value);
  } catch (_) {
    return new Set();
  }
}

function shouldSkipDirectory(dirName) {
  return shouldSkipDirectoryName(dirName, getScanExcludeNames());
}

function isSkippedLibraryPath(filePath, extraLower) {
  if (!filePath) return false;
  const pathInfo = parseZipPath(filePath);
  const diskPath = pathInfo.isZipEntry ? pathInfo.zipPath : filePath;
  if (shouldSkipEntryPath(diskPath, extraLower)) return true;
  if (pathInfo.isZipEntry && shouldSkipEntryPath(pathInfo.entryPath, extraLower)) return true;
  return false;
}

// Update the scanDirectory function
async function scanDirectory(directoryPath, isValidFile) {
  const files = [];
  let totalFiles = 0;
  let isCancelled = false;

  // Function to check if a directory should be processed
  function shouldProcessDirectory(dirName) {
    return !shouldSkipDirectory(dirName);
  }

  // Process a batch of entries in parallel
  async function processBatch(entries, currentDir) {
    if (isCancelled) return [];

    const batchResults = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          // Skip system directories
          if (!shouldProcessDirectory(entry.name)) {
            debugLog(`Skipping system directory: ${entry.name}`);
            return { files: [], count: 0 };
          }
          
          return await scanRecursive(fullPath);
        } else {
          totalFiles++;
          if (shouldSkipFileName(entry.name)) {
            return { files: [], count: 0 };
          }
          
          try {
            const stats = await fs.promises.stat(fullPath);
            if (isValidFile(entry.name, stats.size)) {
              return { 
                files: [{
                  filePath: fullPath,
                  fileName: entry.name,
                  size: stats.size,
                  mtime: stats.mtime
                }], 
                count: 1 
              };
            }
          } catch (error) {
            console.error(`Error processing file ${fullPath}:`, error);
          }
          return { files: [], count: 0 };
        }
      })
    );
    
    // Combine results from the batch
    return batchResults.reduce(
      (acc, result) => {
        if (result) {
          acc.files.push(...result.files);
          acc.count += result.count;
        }
        return acc;
      },
      { files: [], count: 0 }
    );
  }

  // Scan directory recursively with improved parallelism
  async function scanRecursive(dir) {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      
      // Process in batches of 50 for better performance
      const BATCH_SIZE = 50;
      const results = [];
      
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const batchResult = await processBatch(batch, dir);
        results.push(batchResult);
        
        if (isCancelled) break;
      }
      
      // Combine all batch results
      return results.reduce(
        (acc, result) => {
          acc.files.push(...result.files);
          acc.count += result.count;
          return acc;
        },
        { files: [], count: 0 }
      );
    } catch (error) {
      console.error(`Error reading directory ${dir}:`, error);
      return { files: [], count: 0 };
    }
  }

  // Add a method to cancel the scan
  const cancelScan = () => {
    isCancelled = true;
  };

  // Start the scan
  const result = await scanRecursive(directoryPath);
  files.push(...result.files);
  
  return { files, totalFiles, cancelScan };
}

// Helper functions for managing multiple thumbnails
function parseThumbnails(thumbnailString) {
  if (!thumbnailString || thumbnailString === '3d.png' || !thumbnailString.includes('::')) {
    return [thumbnailString].filter(Boolean);
  }
  return thumbnailString.split('::').filter(Boolean);
}

function getDefaultThumbnail(thumbnailString, defaultIndex = 0) {
  const thumbnails = parseThumbnails(thumbnailString);
  if (thumbnails.length === 0) return null;
  const index = Math.max(0, Math.min(defaultIndex, thumbnails.length - 1));
  return thumbnails[index];
}

/** First stored thumbnail as { base64, mimeType } for AI tagging (handles multi-thumb `::` joins). */
function getThumbnailImagePayload(thumbnailString) {
  const thumb = getDefaultThumbnail(thumbnailString);
  if (!thumb || typeof thumb !== 'string' || !thumb.startsWith('data:image')) {
    return null;
  }
  const commaIndex = thumb.indexOf(',');
  if (commaIndex === -1) return null;
  const header = thumb.slice(0, commaIndex);
  const base64 = thumb.slice(commaIndex + 1).replace(/\s/g, '');
  if (!base64) return null;
  const mimeMatch = header.match(/^data:([^;]+)/i);
  return {
    base64,
    mimeType: (mimeMatch && mimeMatch[1]) || 'image/png'
  };
}

function addThumbnailToModel(thumbnailString, newThumbnail) {
  if (!newThumbnail) return thumbnailString;
  const thumbnails = parseThumbnails(thumbnailString);
  thumbnails.push(newThumbnail);
  return thumbnails.join('::');
}

function setDefaultThumbnailIndex(thumbnailString, index) {
  const thumbnails = parseThumbnails(thumbnailString);
  if (thumbnails.length === 0 || index < 0 || index >= thumbnails.length) {
    return thumbnailString;
  }
  // Move the selected thumbnail to the front (making it the default)
  const selected = thumbnails[index];
  thumbnails.splice(index, 1);
  thumbnails.unshift(selected);
  return thumbnails.join('::');
}

async function saveThumbnail(filePath, thumbnail) {
  try {
    const { value } = compressThumbnailBlob(thumbnail);
    database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(value, filePath);
    return true;
  } catch (error) {
    console.error('Error saving thumbnail:', error);
    throw error;
  }
}









// Update the backup-database handler
ipcMain.handle('backup-database', async () => {
  try {
    const dbPath = getDatabasePath();
    const dbDir = path.dirname(dbPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dbDir, `printventory-backup-${timestamp}.db`);

    if (database.db.open) {
      database.db.close();
    }

    await fs.promises.copyFile(dbPath, backupPath);

    database.db = new Database(dbPath, { 
      verbose: DEBUG ? console.log : null 
    });

    return { success: true, filePath: backupPath };
  } catch (error) {
    console.error('Backup error:', error);
    try {
      const dbPath = getDatabasePath();
      database.db = new Database(dbPath, { 
        verbose: DEBUG ? console.log : null 
      });
    } catch (reopenError) {
      console.error('Error reopening database:', reopenError);
    }
    return { success: false, message: error.message };
  }
});

// Update the restore-database handler
ipcMain.handle('restore-database', async (event, payload = null) => {
  if (payload && payload.base64) {
    try {
      const dbPath = getDatabasePath();
      const buffer = Buffer.from(payload.base64, 'base64');

      if (database.db.open) {
        database.db.close();
      }

      await fs.promises.writeFile(dbPath, buffer);

      database.db = new Database(dbPath, { 
        verbose: DEBUG ? console.log : null 
      });

      return { success: true };
    } catch (error) {
      console.error('Restore error:', error);
      try {
        const dbPath = getDatabasePath();
        database.db = new Database(dbPath, { 
          verbose: DEBUG ? console.log : null 
        });
      } catch (reopenError) {
        console.error('Error reopening database:', reopenError);
      }
      return { success: false, message: error.message };
    }
  }

  return { success: false, message: 'Upload a backup file to restore.' };
});

// Export library handler
function libraryTableExists(name) {
  try {
    return Boolean(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch (_) {
    return false;
  }
}

function libraryColumnExists(table, column) {
  try {
    return database.db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
  } catch (_) {
    return false;
  }
}

function pushGrouped(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildLibraryExportData() {
  const models = database.db.prepare(`
    SELECT id, filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, hash, size, license, modifiedDate, dateAdded, isNew, rating, favorite
    FROM models
  `).all();

  const tagsByModelId = new Map();
  if (libraryTableExists('tags') && libraryTableExists('model_tags')) {
    for (const row of database.db.prepare(`
      SELECT mt.model_id, t.name
      FROM tags t
      JOIN model_tags mt ON mt.tag_id = t.id
    `).all()) {
      pushGrouped(tagsByModelId, row.model_id, row.name);
    }
  }

  const filamentsByModelId = new Map();
  if (libraryTableExists('filaments') && libraryTableExists('model_filaments')) {
    for (const row of database.db.prepare(`
      SELECT mf.model_id, f.name, f.vendor, f.material, f.color_hex, f.diameter, f.spoolman_id, f.source
      FROM filaments f
      JOIN model_filaments mf ON mf.filament_id = f.id
      ORDER BY f.vendor COLLATE NOCASE, f.name COLLATE NOCASE
    `).all()) {
      pushGrouped(filamentsByModelId, row.model_id, {
        name: row.name,
        vendor: row.vendor,
        material: row.material,
        color_hex: row.color_hex,
        diameter: row.diameter,
        spoolman_id: row.spoolman_id,
        source: row.source
      });
    }
  }

  const filamentsByEventId = new Map();
  if (libraryTableExists('print_events') && libraryTableExists('print_event_filaments') && libraryTableExists('filaments')) {
    for (const row of database.db.prepare(`
      SELECT pef.event_id, f.name, f.vendor, f.material, f.color_hex, f.diameter, f.spoolman_id, f.source
      FROM filaments f
      JOIN print_event_filaments pef ON pef.filament_id = f.id
      ORDER BY f.vendor COLLATE NOCASE, f.name COLLATE NOCASE
    `).all()) {
      pushGrouped(filamentsByEventId, row.event_id, {
        name: row.name,
        vendor: row.vendor,
        material: row.material,
        color_hex: row.color_hex,
        diameter: row.diameter,
        spoolman_id: row.spoolman_id,
        source: row.source
      });
    }
  }

  const partsByEventId = new Map();
  if (libraryTableExists('print_events') && libraryTableExists('print_event_parts')) {
    const hasPartsCatalog = libraryTableExists('parts');
    for (const row of database.db.prepare(`
      SELECT pep.event_id,
             ${hasPartsCatalog ? 'COALESCE(p.name, pep.name)' : 'pep.name'} AS name,
             ${hasPartsCatalog ? 'p.category' : 'NULL'} AS category,
             ${hasPartsCatalog ? 'p.unit' : 'NULL'} AS unit,
             pep.quantity AS quantity
      FROM print_event_parts pep
      ${hasPartsCatalog ? 'LEFT JOIN parts p ON p.id = pep.part_id' : ''}
      ORDER BY name COLLATE NOCASE
    `).all()) {
      pushGrouped(partsByEventId, row.event_id, {
        name: row.name,
        category: row.category,
        unit: row.unit,
        quantity: row.quantity
      });
    }
  }

  const eventsByModelId = new Map();
  if (libraryTableExists('print_events')) {
    const hasPrinters = libraryTableExists('printers');
    const hasPrinterType = hasPrinters && libraryColumnExists('printers', 'printer_type');
    const hasPrinterId = libraryColumnExists('print_events', 'printer_id');
    const printerSelect = hasPrinters && hasPrinterId
      ? `, pr.nickname AS printer_nickname, pr.manufacturer AS printer_manufacturer, pr.model AS printer_model, ${hasPrinterType ? 'pr.printer_type' : 'NULL'} AS printer_type`
      : ', NULL AS printer_nickname, NULL AS printer_manufacturer, NULL AS printer_model, NULL AS printer_type';
    const printerJoin = hasPrinters && hasPrinterId
      ? 'LEFT JOIN printers pr ON pr.id = pe.printer_id'
      : '';
    for (const row of database.db.prepare(`
      SELECT pe.id, pe.model_id, pe.printed_at, pe.outcome, pe.quantity, pe.notes, pe.created_at
             ${printerSelect}
      FROM print_events pe
      ${printerJoin}
      ORDER BY pe.printed_at DESC, pe.id DESC
    `).all()) {
      pushGrouped(eventsByModelId, row.model_id, {
        printed_at: row.printed_at,
        outcome: row.outcome,
        quantity: row.quantity,
        notes: row.notes,
        created_at: row.created_at,
        printer_nickname: row.printer_nickname || null,
        printer_manufacturer: row.printer_manufacturer || null,
        printer_model: row.printer_model || null,
        printer_type: row.printer_type || null,
        filaments: filamentsByEventId.get(row.id) || [],
        parts: partsByEventId.get(row.id) || []
      });
    }
  }

  const logsByPrinterId = new Map();
  if (libraryTableExists('printer_maintenance_logs')) {
    for (const row of database.db.prepare(`
      SELECT printer_id, maintenance_type, title, description, performed_at, created_at
      FROM printer_maintenance_logs
      ORDER BY performed_at DESC, id DESC
    `).all()) {
      pushGrouped(logsByPrinterId, row.printer_id, {
        maintenance_type: row.maintenance_type,
        title: row.title,
        description: row.description,
        performed_at: row.performed_at,
        created_at: row.created_at
      });
    }
  }

  const remindersByPrinterId = new Map();
  if (libraryTableExists('printer_maintenance_reminders')) {
    const hasLastCompleted = libraryColumnExists('printer_maintenance_reminders', 'last_completed_at');
    for (const row of database.db.prepare(`
      SELECT printer_id, title, maintenance_type, due_date, interval_days, notes, status,
             ${hasLastCompleted ? 'last_completed_at' : 'NULL AS last_completed_at'}, created_at
      FROM printer_maintenance_reminders
      ORDER BY due_date ASC, id ASC
    `).all()) {
      pushGrouped(remindersByPrinterId, row.printer_id, {
        title: row.title,
        maintenance_type: row.maintenance_type,
        due_date: row.due_date,
        interval_days: row.interval_days,
        notes: row.notes,
        status: row.status,
        last_completed_at: row.last_completed_at,
        created_at: row.created_at
      });
    }
  }

  const printers = libraryTableExists('printers')
    ? database.db.prepare(`
        SELECT id, nickname, manufacturer, model, ${libraryColumnExists('printers', 'printer_type') ? 'printer_type' : 'NULL AS printer_type'}, firmware_type, is_klipper, web_url, notes, created_at, updated_at
        FROM printers
        ORDER BY nickname COLLATE NOCASE, id ASC
      `).all().map((row) => ({
        nickname: row.nickname,
        manufacturer: row.manufacturer,
        model: row.model,
        printer_type: row.printer_type || null,
        firmware_type: row.firmware_type,
        is_klipper: row.is_klipper ? 1 : 0,
        web_url: row.web_url,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        maintenanceLogs: logsByPrinterId.get(row.id) || [],
        maintenanceReminders: remindersByPrinterId.get(row.id) || []
      }))
    : [];

  const parts = libraryTableExists('parts')
    ? database.db.prepare(`
        SELECT name, category, quantity, unit, notes, low_stock
        FROM parts
        ORDER BY name COLLATE NOCASE, id ASC
      `).all()
    : [];

  const slicers = libraryTableExists('slicers')
    ? database.db.prepare('SELECT name, path FROM slicers ORDER BY name COLLATE NOCASE, id ASC').all()
    : [];

  return {
    version: '1.0',
    exportDate: new Date().toISOString(),
    printers,
    parts,
    slicers,
    models: models.map((model) => ({
      filePath: model.filePath,
      fileName: model.fileName,
      designer: model.designer,
      source: model.source,
      notes: model.notes,
      printed: model.printed,
      print_status: model.print_status || (model.printed ? 'printed' : 'unprinted'),
      print_count: model.print_count || 0,
      last_printed_at: model.last_printed_at || null,
      parentModel: model.parentModel,
      license: model.license,
      rating: model.rating || 0,
      favorite: model.favorite ? 1 : 0,
      tags: tagsByModelId.get(model.id) || [],
      filaments: filamentsByModelId.get(model.id) || [],
      printEvents: eventsByModelId.get(model.id) || []
    }))
  };
}

ipcMain.handle('export-library', async () => {
  try {
    const exportData = buildLibraryExportData();
    const exportDir = path.dirname(getDatabasePath());
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const exportPath = path.join(exportDir, `printventory-library-${timestamp}.json`);
    await fs.promises.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf8');
    return { success: true, filePath: exportPath };
  } catch (error) {
    console.error('Export library error:', error);
    return { success: false, message: error.message };
  }
});

// Import library handler
ipcMain.handle('import-library', async (event, payload = null) => {
  const importLibraryData = async (importData) => {
    if (!importData.models || !Array.isArray(importData.models)) {
      throw new Error('Invalid library file format: missing models array');
    }

    const totalModels = importData.models.length;
    if (event && event.sender) {
      event.sender.send('show-progress-dialog', {
        title: 'Importing Library',
        message: 'Reading library file...',
        total: totalModels
      });
    }

    let importedCount = 0;
    let updatedCount = 0;

    for (let i = 0; i < importData.models.length; i++) {
      const modelData = importData.models[i];
      try {
        const existingModel = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(modelData.filePath);

        let filamentIds;
        if (Array.isArray(modelData.filaments)) {
          filamentIds = [];
          for (const entry of modelData.filaments) {
            if (entry && typeof entry === 'object') {
              const id = upsertImportedFilament(entry);
              if (id) filamentIds.push(id);
            } else {
              const id = Number(entry);
              if (Number.isInteger(id) && id > 0) filamentIds.push(id);
            }
          }
        }

        await saveModel({
          filePath: modelData.filePath,
          fileName: modelData.fileName,
          designer: modelData.designer || null,
          source: modelData.source || null,
          notes: modelData.notes || null,
          printed: modelData.printed || 0,
          parentModel: modelData.parentModel || null,
          license: modelData.license || null,
          tags: modelData.tags || [],
          ...(filamentIds !== undefined ? { filaments: filamentIds } : {})
        });

        if (existingModel) {
          updatedCount++;
        } else {
          importedCount++;
        }

        if (event && event.sender) {
          event.sender.send('update-progress', {
            current: i + 1,
            total: totalModels,
            message: `Importing model ${i + 1} of ${totalModels}...`
          });
        }
      } catch (modelError) {
        console.error(`Error importing model ${modelData.filePath}:`, modelError);
        if (event && event.sender) {
          event.sender.send('update-progress', {
            current: i + 1,
            total: totalModels,
            message: `Importing model ${i + 1} of ${totalModels}...`
          });
        }
      }
    }

    if (event && event.sender) {
      event.sender.send('close-progress-dialog');
    }

    return { success: true, imported: importedCount, updated: updatedCount };
  };

  if (payload && payload.json) {
    try {
      const importData = JSON.parse(payload.json);
      return await importLibraryData(importData);
    } catch (error) {
      console.error('Import library error:', error);
      if (event && event.sender) {
        event.sender.send('close-progress-dialog');
      }
      return { success: false, message: error.message };
    }
  }
});

// Update these handlers to remove Promise wrappers and use synchronous API

ipcMain.handle('get-duplicate-files', async () => {
  try {
    const models = database.db.prepare(`
      SELECT filePath, hash, size,
        CASE WHEN thumbnail IS NOT NULL AND thumbnail != '' AND thumbnail != '3d.png' THEN 1 ELSE 0 END AS hasThumbnail
      FROM models WHERE hash IS NOT NULL
    `).all();
    
    // Group files by hash
    const duplicates = {};
    for (const model of models) {
      if (!model.hash) continue;
      
      if (!duplicates[model.hash]) {
        duplicates[model.hash] = [];
      }
      duplicates[model.hash].push({
        filePath: model.filePath,
        size: model.size,
        hasThumbnail: model.hasThumbnail === 1
      });
    }
    
    // Filter out unique files
    return Object.fromEntries(
      Object.entries(duplicates).filter(([_, files]) => files.length > 1)
    );
  } catch (error) {
    console.error('Error getting duplicate files:', error);
    throw error;
  }
});

// Add this new handler
ipcMain.handle('check-files-exist', async (_, filePaths) => {
  const results = await Promise.all(filePaths.map(async (path) => {
    if (isUrlModel(path)) {
      return { path, exists: true };
    }
    try {
      await fs.promises.access(path, fs.constants.F_OK);
      return {
        path,
        exists: true
      };
    } catch {
      return {
        path,
        exists: false
      };
    }
  }));
  return results;
});

// Update the trash-file handler with simpler path normalization
ipcMain.handle('trash-file', async (event, filePath) => {
  try {
    // Validate UNC path in server mode (skips URL models)
    try {
      validateUncPath(filePath, 'trash-file');
    } catch (validationError) {
      throw new Error(validationError.message);
    }
  } catch (error) {
    console.error('Error in trash-file handler:', error);
    throw error;
  }
  
  // Simple path normalization - replace all backslashes with forward slashes
  const normalizedPath = filePath.replace(/\\/g, "/");
  console.log('trash-file handler received path:', filePath);
  console.log('Normalized path:', normalizedPath);
  
  try {
    if (!isUrlModel(filePath)) {
      console.log('Attempting trashItem with path:', normalizedPath);
      await shell.trashItem(normalizedPath);
      console.log('trashItem succeeded');
    }
    
    // Remove from database (for both file and URL-only models)
    await new Promise((resolve, reject) => {
      console.log('Deleting from database:', normalizedPath);
      database.db.transaction(() => {
        const model = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(normalizedPath);
        if (model) {
          deleteModelJunctionRows(model.id);
          database.db.prepare('DELETE FROM models WHERE id = ?').run(model.id);
        }
      })();
      resolve();
    });
    
    return true;
  } catch (err) {
    console.error("Error moving file to trash:", err);
    console.error("Error details:", {
      message: err.message,
      code: err.code,
      path: normalizedPath
    });
    return false;
  }
});

// Update or add this handler in main.js
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    // Validate UNC path in server mode
    try {
      validateUncPath(filePath, 'delete-file');
    } catch (validationError) {
      throw new Error(validationError.message);
    }
    
    console.log('main: delete-file handler called with:', filePath);
    const result = await deleteFile(filePath);
    
    // Send refresh-grid event to update the UI after file deletion
    if (result) {
      event.sender.send('refresh-grid');
    }
    
    return result;
  } catch (error) {
    console.error('Error deleting file:', error);
    throw error;
  }
});

// Update the fetch-thangs-page handler
ipcMain.handle('fetch-thangs-page', async (event, url) => {
  try {
    if (!fetch) {
      throw new Error('Fetch not initialized');
    }
    console.log('Fetching Thangs page:', url);
    
    const browser = await puppeteer.launch({
      headless: true
    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Get and log the full HTML source
    const htmlContent = await page.content();
    console.log('Page HTML:', htmlContent);

    // Extract the data
    const data = await page.evaluate(() => {
      // Get model title (which will be the parent model)
      const titleElement = document.querySelector('div[class^="ModelTitle_Text-"]');
      const parentModel = titleElement ? titleElement.textContent.trim() : null;

      // Get designer name
      const designerElement = document.querySelector('a[class^="ModelDesigner_ProfileLink-"]');
      const designer = designerElement ? designerElement.textContent.trim() : null;

      // Get license info - look for license text in the description
      const descriptionElement = document.querySelector('div[class^="ModelDescription_"]');
      const description = descriptionElement ? descriptionElement.textContent.toLowerCase() : '';
      
      let license = 'Unknown';
      if (description.includes('personal use')) {
        license = 'For Personal Use';
      } else if (description.includes('creative commons')) {
        license = 'Creative Commons';
      } else if (description.includes('commercial use')) {
        license = 'Commercial Use Allowed';
      }

      // Log the found elements for debugging
      console.log('Found elements:', {
        titleElement: titleElement?.outerHTML,
        designerElement: designerElement?.outerHTML,
        descriptionElement: descriptionElement?.outerHTML
      });

      return {
        parentModel,
        designer,
        license
      };
    });

    await browser.close();
    console.log('Scraped data:', data);
    
    return data;
  } catch (error) {
    console.error('Error fetching Thangs page:', error);
    throw error;
  }
});

async function deleteTagHandler(event, tagId) {
  try {
    return database.db.transaction(() => {
      // First delete from model_tags (child table)
      database.db.prepare('DELETE FROM model_tags WHERE tag_id = ?').run(tagId);
          
          // Then delete the tag itself
      database.db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
      
      return true;
    })();
  } catch (error) {
    console.error('Error deleting tag:', error);
    throw error;
  }
}
ipcMain.handle('delete-tag', deleteTagHandler);
ipcHandlerRegistry.set('delete-tag', deleteTagHandler);

async function getTagModelCountHandler(event, tagId) {
  return new Promise((resolve, reject) => {
    const row = database.db.prepare('SELECT COUNT(*) as count FROM model_tags WHERE tag_id = ?').get(tagId);
    if (row) {
      resolve(row.count);
    } else {
      reject(new Error('Tag not found'));
    }
  });
}
ipcMain.handle('get-tag-model-count', getTagModelCountHandler);
ipcHandlerRegistry.set('get-tag-model-count', getTagModelCountHandler);

ipcMain.handle('get-all-metadata', async () => {
  try {
    return database.db.prepare(`
      SELECT 'designer' as type, designer as name, COUNT(*) as model_count 
      FROM models 
      WHERE designer IS NOT NULL AND designer != '' 
      GROUP BY designer
      UNION ALL
      SELECT 'parentModel' as type, parentModel as name, COUNT(*) as model_count 
      FROM models 
      WHERE parentModel IS NOT NULL AND parentModel != '' 
      GROUP BY parentModel
      UNION ALL
      SELECT 'license' as type, license as name, COUNT(*) as model_count 
      FROM models 
      WHERE license IS NOT NULL AND license != '' 
      GROUP BY license
      ORDER BY type, name
    `).all();
  } catch (error) {
    console.error('Error getting metadata:', error);
    throw error;
  }
});

ipcMain.handle('get-stats', async () => {
  try {
    // Total model count
    const totalModels = database.db.prepare('SELECT COUNT(*) as count FROM models').get();
    const totalCount = totalModels ? totalModels.count : 0;

    // File type breakdown (count + disk usage)
    const stlStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) LIKE '%.stl'").get();
    const threeMfStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) LIKE '%.3mf'").get();
    const otherStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) NOT LIKE '%.stl' AND LOWER(fileName) NOT LIKE '%.3mf'").get();
    const totalBytesRow = database.db.prepare('SELECT COALESCE(SUM(size), 0) as bytes FROM models').get();
    
    // Archived models (models inside ZIP files)
    const archivedCount = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE filePath LIKE '%::%'").get();
    
    // Models with metadata
    const withDesigner = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE designer IS NOT NULL AND designer != ''").get();
    const withParentModel = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE parentModel IS NOT NULL AND parentModel != ''").get();
    const withLicense = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE license IS NOT NULL AND license != ''").get();
    const withTags = database.db.prepare("SELECT COUNT(DISTINCT model_id) as count FROM model_tags").get();
    
    // Tag statistics
    const totalTags = database.db.prepare('SELECT COUNT(*) as count FROM tags').get();
    const mostUsedTag = database.db.prepare(`
      SELECT t.name, COUNT(mt.model_id) as count 
      FROM tags t 
      JOIN model_tags mt ON t.id = mt.tag_id 
      GROUP BY t.id, t.name 
      ORDER BY count DESC 
      LIMIT 1
    `).get();
    
    // Calculate percentages
    const calculatePercentage = (count) => {
      if (totalCount === 0) return 0;
      return ((count / totalCount) * 100).toFixed(1);
    };

    const stlBytes = stlStats ? stlStats.bytes : 0;
    const threeMfBytes = threeMfStats ? threeMfStats.bytes : 0;
    const otherBytes = otherStats ? otherStats.bytes : 0;
    const totalBytes = totalBytesRow ? totalBytesRow.bytes : 0;
    
    return {
      totalModels: totalCount,
      totalBytes,
      fileTypes: {
        stl: stlStats ? stlStats.count : 0,
        threeMf: threeMfStats ? threeMfStats.count : 0,
        other: otherStats ? otherStats.count : 0,
        stlBytes,
        threeMfBytes,
        otherBytes
      },
      archivedModels: archivedCount ? archivedCount.count : 0,
      percentages: {
        withDesigner: calculatePercentage(withDesigner ? withDesigner.count : 0),
        withParentModel: calculatePercentage(withParentModel ? withParentModel.count : 0),
        withLicense: calculatePercentage(withLicense ? withLicense.count : 0),
        withTags: calculatePercentage(withTags ? withTags.count : 0)
      },
      tags: {
        total: totalTags ? totalTags.count : 0,
        mostUsed: mostUsedTag ? {
          name: mostUsedTag.name,
          count: mostUsedTag.count
        } : null
      }
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    throw error;
  }
});

// System Report: server / Electron-process GPU (client WebGL is detected in the browser)
async function collectServerGpuInfo() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  const glBackend = process.env.PRINTVENTORY_GL_BACKEND
    || (process.argv.includes('--use-angle=swiftshader') ? 'swiftshader'
      : (process.argv.some((a) => a.includes('vulkan') || a === '--use-gl=egl') ? 'nvidia' : 'unknown'));

  const result = {
    available: false,
    serverMode: true,
    glBackend,
    nvidiaVisibleDevices: process.env.NVIDIA_VISIBLE_DEVICES || null,
    nvidiaDriverCapabilities: process.env.NVIDIA_DRIVER_CAPABILITIES || null,
    nvidia: null,
    electronGpuInfo: null,
    featureStatus: null,
    activeRenderer: null,
    usingSwiftShader: glBackend === 'swiftshader',
    warnings: [],
    error: null
  };

  // nvidia-smi (host GPU via nvidia-container-toolkit) — independent of WebGL backend
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 5000, windowsHide: true }
    );
    const gpus = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(',').map((p) => p.trim());
        return {
          index: parts[0] || '',
          name: parts[1] || '',
          driverVersion: parts[2] || '',
          memoryTotalMiB: parts[3] || '',
          memoryUsedMiB: parts[4] || '',
          utilizationPercent: parts[5] || ''
        };
      });
    if (gpus.length) {
      result.nvidia = { available: true, gpus };
      result.available = true;
    } else {
      result.nvidia = { available: false, message: 'nvidia-smi returned no GPUs' };
    }
  } catch (nvidiaErr) {
    result.nvidia = {
      available: false,
      message: nvidiaErr && nvidiaErr.code === 'ENOENT'
        ? 'nvidia-smi not found (no NVIDIA toolkit device mount)'
        : (nvidiaErr.message || String(nvidiaErr))
    };
  }

  if (result.nvidia?.available && result.nvidiaDriverCapabilities) {
    const caps = `,${result.nvidiaDriverCapabilities},`;
    if (!caps.includes(',graphics,') && !caps.includes(',all,')) {
      result.warnings.push(
        "NVIDIA_DRIVER_CAPABILITIES is missing 'graphics' — WebGL cannot use the GPU (need e.g. graphics,compute,utility)."
      );
    }
  }

  // Chromium/Electron GPU process view (what thumbnail WebGL actually sees)
  try {
    if (app.isReady()) {
      const [gpuInfo, featureStatus] = await Promise.all([
        app.getGPUInfo('complete').catch(() => app.getGPUInfo('basic')),
        Promise.resolve().then(() => app.getGPUFeatureStatus())
      ]);
      result.electronGpuInfo = gpuInfo || null;
      result.featureStatus = featureStatus || null;

      const aux = gpuInfo && gpuInfo.auxAttributes ? gpuInfo.auxAttributes : null;
      const glRenderer = (aux && (aux.glRenderer || aux.gl_renderer)) || null;
      const gpuDevice = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice[0] : null;
      const deviceString = gpuDevice
        ? [gpuDevice.vendorString, gpuDevice.deviceString].filter(Boolean).join(' ')
        : null;

      result.activeRenderer = glRenderer || deviceString || null;
      if (result.activeRenderer) result.available = true;

      const rendererLower = String(result.activeRenderer || '').toLowerCase();
      if (rendererLower.includes('swiftshader') || rendererLower.includes('llvmpipe')) {
        result.usingSwiftShader = true;
        if (result.nvidia?.available) {
          result.warnings.push(
            'Host NVIDIA GPU is visible, but Electron WebGL is still on software rendering (SwiftShader/llvmpipe). Check PRINTVENTORY_GL_BACKEND and NVIDIA_DRIVER_CAPABILITIES=graphics.'
          );
        }
      } else if (result.activeRenderer && glBackend === 'nvidia') {
        result.usingSwiftShader = false;
      }
    }
  } catch (electronGpuErr) {
    result.warnings.push(`Electron GPU info unavailable: ${electronGpuErr.message || electronGpuErr}`);
  }

  if (glBackend === 'swiftshader') {
    result.warnings.push(
      'Container is using SwiftShader (CPU WebGL). Set PRINTVENTORY_GPU=nvidia (or auto with a working NVIDIA device) to attempt hardware WebGL.'
    );
  }

  return result;
}

ipcMain.handle('get-gpu-info', async () => {
  try {
    return await collectServerGpuInfo();
  } catch (error) {
    console.error('Error getting GPU info:', error);
    return { available: false, serverMode: true, error: error.message };
  }
});

ipcMain.handle('benchmark-filesystem', async () => {
  try {
    const dbPath = getDatabasePath();
    const dbDir = path.dirname(dbPath);
    const testFilePath = path.join(dbDir, 'benchmark-test.tmp');
    
    const iterations = 10;
    const fileSize = 1024 * 1024; // 1MB test file
    const testData = Buffer.alloc(fileSize, 'A');
    
    // Write benchmark
    const writeStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      await fs.promises.writeFile(testFilePath, testData);
    }
    const writeTime = Date.now() - writeStart;
    const writeSpeed = (iterations * fileSize) / (writeTime / 1000); // bytes per second
    
    // Read benchmark
    const readStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      await fs.promises.readFile(testFilePath);
    }
    const readTime = Date.now() - readStart;
    const readSpeed = (iterations * fileSize) / (readTime / 1000); // bytes per second
    
    // Cleanup
    try {
      await fs.promises.unlink(testFilePath);
    } catch (cleanupError) {
      console.warn('Failed to cleanup benchmark test file:', cleanupError);
    }
    
    return {
      success: true,
      write: {
        time: writeTime,
        speed: writeSpeed,
        speedMBps: (writeSpeed / (1024 * 1024)).toFixed(2)
      },
      read: {
        time: readTime,
        speed: readSpeed,
        speedMBps: (readSpeed / (1024 * 1024)).toFixed(2)
      },
      iterations: iterations,
      fileSize: fileSize
    };
  } catch (error) {
    console.error('Error benchmarking filesystem:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('benchmark-database', async () => {
  try {
    if (!database.db) {
      return { success: false, error: 'Database not initialized' };
    }
    
    const iterations = 100;
    
    // Write benchmark - insert test records
    const insertStmt = database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    const writeStart = Date.now();
    const transaction = database.db.transaction(() => {
      for (let i = 0; i < iterations; i++) {
        insertStmt.run(`benchmark_test_${i}`, `test_value_${i}`);
      }
    });
    transaction();
    const writeTime = Date.now() - writeStart;
    const writeOpsPerSec = (iterations / (writeTime / 1000)).toFixed(2);
    
    // Read benchmark - select test records
    const selectStmt = database.db.prepare('SELECT value FROM settings WHERE key = ?');
    const readStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      selectStmt.get(`benchmark_test_${i}`);
    }
    const readTime = Date.now() - readStart;
    const readOpsPerSec = (iterations / (readTime / 1000)).toFixed(2);
    
    // Cleanup - delete test records
    const deleteStmt = database.db.prepare('DELETE FROM settings WHERE key LIKE ?');
    deleteStmt.run('benchmark_test_%');
    
    return {
      success: true,
      write: {
        time: writeTime,
        operations: iterations,
        opsPerSec: writeOpsPerSec
      },
      read: {
        time: readTime,
        operations: iterations,
        opsPerSec: readOpsPerSec
      }
    };
  } catch (error) {
    console.error('Error benchmarking database:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('rename-metadata', async (event, type, oldName, newName) => {
  try {
    if (!oldName || !newName || oldName.trim() === '' || newName.trim() === '') {
      throw new Error('Name cannot be empty');
    }

    // Validate type
    const validTypes = ['designer', 'parentModel', 'license'];
    if (!validTypes.includes(type)) {
      throw new Error('Invalid metadata type');
    }

    // Check if new name already exists for this type (for merge information)
    const existing = database.db.prepare(`
      SELECT COUNT(*) as count 
      FROM models 
      WHERE ${type} = ? AND ${type} IS NOT NULL AND ${type} != ''
    `).get(newName.trim());
    
    const existingCount = existing ? existing.count : 0;
    const isMerge = existingCount > 0;

    // Update all models with the old name to the new name (merge if new name exists)
    const result = database.db.prepare(`
      UPDATE models 
      SET ${type} = ? 
      WHERE ${type} = ?
    `).run(newName.trim(), oldName.trim());

    return { 
      success: true, 
      updated: result.changes,
      merged: isMerge,
      existingCount: existingCount
    };
  } catch (error) {
    console.error('Error renaming metadata:', error);
    throw error;
  }
});

ipcMain.handle('delete-metadata', async (event, type, name) => {
  try {
    if (!name || name.trim() === '') {
      throw new Error('Name cannot be empty');
    }

    // Validate type
    const validTypes = ['designer', 'parentModel', 'license'];
    if (!validTypes.includes(type)) {
      throw new Error('Invalid metadata type');
    }

    // Set the field to NULL for all models with that value
    const result = database.db.prepare(`
      UPDATE models 
      SET ${type} = NULL 
      WHERE ${type} = ?
    `).run(name.trim());

    return { success: true, updated: result.changes };
  } catch (error) {
    console.error('Error deleting metadata:', error);
    throw error;
  }
});

// Update the purge-models handler
const purgeModelsHandler = async (event, options = {}) => {
  try {
    // Skip native dialog only when user already confirmed in UI (in-app dialog or server/Docker)
    const fromWebSocket = !!(event && event.wsClient);
    const confirmedInDialog = !!(options && options.confirmedInDialog);
    let doPurge = fromWebSocket || confirmedInDialog;

    if (!doPurge) {
      const result = await clientDialogs.messageBox(event, {
        type: 'warning',
        title: 'Purge Models',
        message: 'Are you sure you want to purge all models?',
        detail: 'This will remove all model data from the database. This action cannot be undone.',
        buttons: ['Cancel', 'Purge All Models'],
        defaultId: 0,
        cancelId: 0,
      });
      doPurge = result.response === 1; // User clicked "Purge All Models"
    }

    if (doPurge) {
      // Check if database is open, if not reopen it
      if (!database.db.open) {
        const dbPath = getDatabasePath();
        database.db = new Database(dbPath, {
          verbose: DEBUG ? console.log : null
        });
      }

      try {
        // Execute each statement individually to avoid transaction issues
        // First clear the model_tags table (child table)
        database.db.prepare('DELETE FROM model_tags').run();
        database.db.prepare('DELETE FROM model_filaments').run();

        // Then clear the models table (parent table)
        database.db.prepare('DELETE FROM models').run();

        // Finally clear unused tags
        database.db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM model_tags)').run();

        return true;
      } catch (dbError) {
        console.error('Database error during purge:', dbError);
        throw dbError;
      }
    }
    return false;
  } catch (error) {
    console.error('Error purging models:', error);
    throw error;
  }
};
ipcMain.handle('purge-models', purgeModelsHandler);
ipcHandlerRegistry.set('purge-models', purgeModelsHandler);

const clearNewFlagsHandler = async () => {
  try {
    if (!database.db || !database.db.open) {
      const dbPath = getDatabasePath();
      database.db = new Database(dbPath, {
        verbose: DEBUG ? console.log : null
      });
    }
    const result = database.db.prepare('UPDATE models SET isNew = 0 WHERE isNew = 1').run();
    return { success: true, cleared: result.changes || 0 };
  } catch (error) {
    console.error('Error clearing new flags:', error);
    throw error;
  }
};
ipcMain.handle('clear-new-model-flags', clearNewFlagsHandler);

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
  if (global.broadcastEvent) {
    global.broadcastEvent('preview-bundle-models', payload);
  } else if (event && event.sender) {
    event.sender.send('preview-bundle-models', payload);
  } else {
    throw new Error('Cannot preview bundle: no connection available');
  }
}

function sendPreviewModelEvent(event, filePath) {
  if (global.broadcastEvent) {
    global.broadcastEvent('preview-model', filePath);
  } else if (event && event.sender) {
    event.sender.send('preview-model', filePath);
  } else {
    throw new Error('Cannot preview file: no connection available');
  }
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
    event.sender.send('select-model-by-filepath', filePaths[0]);
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

  // Add "Download" option for server mode at the top
  if (filePaths.length === 1) {
    menuItems.push({
      label: 'Download',
      click: async () => {
        try {
          console.log('Download clicked for file:', filePaths[0]);
          // Send download event to renderer
          // In server mode, use broadcastEvent to send to all WebSocket clients
          if (global.broadcastEvent) {
            console.log('Broadcasting download-model event via WebSocket');
            global.broadcastEvent('download-model', filePaths[0]);
          } else {
            // In normal mode, use event.sender.send
            console.log('Sending download-model event via event.sender');
            event.sender.send('download-model', filePaths[0]);
          }
        } catch (error) {
          console.error('Error triggering download:', error);
          clientDialogs.messageBox(event, {
            type: 'error',
            title: 'Error',
            message: 'Could not download file',
            detail: error.message
          });
        }
      }
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

  // Server mode hands the files to the local helper via printventory://.
  // Desktop mode launches the slicer here, and only for a single selection.
  if (slicers.length > 0 && filePaths.length >= 1 && (true)) {
    const slicerSubmenu = {
      label: 'Open in Slicer',
      submenu: slicers.map(slicer => ({
        label: slicer.name,
        slicerName: slicer.name,
        slicerPath: slicer.path,
        click: async () => {
          try {
            {
              const commandPayload = {
                type: 'open-in-slicer',
                filePaths: filePaths.slice(),
                filePath: filePaths[0],
                slicerName: slicer.name,
                slicerPath: slicer.path,
                downloadToken: getServerAuth().issueDownloadToken(),
                isZipEntry: Boolean(isZipEntry),
                zipPath: isZipEntry && pathInfo ? pathInfo.zipPath : null,
                entryPath: isZipEntry && pathInfo ? pathInfo.entryPath : null
              };
              if (global.broadcastEvent) {
                global.broadcastEvent('execute-client-command', commandPayload);
              } else {
                event.sender.send('execute-client-command', commandPayload);
              }
              return;
            }

            // For hidden Electron window or normal mode, check Docker/Windows path compatibility
            const inDocker = isDockerContainer();
            if (inDocker) {
              // Check if slicer path is a Windows path (starts with drive letter like C:\ or UNC like \\server)
              const hasWindowsDrive = /^[A-Za-z]:[\\/]/.test(slicer.path);
              const hasUncPath = /^\\\\/.test(slicer.path);
              const isWindowsPath = hasWindowsDrive || hasUncPath;
              
              if (isWindowsPath) {
                console.error('[Slicer] Cannot execute Windows slicer in Docker:', slicer.path);
                const errorMessage = `The slicer path "${slicer.path}" is a Windows path, but the application is running in a Docker container (Linux).\n\n` +
                  `In Docker/Server mode, slicer paths must be:\n` +
                  `- Linux executable paths (e.g., /usr/bin/slicer)\n` +
                  `- Paths accessible from within the container\n\n` +
                  `If you need to use a Windows slicer, you must run Printventory in normal mode (not Docker/Server mode).`;

                clientDialogs.messageBox(event, {
                  type: 'warning',
                  title: 'Slicer Path Not Compatible',
                  message: 'Cannot execute Windows executable in Docker container',
                  detail: errorMessage
                });
                return; // Exit early - don't try to execute
              }
            }

            // Execute slicer command (only in normal mode, not server mode)
            const invalidSlicer = invalidSlicerPathError(slicer.path, slicer.name);
            if (invalidSlicer) {
              presentInvalidSlicer(event, invalidSlicer);
              return;
            }

            let modelPath = filePaths[0]; // Use the first file selected

            // If it's a zip entry, extract to OS temp first
            if (isZipEntry && pathInfo) {
              modelPath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
            }

            // Final safety check: if we're in Docker and path looks like Windows, don't execute
            if (inDocker && (/^[A-Za-z]:[\\/]/.test(slicer.path) || /^\\\\/.test(slicer.path))) {
              console.error('[Slicer] Blocked Windows path execution in Docker:', slicer.path);
              throw new Error('Cannot execute Windows executable in Docker container. Please use a Linux-compatible slicer path.');
            }

            await runSlicerWithModelPaths(slicer, [modelPath]);
          } catch (error) {
            console.error('Error slicing model:', error);
            if (error && error.code === 'INVALID_SLICER') {
              presentInvalidSlicer(event, error);
            } else {
              clientDialogs.messageBox(event, {
                type: 'error',
                title: 'Error',
                message: 'Could not slice model',
                detail: error.message
              });
            }
          }
        }
      }))
    };
    menuItems.push(slicerSubmenu);
  }

  menuItems.push({
    label: 'Tag from Folder',
    click: async () => {
      const configuredLevels = clampFolderLevels(getSettings().aiTagFolderLevels);
      const levels = configuredLevels > 0 ? configuredLevels : 1;
      try {
        const result = applyFolderTagsToModels(filePaths, levels);
        if (global.broadcastEvent) {
          global.broadcastEvent('refresh-grid');
        } else if (event.sender && event.sender.send) {
          event.sender.send('refresh-grid');
        }
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
  const aitaggingForMenu = require('./aitagging');

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
          const aitagging = require('./aitagging');
          const settings = getSettings();
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
            if (global.broadcastEvent) {
              // In server mode, use broadcastEvent to send to all WebSocket clients
              console.log('[Generate Tags] Broadcasting start-batch-tag-generation via WebSocket');
              global.broadcastEvent('start-batch-tag-generation', filesToProcess.length, filesToProcess);
            } else if (eventSender && eventSender.send) {
              // Normal mode - use captured sender or clickEvent sender
              console.log('[Generate Tags] Sending start-batch-tag-generation via eventSender.send');
              console.log('[Generate Tags] eventSender details:', {
                hasSend: typeof eventSender.send === 'function',
                isDestroyed: eventSender.isDestroyed ? eventSender.isDestroyed() : 'N/A'
              });
              try {
                eventSender.send('start-batch-tag-generation', filesToProcess.length, filesToProcess);
                console.log('[Generate Tags] Successfully sent start-batch-tag-generation event');
              } catch (sendError) {
                console.error('[Generate Tags] Error sending start-batch-tag-generation event:', sendError);
              }
            } else {
              console.error('[Generate Tags] No valid way to send start-batch-tag-generation event', {
                hasClickEvent: !!clickEvent,
                hasClickEventSender: !!(clickEvent && clickEvent.sender),
                hasCapturedSender: !!sender,
                hasEventSender: !!eventSender,
                hasSend: !!(eventSender && eventSender.send)
              });
            }
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
              if (global.broadcastEvent) {
                // In server mode, use broadcastEvent to send to all WebSocket clients
                console.log('[Generate Tags] Broadcasting start-single-tag-generation via WebSocket');
                global.broadcastEvent('start-single-tag-generation', filesToProcess[0], modelData);
              } else if (eventSender && eventSender.send) {
                // Normal mode - use captured sender or clickEvent sender
                console.log('[Generate Tags] Sending start-single-tag-generation via eventSender.send');
                console.log('[Generate Tags] eventSender details:', {
                  hasSend: typeof eventSender.send === 'function',
                  isDestroyed: eventSender.isDestroyed ? eventSender.isDestroyed() : 'N/A'
                });
                try {
                  eventSender.send('start-single-tag-generation', filesToProcess[0], modelData);
                  console.log('[Generate Tags] Successfully sent start-single-tag-generation event');
                } catch (sendError) {
                  console.error('[Generate Tags] Error sending start-single-tag-generation event:', sendError);
                }
              } else {
                console.error('[Generate Tags] No valid way to send start-single-tag-generation event', {
                  hasClickEvent: !!clickEvent,
                  hasClickEventSender: !!(clickEvent && clickEvent.sender),
                  hasCapturedSender: !!sender,
                  hasEventSender: !!eventSender,
                  hasSend: !!(eventSender && eventSender.send)
                });
              }
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
              if (global.broadcastEvent) {
                global.broadcastEvent('tags-generated', filePath, [], rateLimitSkipMessage);
              } else if (eventSender && eventSender.send) {
                eventSender.send('tags-generated', filePath, [], rateLimitSkipMessage);
              }
              return;
            }
            try {
              // Get the model from the database to access its thumbnail
              const model = getModelByFilePath(filePath, { includeThumbnail: true });
              
              if (!model) {
                console.log(`Model not found in database: ${filePath}, skipping`);
                completed++;
                      // Send empty tags for skipped models so they appear in the review dialog
                      if (global.broadcastEvent) {
                        global.broadcastEvent('tags-generated', filePath, [], null);
                      } else if (eventSender && eventSender.send) {
                        eventSender.send('tags-generated', filePath, [], null);
                      }
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
              // Send empty tags for already-tagged models so they appear in the review dialog
              if (global.broadcastEvent) {
                global.broadcastEvent('tags-generated', filePath, [], null);
              } else if (eventSender && eventSender.send) {
                eventSender.send('tags-generated', filePath, [], null);
              }
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
                    // Send error info with empty tags
                    if (global.broadcastEvent) {
                      global.broadcastEvent('tags-generated', filePath, [], error.message);
                    } else if (eventSender && eventSender.send) {
                      eventSender.send('tags-generated', filePath, [], error.message);
                    }
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
                      // Send error info with empty tags
                      if (global.broadcastEvent) {
                        global.broadcastEvent('tags-generated', filePath, [], error.message);
                      } else if (eventSender && eventSender.send) {
                        eventSender.send('tags-generated', filePath, [], error.message);
                      }
                      completed++;
                      return;
                    }
                  }
                }
              }
              
              // Send the generated tags back to the renderer process
              if (global.broadcastEvent) {
                global.broadcastEvent('tags-generated', filePath, tags, null);
              } else if (eventSender && eventSender.send) {
                eventSender.send('tags-generated', filePath, tags, null);
              }
              
              completed++;
              // Progress is now shown in the review dialog
            } catch (error) {
              console.error(`Unexpected error processing ${filePath}:`, error);
              failureCount++;
              completed++;
              // Check if it's a rate limit error
              if (error.message && error.message.includes('Rate limit')) {
                rateLimitStopped = true;
                // Send error info with empty tags
                if (global.broadcastEvent) {
                  global.broadcastEvent('tags-generated', filePath, [], error.message);
                } else if (eventSender && eventSender.send) {
                  eventSender.send('tags-generated', filePath, [], error.message);
                }
              } else {
                // Send empty tags for failed models so they appear in the review dialog
                if (global.broadcastEvent) {
                  global.broadcastEvent('tags-generated', filePath, []);
                } else if (eventSender && eventSender.send) {
                  eventSender.send('tags-generated', filePath, []);
                }
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
            if (global.broadcastEvent) {
              global.broadcastEvent('batch-tag-generation-complete');
            } else if (eventSender && eventSender.send) {
              eventSender.send('batch-tag-generation-complete');
            }
          }
        } catch (error) {
          console.error('Error generating tags:', error);

          if (filePaths.length > 1) {
            if (global.broadcastEvent) {
              global.broadcastEvent('batch-tag-generation-complete');
            } else if (eventSender && eventSender.send) {
              eventSender.send('batch-tag-generation-complete');
            }
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
          // In server mode: send event to renderer to show file input dialog (pass all paths for multi-edit)
          if (global.broadcastEvent) {
            global.broadcastEvent('add-image-request', filePaths);
          } else {
            event.sender.send('add-image-request', filePaths);
          }
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
        
        // Send event to renderer to show manage thumbnails modal
        if (global.broadcastEvent) {
          global.broadcastEvent('manage-thumbnails-request', filePaths[0]);
        } else {
          event.sender.send('manage-thumbnails-request', filePaths[0]);
        }
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
            if (global.broadcastEvent) {
              global.broadcastEvent('refresh-grid');
            } else {
              event.sender.send('refresh-grid');
            }
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
          if (global.broadcastEvent) {
            global.broadcastEvent('refresh-grid');
          } else {
            event.sender.send('refresh-grid');
          }
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
            entry.clientAction = {
              type: 'open-in-slicer',
              slicerName: subItem.slicerName || subItem.label,
              slicerPath: subItem.slicerPath,
              downloadToken: getServerAuth().issueDownloadToken(),
              filePaths: filePaths
            };
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
// Register in handler registry for direct WebSocket invocation
ipcHandlerRegistry.set('execute-context-menu-action', executeContextMenuActionHandler);

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

// Update the handler name to match the convention
async function getModelTagsHandler(event, modelId) {
  try {
    return database.db.prepare(`
      SELECT t.* 
      FROM tags t 
      JOIN model_tags mt ON mt.tag_id = t.id 
      WHERE mt.model_id = ?
    `).all(modelId);
  } catch (error) {
    console.error('Error getting model tags:', error);
    throw error;
  }
}
ipcMain.handle('get-model-tags', getModelTagsHandler);
ipcHandlerRegistry.set('get-model-tags', getModelTagsHandler);

async function getGroupTagsHandler(event, modelIds) {
  try {
    const ids = (Array.isArray(modelIds) ? modelIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return database.db.prepare(`
      SELECT DISTINCT t.name AS name
      FROM tags t
      JOIN model_tags mt ON mt.tag_id = t.id
      WHERE mt.model_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE
    `).all(...ids).map((row) => row.name).filter(Boolean);
  } catch (error) {
    console.error('Error getting group tags:', error);
    throw error;
  }
}
ipcMain.handle('get-group-tags', getGroupTagsHandler);
ipcHandlerRegistry.set('get-group-tags', getGroupTagsHandler);

// Add these handlers
ipcMain.handle('quitApp', () => {
  app.quit();
});

ipcMain.handle('getSetting', async (event, key) => {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (error) {
    console.error('Error getting setting:', error);
    throw error;
  }
});

ipcMain.handle('saveSetting', async (event, key, value) => {
  try {
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
    return true;
  } catch (error) {
    console.error('Error saving setting:', error);
    throw error;
  }
});

// Browser extension / MCP local HTTP server control (normal mode)
ipcMain.handle('start-extension-server', async (event, port) => {
  return { success: true, running: true, message: 'Server mode already listening' };
});

ipcMain.handle('stop-extension-server', async () => {
  return { success: false, message: 'Not available in server mode' };
});

ipcMain.handle('sync-local-http-server', async (event, port) => {
  return syncLocalHttpServer(port);
});

ipcMain.handle('import-extension-inbox', async () => {
  return runExtensionInboxImport('manual');
});

ipcMain.handle('get-default-extension-inbox-directory', async () => {
  return extensionInbox.defaultInboxDirectory();
});

ipcMain.handle('get-mcp-connection-info', async () => {
  return getMcpConnectionInfo();
});

/** Copy SQLite main + sidecar files (-wal / -shm) when migrating paths. */
function copySqliteDbFiles(srcBase, destBase) {
  fs.copyFileSync(srcBase, destBase);
  for (const ext of ['-wal', '-shm']) {
    const s = srcBase + ext;
    const d = destBase + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, d);
  }
}

/**
 * Docker/server previously used isDev → __dirname/printventory.db (ephemeral /app).
 * If the persisted userData DB does not exist yet, copy from that legacy file once.
 */
function migrateLegacyServerDbIfNeeded(persistedPath) {
  if (fs.existsSync(persistedPath)) return;
  const legacy = path.join(__dirname, 'printventory.db');
  if (!fs.existsSync(legacy)) return;
  try {
    copySqliteDbFiles(legacy, persistedPath);
    console.log('[Server mode] Migrated SQLite from', legacy, 'to', persistedPath);
  } catch (e) {
    console.error('[Server mode] Could not migrate legacy database:', e);
  }
}

/**
 * Apply Docker/env defaults without clobbering user-saved settings on every restart.
 * Set PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1 to always apply env (old behavior).
 */
/** PRINTVENTORY_ENABLE_ZIP, PRINTVENTORY_FILE_TYPES, PRINTVENTORY_AI_* and friends (env-settings.js). */
function applyEnvSettings() {
  if (!database.db) return;
  const { settings, errors } = settingsFromEnv(process.env, {
    fileTypeIds: ADDITIONAL_FILE_TYPES_CATALOG.map((entry) => entry.id)
  });
  const save = database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const { env, key, value } of settings) {
    save.run(key, value);
    console.log(`Startup env applied setting ${key} from ${env}:`, SECRET_ENV.has(env) ? '(hidden)' : value);
  }
  for (const error of errors) console.error(`Ignored environment variable ${error}`);
}

function applyDockerEnvSettingIfNeeded(key, envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const trimmed = String(envValue).trim();
  const force = process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === '1' ||
    process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const current = row?.value != null ? String(row.value).trim() : '';
    if (!force && current !== '') return;
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, trimmed);
    console.log(`Startup env applied setting ${key}:`, trimmed, force ? '(PRINTVENTORY_ENV_OVERRIDES_SETTINGS)' : '');
  } catch (e) {
    console.error(`Error applying env to setting ${key}:`, e);
  }
}

function dedupePathList(paths) {
  const seen = new Set();
  const out = [];
  for (const item of paths || []) {
    const p = String(item || '').trim();
    if (!p) continue;
    const key = p.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** STL_HOME and STL_HOME_EXCLUDE: comma, semicolon, or newline separated paths, or a JSON array. */
function parseExcludePathList(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry || '').trim()).filter(Boolean);
      }
    } catch (_) { /* treat as a delimited list */ }
  }
  return text.split(/[\r\n,;]+/).map((entry) => entry.trim()).filter(Boolean);
}

function excludeDirectoriesSettingIsEmpty(value) {
  const current = value == null ? '' : String(value).trim();
  if (!current || current === '[]') return true;
  try {
    const parsed = JSON.parse(current);
    if (!Array.isArray(parsed)) return false;
    return parsed.every((entry) => !String(entry || '').trim());
  } catch (_) {
    return false;
  }
}

function readLegacyStlHomePaths(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[') || /[\r\n,;]/.test(text)) return dedupePathList(parseExcludePathList(text));
  return [text];
}

/** Directories scanned as STL Home. Prefers the JSON list, then a legacy single stlHome path. */
function readStlHomeDirectories() {
  try {
    if (!database.db) return [];
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeDirectories');
    const fromList = dedupePathList(parseExcludePathList(row?.value));
    if (fromList.length) return fromList;
    const legacy = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHome')?.value;
    return readLegacyStlHomePaths(legacy);
  } catch (error) {
    console.error('Invalid STL Home directories setting:', error);
    return [];
  }
}

function stlHomeDirectoriesAreUnset() {
  const listRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeDirectories');
  if (!excludeDirectoriesSettingIsEmpty(listRow?.value)) return false;
  const legacy = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHome')?.value;
  return !String(legacy || '').trim();
}

/**
 * Seed STL Home directories from STL_HOME.
 * One path or several (comma, semicolon, newline, or a JSON array). The stored
 * list default is "[]", which is unset. A saved list — or a legacy stlHome path —
 * is left alone unless PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1.
 */
function applyStlHomeEnvIfNeeded(envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const paths = dedupePathList(parseExcludePathList(envValue));
  if (!paths.length) return;
  const force = process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === '1' ||
    process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    if (!force && !stlHomeDirectoriesAreUnset()) return;
    const json = JSON.stringify(paths);
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('stlHomeDirectories', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(json);
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('stlHome', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(paths[0]);
    console.log('Startup env applied setting stlHomeDirectories:', json, force ? '(PRINTVENTORY_ENV_OVERRIDES_SETTINGS)' : '');
  } catch (e) {
    console.error('Error applying STL_HOME:', e);
  }
}

/**
 * Seed STL Home excluded directories from STL_HOME_EXCLUDE.
 * The stored default is "[]", which is unset. A saved list is left alone unless
 * PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1.
 */
function applyStlHomeExcludeEnvIfNeeded(envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const paths = parseExcludePathList(envValue);
  if (!paths.length) return;
  const force = process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === '1' ||
    process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeExcludeDirectories');
    if (!force && !excludeDirectoriesSettingIsEmpty(row?.value)) return;
    const json = JSON.stringify(paths);
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('stlHomeExcludeDirectories', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(json);
    console.log('Startup env applied setting stlHomeExcludeDirectories:', json, force ? '(PRINTVENTORY_ENV_OVERRIDES_SETTINGS)' : '');
  } catch (e) {
    console.error('Error applying STL_HOME_EXCLUDE:', e);
  }
}

// Update the database path handling
function getDatabasePath() {
  try {
    const envDb = process.env.PRINTVENTORY_DB_PATH?.trim();
    if (envDb) {
      const resolved = path.isAbsolute(envDb) ? envDb : path.resolve(process.cwd(), envDb);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      debugLog('Using database path from PRINTVENTORY_DB_PATH:', resolved);
      return resolved;
    }

    const userDataPath = path.join(app.getPath('userData'), 'data');

    // Ensure the directory exists
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }

    const dbPath = path.join(userDataPath, 'printventory.db');
    migrateLegacyServerDbIfNeeded(dbPath);
    debugLog('Using database path:', dbPath);
    return dbPath;
  } catch (error) {
    console.error('Error setting up database path:', error);
    throw error;
  }
}

// Add these IPC handlers
// Helper: URL-only models (added by Chrome extension) have filePath "url::https://..."
function isUrlModel(filePath) {
  return typeof filePath === 'string' && filePath.startsWith('url::');
}

function getLibraryRootPaths() {
  const roots = [];
  const add = (value) => {
    if (value && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && !roots.includes(trimmed)) roots.push(trimmed);
    }
  };
  for (const home of parseExcludePathList(process.env.STL_HOME)) add(home);
  try {
    if (database.db) {
      for (const home of readStlHomeDirectories()) add(home);
      add(database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value);
    }
  } catch (_) { /* db not ready */ }
  return roots;
}

// Windows-scanned libraries reused in Docker still store C:\... paths. Try the
// stored path plus Linux mount equivalents derived from STL_HOME / directoryPath.
function collectReadablePathCandidates(filePath) {
  if (!filePath || typeof filePath !== 'string') return [];
  const normalized = filePath.replace(/\\/g, '/');
  const candidates = [];
  const add = (p) => {
    if (p && typeof p === 'string' && !candidates.includes(p)) candidates.push(p);
  };
  add(filePath);
  add(normalized);

  const win = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (win) {
    const drive = win[1].toLowerCase();
    const rest = win[2];
    add('/' + rest);
    add('/mnt/' + rest);
    add('/mnt/' + drive + '/' + rest);
    for (const root of getLibraryRootPaths()) {
      const rootNorm = String(root).replace(/\\/g, '/').replace(/\/$/, '');
      if (!rootNorm) continue;
      const rootBase = rootNorm.split('/').filter(Boolean).pop() || '';
      const restParts = rest.split('/').filter(Boolean);
      const idx = restParts.findIndex((p) => p.toLowerCase() === rootBase.toLowerCase());
      if (idx >= 0) {
        const relative = restParts.slice(idx + 1).join('/');
        add(relative ? `${rootNorm}/${relative}` : rootNorm);
      }
    }
  }
  return candidates;
}

function resolveReadableDiskPath(diskPath) {
  if (!diskPath || isUrlModel(diskPath)) return null;
  for (const candidate of collectReadablePathCandidates(diskPath)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* ignore invalid paths */ }
  }
  return null;
}

function resolveReadableModelPath(filePath) {
  if (!filePath || isUrlModel(filePath)) return null;
  const pathInfo = parseZipPath(filePath);
  const diskPath = pathInfo.isZipEntry ? pathInfo.zipPath : filePath;
  const resolved = resolveReadableDiskPath(diskPath);
  if (!resolved) return null;
  return pathInfo.isZipEntry ? `${resolved}::${pathInfo.entryPath}` : resolved;
}

// Helper function to parse zip path format
function parseZipPath(filePath) {
  if (isUrlModel(filePath)) {
    return { zipPath: filePath, entryPath: null, isZipEntry: false };
  }
  if (filePath.includes('::')) {
    const [zipPath, entryPath] = filePath.split('::');
    return { zipPath, entryPath, isZipEntry: true };
  }
  return { zipPath: filePath, entryPath: null, isZipEntry: false };
}

// Skip macOS resource-fork / AppleDouble entries (._*) and __MACOSX metadata — not valid models
function isMacOsResourceForkEntry(entryPath) {
  return shouldSkipEntryPath(entryPath, getScanExcludeNames());
}

// Minimum ZIP is 22 bytes (end-of-central-directory). 3MF is ZIP-based (starts with PK).
function isLikelyValidZipBuffer(data) {
  if (!Buffer.isBuffer(data) || data.length < 22) return false;
  return data[0] === 0x50 && data[1] === 0x4B; // PK
}

/** Dedicated OS-temp folder for zip-entry extracts — never the library / STL home. */
const EXTRACT_TEMP_DIR_NAME = 'printventory-extracts';
const EXTRACT_TEMP_FILE_PREFIX = 'printventory_';
/** Slicer may still be reading the file after launch; delay cleanup. */
const EXTRACT_TEMP_SLICER_CLEANUP_MS = 10 * 60 * 1000;
const pendingExtractTempCleanups = new Set();

function getOsTempRoot() {
  try {
    if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady()) {
      return app.getPath('temp');
    }
  } catch (_) { /* use os.tmpdir */ }
  return os.tmpdir();
}

function getExtractTempDir() {
  const osDir = path.join(getOsTempRoot(), EXTRACT_TEMP_DIR_NAME);
  // Guard: if TEMP is mounted inside the library (common Docker misconfig), use userData instead
  try {
    if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady() && database.db) {
      const resolvedDir = path.resolve(osDir);
      for (const home of readStlHomeDirectories()) {
        const stlHome = path.resolve(String(home));
        if (resolvedDir === stlHome || resolvedDir.startsWith(stlHome + path.sep)) {
          return path.join(app.getPath('userData'), EXTRACT_TEMP_DIR_NAME);
        }
      }
    }
  } catch (_) { /* keep OS temp */ }
  return osDir;
}

function ensureExtractTempDir() {
  const dir = getExtractTempDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isPrintventoryExtractTempPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const resolved = path.resolve(filePath);
    const base = path.basename(resolved);
    if (!base.startsWith(EXTRACT_TEMP_FILE_PREFIX)) return false;

    const allowedRoots = [
      path.resolve(getExtractTempDir()),
      path.resolve(path.join(getOsTempRoot(), EXTRACT_TEMP_DIR_NAME)),
      path.resolve(getOsTempRoot())
    ];
    try {
      if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady()) {
        allowedRoots.push(path.resolve(path.join(app.getPath('userData'), EXTRACT_TEMP_DIR_NAME)));
      }
    } catch (_) { /* ignore */ }

    const parent = path.resolve(path.dirname(resolved));
    return allowedRoots.some((root) => parent === root || resolved.startsWith(root + path.sep));
  } catch (_) {
    return false;
  }
}

function isPrintventoryExtractTempFileName(fileName) {
  return typeof fileName === 'string' && fileName.startsWith(EXTRACT_TEMP_FILE_PREFIX);
}

async function cleanupExtractTempFile(filePath) {
  if (!isPrintventoryExtractTempPath(filePath)) return false;
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    pendingExtractTempCleanups.delete(filePath);
    return true;
  } catch (err) {
    console.warn('Failed to clean up extract temp file:', filePath, err.message);
    return false;
  }
}

function scheduleExtractTempCleanup(filePath, delayMs = EXTRACT_TEMP_SLICER_CLEANUP_MS) {
  if (!isPrintventoryExtractTempPath(filePath)) return;
  pendingExtractTempCleanups.add(filePath);
  setTimeout(() => {
    cleanupExtractTempFile(filePath).catch(() => {});
  }, Math.max(0, delayMs));
}

function scheduleExtractTempCleanupMany(filePaths, delayMs = EXTRACT_TEMP_SLICER_CLEANUP_MS) {
  for (const fp of filePaths || []) {
    scheduleExtractTempCleanup(fp, delayMs);
  }
}

/** Remove leftover extract temps (startup / quit). Optionally only files older than maxAgeMs. */
async function cleanupExtractTempDirectory({
  maxAgeMs = 0,
  // Full OS TEMP readdir is slow on busy machines — skip on cold start; still run on quit.
  includeLegacyOsTempRoot = true,
} = {}) {
  const now = Date.now();
  const dirs = new Set([getExtractTempDir(), path.join(getOsTempRoot(), EXTRACT_TEMP_DIR_NAME)]);
  try {
    if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady()) {
      dirs.add(path.join(app.getPath('userData'), EXTRACT_TEMP_DIR_NAME));
    }
  } catch (_) { /* ignore */ }

  async function sweepDir(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(EXTRACT_TEMP_FILE_PREFIX)) continue;
      const full = path.join(dir, entry.name);
      try {
        if (maxAgeMs > 0) {
          const stat = await fs.promises.stat(full);
          if (now - stat.mtimeMs < maxAgeMs) continue;
        }
        await fs.promises.unlink(full);
        pendingExtractTempCleanups.delete(full);
      } catch (_) { /* ignore busy files */ }
    }
  }

  for (const dir of dirs) {
    await sweepDir(dir);
  }
  // Legacy flat printventory_* files written directly under OS temp (quit / explicit only)
  if (includeLegacyOsTempRoot) {
    await sweepDir(getOsTempRoot());
  }
}

// Helper function to extract model from zip to temp file or specified destination
async function extractModelFromZip(zipPath, entryPath, destinationPath = null) {
  const entryData = await extractZipEntryBuffer(zipPath, entryPath);

  if (destinationPath) {
    // Extract to specified destination, preserving directory structure
    const destPath = path.join(destinationPath, entryPath);
    const destDir = path.dirname(destPath);
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.writeFile(destPath, entryData);
    return destPath;
  }

  // Always OS temp subdirectory — never adjacent to the zip / library
  const tempDir = ensureExtractTempDir();
  const fileName = path.basename(entryPath).replace(/[<>:"|?*]/g, '_');
  const tempPath = path.join(tempDir, `${EXTRACT_TEMP_FILE_PREFIX}${Date.now()}_${fileName}`);
  await fs.promises.writeFile(tempPath, entryData);
  return tempPath;
}

async function resolveModelPathsForSlicer(filePaths) {
  const rawPaths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const resolved = [];

  for (const fp of rawPaths) {
    if (typeof fp !== 'string' || isUrlModel(fp)) continue;

    const pathInfo = parseZipPath(fp);
    if (pathInfo.isZipEntry) {
      if (isMacOsResourceForkEntry(pathInfo.entryPath)) continue;
      resolved.push(await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath));
    } else if (fs.existsSync(fp)) {
      resolved.push(fp);
    }
  }

  return resolved;
}

function getSlicerBySelection(slicers, { slicerId, slicerName } = {}) {
  if (!Array.isArray(slicers) || slicers.length === 0) return null;
  if (slicerId != null) {
    return slicers.find((slicer) => slicer.id === slicerId) || null;
  }
  if (slicerName) {
    return slicers.find((slicer) => slicer.name === slicerName) || null;
  }
  return slicers[0];
}

/**
 * The server cannot open a folder picker on the user's computer, so it asks the browser for a
 * path inside the container. (A folder browser for mounted volumes is planned.)
 */
async function askForFolder(event, { title, defaultPath } = {}) {
  const value = await clientDialogs.input(event, {
    title: title || 'Select Directory',
    message: 'Folder path inside the container (for example /mnt/models/sorted):',
    defaultValue: defaultPath ? String(defaultPath) : '',
    placeholder: '/mnt/models'
  });
  const folder = value ? value.trim() : '';
  return folder || null;
}

function presentInvalidSlicer(event, error) {
  return clientDialogs.messageBox(event, {
    type: 'error',
    title: 'Slicer path is not valid',
    message: 'Could not open the slicer',
    detail: error.message
  });
}

function runSlicerWithModelPaths(slicer, modelPaths) {
  if (!modelPaths.length) {
    return Promise.reject(new Error('No model files to open in slicer'));
  }

  const invalid = invalidSlicerPathError(slicer.path, slicer.name);
  if (invalid) return Promise.reject(invalid);

  const inDocker = isDockerContainer();
  if (inDocker && (/^[A-Za-z]:[\\/]/.test(slicer.path) || /^\\\\/.test(slicer.path))) {
    return Promise.reject(new Error(
      `The slicer path "${slicer.path}" is a Windows path, but the application is running in a Docker container (Linux). ` +
      'Use a Linux slicer path or run Printventory in normal mode.'
    ));
  }

  const spec = buildSlicerSpawnSpec(slicer.path, modelPaths);
  console.log('[Slicer] Launching', spec.command, spec.args.join(' '));
  // Resolve when the process starts. Slicers that are already open often hand the
  // file to the existing window and exit non-zero; that is still a successful launch.
  return launchSlicerProcess(spec, { name: slicer.name, slicerPath: slicer.path }).then(
    () => {
      scheduleExtractTempCleanupMany(modelPaths);
      return { success: true, count: modelPaths.length };
    },
    (error) => {
      scheduleExtractTempCleanupMany(modelPaths, 0);
      throw error;
    }
  );
}

// Helper function to clean HTML entities and special characters from description text
function cleanDescriptionText(text) {
  if (!text) return text;
  
  let cleaned = text;
  
  // First, decode double-encoded HTML entities (e.g., &amp;lt; becomes &lt;, &amp;#34; becomes &#34;)
  // This handles cases where entities are encoded multiple times
  let previousCleaned = '';
  while (cleaned !== previousCleaned) {
    previousCleaned = cleaned;
    cleaned = cleaned.replace(/&amp;(#?\w+;)/g, '&$1');
  }
  
  // Decode common HTML entities
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#34;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&apos;/g, "'");
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&#160;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  
  // Remove HTML tags (including nested tags and multiline)
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  
  // Decode any remaining numeric entities (decimal and hexadecimal)
  cleaned = cleaned.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
  cleaned = cleaned.replace(/&#x([0-9a-fA-F]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  
  // Clean up whitespace - replace multiple spaces/newlines/tabs with single space
  cleaned = cleaned.replace(/\s+/g, ' ');
  
  // Trim leading/trailing whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

/** Locate main model part in a 3MF zip (JSZip contents). Handles alternate paths/casing. */
function find3dModelZipEntry(contents) {
  if (!contents || !contents.files) return null;
  const preferred = ['3D/3dmodel.model', '/3D/3dmodel.model'];
  for (const p of preferred) {
    const f = contents.files[p];
    if (f && !f.dir) return f;
  }
  for (const key of Object.keys(contents.files)) {
    const f = contents.files[key];
    if (f.dir) continue;
    const norm = key.replace(/\\/g, '/');
    if (/(^|\/)3dmodel\.model$/i.test(norm)) return f;
  }
  return null;
}

// Helper function to parse 3MF model XML and extract metadata
function parse3MFModelXML(xmlContent) {
  const metadata = {
    designer: null,
    parentModel: null,
    notes: null,
    license: null
  };

  try {
    // Match <metadata ...> regardless of attribute order (some writers put type before name)
    const metadataPattern = /<metadata\b([^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/metadata>/gi;
    let match;

    while ((match = metadataPattern.exec(xmlContent)) !== null) {
      const attrChunk = match[1];
      const nameMatch = attrChunk.match(/\bname\s*=\s*["']([^"']+)["']/i);
      if (!nameMatch) continue;
      const fieldName = nameMatch[1].trim();
      let fieldValue = match[2].trim();
      
      // If the value is in a CDATA section, it's already extracted by the regex
      // Otherwise, handle any remaining encoding

      // Map XML metadata names to database fields
      if (fieldName === 'Designer' && fieldValue) {
        metadata.designer = fieldValue;
      } else if (fieldName === 'Title' && fieldValue) {
        metadata.parentModel = fieldValue;
      } else if (fieldName === 'Description' && fieldValue) {
        metadata.notes = cleanDescriptionText(fieldValue);
      } else if (fieldName === 'License' && fieldValue) {
        metadata.license = fieldValue;
      }
    }
  } catch (error) {
    console.error('Error parsing 3MF model XML:', error);
  }

  return metadata;
}

// Helper function to filter 3MF metadata based on user settings
function filter3MFMetadataBySettings(metadata) {
  const filtered = {
    designer: null,
    parentModel: null,
    notes: null,
    license: null
  };
  
  try {
    // Get settings from database (default to '1' if not set)
    const enableDesigner = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFDesigner');
    const enableParentModel = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFParentModel');
    const enableLicense = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFLicense');
    const enableNotes = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enable3MFNotes');
    
    // Include field if setting is '1' or not set (default enabled)
    if (metadata.designer && (enableDesigner?.value === '1' || !enableDesigner)) {
      filtered.designer = metadata.designer;
    }
    if (metadata.parentModel && (enableParentModel?.value === '1' || !enableParentModel)) {
      filtered.parentModel = metadata.parentModel;
    }
    if (metadata.license && (enableLicense?.value === '1' || !enableLicense)) {
      filtered.license = metadata.license;
    }
    if (metadata.notes && (enableNotes?.value === '1' || !enableNotes)) {
      filtered.notes = metadata.notes;
    }
  } catch (error) {
    console.error('Error filtering 3MF metadata by settings:', error);
    // On error, return original metadata (fail open)
    return metadata;
  }
  
  return filtered;
}

// Helper function to extract metadata from a 3MF file
async function extract3MFMetadata(filePath) {
  try {
    // Check if this is a zip entry
    const pathInfo = parseZipPath(filePath);
    let actualFilePath = filePath;
    let shouldCleanup = false;
    
    if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
      return null;
    }
    
    if (pathInfo.isZipEntry) {
      // Extract to temp file first
      try {
        actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
        shouldCleanup = true;
      } catch (error) {
        console.error('Error extracting zip entry for 3MF metadata:', error);
        return null;
      }
    }
    
    // Check if file exists
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return null;
    }
    
    const data = await fs.promises.readFile(actualFilePath);
    if (!isLikelyValidZipBuffer(data)) {
      return null;
    }
    
    // Use JSZip to extract the 3MF file (which is a zip file)
    const zip = new JSZip();
    let contents;
    try {
      contents = await zip.loadAsync(data);
    } catch (zipError) {
      return null;
    }
    
    const modelXmlFile = find3dModelZipEntry(contents);
    
    if (modelXmlFile && !modelXmlFile.dir) {
      const xmlContent = await modelXmlFile.async('string');
      const parsedMetadata = parse3MFModelXML(xmlContent);
      
      // Clean up temp file if needed
      if (shouldCleanup && actualFilePath !== filePath) {
        try {
          await fs.promises.unlink(actualFilePath);
        } catch (cleanupError) {
          console.error('Error cleaning up temp file:', cleanupError);
        }
      }
      
      return parsedMetadata;
    } else {
      // Clean up temp file if needed
      if (shouldCleanup && actualFilePath !== filePath) {
        try {
          await fs.promises.unlink(actualFilePath);
        } catch (cleanupError) {
          console.error('Error cleaning up temp file:', cleanupError);
        }
      }
      return null;
    }
  } catch (error) {
    console.error('Error extracting 3MF metadata:', error);
    return null;
  }
}

ipcMain.handle('get3MFImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  // Skip files located in __MACOSX directories
  if (/[\\\/]__macosx[\\\/]/i.test(filePath)) {
    return [];
  }

  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const verbose = opts.verbose === true || process.env.PRINTVENTORY_DEBUG_3MF === '1';
  const maxImagesRaw = Number(opts.maxImages);
  const maxImages = Number.isFinite(maxImagesRaw) && maxImagesRaw > 0
    ? Math.min(Math.floor(maxImagesRaw), 250)
    : 250;
  const compress = opts.compress !== false;
  const log = (...args) => { if (verbose) console.log(...args); };
  
  // Check if this is a zip entry
  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;
  
  // Skip macOS resource-fork entries (._*) - not valid 3MF
  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }
  
  if (pathInfo.isZipEntry) {
    // Extract to temp file first
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for 3MF images:', error);
      return [];
    }
  }
  
  try {
    log('Starting to process 3MF file:', actualFilePath);
    
    // Check if file exists
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }
    
    const data = await fs.promises.readFile(actualFilePath);
    if (!isLikelyValidZipBuffer(data)) {
      log('Skipping non-ZIP or too-small file (e.g. macOS ._ file):', actualFilePath, 'size:', data.length);
      return [];
    }
    
    // Use JSZip to extract the 3MF file (which is a zip file)
    const zip = new JSZip();
    let contents;
    try {
      contents = await zip.loadAsync(data);
    } catch (zipError) {
      const msg = zipError && zipError.message ? zipError.message : String(zipError);
      if (/end of central directory|not a zip/i.test(msg)) {
        log('Invalid or truncated ZIP/3MF, skipping:', actualFilePath);
      } else {
        console.error('Error loading 3MF as ZIP:', zipError);
      }
      return [];
    }
    log('Zip contents loaded successfully');
    
    // Log all files in the 3MF
    log('\nContents of 3MF file:', actualFilePath);
    log('Number of files in archive:', Object.keys(contents.files).length);
    if (verbose) {
      log('All files in archive:');
      Object.keys(contents.files).forEach(filename => {
        const file = contents.files[filename];
        log(' -', filename, file.dir ? '(directory)' : `(${file._data ? file._data.length : 0} bytes)`);
      });
    }
    
    // Parse 3dmodel.model XML file to extract metadata
    try {
      const modelXmlFile = find3dModelZipEntry(contents);
      
      if (modelXmlFile && !modelXmlFile.dir) {
        log('Found 3dmodel.model file, parsing metadata...');
        const xmlContent = await modelXmlFile.async('string');
        const parsedMetadata = parse3MFModelXML(xmlContent);
        
        // Filter metadata based on user settings
        const filteredMetadata = filter3MFMetadataBySettings(parsedMetadata);
        
        // Update database if we found any metadata
        if (filteredMetadata.designer || filteredMetadata.parentModel || filteredMetadata.notes || filteredMetadata.license) {
          log('Parsed metadata from 3dmodel.model:', filteredMetadata);
          
          // Use original filePath for database lookup (not actualFilePath which might be a temp file)
          const dbFilePath = filePath;
          
          // Get the model from database to check existing values
          let existingModel = getModelByFilePath(dbFilePath);
          
          // If model doesn't exist, create it (similar to add-multiple-thumbnails handler)
          if (!existingModel) {
            log('Model not found in database, creating entry with metadata...');
            const fileName = path.basename(dbFilePath);
            // Handle zip entry paths - extract just the entry name
            const finalFileName = dbFilePath.includes('::') 
              ? dbFilePath.split('::').pop() 
              : fileName;
            const dateAdded = new Date().toISOString();
            
            database.db.prepare(`
              INSERT INTO models (filePath, fileName, designer, parentModel, notes, license, dateAdded, isNew)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `).run(
              dbFilePath,
              finalFileName,
              filteredMetadata.designer || null,
              filteredMetadata.parentModel || null,
              filteredMetadata.notes || null,
              filteredMetadata.license || null,
              dateAdded
            );
            
            log(`Created model entry for ${dbFilePath} with metadata`);
          } else {
            // Model exists - only update fields that are empty/null in the database
            const updates = {};
            const conditions = [];
            const values = [];
            
            if (filteredMetadata.designer && (!existingModel.designer || existingModel.designer.trim() === '')) {
              updates.designer = filteredMetadata.designer;
              values.push(filteredMetadata.designer);
              conditions.push('designer = ?');
            }
            
            if (filteredMetadata.parentModel && (!existingModel.parentModel || existingModel.parentModel.trim() === '')) {
              updates.parentModel = filteredMetadata.parentModel;
              values.push(filteredMetadata.parentModel);
              conditions.push('parentModel = ?');
            }
            
            if (filteredMetadata.notes && (!existingModel.notes || existingModel.notes.trim() === '')) {
              updates.notes = filteredMetadata.notes;
              values.push(filteredMetadata.notes);
              conditions.push('notes = ?');
            }
            
            if (filteredMetadata.license && (!existingModel.license || existingModel.license.trim() === '')) {
              updates.license = filteredMetadata.license;
              values.push(filteredMetadata.license);
              conditions.push('license = ?');
            }
            
            // Update database if we have any fields to update
            if (Object.keys(updates).length > 0) {
              values.push(dbFilePath);
              const updateStmt = database.db.prepare(`
                UPDATE models 
                SET ${conditions.join(', ')} 
                WHERE filePath = ?
              `);
              updateStmt.run(...values);
              log(`Updated model metadata for ${dbFilePath}:`, updates);
            } else {
              log('Model already has values for all metadata fields, skipping update');
            }
          }
        } else {
          log('No metadata found in 3dmodel.model file');
        }
      } else {
        log('3dmodel.model file not found in 3MF archive');
      }
    } catch (metadataError) {
      console.warn('Error parsing 3MF metadata (continuing with thumbnail extraction):', metadataError);
    }
    
    // Helper to check if file is an image and not a system file
    const isImage = (path) => {
      const normalized = path.replace(/\\/g, '/');
      // Skip Mac/System files
      if (normalized.includes('__MACOSX/') || normalized.split('/').pop().startsWith('._')) return false;
      return normalized.match(/\.(png|jpe?g|gif|webp)$/i);
    };

    // Helper to get proper MIME type from file extension
    const getMimeType = (path) => {
      const ext = path.split('.').pop().toLowerCase();
      const mimeMap = {
        'jpg': 'jpeg',
        'jpeg': 'jpeg',
        'png': 'png',
        'gif': 'gif',
        'webp': 'webp'
      };
      return mimeMap[ext] || 'png';
    };

    // Normalized archive path (zip may use \ or /; match Auxiliaries at any depth)
    const isInAuxiliariesPath = (normLower) =>
      normLower.startsWith('auxiliaries/') ||
      normLower.includes('/auxiliaries/') ||
      normLower.startsWith('auxiliary/') ||
      normLower.includes('/auxiliary/');

    // Helper to calculate score for an image to determine priority
    const calculateScore = (path, size) => {
      let score = 0;
      const norm = path.replace(/\\/g, '/').toLowerCase();
      const fileName = norm.split('/').pop().toLowerCase();
      const inAuxiliaries = isInAuxiliariesPath(norm);

      // Bambu Studio / Orca / PrusaSlicer: project cover is often Metadata/thumbnail.png
      if (/(^|\/)metadata\/thumbnail\.(png|jpe?g|webp|gif)$/.test(norm)) {
        score += 280;
      }

      // 0. HIGHEST: Auxiliaries/ (any subfolder) — slicer/preview thumbnails per 3MF auxiliary content
      if (inAuxiliaries) {
        score += 220;
      }

      // 1. Very high: Images in 3D/Textures/ or 3D/Texture/ (3MF standard texture location)
      if (norm.includes('3d/textures/') || norm.includes('3d/texture/')) {
        score += 200;
      }

      // 2. Plate images (high priority) - prefer images with "plate" in name
      if (fileName.includes('plate')) score += 150; // Prefer plate images like plate_1.jpg

      // 3. Camera photos (high priority) - specific patterns
      if (fileName.match(/^dsc/)) score += 100; // Nikon/Sony
      if (fileName.match(/^img/)) score += 100; // Canon/generic
      if (fileName.match(/^pxl/)) score += 100; // Pixel
      if (fileName.match(/^\d{8}_\d{6}/)) score += 100; // Android date format

      // 4. Paths containing "metadata" (lower priority) unless it is the slicer project thumbnail above
      const isSlicerThumbnailPath = /(^|\/)metadata\/thumbnail\.(png|jpe?g|webp|gif)$/.test(norm);
      if (!inAuxiliaries && norm.includes('metadata') && !isSlicerThumbnailPath) score -= 50;
      if (!inAuxiliaries && fileName.includes('thumbnail')) score -= 20;
      if (!inAuxiliaries && fileName.includes('preview')) score -= 10;

      // 5. File size (preference for larger, likely higher res images)
      // Cap size bonus at 50 points (assuming size is in bytes)
      // Use 0 if size is undefined
      const safeSize = size || 0;
      score += Math.min(safeSize / 1024, 50);

      // 6. Prefer webp/jpg over png (often photos vs generated)
      if (fileName.endsWith('.webp') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
        score += 10;
      }

      return score;
    };

    // Scan all images in the archive
    log('\nScanning all images in 3MF archive...');
    const allImages = [];

    for (const [path, file] of Object.entries(contents.files)) {
      if (isImage(path) && !file.dir) {
        // Try to get uncompressed size if available, otherwise 0
        const size = (file._data && file._data.uncompressedSize) || 0;
        const score = calculateScore(path, size);
        log(`Found image: ${path} (Score: ${score})`);

        allImages.push({
          path,
          file,
          score
        });
      }
    }

    // Sort images by score descending (default thumbnail order: highest score first)
    allImages.sort((a, b) => b.score - a.score);

    // Extract images in priority order. Cap avoids huge photo dumps blowing IPC + DB row size.
    const MAX_3MF_IMAGES_TO_EXTRACT = maxImages;
    const imageFiles = [];
    const toExtract = allImages.slice(0, MAX_3MF_IMAGES_TO_EXTRACT);
    if (allImages.length > MAX_3MF_IMAGES_TO_EXTRACT) {
      log(
        `3MF has ${allImages.length} image entries; extracting ${MAX_3MF_IMAGES_TO_EXTRACT} highest-priority (memory / DB safety cap).`
      );
    }

    for (const imgObj of toExtract) {
      log(`Extracting: ${imgObj.path} (Score: ${imgObj.score})`);
      const imageData = await imgObj.file.async('base64');
      const mimeType = getMimeType(imgObj.path);
      let dataUrl = `data:image/${mimeType};base64,${imageData}`;
      if (compress) {
        try {
          dataUrl = compressDataUrl(dataUrl) || dataUrl;
        } catch (_) { /* keep original */ }
      }
      imageFiles.push(dataUrl);
    }
    
    log('\nExtracted total images:', imageFiles.length);
    if (imageFiles.length === 0) {
      log('No images found in 3MF file. Expected under Auxiliaries/ (any subfolder), 3D/Textures/, or 3D/Texture/.');
    }
    return imageFiles.length > 0 ? imageFiles : [];
  } catch (error) {
    console.error('Error reading 3MF images:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    return [];
  }
});

ipcMain.handle('getLYSImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\\/]__macosx[\\\/]/i.test(filePath)) {
    return [];
  }

  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const compress = opts.compress !== false;

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for LYS preview:', error);
      return [];
    }
  }

  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    const data = await fs.promises.readFile(actualFilePath);
    const entry = extractLysPreviewEntry(new Uint8Array(data));
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    const ext = path.extname(entry.name || '').toLowerCase().replace(/^\./, '') || 'png';
    const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' };
    const mimeType = mimeMap[ext] || 'png';
    let dataUrl = `data:image/${mimeType};base64,${Buffer.from(entry.bytes).toString('base64')}`;
    if (compress) {
      try {
        dataUrl = compressDataUrl(dataUrl) || dataUrl;
      } catch (_) { /* keep original */ }
    }
    return [dataUrl];
  } catch (error) {
    console.error('Error reading LYS preview:', error);
    return [];
  }
});

ipcMain.handle('getF3DImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\\/]__macosx[\\\/]/i.test(filePath)) {
    return [];
  }

  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const compress = opts.compress !== false;

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for F3D preview:', error);
      return [];
    }
  }

  let fh;
  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    fh = await fs.promises.open(actualFilePath, 'r');
    const { size } = await fh.stat();
    const handle = fh;
    const entry = await extractF3dPreviewEntry({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        return new Uint8Array(buf.subarray(0, bytesRead));
      }
    });
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    const ext = path.extname(entry.name || '').toLowerCase().replace(/^\./, '') || 'png';
    const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' };
    const mimeType = mimeMap[ext] || 'png';
    let dataUrl = `data:image/${mimeType};base64,${Buffer.from(entry.bytes).toString('base64')}`;
    if (compress) {
      try {
        dataUrl = compressDataUrl(dataUrl) || dataUrl;
      } catch (_) { /* keep original */ }
    }
    return [dataUrl];
  } catch (error) {
    console.error('Error reading F3D preview:', error);
    return [];
  } finally {
    await fh?.close();
  }
});

ipcMain.handle('getChituboxImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\\/]__macosx[\\\/]/i.test(filePath)) {
    return [];
  }

  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const compress = opts.compress !== false;

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for ChiTuBox preview:', error);
      return [];
    }
  }

  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    const data = await fs.promises.readFile(actualFilePath);
    const entry = extractChituboxPreviewEntry(new Uint8Array(data));
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    let dataUrl = `data:image/png;base64,${Buffer.from(entry.bytes).toString('base64')}`;
    if (compress) {
      try {
        dataUrl = compressDataUrl(dataUrl) || dataUrl;
      } catch (_) { /* keep original */ }
    }
    return [dataUrl];
  } catch (error) {
    console.error('Error reading ChiTuBox preview:', error);
    return [];
  }
});

ipcMain.handle('getVoxlImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  if (/[\\\/]__macosx[\\\/]/i.test(filePath)) {
    return [];
  }

  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const compress = opts.compress !== false;

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for VOXL preview:', error);
      return [];
    }
  }

  let fh;
  try {
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    fh = await fs.promises.open(actualFilePath, 'r');
    const { size } = await fh.stat();
    const handle = fh;
    const entry = await extractVoxlPreviewEntry({
      size,
      read: async (offset, length) => {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        return new Uint8Array(buf.subarray(0, bytesRead));
      }
    });
    if (!entry || !entry.bytes || !entry.bytes.length) {
      return [];
    }

    const mime = (entry.mimeType || 'image/png').toLowerCase();
    const mimeType = mime.includes('jpeg') || mime.includes('jpg')
      ? 'jpeg'
      : mime.includes('webp')
        ? 'webp'
        : 'png';
    let dataUrl = `data:image/${mimeType};base64,${Buffer.from(entry.bytes).toString('base64')}`;
    if (compress) {
      try {
        dataUrl = compressDataUrl(dataUrl) || dataUrl;
      } catch (_) { /* keep original */ }
    }
    return [dataUrl];
  } catch (error) {
    console.error('Error reading VOXL preview:', error);
    return [];
  } finally {
    await fh?.close();
  }
});

ipcMain.handle('get3MFSTL', async (event, filePath) => {
  if (isUrlModel(filePath)) return null;
  try {
    // Check if this is a zip entry
    const pathInfo = parseZipPath(filePath);
    let actualFilePath = filePath;
    let shouldCleanup = false;
    
    if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
      return null;
    }
    
    if (pathInfo.isZipEntry) {
      // Extract to temp file first
      try {
        actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
        shouldCleanup = true;
      } catch (error) {
        console.error('Error extracting zip entry for 3MF STL:', error);
        return null;
      }
    }
    
    const data = await fs.promises.readFile(actualFilePath);
    if (!isLikelyValidZipBuffer(data)) {
      return null;
    }
    
    const zip = new JSZip();
    let contents;
    try {
      contents = await zip.loadAsync(data);
    } catch (zipError) {
      return null;
    }
    
    // Look for STL files in the 3MF
    for (const [entryPath, file] of Object.entries(contents.files)) {
      if (entryPath.endsWith('.stl')) {
        // Extract STL payload into dedicated OS temp dir
        const tempPath = path.join(ensureExtractTempDir(), `${EXTRACT_TEMP_FILE_PREFIX}${Date.now()}.stl`);
        await fs.promises.writeFile(tempPath, await file.async('nodebuffer'));
        
        // Clean up intermediate zip-entry extract if needed
        if (shouldCleanup && actualFilePath !== filePath) {
          await cleanupExtractTempFile(actualFilePath);
        }
        
        return tempPath;
      }
    }
    
    // Clean up intermediate temp file if needed
    if (shouldCleanup && actualFilePath !== filePath) {
      try {
        await fs.promises.unlink(actualFilePath);
      } catch (cleanupError) {
        console.error('Error cleaning up temp file:', cleanupError);
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting STL from 3MF:', error);
    return null;
  }
});

// Read model file for preview (STL parsing in renderer)
const readModelFileHandler = async (event, filePath) => {
  if (isUrlModel(filePath)) throw new Error('URL-only model has no file to read');
  let tempPath = null;
  try {
    // Handle zip entries — extract to OS temp, read, then delete
    if (filePath.includes('::')) {
      const pathInfo = parseZipPath(filePath);
      tempPath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
      const data = await fs.promises.readFile(tempPath);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    const data = await fs.promises.readFile(filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } catch (error) {
    console.error(`Error reading model file ${filePath}:`, error);
    throw error;
  } finally {
    if (tempPath) {
      await cleanupExtractTempFile(tempPath);
    }
  }
};
ipcMain.handle('read-model-file', readModelFileHandler);
// Register in handler registry for direct WebSocket invocation
ipcHandlerRegistry.set('read-model-file', readModelFileHandler);

// Parse 3MF preview handler
const parse3mfPreviewHandler = async (event, filePath, requestId) => {
  // Validate arguments - ensure filePath is a string, not an array
  if (Array.isArray(filePath)) {
    console.error('parse-3mf-preview: filePath is an array, extracting first element');
    filePath = filePath[0];
  }
  if (typeof filePath !== 'string') {
    throw new Error(`parse-3mf-preview: filePath must be a string, received ${typeof filePath}`);
  }
  if (isUrlModel(filePath)) throw new Error('URL-only model has no file to preview');
  
  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;
  let shouldCleanup = false;
  let fileStat = null;

  if (pathInfo.isZipEntry) {
    if (isMacOsResourceForkEntry(pathInfo.entryPath)) {
      throw new Error('macOS resource-fork entry is not a valid 3MF');
    }
    actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    shouldCleanup = true;
  }

  try {
    fileStat = await fs.promises.stat(actualFilePath);
  } catch (error) {
    console.error('Error statting 3MF preview file:', error);
  }

  if (fileStat && fileStat.size > PREVIEW_3MF_MAX_FILE_SIZE_MB * 1024 * 1024) {
    if (shouldCleanup && actualFilePath !== filePath) {
      try { await fs.promises.unlink(actualFilePath); } catch {}
    }
    throw new Error(
      `3MF preview skipped: file is too large (${Math.round(fileStat.size / 1024 / 1024)}MB > ${PREVIEW_3MF_MAX_FILE_SIZE_MB}MB)`
    );
  }

  cancelAllPreview3mfWorkers();

  // Bump preview cache version when simplification/placement logic changes
  const cacheKey = fileStat ? `v8|${filePath}|${fileStat.size}|${fileStat.mtimeMs}` : null;
  const cacheDir = getPreview3mfCacheDir();
  const cacheHash = cacheKey ? crypto.createHash('sha256').update(cacheKey).digest('hex') : null;
  const cachePath = cacheHash ? path.join(cacheDir, `${cacheHash}.json`) : null;

  // In-memory cache
  if (cacheKey && preview3mfCache.has(cacheKey)) {
    const cached = preview3mfCache.get(cacheKey);
    preview3mfCache.delete(cacheKey);
    preview3mfCache.set(cacheKey, cached);
    if (shouldCleanup && actualFilePath !== filePath) {
      try { await fs.promises.unlink(actualFilePath); } catch {}
    }
    return normalizePreview3mfTypedArrays(cached);
  }

  // Disk cache
  if (cachePath) {
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const cacheStat = await fs.promises.stat(cachePath);
      if (cacheStat.size <= PREVIEW_3MF_MAX_DISK_CACHE_MB * 1024 * 1024) {
        const cachedJson = await fs.promises.readFile(cachePath, 'utf8');
        const parsed = normalizePreview3mfTypedArrays(JSON.parse(cachedJson));
        preview3mfCache.set(cacheKey, parsed);
        trimPreview3mfMemoryCache();
        if (shouldCleanup && actualFilePath !== filePath) {
          try { await fs.promises.unlink(actualFilePath); } catch {}
        }
        return parsed;
      }
      try { await fs.promises.unlink(cachePath); } catch {}
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.error('Error reading 3MF preview cache:', error);
      }
    }
  }

  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'preview-3mf-worker-node.js');
    const entry = { worker: createPreview3mfWorker(workerPath) };
    const worker = entry.worker;
    let settled = false;

    const finish = (handler) => {
      if (settled) return;
      settled = true;
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      handler();
    };

    const cleanup = async () => {
      preview3mfWorkers.delete(requestId);
      terminatePreview3mfWorker(entry);
      if (shouldCleanup && actualFilePath !== filePath) {
        try { await fs.promises.unlink(actualFilePath); } catch {}
      }
    };

    preview3mfWorkers.set(requestId, { worker, entry, reject, cleanup });

    const onMessage = async (message) => {
      const { ok, json, error, type, message: statusMessage } = message || {};
      if (type === 'status') {
        // Use global.sendEvent for server mode compatibility
        if (global.broadcastEvent) {
          global.broadcastEvent('3mf-preview-status', requestId, statusMessage);
        } else if (event && event.sender) {
          event.sender.send('3mf-preview-status', requestId, statusMessage);
        }
        return;
      }

      finish(async () => {
        await cleanup();
        if (!ok) {
          reject(new Error(formatPreview3mfError(new Error(error || 'Failed to parse 3MF'))));
          return;
        }

        if (cacheKey) {
          preview3mfCache.set(cacheKey, normalizePreview3mfTypedArrays(json));
          trimPreview3mfMemoryCache();
          if (cachePath) {
            try {
              const serialized = serializePreview3mfForDisk(json);
              if (serialized.length <= PREVIEW_3MF_MAX_DISK_CACHE_MB * 1024 * 1024) {
                await fs.promises.mkdir(cacheDir, { recursive: true });
                await fs.promises.writeFile(cachePath, serialized);
              }
            } catch (cacheError) {
              console.error('Error writing 3MF preview cache:', cacheError);
            }
          }
        }

        resolve(normalizePreview3mfTypedArrays(json));
      });
    };

    const onError = async (error) => {
      finish(async () => {
        await cleanup();
        reject(new Error(formatPreview3mfError(error)));
      });
    };

    const onExit = async (code) => {
      if (code === 0) return;
      finish(async () => {
        await cleanup();
        reject(new Error(`3MF preview worker exited unexpectedly (code ${code})`));
      });
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    worker.postMessage({ filePath: actualFilePath });
  });
};

ipcMain.handle('parse-3mf-preview', parse3mfPreviewHandler);
// Register in handler registry for direct WebSocket invocation
ipcHandlerRegistry.set('parse-3mf-preview', parse3mfPreviewHandler);

ipcMain.handle('cancel-3mf-preview', async (event, requestId) => {
  const entry = preview3mfWorkers.get(requestId);
  if (!entry) return;

  terminatePreview3mfWorker(entry.entry);
  await entry.cleanup?.();
  entry.reject?.(new Error('Preview cancelled'));
});

// Handler to pull metadata from 3MF files
ipcMain.handle('pull-3mf-metadata', async (event, filePaths) => {
  try {
    const filePathsArray = Array.isArray(filePaths) ? filePaths : [filePaths];
    
    // Filter to only 3MF files
    const threeMFFiles = filePathsArray.filter(fp => {
      const ext = path.extname(fp).toLowerCase();
      // Handle zip entries - check the entry path extension
      if (fp.includes('::')) {
        const entryPath = fp.split('::')[1];
        return path.extname(entryPath).toLowerCase() === '.3mf';
      }
      return ext === '.3mf';
    });
    
    if (threeMFFiles.length === 0) {
      throw new Error('No 3MF files selected');
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
        return { success: false, cancelled: true };
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
    
    return {
      success: true,
      processed: threeMFFiles.length,
      successCount,
      errorCount,
      noMetadataCount,
      results
    };
  } catch (error) {
    console.error('Error pulling 3MF metadata:', error);
    throw error;
  }
});

// Add handler to extract model from zip to temp file
ipcMain.handle('extract-model-from-zip', async (event, filePath) => {
  if (isUrlModel(filePath)) throw new Error('URL-only model has no file to extract');
  try {
    const pathInfo = parseZipPath(filePath);
    if (!pathInfo.isZipEntry) {
      // Not a zip entry, return original path
      return filePath;
    }
    
    return await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
  } catch (error) {
    console.error('Error extracting model from zip:', error);
    throw error;
  }
});

// Renderer cleanup for extract temps (loadModel / preview)
ipcMain.handle('delete-temp-file', async (event, filePath) => {
  try {
    return await cleanupExtractTempFile(filePath);
  } catch (error) {
    console.warn('delete-temp-file failed:', error.message);
    return false;
  }
});
ipcHandlerRegistry.set('delete-temp-file', async (event, filePath) => {
  return await cleanupExtractTempFile(filePath);
});

// Add handler to extract zip archive
ipcMain.handle('extract-zip-archive', async (event, filePath, destinationPath) => {
  try {
    const pathInfo = parseZipPath(filePath);
    if (!pathInfo.isZipEntry) {
      throw new Error('Not a zip entry');
    }
    
    const entryData = await extractZipEntryBuffer(pathInfo.zipPath, pathInfo.entryPath);

    // Create destination path preserving directory structure
    const destPath = path.join(destinationPath, pathInfo.entryPath);
    const destDir = path.dirname(destPath);
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.writeFile(destPath, entryData);
    
    return destPath;
  } catch (error) {
    console.error('Error extracting zip archive:', error);
    throw error;
  }
});

function parseDuplicatesRequest(includeZipOrOptions) {
  if (includeZipOrOptions && typeof includeZipOrOptions === 'object' && !Array.isArray(includeZipOrOptions)) {
    const filters = includeZipOrOptions.filters && typeof includeZipOrOptions.filters === 'object'
      ? includeZipOrOptions.filters
      : null;
    return { includeZip: !!includeZipOrOptions.includeZip, filters };
  }
  return { includeZip: !!includeZipOrOptions, filters: null };
}

// Add a new IPC handler for getting duplicates
const getDuplicatesHandler = async (event, includeZipOrOptions = false) => {
  const { includeZip, filters } = parseDuplicatesRequest(includeZipOrOptions);
  const maxRetries = isGeneratingHashes ? 5 : 1;
  const retryDelayMs = 150;
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Only fetch rows whose hash has 2+ distinct paths (avoids loading every unique model into memory).
      // Zip entries use "archive::entry" paths — exclude them unless includeZip is true.
      // Optional filters (current library view) apply to both the hash-count subquery
      // and the file list so De-Dup can run on a designer/tag/query subset.
      const zipClause = includeZip ? '' : " AND instr(filePath, '::') = 0";
      const outerFilter = buildModelFilterConditions(filters);
      const innerFilter = buildModelFilterConditions(filters);
      const rows = database.db.prepare(`
        SELECT filePath, fileName, hash, size
        FROM models
        WHERE hash IS NOT NULL
          AND hash != ''
          AND LENGTH(TRIM(hash)) > 0
          ${zipClause}
          ${sqlAndFilterConditions(outerFilter.conditions)}
          AND hash IN (
            SELECT hash
            FROM models
            WHERE hash IS NOT NULL
              AND hash != ''
              AND LENGTH(TRIM(hash)) > 0
              ${zipClause}
              ${sqlAndFilterConditions(innerFilter.conditions)}
            GROUP BY hash
            HAVING COUNT(DISTINCT filePath) > 1
          )
        ORDER BY hash, filePath
      `).all(...outerFilter.params, ...innerFilter.params);

      // Group by hash; dedupe by filePath (DB can have duplicate rows for the same path)
      const groupsByHash = new Map();
      for (const row of rows) {
        if (!row.hash || row.hash.trim() === '') continue;
        let group = groupsByHash.get(row.hash);
        if (!group) {
          group = { hash: row.hash, files: [], seen: new Set() };
          groupsByHash.set(row.hash, group);
        }
        if (group.seen.has(row.filePath)) continue;
        group.seen.add(row.filePath);
        // Omit redundant per-file hash to keep IPC payload lean for large libraries
        group.files.push({
          filePath: row.filePath,
          fileName: row.fileName,
          size: row.size
        });
      }

      const duplicateGroups = [];
      for (const group of groupsByHash.values()) {
        if (group.files.length > 1) {
          duplicateGroups.push({ hash: group.hash, files: group.files });
        }
      }

      console.log('Found duplicate groups:', duplicateGroups.length);
      // Array of { hash, files } — leaner than a hash-keyed object for large result sets
      return duplicateGroups;
    } catch (error) {
      lastError = error;
      console.error('Error getting duplicates (attempt ' + (attempt + 1) + '/' + maxRetries + '):', error);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastError;
};
ipcMain.handle('get-duplicates', getDuplicatesHandler);
ipcHandlerRegistry.set('get-duplicates', getDuplicatesHandler);

function countModelsNeedingHash({ includeSha256 = false, filters = null } = {}) {
  const hashClause = includeSha256
    ? `(hash IS NULL OR hash = '' OR LENGTH(hash) = 64)`
    : `(hash IS NULL OR hash = '')`;
  const { conditions, params } = buildModelFilterConditions(filters);
  const row = database.db.prepare(`
    SELECT COUNT(*) as count FROM models
    WHERE ${hashClause}
      AND filePath NOT LIKE 'url::%'
      ${sqlAndFilterConditions(conditions)}
  `).get(...params);
  return row ? row.count : 0;
}

function emitHashGenerationProgress(event, payload) {
  if (global.broadcastEvent) {
    global.broadcastEvent('hash-generation-progress', payload);
  } else if (event && event.sender) {
    event.sender.send('hash-generation-progress', payload);
  }
}

function emitHashGenerationComplete(event, payload) {
  if (global.broadcastEvent) {
    global.broadcastEvent('hash-generation-complete', payload);
  } else if (event && event.sender) {
    event.sender.send('hash-generation-complete', payload);
  }
}

// Internal function to calculate missing hashes
async function calculateMissingHashesInternal(event, filters = null) {
  if (isGeneratingHashes) {
    return { alreadyRunning: true, calculated: 0, failed: 0, total: 0 };
  }
  try {
    // Set hash generation state
    isGeneratingHashes = true;

    // Missing hashes, plus SHA256 (64 hex chars) that can be regenerated as MD5.
    // SHA256 still groups duplicates correctly — conversion is best-effort.
    const filterSql = buildModelFilterConditions(filters);
    const modelsWithMissingHashes = database.db.prepare(`
      SELECT filePath, fileName, size, hash
      FROM models
      WHERE (hash IS NULL OR hash = '' OR LENGTH(hash) = 64)
        AND filePath NOT LIKE 'url::%'
        ${sqlAndFilterConditions(filterSql.conditions)}
    `).all(...filterSql.params);

    console.log(`Found ${modelsWithMissingHashes.length} models with missing or SHA256 hashes (need MD5)`);

    if (modelsWithMissingHashes.length === 0) {
      isGeneratingHashes = false;
      return { calculated: 0, failed: 0, total: 0 };
    }

    console.log('Starting parallel hash calculation for', modelsWithMissingHashes.length, 'files');

    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let firstError = '';
    const updateHash = database.db.prepare('UPDATE models SET hash = ? WHERE filePath = ?');
    const progressPayload = () => ({
      processed: processedCount,
      total: modelsWithMissingHashes.length,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount
    });

    emitHashGenerationProgress(event, progressPayload());

    // Process files in parallel with concurrency limit
    // Keep Docker/server concurrency low — high parallelism + thumb renders saturates UNC/CIFS.
    const concurrencyLimit = 4;
    
    // Helper function to calculate hash with retry and timeout
    const calculateFileHashWithRetry = async (filePath, maxRetries = 2) => {
      let lastError;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Add timeout for file operations (especially important for network files in Docker)
          const timeoutMs = 300000; // 5 min for server mode, 1 min for normal
          const hashPromise = calculateFileHash(filePath);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Hash calculation timeout after ${timeoutMs}ms`)), timeoutMs)
          );
          
          return await Promise.race([hashPromise, timeoutPromise]);
        } catch (error) {
          lastError = error;
          // Only retry on certain errors (network issues, timeouts, temporary file system errors)
          const isRetryableError = error.code === 'ETIMEDOUT' || 
                                   error.code === 'ENOENT' || 
                                   error.code === 'EACCES' ||
                                   error.code === 'Z_BUF_ERROR' ||
                                   error.message.includes('timeout') ||
                                   error.message.includes('ENOTFOUND') ||
                                   isFragileZipError(error);
          
          if (attempt < maxRetries && isRetryableError) {
            console.warn(`Retry ${attempt + 1}/${maxRetries} for ${filePath}: ${error.message}`);
            // Exponential backoff: 1s, 2s, 4s
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            continue;
          }
          throw error;
        }
      }
      throw lastError;
    };

    const processFile = async (model) => {
      try {
        const readablePath = resolveReadableModelPath(model.filePath);
        const existingHash = model.hash && String(model.hash).trim();
        const hasSha256 = existingHash && existingHash.length === 64;

        if (readablePath) {
          try {
            const hash = await calculateFileHashWithRetry(readablePath);
            updateHash.run(hash, model.filePath);
            successCount++;
            console.log(`Hash calculated for: ${model.filePath} (${successCount} succeeded, ${failedCount} failed, ${processedCount + 1}/${modelsWithMissingHashes.length} total)`);
          } catch (hashError) {
            if (hasSha256) {
              skippedCount++;
              console.warn(`Keeping existing SHA256 hash; MD5 regeneration failed for ${model.filePath}: ${hashError.message}`);
            } else {
              failedCount++;
              if (!firstError) firstError = hashError.message || String(hashError);
              console.error(`Failed to calculate hash for ${model.filePath} after retries:`, hashError.message);
            }
          }
        } else if (hasSha256) {
          skippedCount++;
          console.warn(`Keeping existing SHA256 hash; file not readable: ${model.filePath}`);
        } else {
          console.warn(`File no longer exists: ${model.filePath}`);
          failedCount++;
          if (!firstError) firstError = `File not found: ${model.filePath}`;
        }
        
        processedCount++;
        emitHashGenerationProgress(event, progressPayload());
      } catch (error) {
        console.error(`Unexpected error processing ${model.filePath}:`, error);
        failedCount++;
        if (!firstError) firstError = error.message || String(error);
        processedCount++;
        emitHashGenerationProgress(event, progressPayload());
      }
    };

    // Process files in parallel batches
    for (let i = 0; i < modelsWithMissingHashes.length; i += concurrencyLimit) {
      const batch = modelsWithMissingHashes.slice(i, i + concurrencyLimit);
      await Promise.all(batch.map(processFile));
    }

    isGeneratingHashes = false;

    console.log(`Hash generation complete: ${successCount} succeeded, ${failedCount} failed, ${skippedCount} skipped out of ${modelsWithMissingHashes.length} total`);

    const completePayload = {
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      total: modelsWithMissingHashes.length,
      firstError: firstError || undefined
    };
    emitHashGenerationComplete(event, completePayload);

    return { 
      calculated: successCount, 
      failed: failedCount,
      skipped: skippedCount,
      total: modelsWithMissingHashes.length,
      firstError: firstError || undefined
    };
  } catch (error) {
    isGeneratingHashes = false;
    console.error('Error calculating missing hashes:', error);
    throw error;
  }
}

// Add IPC handler to calculate missing hashes
ipcMain.handle('calculate-missing-hashes', async (event) => {
  return await calculateMissingHashesInternal(event);
});

// Add IPC handler for generateMissingHashes (calls the same internal function)
const generateMissingHashesHandler = async (event, filters = null) => {
  // Check if hash generation is already in progress
  if (isGeneratingHashes) {
    console.log('Hash generation already in progress, returning current status');
    return {
      alreadyRunning: true,
      total: countModelsNeedingHash({ includeSha256: true, filters })
    };
  }
  const total = countModelsNeedingHash({ includeSha256: true, filters });
  if (total === 0) {
    return { calculated: 0, failed: 0, total: 0 };
  }
  // Don't hold the WebSocket IPC slot for the entire hash run (default 30s timeout
  // made Docker/server Dedup report that every hash failed).
  calculateMissingHashesInternal(event, filters).catch((error) => {
    isGeneratingHashes = false;
    console.error('Error calculating missing hashes:', error);
    emitHashGenerationComplete(event, {
      success: 0,
      failed: total,
      total,
      firstError: error.message || String(error)
    });
  });
  return { started: true, total };
};
ipcMain.handle('generateMissingHashes', generateMissingHashesHandler);
ipcHandlerRegistry.set('generateMissingHashes', generateMissingHashesHandler);

const getModelsWithoutHashHandler = async (event, filters = null) => {
  try {
    // SHA256 hashes already work for Dedup grouping — only prompt when hash is empty.
    return countModelsNeedingHash({ includeSha256: false, filters });
  } catch (error) {
    console.error('Error getting models without hash:', error);
    return 0;
  }
};
ipcMain.handle('getModelsWithoutHash', getModelsWithoutHashHandler);
ipcHandlerRegistry.set('getModelsWithoutHash', getModelsWithoutHashHandler);

// Add IPC handler to check if hash generation is in progress
ipcMain.handle('is-generating-hashes', async () => {
  return isGeneratingHashes;
});

// Add IPC handler to calculate and save hash for a single file
ipcMain.handle('calculate-file-hash', async (event, filePath) => {
  if (isUrlModel(filePath)) return '';
  try {
    const hash = await calculateFileHash(filePath);
    // Update the database with the calculated hash
    database.db.prepare('UPDATE models SET hash = ? WHERE filePath = ?').run(hash, filePath);
    return hash;
  } catch (error) {
    console.error(`Error calculating hash for ${filePath}:`, error);
    throw error;
  }
});

// Add this IPC handler for thumbnails
ipcMain.handle('getThumbnail', async (event, filePath) => {
  try {
    const stored = loadThumbnailForModel(filePath);
    if (!stored) return null;
    return getDefaultThumbnail(stored, 0);
  } catch (error) {
    console.error('Error getting thumbnail:', error);
    return null;
  }
});

// IPC handler to get all thumbnails for a model
ipcMain.handle('get-all-thumbnails', async (event, filePath) => {
  try {
    const stored = loadThumbnailForModel(filePath);
    if (!stored) return [];
    return parseThumbnails(stored);
  } catch (error) {
    console.error('Error getting all thumbnails:', error);
    return [];
  }
});

// Helper function to add multiple thumbnails at once
function addMultipleThumbnails(thumbnailString, newThumbnails) {
  if (!newThumbnails || newThumbnails.length === 0) return thumbnailString;
  const thumbnails = parseThumbnails(thumbnailString);
  
  // Add all new thumbnails, avoiding duplicates by checking the full string
  for (const newThumbnail of newThumbnails) {
    if (newThumbnail && typeof newThumbnail === 'string' && newThumbnail.length > 0) {
      // Check if this exact thumbnail already exists
      const exists = thumbnails.some(t => t === newThumbnail);
      if (!exists) {
        thumbnails.push(newThumbnail);
      }
    }
  }
  return thumbnails.join('::');
}

// IPC handler to add a thumbnail to a model
ipcMain.handle('add-thumbnail', async (event, filePath, imageDataUrl) => {
  try {
    const currentThumbnail = readThumbnailColumn(filePath);
    const compressedImage = compressDataUrl(imageDataUrl);
    const thumbnailsWithNew = addThumbnailToModel(currentThumbnail, compressedImage);
    
    // Parse thumbnails to get count and new index
    const thumbnails = parseThumbnails(thumbnailsWithNew);
    const newImageIndex = thumbnails.length - 1; // The new image is at the end
    
    // Make the new image the default (move it to the front)
    const updatedThumbnail = setDefaultThumbnailIndex(thumbnailsWithNew, newImageIndex);
    await saveThumbnail(filePath, updatedThumbnail);
    
    // Verify the save was successful
    const finalThumbnails = parseThumbnails(readThumbnailColumn(filePath) || '');
    
    // Send message to renderer to refresh the grid with updated thumbnail
    // In server mode always broadcast so browser clients get the update (invoke may come via hidden window)
    if (global.broadcastEvent) {
      global.broadcastEvent('thumbnail-added', {
        filePath: filePath,
        thumbnailCount: finalThumbnails.length,
        hasMultiple: finalThumbnails.length > 1,
        newImageIsDefault: true
      });
    } else if (event && event.sender) {
      event.sender.send('thumbnail-added', {
        filePath: filePath,
        thumbnailCount: finalThumbnails.length,
        hasMultiple: finalThumbnails.length > 1,
        newImageIsDefault: true
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error adding thumbnail:', error);
    throw error;
  }
});

// IPC handler to add multiple thumbnails at once (for 3MF files)
ipcMain.handle('add-multiple-thumbnails', async (event, filePath, imageDataUrls) => {
  try {
    if (!imageDataUrls || !Array.isArray(imageDataUrls) || imageDataUrls.length === 0) {
      return false;
    }
    
    // Check if model exists in database
    let model = getModelByFilePath(filePath);
    if (!model) {
      // Model doesn't exist yet - create it with just the thumbnails
      // Extract fileName from filePath
      const path = require('path');
      const fileName = path.basename(filePath);
      // Create model entry
      const dateAdded = new Date().toISOString();
      const bundle = deriveBundleFromFilePath(filePath);
      database.db.prepare(`
        INSERT INTO models (filePath, fileName, thumbnail, dateAdded, isNew, bundleKey, bundleLabel, bundleKind)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        filePath,
        fileName,
        '',
        dateAdded,
        bundle.bundleKey || null,
        bundle.bundleLabel || null,
        bundle.bundleKind || null
      );
      // Re-fetch the model
      model = getModelByFilePath(filePath);
      if (!model) {
        return false;
      }
    }
    
    const currentThumbnail = readThumbnailColumn(filePath);
    
    // Filter out any null/undefined/empty images and compress on ingest
    const validImages = imageDataUrls
      .filter(img => img && typeof img === 'string' && img.length > 0)
      .map((img) => compressDataUrl(img));
    
    if (validImages.length === 0) {
      return false;
    }
    
    const updatedThumbnail = addMultipleThumbnails(currentThumbnail, validImages);
    const finalCount = parseThumbnails(updatedThumbnail).length;
    
    // Save the thumbnail
    await saveThumbnail(filePath, updatedThumbnail);
    
    // Verify it was saved
    const verifyThumbnail = readThumbnailColumn(filePath);
    const verifyCount = verifyThumbnail ? parseThumbnails(verifyThumbnail).length : 0;
    
    if (verifyCount !== finalCount) {
      // Try to save again
      await saveThumbnail(filePath, updatedThumbnail);
    }
    
    // Return the updated thumbnail string so renderer can use it
    return {
      success: true,
      thumbnailCount: verifyCount,
      thumbnailString: verifyThumbnail || updatedThumbnail
    };
  } catch (error) {
    console.error('Error adding multiple thumbnails:', error);
    console.error('Error stack:', error.stack);
    throw error;
  }
});

// IPC handler to set the default thumbnail index
ipcMain.handle('set-default-thumbnail', async (event, filePath, index) => {
  try {
    const thumbnail = readThumbnailColumn(filePath);
    if (!thumbnail) return false;
    const updatedThumbnail = setDefaultThumbnailIndex(thumbnail, index);
    await saveThumbnail(filePath, updatedThumbnail);
    const thumbs = parseThumbnails(updatedThumbnail);
    const payload = {
      filePath,
      thumbnailCount: thumbs.length,
      defaultChanged: true
    };
    if (global.broadcastEvent) {
      global.broadcastEvent('thumbnail-default-changed', payload);
    } else if (event && event.sender) {
      event.sender.send('thumbnail-default-changed', payload);
    }
    return true;
  } catch (error) {
    console.error('Error setting default thumbnail:', error);
    throw error;
  }
});

// IPC handler to delete a thumbnail by index
ipcMain.handle('delete-thumbnail', async (event, filePath, index) => {
  try {
    const thumbnail = readThumbnailColumn(filePath);
    if (!thumbnail) return false;
    
    const thumbnails = parseThumbnails(thumbnail).filter(t => t && t !== '3d.png' && t.length > 0 && t.startsWith('data:image'));
    
    // Ensure model has at least one thumbnail and index is valid
    if (thumbnails.length <= 1) {
      throw new Error('Cannot delete thumbnail: model must have at least one thumbnail');
    }
    
    if (index < 0 || index >= thumbnails.length) {
      throw new Error('Invalid thumbnail index');
    }
    
    // Cannot delete the active (first) thumbnail
    if (index === 0) {
      throw new Error('Cannot delete the active thumbnail');
    }
    
    // Remove the thumbnail at the specified index
    thumbnails.splice(index, 1);
    const updatedThumbnail = thumbnails.join('::');
    await saveThumbnail(filePath, updatedThumbnail);
    
    // Send refresh event
    if (event && event.sender) {
      event.sender.send('thumbnail-deleted', {
        filePath: filePath,
        thumbnailCount: thumbnails.length
      });
    } else if (global.broadcastEvent) {
      global.broadcastEvent('thumbnail-deleted', {
        filePath: filePath,
        thumbnailCount: thumbnails.length
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error deleting thumbnail:', error);
    throw error;
  }
});

// Update the checkForUpdates function to track user's response
async function checkForUpdates(isBeta = false) {
  try {
    // First check if we've already shown update dialog this session
    const versionCheckPerformed = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('versionCheckPerformedOnStartup');
    if (versionCheckPerformed && versionCheckPerformed.value === 'true') {
      console.log('Version check already performed this session, skipping');
      return null;
    }

    return new Promise((resolve, reject) => {
      const versionUrl = releasesApiUrl(isBeta);
      console.log('Main Process - Checking GitHub releases:', versionUrl);

      https.get(versionUrl, {
        // GitHub's API requires a User-Agent.
        headers: { 'User-Agent': 'Printventory', Accept: 'application/vnd.github+json' }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          let version = null;
          try {
            version = latestVersionFromReleases(JSON.parse(data), isBeta);
          } catch (_) {
            version = null;
          }
          console.log('Main Process - Latest release:', version, `(HTTP ${res.statusCode})`);
          if (version) {
            console.log('Main Process - Valid version format received:', version);
            // Update the database with the latest version
            try {
              database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(version, 'latestVersion');
              database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(new Date().toISOString(), 'lastUpdateCheck');
              // Mark that we've performed the version check
              database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('true', 'versionCheckPerformedOnStartup');
              console.log('Database updated with latest version:', version);
            } catch (dbError) {
              console.error('Error updating version in database:', dbError);
            }
            resolve(version);
          } else {
            reject(new Error(`No release found (HTTP ${res.statusCode})`));
          }
        });
      }).on('error', (err) => {
        console.error('Error checking for updates:', err);
        reject(err);
      });
    });
  } catch (error) {
    console.error('Error in checkForUpdates:', error);
    return null;
  }
}

// Update the IPC handler
ipcMain.handle('check-for-updates', async (event, isBeta) => {
  try {
    console.log('Main Process - Update check requested:', { isBeta });
    // Add timeout to the version check
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Version check timed out')), 5000);
    });
    
    const versionPromise = checkForUpdates(isBeta);
    const latestVersion = await Promise.race([versionPromise, timeoutPromise]);
    
    console.log('Main Process - Latest version found:', latestVersion);
    return latestVersion;
  } catch (error) {
    console.error('Error checking for updates:', error);
    // Return current version to prevent update dialog on failure
    const currentVersion = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('currentVersion');
    return currentVersion?.value || null;
  }
});

// The browser opens the release page; the server only knows the address.
ipcMain.handle('open-update-page', async (event, isBeta) => releasesPageUrl(isBeta));

// Add new IPC handler for opening folder dialog
ipcMain.handle('open-folder-dialog', async (event, titleOrOptions) => {
  const options = titleOrOptions && typeof titleOrOptions === 'object' ? titleOrOptions : { title: titleOrOptions };
  const folder = await askForFolder(event, { title: options.title, defaultPath: options.defaultPath });
  return folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] };
});

// Add new IPC handler for moving multiple files
ipcMain.handle('move-files', async (event, filePaths, destinationFolder) => {
  try {
    for (const filePath of filePaths) {
      // Check if the file exists before moving
      if (!fs.existsSync(filePath)) {
        console.error(`File does not exist: ${filePath}`);
        throw new Error(`File does not exist: ${filePath}`);
      }

      const newDestination = path.join(destinationFolder, path.basename(filePath));
      console.log(`Moving file from ${filePath} to ${newDestination}`); // Log the move operation
      await fs.promises.rename(filePath, newDestination);
      database.db.prepare('UPDATE models SET filePath = ? WHERE filePath = ?').run(newDestination, filePath);
    }
    event.sender.send('refresh-grid');
    return true;
  } catch (error) {
    console.error("Error moving files:", error);
    throw error;
  }
});

// Add these IPC listeners near the end of your main.js file
function inspectOrganizeDirectory(dirPath, allowMissing) {
  const target = String(dirPath || '').trim();
  if (!target) {
    return { ok: false, error: 'Choose a source directory and a destination directory.' };
  }
  try {
    validateUncPath(target, 'organize-library');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return { ok: false, error: `"${target}" is not a folder.` };
    return { ok: true, path: target, created: false };
  } catch (err) {
    if (err && err.code === 'ENOENT' && allowMissing) return { ok: true, path: target, created: true };
    if (err && err.code === 'ENOENT') return { ok: false, error: `Folder not found: ${target}` };
    return { ok: false, error: err.message || 'Could not read that folder.' };
  }
}

function statOrganizeFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, isFile: st.isFile() };
  } catch (_) {
    return null;
  }
}

function readScannedDirectorySetting() {
  try {
    if (!database.db) return [];
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('scannedDirectories');
    const parsed = JSON.parse(row && row.value ? row.value : '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function rememberScannedDirectory(directoryPath) {
  const dir = String(directoryPath || '').trim();
  if (!dir || !database.db) return;
  const list = readScannedDirectorySetting();
  if (list.some((item) => pathsAreSame(item, dir))) return;
  list.push(dir);
  try {
    database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'scannedDirectories',
      JSON.stringify(list)
    );
  } catch (error) {
    console.error('Could not remember scanned directory:', error);
  }
}

function directoryExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function listOrganizeSources() {
  const saved = readScannedDirectorySetting();
  const homes = readStlHomeDirectories();
  let lastScan = '';
  try {
    lastScan = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value || '';
  } catch (_) {
    lastScan = '';
  }
  let forestRoots = [];
  try {
    const rows = database.db.prepare('SELECT filePath FROM models').all();
    const forest = buildFolderForest(rows.map((row) => row.filePath).filter(Boolean), {
      stlHome: homes[0] || '',
      roots: [...saved, ...homes, lastScan].filter(Boolean)
    });
    forestRoots = Array.isArray(forest.roots) ? forest.roots : [];
  } catch (error) {
    console.error('Could not list scanned directories:', error);
  }

  const items = [];
  const add = (dir) => {
    const folder = String(dir || '').trim();
    if (!folder || folder.includes('::') || !directoryExists(folder)) return;
    const normalized = path.normalize(folder);
    if (items.some((item) => pathsAreSame(item.path, normalized))) return;
    items.push({ path: normalized, label: normalized });
  };

  for (const node of forestRoots) {
    if (!node || node.isBundle) continue;
    add(node.path);
  }
  for (const dir of saved) add(dir);
  for (const dir of homes) add(dir);
  if (lastScan) add(lastScan);

  items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return items;
}

function zipArchivesEnabled() {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
    return !!(row && row.value === '1');
  } catch (_) {
    return false;
  }
}

function buildOrganizePlan(sourceDir, destDir, includeZips, layers) {
  const source = inspectOrganizeDirectory(sourceDir, false);
  if (!source.ok) {
    return { ok: false, error: source.error, moves: [], skipped: [], sample: [], copyCount: 0, resumeCount: 0, copyBytes: 0, noParentCount: 0, reasonCounts: {} };
  }
  const dest = inspectOrganizeDirectory(destDir, true);
  if (!dest.ok) {
    return { ok: false, error: dest.error, moves: [], skipped: [], sample: [], copyCount: 0, resumeCount: 0, copyBytes: 0, noParentCount: 0, reasonCounts: {} };
  }
  const rows = database.db.prepare('SELECT id, filePath, fileName, designer, parentModel, license, source, print_status, size FROM models').all();
  const plan = planOrganize(rows, source.path, dest.path, {
    sourceStat: statOrganizeFile,
    destStat: statOrganizeFile,
    includeZips: includeZips === true && zipArchivesEnabled(),
    layers: Array.isArray(layers) ? layers : undefined,
    allowedRoots: listOrganizeSources().map((item) => item.path)
  });
  return Object.assign(plan, {
    destWillBeCreated: !!dest.created,
    sourceDir: source.path,
    destDir: dest.path
  });
}

function publicOrganizePreview(plan) {
  return {
    ok: !!plan.ok,
    error: plan.error || null,
    spaceError: plan.spaceError || null,
    enoughSpace: !!plan.enoughSpace,
    freeBytes: plan.freeBytes == null ? null : plan.freeBytes,
    marginBytes: plan.marginBytes,
    copyBytes: plan.copyBytes || 0,
    copyCount: plan.copyCount || 0,
    resumeCount: plan.resumeCount || 0,
    zipCount: plan.zipCount || 0,
    zipEntryCount: plan.zipEntryCount || 0,
    noParentCount: plan.noParentCount || 0,
    emptyLayers: Array.isArray(plan.emptyLayers) ? plan.emptyLayers : [],
    layers: Array.isArray(plan.layers) ? plan.layers : [],
    skippedCount: Array.isArray(plan.skipped) ? plan.skipped.length : 0,
    reasonCounts: plan.reasonCounts || {},
    sample: plan.sample || [],
    skipped: Array.isArray(plan.skipped) ? plan.skipped.slice(0, 40) : [],
    destWillBeCreated: !!plan.destWillBeCreated,
    sourceDir: plan.sourceDir || '',
    destDir: plan.destDir || ''
  };
}

function sendOrganizeEvent(event, channel, data) {
  if (typeof global.sendEvent === 'function') {
    global.sendEvent(event, channel, data);
    return;
  }
  if (event && event.sender) event.sender.send(channel, data);
}

ipcMain.handle('list-organize-sources', async () => {
  try {
    return listOrganizeSources();
  } catch (error) {
    console.error('Could not list organize sources:', error);
    return [];
  }
});

ipcMain.handle('organize-library-preview', async (event, payload) => {
  try {
    const sourceDir = payload && payload.sourceDir;
    const destDir = payload && payload.destDir;
    const plan = buildOrganizePlan(sourceDir, destDir, payload && payload.includeZips, payload && payload.layers);
    let free = null;
    const spacePath = plan.destDir || destDir;
    if (spacePath) {
      try {
        free = await readFreeBytes(spacePath);
      } catch (_) {
        free = null;
      }
    }
    return publicOrganizePreview(withFreeSpace(plan, free));
  } catch (err) {
    console.error('Organize library preview failed:', err);
    return {
      ok: false,
      error: err.message || 'Could not preview the organize job.',
      enoughSpace: false,
      sample: [],
      skipped: [],
      copyCount: 0,
      resumeCount: 0
    };
  }
});

ipcMain.handle('organize-library-run', async (event, payload) => {
  let progressOpen = false;
  try {
    const sourceDir = payload && payload.sourceDir;
    const destDir = payload && payload.destDir;
    let free = null;
    try {
      free = await readFreeBytes(destDir);
    } catch (_) {
      free = null;
    }
    const plan = withFreeSpace(buildOrganizePlan(sourceDir, destDir, payload && payload.includeZips, payload && payload.layers), free);
    if (!plan.ok) return { ok: false, error: plan.error || 'Could not organize that folder.' };
    if (!plan.enoughSpace) return { ok: false, error: plan.spaceError || 'Not enough free disk space.' };
    const total = (plan.copyCount || 0) + (plan.resumeCount || 0);
    if (!total) return { ok: false, error: 'Nothing to move.' };
    if (plan.destWillBeCreated) {
      await fs.promises.mkdir(plan.destDir, { recursive: true });
    }
    sendOrganizeEvent(event, 'show-progress-dialog', {
      title: 'Organize Library',
      message: 'Copying models...',
      total
    });
    progressOpen = true;
    const updatePath = database.db.prepare('UPDATE models SET filePath = ?, fileName = ? WHERE filePath = ?');
    const updateZipEntry = database.db.prepare('UPDATE models SET filePath = ?, bundleKey = ?, bundleLabel = ?, bundleKind = ? WHERE filePath = ?');
    const updateZipEntries = database.db.transaction((rows) => {
      for (const row of rows) {
        const bundle = deriveBundleFromFilePath(row.to);
        const info = updateZipEntry.run(
          row.to,
          bundle.bundleKey || null,
          bundle.bundleLabel || null,
          bundle.bundleKind || null,
          row.from
        );
        if (!info.changes) throw new Error('Library record was not updated');
      }
    });
    const results = await runOrganizePlan(plan, {
      updateFilePath: (from, to) => {
        const info = updatePath.run(to, path.basename(to), from);
        if (!info.changes) throw new Error('Library record was not updated');
      },
      updateLibrary: (updates) => updateZipEntries(updates),
      onProgress: (current, count, move) => {
        sendOrganizeEvent(event, 'update-progress', {
          current,
          total: count,
          message: move ? path.basename(move.to) : 'Finishing...'
        });
      }
    });
    sendOrganizeEvent(event, 'close-progress-dialog');
    progressOpen = false;
    sendOrganizeEvent(event, 'refresh-grid');
    return {
      ok: results.failed.length === 0,
      moved: results.moved,
      resumed: results.resumed,
      failed: results.failed.slice(0, 20),
      failedCount: results.failed.length,
      warnings: results.warnings.slice(0, 20),
      warningCount: results.warnings.length,
      skipped: results.skipped,
      zipModels: results.zipModels || 0
    };
  } catch (err) {
    console.error('Organize library run failed:', err);
    if (progressOpen) sendOrganizeEvent(event, 'close-progress-dialog');
    sendOrganizeEvent(event, 'refresh-grid');
    return { ok: false, error: err.message || 'Organize failed.' };
  }
});



ipcMain.handle('getTotalModelCount', async () => {
  try {
    // Query total count from the models table
    const row = database.db.prepare("SELECT COUNT(*) AS total FROM models").get();
    return row.total;
  } catch (error) {
    console.error("Error getting total model count:", error);
    return 0;
  }
});



// Add IPC handlers for AI Config
const testAIConfigHandler = async (event, apiKey, baseURL, model, service) => {
  const aitagging = require('./aitagging');
  // Normalize service to handle case/whitespace variations
  const normalizedService = service ? String(service).toLowerCase().trim() : 'openai';
  // If endpoint contains puter.com, treat as Puter service
  const isPuterService = normalizedService === 'puter' || 
    (baseURL && (baseURL.includes('puter.com') || baseURL.includes('js.puter.com')));
  
  console.log('[Main] test-ai-config handler:', { 
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
  console.log('[Main] Created puterIPCHandler:', { 
    isPuterService, 
    hasHandler: !!puterIPCHandler,
    handlerType: typeof puterIPCHandler
  });
  
  return await aitagging.testAIConfig(apiKey, baseURL, model, service, puterIPCHandler);
};

// Register handler for both IPC and WebSocket (server mode)
ipcMain.handle('test-ai-config', testAIConfigHandler);

ipcMain.handle('get-default-ai-prompt', async () => {
  const settings = getSettings();
  const aitagging = require('./aitagging');
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
  console.log('[Puter IPC Handler] createPuterIPCHandler called, has event:', !!event, 'event keys:', event ? Object.keys(event) : []);
  
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
      console.log('[Puter IPC Handler] Found webContents from event.sender');
    }
    // In server mode, event might have a wsClient property (set by WebSocket handler)
    if (event.wsClient) {
      wsClient = event.wsClient;
      console.log('[Puter IPC Handler] Found wsClient from event.wsClient');
    } else {
      console.log('[Puter IPC Handler] No wsClient found in event');
    }
  } else {
    console.log('[Puter IPC Handler] No event provided');
  }
  
  console.log('[Puter IPC Handler] Extracted:', { hasWebContents: !!webContents, hasWsClient: !!wsClient, true: true });
  
  return async (prompt, imageUrl, model) => {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      // Store both webContents and wsClient for routing responses
      puterPendingRequests.set(requestId, { resolve, reject, webContents, wsClient });
      
      // In server mode with WebSocket client, send via WebSocket
      // This routes to the browser client where Puter.js is loaded and can show the captcha
      if (wsClient) {
        console.log('[Puter AI] Sending request to browser client via WebSocket (captcha will appear in browser window)');
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
      
      // Timeout after 60 seconds
      setTimeout(() => {
        if (puterPendingRequests.has(requestId)) {
          puterPendingRequests.delete(requestId);
          reject(new Error('Puter AI request timeout'));
        }
      }, 60000);
    });
  };
}

// IPC handler for puter.com AI calls (forwards to renderer)
ipcMain.handle('puter-ai-chat', async (event, prompt, imageUrl, model) => {
  // Pass event so it can route to the correct client (WebSocket in server mode, IPC in normal mode)
  const handler = createPuterIPCHandler(event);
  return await handler(prompt, imageUrl, model);
});

async function generateTagsHandler(event, filePath) {
  try {
    const aitagging = require('./aitagging');
    const settings = getSettings();
    
    // Create puter IPC handler if service is puter
    // Pass event so it can route to the correct client (WebSocket in server mode, IPC in normal mode)
    const puterIPCHandler = settings.aiService === 'puter' ? createPuterIPCHandler(event) : null;
    
    // Initialize OpenAI with the API key
    aitagging.initializeOpenAI(settings.apiKey, settings.apiEndpoint, settings.aiService, puterIPCHandler);
    
    // Get the model from the database to access its thumbnail
    const model = getModelByFilePath(filePath, { includeThumbnail: true });
    
    if (!model) {
      console.log(`Model not found in database: ${filePath}`);
      return [];
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
      return [];
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

    if (!model.thumbnail) {
      // If no thumbnail exists, we need to generate one or use a default image
      console.log('No thumbnail found for model, using default image');
      try {
        const fs = require('fs').promises;
        const defaultImagePath = './logo.png'; // Use a default image that's guaranteed to be in PNG format
        const data = await fs.readFile(defaultImagePath, { encoding: 'base64' });
        const tags = await aitagging.generateTagsForImage(data, settings.aiModel, tagOptions, 2000, 5, filePath);
        return tags;
      } catch (error) {
        console.error(`Error generating tags with default image:`, error);
        // Re-throw rate limit errors so user is notified
        if (error.message && error.message.includes('Rate limit')) {
          throw error;
        }
        return []; // Return empty tags array instead of throwing
      }
    }
    
    // Use default thumb only — multi-thumb strings are joined with `::`
    const imagePayload = getThumbnailImagePayload(model.thumbnail);
    
    if (!imagePayload) {
      console.error('Invalid thumbnail format');
      return []; // Return empty tags instead of throwing
    }
    
    try {
      const tags = await aitagging.generateTagsForImage(
        imagePayload.base64,
        settings.aiModel,
        { ...tagOptions, mimeType: imagePayload.mimeType },
        2000,
        5,
        filePath
      );
      return tags;
    } catch (error) {
      console.error('Error generating tags:', error);
      // Re-throw rate limit errors so user is notified
      if (error.message && error.message.includes('Rate limit')) {
        throw error;
      }
      return []; // Return empty tags array instead of throwing
    }
  } catch (error) {
    console.error('Error generating tags:', error);
    throw error;
  }
}
ipcMain.handle('generate-tags', generateTagsHandler);
ipcHandlerRegistry.set('generate-tags', generateTagsHandler);

// Add this helper function (if it doesn't already exist) near the top of main.js
function applyFolderTagsToModels(filePaths, levels) {
  return applyFolderTagsInDb(database.db, filePaths, levels);
}

// Folder names only, and only for paths this scan inserted. Existing models are not passed in.
function applyFolderTagsToNewScanFiles(filePaths) {
  if (!database.db || !Array.isArray(filePaths) || filePaths.length === 0) {
    return { updated: 0, tagsAdded: 0 };
  }
  const enabledRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('autoTagFromFolderOnScan');
  const levelsRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagFolderLevels');
  const levels = clampFolderLevels(levelsRow ? levelsRow.value : 2);
  if (!shouldAutoTagNewScanFiles(enabledRow ? enabledRow.value : '0', levels)) {
    return { updated: 0, tagsAdded: 0 };
  }
  const result = applyFolderTagsToModels(filePaths, levels);
  if (result.tagsAdded > 0) {
    console.log(`[Tag from Folder] Added ${result.tagsAdded} tag(s) on ${result.updated} newly scanned model(s).`);
  }
  return result;
}

function getSettings() {
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

// Add or update this function to get models without thumbnails
ipcMain.handle('get-models-without-thumbnails', async () => {
  try {
    const modelsWithoutThumbnails = database.db.prepare(`
      SELECT filePath FROM models WHERE thumbnail IS NULL OR thumbnail = '' OR thumbnail = '3d.png'
    `).all();
    return modelsWithoutThumbnails;
  } catch (error) {
    console.error('Error fetching models without thumbnails:', error);
    return [];
  }
});

ipcMain.handle('get-models-with-default-thumbnails', async () => {
  try {
    const modelsWithDefaultThumbnails = database.db.prepare(`
      SELECT filePath FROM models WHERE thumbnail IS NULL OR thumbnail = '' OR thumbnail = '3d.png'
    `).all();
    return modelsWithDefaultThumbnails;
  } catch (error) {
    console.error('Error fetching models with default thumbnails:', error);
    return [];
  }
});

ipcMain.handle('get-folder-tree', async () => {
  try {
    const rows = database.db.prepare('SELECT filePath FROM models').all();
    const filePaths = rows.map((r) => r.filePath).filter(Boolean);
    const homes = readStlHomeDirectories();
    const envHomes = parseExcludePathList(process.env.STL_HOME);
    const lastScan = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value || '';
    const primary = homes[0] || envHomes[0] || '';
    return buildFolderForest(filePaths, {
      stlHome: primary,
      roots: [...homes, ...envHomes, lastScan].filter(Boolean)
    });
  } catch (error) {
    console.error('Error building folder tree:', error);
    return { roots: [] };
  }
});

// Add this new IPC handler to fetch models by directory
ipcMain.handle('get-models-by-directory', async (event, directoryPath) => {
  try {
const selectCols = MODEL_LIST_COLUMNS;
    const models = database.db.prepare(`
      SELECT ${selectCols} FROM models
      WHERE REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?
    `).all(directoryScanPrefixSqlParam(directoryPath));
    return models;
  } catch (error) {
    console.error('Error fetching models by directory:', error);
    throw error;
  }
});

// Example: Get models for a given page (limit and offset)
ipcMain.handle('get-models-page', async (event, { page, pageSize, sortOption }) => {
  try {
    const offset = (page - 1) * pageSize;
const selectCols = MODEL_LIST_COLUMNS;
    const models = database.db.prepare(
      `SELECT ${selectCols} FROM models ORDER BY ${sortOption} LIMIT ? OFFSET ?`
    ).all(pageSize, offset);
    return models;
  } catch (error) {
    console.error('Error fetching models page:', error);
    return [];
  }
});

// Add this new IPC handler
ipcMain.handle('fetch-makerworld-page', async (event, url) => {
  try {
    if (!fetch) {
      throw new Error('Fetch not initialized');
    }
    const response = await fetch(url);
    const html = await response.text();
    
    // Extract model name from the page title
    const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                      html.match(/<title>([^<]+)</i);
    let modelName = '';
    if (titleMatch && titleMatch[1]) {
      modelName = titleMatch[1].split('|')[0].trim();
    }
    
    // Extract designer name using multiple possible patterns
    const designerPatterns = [
      /class="author-name"[^>]*>([^<]+)</i,
      /data-username="([^"]+)"/i,
      /profileId-[0-9]+">([^<]+)</i
    ];
    
    let designer = 'Unknown';
    for (const pattern of designerPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        designer = match[1].trim();
        break;
      }
    }

    return {
      modelName,
      designer
    };
  } catch (error) {
    console.error('Error fetching MakerWorld page:', error);
    throw error;
  }
});




// Add this near the top after other imports
let fetch;
(async () => {
  fetch = (await import('node-fetch')).default;
})();



ipcMain.handle('get-slicers', () => {
  try {
    // Ensure the slicers table exists before querying it
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
      return [];
    }
    return database.db.prepare('SELECT * FROM slicers').all();
  } catch (error) {
    console.error('Error getting slicers:', error);
    return [];
  }
});

ipcMain.handle('save-slicer', (event, { name, path }) => {
  try {
    // Ensure the slicers table exists before inserting
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
    }
    database.db.prepare('INSERT OR REPLACE INTO slicers (name, path) VALUES (?, ?)').run(name, path);
    return true;
  } catch (error) {
    console.error('Error saving slicer:', error);
    throw error;
  }
});

ipcMain.handle('delete-slicer', (event, id) => {
  try {
    // Ensure the slicers table exists before deleting
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
      return true; // Nothing to delete if table didn't exist
    }
    database.db.prepare('DELETE FROM slicers WHERE id = ?').run(id);
    return true;
  } catch (error) {
    console.error('Error deleting slicer:', error);
    throw error;
  }
});

const clearAndSaveSlicersHandler = async (event, slicers) => {
  try {
    // Ensure slicers is an array (WebSocket might wrap it in an array)
    let slicersArray = slicers;
    if (!Array.isArray(slicersArray)) {
      // If it's not an array, try to extract it
      if (Array.isArray(slicersArray) === false && slicersArray && typeof slicersArray === 'object') {
        // Might be wrapped: [slicers] -> slicers
        slicersArray = Array.isArray(slicersArray) ? slicersArray : [slicersArray];
      } else if (Array.isArray(slicersArray) && slicersArray.length === 1 && Array.isArray(slicersArray[0])) {
        // Unwrap if double-wrapped: [[slicers]] -> [slicers]
        slicersArray = slicersArray[0];
      } else {
        // Last resort: convert to array
        slicersArray = [slicersArray];
      }
    }
    
    // Validate that we have an array
    if (!Array.isArray(slicersArray)) {
      throw new Error('slicers parameter must be an array');
    }
    
    // Ensure the slicers table exists before clearing and saving
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
    }

    const seenNames = new Set();
    const seenPaths = new Set();
    for (const slicer of slicersArray) {
      if (!slicer || typeof slicer !== 'object' || !slicer.name || !slicer.path) continue;
      const name = String(slicer.name).trim();
      const slicerPath = String(slicer.path).trim();
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) {
        throw new Error(`"${name}" is already used. Each slicer needs its own name.`);
      }
      seenNames.add(nameKey);
      const pathKey = slicerPath.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
      if (seenPaths.has(pathKey)) {
        throw new Error(`"${slicerPath}" is already used. Each slicer needs its own path.`);
      }
      seenPaths.add(pathKey);
    }
    
    // Use a transaction to ensure atomicity
    database.db.transaction(() => {
      // Drop all existing entries
      database.db.prepare('DELETE FROM slicers').run();
      
      // Insert new entries
      const insert = database.db.prepare('INSERT INTO slicers (name, path) VALUES (?, ?)');
      slicersArray.forEach(slicer => {
        // Validate slicer object
        if (slicer && typeof slicer === 'object' && slicer.name && slicer.path) {
          insert.run(slicer.name, slicer.path);
        } else {
          console.warn('Invalid slicer object skipped:', slicer);
        }
      });
    })();
    
    return true;
  } catch (error) {
    console.error('Error clearing and saving slicers:', error);
    console.error('slicers parameter type:', typeof slicers, 'isArray:', Array.isArray(slicers), 'value:', slicers);
    const message = String(error && error.message ? error.message : error);
    if (/slicers\.name/i.test(message)) {
      throw new Error('That slicer name is already used. Each slicer needs its own name.');
    }
    if (/slicers\.path/i.test(message)) {
      throw new Error('That slicer path is already used. Each slicer needs its own path.');
    }
    throw error;
  }
};

ipcMain.handle('clear-and-save-slicers', clearAndSaveSlicersHandler);
// Register in handler registry for WebSocket/Server mode
ipcHandlerRegistry.set('clear-and-save-slicers', clearAndSaveSlicersHandler);

const openFileInSlicerHandler = async (event, options = {}) => {
  const { filePaths, slicerId, slicerName } = options || {};
  const paths = Array.isArray(filePaths) ? filePaths : (filePaths ? [filePaths] : []);
  if (!paths.length) {
    throw new Error('No file paths provided');
  }

  ensureSlicersTableExists();
  const slicers = database.db.prepare('SELECT * FROM slicers').all();
  const slicer = getSlicerBySelection(slicers, { slicerId, slicerName });
  if (!slicer) {
    throw new Error('No slicer configured. Add a slicer in Settings.');
  }

  const invalidSlicer = invalidSlicerPathError(slicer.path, slicer.name);
  {
    const firstPath = paths[0];
    const pathInfo = parseZipPath(firstPath);
    const commandPayload = {
      type: 'open-in-slicer',
      filePaths: paths,
      filePath: firstPath,
      slicerName: slicer.name,
      slicerPath: slicer.path,
      downloadToken: getServerAuth().issueDownloadToken(),
      isZipEntry: pathInfo.isZipEntry,
      zipPath: pathInfo.isZipEntry ? pathInfo.zipPath : null,
      entryPath: pathInfo.isZipEntry ? pathInfo.entryPath : null
    };

    if (global.broadcastEvent) {
      global.broadcastEvent('execute-client-command', commandPayload);
    } else {
      event.sender.send('execute-client-command', commandPayload);
    }
    return { success: true, serverMode: true, count: paths.length };
  }

  const modelPaths = await resolveModelPathsForSlicer(paths);
  if (!modelPaths.length) {
    throw new Error('No valid local model files to open in slicer');
  }

  try {
    return await runSlicerWithModelPaths(slicer, modelPaths);
  } catch (error) {
    // Launch failed — remove any extracts we just created
    scheduleExtractTempCleanupMany(modelPaths, 0);
    console.error('Error opening file in slicer:', error);
    clientDialogs.messageBox(event, { type: 'error', title: 'Send to Slicer', message: error.message });
    throw error;
  }
};

ipcMain.handle('open-file-in-slicer', openFileInSlicerHandler);
ipcHandlerRegistry.set('open-file-in-slicer', openFileInSlicerHandler);

const getFileStatsHandler = async (event, filePath) => {
  try {
    // URL-only models (Chrome extension) have no local file
    if (isUrlModel(filePath)) {
      return { size: 0, mtimeMs: 0 };
    }

    // Virtual zip paths: archive.zip::entry/path.stl — cannot fs.stat the combined path
    const pathInfo = parseZipPath(filePath);
    if (pathInfo.isZipEntry) {
      if (!fs.existsSync(pathInfo.zipPath)) {
        const err = new Error(`ENOENT: no such file or directory, stat '${pathInfo.zipPath}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return await withZipFileLock(pathInfo.zipPath, async () => {
        const StreamZip = require('node-stream-zip');
        const zip = new StreamZip.async({ file: pathInfo.zipPath });
        try {
          const entries = await zip.entries();
          const entry = findZipEntry(entries, pathInfo.entryPath);
          if (!entry) {
            const err = new Error(
              `ENOENT: no such file or directory, zip entry '${pathInfo.entryPath}' in '${pathInfo.zipPath}'`
            );
            err.code = 'ENOENT';
            throw err;
          }
          const mtimeMs = entry.time ? Number(entry.time) : 0;
          return {
            size: entry.size,
            mtime: mtimeMs ? new Date(mtimeMs) : new Date(0),
            mtimeMs
          };
        } finally {
          await zip.close();
        }
      });
    }

    const stats = await fs.promises.stat(filePath);
    return stats;
  } catch (error) {
    console.error(`Error getting file stats for ${filePath}:`, error);
    throw error;
  }
};
ipcMain.handle('get-file-stats', getFileStatsHandler);
ipcHandlerRegistry.set('get-file-stats', getFileStatsHandler);

// IPC handler for executing commands on client machine (for server mode Electron clients)
// Note: In server mode, browser clients receive this as an event and handle it in renderer.js
const executeClientCommandHandler = async (event, commandData) => {
  try {
    if (!commandData || !commandData.type) {
      throw new Error('Invalid command data');
    }

    const { type, filePath, slicerName, slicerPath, isZipEntry, zipPath, entryPath } = commandData;

    if (type === 'open-file') {
      // The file is on the server; the browser downloads it instead.
      return { success: false, error: 'Download the file to open it on this computer.' };
    } else if (type === 'open-in-slicer') {
      const invalidSlicer = invalidSlicerPathError(slicerPath, slicerName);
      if (invalidSlicer) {
        return { success: false, error: invalidSlicer.message };
      }

      const rawPaths = Array.isArray(commandData.filePaths) && commandData.filePaths.length
        ? commandData.filePaths
        : (filePath ? [filePath] : []);

      let modelPaths = [];
      try {
        modelPaths = await resolveModelPathsForSlicer(rawPaths);
      } catch (error) {
        return { success: false, error: error.message };
      }

      if (!modelPaths.length) {
        const detail = isZipEntry && zipPath && entryPath
          ? `To open ${entryPath} from ${zipPath}:\n\n1. Extract ${entryPath} from the ZIP file\n2. Open the extracted file in ${slicerName}`
          : `Could not resolve local model paths for the slicer.`;
        clientDialogs.messageBox(event, {
          type: 'info',
          title: 'Send to Slicer',
          message: 'Cannot open these models in slicer from here',
          detail
        });
        return { success: false, message: 'No resolvable model paths' };
      }

      try {
        await runSlicerWithModelPaths({ name: slicerName, path: slicerPath }, modelPaths);
        return { success: true, count: modelPaths.length };
      } catch (error) {
        console.error('Error executing slicer command on client:', error);
        return { success: false, error: error.message };
      }
    }
    
    return { success: false, error: 'Unknown command type' };
  } catch (error) {
    console.error('Error executing client command:', error);
    throw error;
  }
};

ipcMain.handle('execute-client-command', executeClientCommandHandler);
// Register in handler registry for WebSocket/Server mode (though it should be sent as event, not IPC call)
ipcHandlerRegistry.set('execute-client-command', executeClientCommandHandler);

ipcMain.handle('get-all-model-references', async () => {
  try {
    // Use the global db variable directly instead of calling getDb()
    const modelRefs = database.db.prepare('SELECT id, filePath FROM models').all();
    return modelRefs;
  } catch (error) {
    console.error('Error getting model references:', error);
    return []; // Return an empty array on error
  }
});

ipcMain.handle('get-db', async () => {
  try {
    const result = await getDb(); // Call your actual getDb function
    return result;
  } catch (error) {
    console.error("Error in get-db handler:", error);
    throw error; // Re-throw the error so the renderer can catch it
  }
});

// Remove or update the getDb function that tries to return a string
function getDb() {
    // Ensure that you return the actual database instance
    if (!database.db) {
        console.error("Database is not initialized.");
        throw new Error("Database is not initialized.");
    }
    return database.db; // Return the initialized database instance
}

// Add this function after the saveModel function
async function saveModelBatch(modelDataBatch) {
  try {
    if (!database.db) {
      console.error('Database not initialized');
      return false;
    }

    // Begin a transaction for better performance
    const transaction = database.db.transaction(() => {
      const stmt = database.db.prepare(`
        INSERT OR IGNORE INTO models 
        (filePath, fileName, hash, size, modifiedDate, dateAdded, isNew) 
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);
      
      for (const modelData of modelDataBatch) {
        const dateAdded = new Date().toISOString();
        stmt.run(
          modelData.filePath,
          modelData.fileName,
          modelData.hash || '',
          modelData.size || 0,
          modelData.modifiedDate || dateAdded,
          dateAdded
        );
      }
    });
    
    transaction();
    scheduleBackgroundHashGeneration('save-model-batch');
    return true;
  } catch (error) {
    console.error('Error saving model batch:', error);
    return false;
  }
}

// Bulk update function for updating multiple models in a single transaction
async function updateModelsBatch(modelDataBatch) {
  try {
    if (!database.db) {
      console.error('Database not initialized');
      return false;
    }

    // Enable foreign key constraints
    database.db.pragma('foreign_keys = ON');

    // Use a transaction for better performance - update models and tags together
    const transaction = database.db.transaction(() => {
      const getModelIdStmt = database.db.prepare('SELECT id FROM models WHERE filePath = ?');
      const getExistingModelStmt = database.db.prepare(`SELECT ${MODEL_DETAIL_COLUMNS} FROM models WHERE filePath = ?`);
      const getExistingTagsStmt = database.db.prepare(`
        SELECT t.name FROM model_tags mt
        JOIN tags t ON mt.tag_id = t.id
        WHERE mt.model_id = ?
      `);
      const updateStmt = database.db.prepare(`
        UPDATE models SET 
          fileName = ?,
          designer = ?,
          source = ?,
          notes = ?,
          printed = ?,
          print_status = ?,
          print_count = ?,
          last_printed_at = ?,
          parentModel = ?,
          license = ?,
          rating = ?,
          favorite = ?,
          isNew = CASE WHEN ? THEN 0 ELSE isNew END
        WHERE filePath = ?
      `);

      const deleteTagsStmt = database.db.prepare('DELETE FROM model_tags WHERE model_id = ?');
      const getTagIdStmt = database.db.prepare('SELECT id FROM tags WHERE name = ?');
      const insertTagStmt = database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)');
      const insertTagNameStmt = database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
      const getTagIdAfterInsertStmt = database.db.prepare('SELECT id FROM tags WHERE name = ?');

      for (let i = 0; i < modelDataBatch.length; i++) {
        const modelData = modelDataBatch[i];
        const {
          filePath,
          fileName,
          designer,
          source,
          notes,
          printed,
          printStatus,
          parentModel,
          license,
          rating,
          favorite,
          tags,
          filaments
        } = modelData;

        console.log(`[Batch ${i}] Processing model: ${filePath}`);
        console.log(`[Batch ${i}] Field values:`, { fileName, designer, source, notes, printed, parentModel, license, tags });

        // Get existing model to preserve values that aren't being updated
        const existingModel = getExistingModelStmt.get(filePath);
        
        if (!existingModel) {
          console.warn(`[Batch ${i}] Model not found in database: ${filePath}`);
          continue; // Skip this model if it doesn't exist
        }
        
        console.log(`[Batch ${i}] Found existing model with ID: ${existingModel.id}`);
        // Only update fields that are explicitly provided (not undefined)
        const finalFileName = fileName !== undefined ? fileName : existingModel.fileName;
        const finalDesigner = designer !== undefined ? (designer || null) : existingModel.designer;
        const finalSource = source !== undefined ? (source || null) : existingModel.source;
        const finalNotes = notes !== undefined ? (notes || null) : existingModel.notes;
        const printFields = printEvents.resolvePrintFieldsOnSave(existingModel, { printed, printStatus });
        const finalPrinted = printFields.printed;
        const finalPrintStatus = printFields.print_status;
        const finalPrintCount = printFields.print_count;
        const finalLastPrintedAt = printFields.last_printed_at;
        const finalParentModel = parentModel !== undefined ? (parentModel || null) : existingModel.parentModel;
        const finalLicense = license !== undefined ? (license || null) : existingModel.license;
        const finalRating = rating !== undefined ? normalizeModelRating(rating) : normalizeModelRating(existingModel.rating);
        const finalFavorite = favorite !== undefined ? (favorite ? 1 : 0) : (existingModel.favorite ? 1 : 0);

        const finals = {
          fileName: finalFileName,
          designer: finalDesigner,
          source: finalSource,
          notes: finalNotes,
          printed: finalPrinted,
          print_status: finalPrintStatus,
          parentModel: finalParentModel,
          license: finalLicense
        };
        let clearIsNew = modelUserFieldsChanged(existingModel, finals);
        if (!clearIsNew && tags !== undefined && Array.isArray(tags)) {
          const existingTagRows = getExistingTagsStmt.all(existingModel.id).map((row) => row.name);
          clearIsNew = JSON.stringify(sortedTagNames(existingTagRows)) !== JSON.stringify(sortedTagNames(tags));
        }

        // Update model fields
        console.log(`[Batch ${i}] Updating model with values:`, {
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalParentModel,
          finalLicense,
          filePath,
          clearIsNew
        });
        const updateResult = updateStmt.run(
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalPrintStatus,
          finalPrintCount,
          finalLastPrintedAt,
          finalParentModel,
          finalLicense,
          finalRating,
          finalFavorite,
          clearIsNew ? 1 : 0,
          filePath
        );
        console.log(`[Batch ${i}] Update result:`, updateResult);

        // Handle tags if provided
        if (tags && Array.isArray(tags) && tags.length > 0) {
          const modelId = existingModel.id;
          
          // Delete existing tags
          deleteTagsStmt.run(modelId);
          
          // Insert new tags
          for (const tagName of tags) {
            if (!tagName || typeof tagName !== 'string' || tagName.trim() === '') continue;
            
            const trimmedTagName = tagName.trim();
            
            // Get or create tag
            let tagResult = getTagIdStmt.get(trimmedTagName);
            if (!tagResult) {
              // Tag doesn't exist, create it
              insertTagNameStmt.run(trimmedTagName);
              tagResult = getTagIdAfterInsertStmt.get(trimmedTagName);
            }
            
            if (tagResult) {
              insertTagStmt.run(modelId, tagResult.id);
            }
          }
        }

        if (filaments !== undefined) {
          replaceModelFilaments(existingModel.id, normalizeFilamentIds(filaments) || []);
        }
      }
    });

    transaction();

    return true;
  } catch (error) {
    console.error('Error updating models batch:', error);
    return false;
  }
}

/** Returns true when user-editable model fields differ (used to clear isNew only on real edits). */
function modelUserFieldsChanged(existing, finals) {
  if (!existing || !finals) return false;
  const norm = (v) => (v == null || String(v).trim() === '' ? null : v);
  return (
    finals.fileName !== existing.fileName ||
    norm(finals.designer) !== norm(existing.designer) ||
    norm(finals.source) !== norm(existing.source) ||
    norm(finals.notes) !== norm(existing.notes) ||
    Number(finals.printed ? 1 : 0) !== Number(existing.printed ? 1 : 0) ||
    String(finals.print_status || '') !== String(existing.print_status || '') ||
    norm(finals.parentModel) !== norm(existing.parentModel) ||
    norm(finals.license) !== norm(existing.license)
  );
}

function sortedTagNames(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim()).filter(Boolean).sort();
}

// Add this function before the IPC handlers
async function saveModel(modelData) {
  try {
    console.log('saveModel:', modelData?.filePath, modelData?.id != null ? `(id ${modelData.id})` : '');
    
    let {
      id: inputId, // Rename to avoid confusion
      filePath: filePathIn,
      fileName,
      designer,
      source,
      notes,
      printed,
      printStatus,
      parentModel,
      license,
      rating,
      favorite,
      tags: rawTags,
      filaments: rawFilaments,
      markAsNew
    } = modelData;

    // Extension path mapping (Docker: client path -> container path) and optional copy to NAS
    let resolvedFilePath = filePathIn;
    const clientPrefixRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('extensionClientPathPrefix');
    const containerPrefixRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('extensionContainerPathPrefix');
    const copyToNasRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('extensionCopyToNasPath');
    const clientPrefix = (clientPrefixRow && clientPrefixRow.value) ? String(clientPrefixRow.value).replace(/\\/g, '/').trim().replace(/\/+$/, '') : '';
    const containerPrefix = (containerPrefixRow && containerPrefixRow.value) ? String(containerPrefixRow.value).replace(/\\/g, '/').trim().replace(/\/+$/, '') : '';
    const copyToNasPath = (copyToNasRow && copyToNasRow.value) ? String(copyToNasRow.value).replace(/\\/g, '/').trim().replace(/\/+$/, '') : '';
    if (clientPrefix && containerPrefix && filePathIn && typeof filePathIn === 'string') {
      const normalizedInput = filePathIn.replace(/\\/g, '/').trim();
      const prefixNorm = clientPrefix.toLowerCase();
      const inputNorm = normalizedInput.toLowerCase();
      if (inputNorm.startsWith(prefixNorm)) {
        const rest = normalizedInput.slice(clientPrefix.length).replace(/^\//, '');
        resolvedFilePath = containerPrefix + (rest ? '/' + rest : '');
      }
    }
    const zipSepForCopy = resolvedFilePath ? resolvedFilePath.indexOf('::') : -1;
    const srcFileForCopy = (resolvedFilePath && zipSepForCopy >= 0) ? resolvedFilePath.slice(0, zipSepForCopy) : resolvedFilePath;
    if (copyToNasPath && srcFileForCopy && fs.existsSync(srcFileForCopy)) {
      const base = path.basename(srcFileForCopy);
      const destFile = path.join(copyToNasPath, base);
      if (!fs.existsSync(path.dirname(destFile))) fs.mkdirSync(path.dirname(destFile), { recursive: true });
      if (path.resolve(srcFileForCopy) !== path.resolve(destFile)) {
        fs.copyFileSync(srcFileForCopy, destFile);
        resolvedFilePath = (zipSepForCopy >= 0) ? destFile + resolvedFilePath.slice(zipSepForCopy) : destFile;
      }
    } else if (copyToNasPath && resolvedFilePath) {
      const srcFile = (zipSepForCopy >= 0) ? resolvedFilePath.slice(0, zipSepForCopy) : resolvedFilePath;
      if (srcFile && !fs.existsSync(srcFile)) {
        console.warn('saveModel: extension path mapping resolved path not found on server:', srcFile);
      }
    }
    const filePath = resolvedFilePath;

    // Standalone .zip: only add if "Include zipped models" is enabled; add each STL/3MF inside (like scan)
    if (filePath && filePath.toLowerCase().endsWith('.zip') && !filePath.includes('::')) {
      const zipSetting = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
      const enableZipArchives = zipSetting && zipSetting.value === '1';
      if (!enableZipArchives) {
        throw new Error('ZIP archives are disabled. Enable "Include zipped models" in Settings to add .zip files.');
      }
      // List STL/3MF entries and save each as zipPath::entryPath (same as scan)
      if (!fs.existsSync(filePath)) {
        throw new Error(`ZIP file not found: ${filePath}`);
      }
      const entries = await withZipFileLock(filePath, async () => {
        const StreamZip = require('node-stream-zip');
        const zip = new StreamZip.async({ file: filePath });
        try {
          return await zip.entries();
        } finally {
          await zip.close();
        }
      });
      const modelExts = getSupportedExtensionsForLibrary(database.db);
      const toAdd = Object.values(entries).filter(
        (e) => !e.isDirectory
          && modelExts.includes(path.extname(e.name).toLowerCase())
          && !isMacOsResourceForkEntry(e.name)
      );
      if (toAdd.length === 0) {
        throw new Error('No supported model files found in the ZIP file. Enable additional file types in Settings > File Type if needed.');
      }
      const baseMeta = {
        designer,
        source,
        notes,
        printed,
        parentModel,
        license,
        rating,
        favorite,
        tags: rawTags,
        filaments: rawFilaments,
        markAsNew
      };
      for (const entry of toAdd) {
        const entryPath = `${filePath}::${entry.name}`;
        const entryFileName = path.basename(entry.name);
        await saveModel({
          ...baseMeta,
          filePath: entryPath,
          fileName: entryFileName
        });
      }
      return { success: true, expanded: true, count: toAdd.length };
    }

    // Ensure tags is always an array, even if a single string was passed
    const tags = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : [];

    console.log(`Processing notes field: "${notes}"`);

    // Enable foreign key constraints
    database.db.pragma('foreign_keys = ON');

    // First, handle the model data without tags
    let modelId;
    let insertedNewModel = false;
    try {
      // Check if the model exists first
      const existingModel = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(filePath);
      
      if (existingModel) {
        // Update existing model
        console.log(`Updating existing model with ID: ${existingModel.id}`);
        
        // Get existing model data to preserve values that aren't being updated
        const existingModelData = getModelById(existingModel.id);
        
        // Only update fields that are explicitly provided (not undefined)
        // Preserve existing values for fields that are undefined in the update
        const finalFileName = fileName !== undefined ? fileName : existingModelData.fileName;
        const finalDesigner = designer !== undefined ? (designer || null) : existingModelData.designer;
        const finalSource = source !== undefined ? (source || null) : existingModelData.source;
        const finalNotes = notes !== undefined ? (notes || null) : existingModelData.notes;
        const printFields = printEvents.resolvePrintFieldsOnSave(existingModelData, { printed, printStatus });
        const finalPrinted = printFields.printed;
        const finalPrintStatus = printFields.print_status;
        const finalPrintCount = printFields.print_count;
        const finalLastPrintedAt = printFields.last_printed_at;
        const finalParentModel = parentModel !== undefined ? (parentModel || null) : existingModelData.parentModel;
        const finalLicense = license !== undefined ? (license || null) : existingModelData.license;
        const finalRating = rating !== undefined ? normalizeModelRating(rating) : normalizeModelRating(existingModelData.rating);
        const finalFavorite = favorite !== undefined ? (favorite ? 1 : 0) : (existingModelData.favorite ? 1 : 0);

        const finals = {
          fileName: finalFileName,
          designer: finalDesigner,
          source: finalSource,
          notes: finalNotes,
          printed: finalPrinted,
          print_status: finalPrintStatus,
          parentModel: finalParentModel,
          license: finalLicense
        };
        let clearIsNew = !markAsNew && modelUserFieldsChanged(existingModelData, finals);
        if (!markAsNew && !clearIsNew && rawTags !== undefined) {
          const existingTagRows = database.db.prepare(`
            SELECT t.name FROM model_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.model_id = ?
          `).all(existingModel.id).map((row) => row.name);
          clearIsNew = JSON.stringify(sortedTagNames(existingTagRows)) !== JSON.stringify(sortedTagNames(tags));
        }
        const bundle = deriveBundleFromFilePath(filePath);
        
        // Use a simpler update approach to avoid foreign key issues
        const updateStmt = database.db.prepare(`
          UPDATE models SET 
            fileName = ?,
            designer = ?,
            source = ?,
            notes = ?,
            printed = ?,
            print_status = ?,
            print_count = ?,
            last_printed_at = ?,
            parentModel = ?,
            license = ?,
            rating = ?,
            favorite = ?,
            bundleKey = ?,
            bundleLabel = ?,
            bundleKind = ?,
            isNew = CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE isNew END
          WHERE id = ?
        `);
        
        updateStmt.run(
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalPrintStatus,
          finalPrintCount,
          finalLastPrintedAt,
          finalParentModel,
          finalLicense,
          finalRating,
          finalFavorite,
          bundle.bundleKey || null,
          bundle.bundleLabel || null,
          bundle.bundleKind || null,
          markAsNew ? 1 : 0,
          clearIsNew ? 1 : 0,
          existingModel.id
        );
        
        modelId = existingModel.id;
      } else {
        // Insert new model
        console.log('Inserting new model');
        
        const printFields = printEvents.resolvePrintFieldsOnSave(null, { printed, printStatus });
        const dateAdded = new Date().toISOString();
        const bundle = deriveBundleFromFilePath(filePath);
        const insertStmt = database.db.prepare(`
          INSERT INTO models (
            filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, license,
            dateAdded, isNew, rating, favorite, bundleKey, bundleLabel, bundleKind
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `);
        
        const result = insertStmt.run(
          filePath,
          fileName,
          designer || null,
          source || null,
          notes || null,
          printFields.printed,
          printFields.print_status,
          printFields.print_count,
          printFields.last_printed_at,
          parentModel || null,
          license || null,
          dateAdded,
          normalizeModelRating(rating),
          favorite ? 1 : 0,
          bundle.bundleKey || null,
          bundle.bundleLabel || null,
          bundle.bundleKind || null
        );
        
        modelId = result.lastInsertRowid;
        insertedNewModel = true;
      }
      
      console.log(`Model saved with ID: ${modelId}`);
    } catch (modelError) {
      console.error('Error saving model data:', modelError);
      throw modelError;
    }

    // Now handle tags in a separate transaction if we have a valid model ID
    // Note: We need to process tags even if the array is empty (to remove all tags)
    if (modelId && tags && Array.isArray(tags)) {
      try {
        console.log(`Processing ${tags.length} tags for model ID ${modelId}`);
        
        // Double-check that the model exists before proceeding
        const modelExists = database.db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId);
        if (!modelExists) {
          console.error(`Model ID ${modelId} does not exist in the database. This should not happen.`);
          return { success: true, modelId }; // Return success but skip tag processing
        }
        
        // Use a transaction to ensure atomicity and handle errors gracefully
        database.db.transaction(() => {
          // First, get existing tags before deleting (to preserve them if there's an error)
          const existingTags = database.db.prepare(`
            SELECT t.name 
            FROM model_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.model_id = ?
          `).all(modelId).map(row => row.name);
          
          // First, remove all existing tags for this model
          const deleteResult = database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);
          console.log(`Deleted ${deleteResult.changes} existing tag relationships`);

          // Process each tag individually (only if there are tags to add)
          if (tags.length > 0) {
            for (const tagName of tags) {
              if (tagName && typeof tagName === 'string' && tagName.trim() !== '') {
                const trimmedTagName = tagName.trim();
                try {
                  console.log(`Processing tag: "${trimmedTagName}"`);
                  
                  // First ensure the tag exists in the tags table
                  database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(trimmedTagName);
                  
                  // Get the tag ID directly
                  const tagRow = database.db.prepare('SELECT id FROM tags WHERE name = ?').get(trimmedTagName);
                  
                  if (tagRow && tagRow.id) {
                    console.log(`Found tag ID ${tagRow.id} for "${trimmedTagName}"`);
                    
                    // Now create the relationship with the known IDs
                    database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)').run(modelId, tagRow.id);
                  } else {
                    console.warn(`Could not find tag ID for "${trimmedTagName}" after insertion`);
                  }
                } catch (singleTagError) {
                  console.error(`Error processing tag "${trimmedTagName}":`, singleTagError);
                  // Continue with other tags
                }
              }
            }
          } else {
            console.log('Tags array is empty - all tags have been removed from this model');
          }
        })();
      } catch (tagError) {
        console.error('Error updating tags:', tagError);
        
        // models_old means model_tags still references the renamed parent table.
        // Repair outside this failed transaction, then retry the tag write.
        if (tagError.message && tagError.message.includes('models_old')) {
          console.log('Detected models_old error. Repairing model_tags and retrying...');
          try {
            repairModelTagsTable();
            // Retry the tag save operation in a new transaction
            database.db.transaction(() => {
              // Delete existing tags first
              database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);
              
              // Re-insert the tags we were trying to save (only if there are tags)
              if (tags.length > 0) {
                for (const tagName of tags) {
                  if (tagName && typeof tagName === 'string' && tagName.trim() !== '') {
                    const trimmedTagName = tagName.trim();
                    try {
                      database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(trimmedTagName);
                      const tagRow = database.db.prepare('SELECT id FROM tags WHERE name = ?').get(trimmedTagName);
                      if (tagRow && tagRow.id) {
                        database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)').run(modelId, tagRow.id);
                      }
                    } catch (retryError) {
                      console.error(`Error retrying tag "${trimmedTagName}":`, retryError);
                    }
                  }
                }
              }
            })();
            console.log('Successfully retried tag save after repairing model_tags');
          } catch (cleanupError) {
            console.error('Error during cleanup and retry:', cleanupError);
            // Don't throw - we want to preserve the model save even if tags fail
          }
        }
        // Continue with the save even if tag update fails - don't throw to preserve model data
      }
    }

    if (modelId && rawFilaments !== undefined) {
      try {
        replaceModelFilaments(modelId, normalizeFilamentIds(rawFilaments) || []);
      } catch (filamentError) {
        console.error('Error updating filaments:', filamentError);
      }
    }

    if (insertedNewModel) {
      scheduleBackgroundHashGeneration('save-model');
    }
    return { success: true, modelId };

  } catch (error) {
    console.error('Error saving model:', error);
    throw error;
  }
}

// Register save-model for Chrome extension (WebSocket works in normal and server mode)
ipcHandlerRegistry.set('save-model', async (event, modelData) => await saveModel(modelData));


// Add this function before saveModel
function verifyDatabaseIntegrity() {
  try {
    console.log('Verifying database integrity...');
    
    // Check if foreign keys are enabled
    const foreignKeysEnabled = database.db.pragma('foreign_keys');
    console.log(`Foreign keys enabled: ${foreignKeysEnabled}`);
    
    // Run integrity check
    const integrityCheck = database.db.pragma('integrity_check');
    console.log(`Integrity check result: ${JSON.stringify(integrityCheck)}`);
    
    repairModelTagsTable();
    
    return true;
  } catch (error) {
    console.error('Database integrity check failed:', error);
    return false;
  }
}

// Add this function to check and create the slicers table if it doesn't exist
function ensureSlicersTableExists() {
  try {
    console.log('Checking if slicers table exists...');
    
    // Check if the slicers table exists
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    
    if (!tableExists) {
      console.log('Slicers table does not exist. Creating it...');
      
      // Create the slicers table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS slicers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL
      )`).run();
      
      console.log('Slicers table created successfully');
    } else {
      console.log('Slicers table already exists');
    }
    
    return true;
  } catch (error) {
    console.error('Error ensuring slicers table exists:', error);
    return false;
  }
}

function ensurePartsTablesExist() {
  try {
    printEvents.ensurePartsSchema(database.db);
    return true;
  } catch (error) {
    console.error('Error ensuring parts tables exist:', error);
    return false;
  }
}

function ensureFilamentsTablesExist() {
  try {
    database.db.prepare(`CREATE TABLE IF NOT EXISTS filaments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        vendor TEXT,
        material TEXT,
        color_hex TEXT,
        diameter REAL,
        spoolman_id INTEGER UNIQUE,
        source TEXT NOT NULL DEFAULT 'manual'
    )`).run();
    database.db.prepare(`CREATE TABLE IF NOT EXISTS model_filaments (
        model_id INTEGER,
        filament_id INTEGER,
        FOREIGN KEY(model_id) REFERENCES models(id),
        FOREIGN KEY(filament_id) REFERENCES filaments(id),
        PRIMARY KEY(model_id, filament_id)
    )`).run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_name ON filaments(name)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_spoolman_id ON filaments(spoolman_id)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_filament_id ON model_filaments(filament_id)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_model_id ON model_filaments(model_id)').run();
    return true;
  } catch (error) {
    console.error('Error ensuring filaments tables exist:', error);
    return false;
  }
}
