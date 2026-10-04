const events = require('./src/server/events');
const database = require('./src/core/database');
const { envOverridesSettings, flushSettingsToDisk, getSettingValueOr, persistSetting } = require('./src/core/settings');
const { app, ipcMain, shell } = require('./src/server/runtime');
const { deleteFilamentHandler, getAllFilamentsHandler, getFilamentsForModel, saveFilamentHandler, syncSpoolmanFilamentsHandler } = require('./src/server/ipc/filaments');
const { createPuterIPCHandler, getAISettings, puterPendingRequests } = require('./src/server/ipc/ai');
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
const { SECRET_SETTING_KEYS, MIN_PASSWORD_LENGTH, parseTrustProxy, parseCookies, SESSION_COOKIE: SESSION_COOKIE_NAME } = require('./server-auth');
const { settingsFromEnv, SECRET_ENV } = require('./env-settings');
const { releasesApiUrl, releasesPageUrl, latestVersionFromReleases, PROJECT_URL } = require('./src/server/releases');
const { RESPONSE_CHANNEL: DIALOG_RESPONSE_CHANNEL } = require('./src/server/client-dialogs');

const { dedupePathList, excludeDirectoriesSettingIsEmpty, getLibraryRootPaths, getScanExcludeNames, isUrlModel, parseExcludePathList, parseZipPath, readScannedDirectorySetting, readStlHomeDirectories, assertContainerPath } = require('./src/core/library-paths');

const { ADDITIONAL_FILE_TYPES_CATALOG, buildModelFilterConditions, sqlAndFilterConditions } = require('./src/core/model-filters');

const { applyThumbnailFlags, getDefaultThumbnail, getThumbnailImagePayload, loadThumbnailForModel, parseThumbnails, readThumbnailColumn } = require('./src/core/thumbnails');

const { EXTRACT_TEMP_DIR_NAME, EXTRACT_TEMP_FILE_PREFIX, cleanupExtractTempFile, ensureExtractTempDir, getExtractTempDir, getOsTempRoot, isPrintventoryExtractTempPath, pendingExtractTempCleanups, scheduleExtractTempCleanupMany } = require('./src/core/extract-temp');

const { MODEL_DETAIL_COLUMNS, MODEL_LIST_COLUMNS, MODEL_LIST_COLUMNS_QUALIFIED, deleteModelJunctionRows, deleteModelsByFilePaths, deleteModelsByIds, getModelByFilePath, getModelById, modelUserFieldsChanged, normalizeModelRating, repairModelTagsTable, replaceModelFilaments } = require('./src/core/models');

const { deleteTagHandler, generateTagsHandler, getAllTagsHandler, renameTagForMcp, resolveTagForMcp, saveTagHandler } = require('./src/server/ipc/tags');

const { countModelsNeedingHash, generateMissingHashesHandler, getDuplicatesHandler, hashGenerationRunning, scheduleBackgroundHashGeneration } = require('./src/server/ipc/hashes');

const { clientDialogs } = require('./src/server/dialogs');
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

const { getServerAuth } = require('./src/server/auth');

const { extractModelFromZip, find3dModelZipEntry, isLikelyValidZipBuffer, isMacOsResourceForkEntry } = require('./src/core/zip-entries');

const { ensureSlicersTableExists, isDockerContainer, openFileInSlicerHandler, resolveModelPathsForSlicer, runSlicerWithModelPaths } = require('./src/server/ipc/slicers');

const { extract3MFMetadata, filter3MFMetadataBySettings, parse3MFModelXML } = require('./src/core/three-mf');

const { getDatabasePath } = require('./src/core/db-path');

const { applyFolderTagsToModels, deleteFile } = require('./src/server/ipc/context-menu');

const { directoryScanPrefixSqlParam, getModelsFilteredHandler, getScanExtensions, normalizeFilamentIds, normalizePath, saveModel, updateModelsBatch } = require('./src/server/ipc/models');

require('./src/server/ipc/previews');

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

const express = require('express');
const WebSocket = require('ws');

// Near the top of the file, add this line
const { version } = require('./package.json');

const PING_INTERVAL = 30000; // 30 seconds

// Server mode detection
let httpServer = null;
let httpServerEpoch = 0;
let http80Server = null;
let wss = null; // WebSocket server
let wsClients = null; // WebSocket clients Set
let letsEncryptRenewInFlight = false;

// The handlers the WebSocket dispatcher calls: every ipcMain.handle(...), from any module,
// lands in this one map, whatever order the modules load in.
const ipcHandlerRegistry = ipcMain._handlers;



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

          // Broadcast to all WebSocket clients (they'll receive as type: 'event')
          events.broadcast(channel, ...(args || []));
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
                events.broadcast(eventChannel, ...eventArgs);
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
  events.setBroadcaster(broadcastEvent);

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
        events.setBroadcaster(null);
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
        events.setBroadcaster(null);
        resolve();
      }
    }, 5000);
  });
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
        events.broadcast('refresh-grid');
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
        events.broadcast(channel, ...args);
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
    events.broadcast('refresh-grid');
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
    events.broadcast('refresh-grid');
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
      events.broadcast('thumbnail-added', payload);
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
      events.broadcast('thumbnail-default-changed', payload);
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
      events.broadcast('thumbnail-deleted', payload);
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
        generating: hashGenerationRunning(),
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
          assertContainerPath(filePath, 'trash-file');
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
        assertContainerPath(filePath, 'move-files');
        if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
        const newDestination = path.join(destinationFolder, path.basename(filePath));
        await fs.promises.rename(filePath, newDestination);
        database.db.prepare('UPDATE models SET filePath = ? WHERE filePath = ?').run(newDestination, filePath);
        moved.push({ from: filePath, to: newDestination });
      }
      events.broadcast('refresh-grid');
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

// IPC handler to expose server mode
ipcMain.handle('is-server-mode', () => {
  return true;
});

// IPC handler to restart server
ipcMain.handle('restart-server', async () => {
  return await restartHttpServer();
});

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
      assertContainerPath(directoryPath, 'scan-directory');
    } catch (validationError) {
      throw new Error(validationError.message);
    }
    
    rememberScannedDirectory(directoryPath);
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
              events.broadcast('refresh-grid');
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

ipcMain.handle('save-thumbnail', async (event, filePath, thumbnail) => {
  try {
    await saveThumbnail(filePath, thumbnail);
    return true;
  } catch (error) {
    console.error('Error saving thumbnail:', error);
    throw error;
  }
});

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

require('./src/server/ipc/settings');

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
  events.broadcast(channel, payload);
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
  events.broadcast('refresh-grid');
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

    database.db = new Database(dbPath);

    return { success: true, filePath: backupPath };
  } catch (error) {
    console.error('Backup error:', error);
    try {
      const dbPath = getDatabasePath();
      database.db = new Database(dbPath);
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

      database.db = new Database(dbPath);

      return { success: true };
    } catch (error) {
      console.error('Restore error:', error);
      try {
        const dbPath = getDatabasePath();
        database.db = new Database(dbPath);
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
      assertContainerPath(filePath, 'trash-file');
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
      assertContainerPath(filePath, 'delete-file');
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

require('./src/server/ipc/metadata');

require('./src/server/ipc/system-report');

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
        database.db = new Database(dbPath);
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

function isPrintventoryExtractTempFileName(fileName) {
  return typeof fileName === 'string' && fileName.startsWith(EXTRACT_TEMP_FILE_PREFIX);
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

    events.broadcast('thumbnail-added', {
      filePath: filePath,
      thumbnailCount: finalThumbnails.length,
      hasMultiple: finalThumbnails.length > 1,
      newImageIsDefault: true
    });

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
    events.broadcast('thumbnail-default-changed', payload);
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
    } else events.broadcast('thumbnail-deleted', {
      filePath: filePath,
      thumbnailCount: thumbnails.length
    });
    
    return true;
  } catch (error) {
    console.error('Error deleting thumbnail:', error);
    throw error;
  }
});

require('./src/server/ipc/updates');

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

require('./src/server/ipc/organize');

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

// Register save-model for Chrome extension (WebSocket works in normal and server mode)


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
