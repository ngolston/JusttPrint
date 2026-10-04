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

const { buildLibraryExportData } = require('./src/server/ipc/backup');

const { scanDirectoryHandler } = require('./src/server/ipc/scan');

const { initializeDatabase } = require('./src/core/db-init');

const { addMultipleThumbnails, addThumbnailToModel, saveThumbnail, setDefaultThumbnailIndex } = require('./src/core/thumbnail-store');

const { libraryPathAllowed, networkPathContext } = require('./src/server/path-context');

const { getMcpToolContext } = require('./src/server/mcp-tools');

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



ipcMain.handle('save-thumbnail', async (event, filePath, thumbnail) => {
  try {
    await saveThumbnail(filePath, thumbnail);
    return true;
  } catch (error) {
    console.error('Error saving thumbnail:', error);
    throw error;
  }
});

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









require('./src/server/ipc/files');

require('./src/server/ipc/web-pages');

require('./src/server/ipc/metadata');

require('./src/server/ipc/system-report');

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

require('./src/server/ipc/organize');

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
