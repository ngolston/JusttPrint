const events = require('./src/server/events');
const thumbnailWorker = require('./src/server/thumbnail-worker');
const { jsonStringifyForWs } = require('./src/server/ws-json');
const database = require('./src/core/database');
const { envOverridesSettings, flushSettingsToDisk, getSettingValueOr, persistSetting } = require('./src/core/settings');
const {
  app,
  ipcMain
} = require('./src/server/runtime');
const { verifyDatabaseIntegrity } = require('./src/core/db-init');
const { cleanupExtractTempDirectory } = require('./src/core/extract-temp');
const { scheduleBackgroundThumbnailCompression } = require('./src/server/thumbnail-compression');
const { applyDockerEnvSettingIfNeeded, applyEnvSettings, applyStlHomeEnvIfNeeded, applyStlHomeExcludeEnvIfNeeded } = require('./src/core/env-settings-apply');
const { closeAllClients, closeHttpServer, ensurePort80ForAcme, getAppListenPort, getConfiguredHttpPort, getHttpServerListenPort, getServerListenPort, getTlsCertsDir, getTlsStatusForUi, httpServerRunning, maybeRenewLetsEncryptCertificate, parseListenPort, persistTlsSettingsFromPayload, reloadTlsHttpListener, resolveAppTls, restartHttpServer, startHttpServer, stopPort80Server, syncPort80Server } = require('./src/server/http');
require('./src/server/ipc');
const {
  puterPendingRequests
} = require('./src/server/ipc/ai');
const fs = require('fs');
const path = require('path');
const {
  registerMcpRoutes,
  buildMcpClientConfig,
  listToolDefinitions,
  SERVER_NAME: MCP_SERVER_NAME
} = require('./mcp-server');
const serverTls = require('./server-tls');
const extensionInbox = require('./extension-inbox');
const {
  invalidSlicerPathError
} = require('./slicer-launch');
const { registerHelperBundleRoute } = require('./helper/install-bundle');
const {
  MIN_PASSWORD_LENGTH,
  parseTrustProxy
} = require('./server-auth');
const { settingsFromEnv, SECRET_ENV } = require('./env-settings');
const { RESPONSE_CHANNEL: DIALOG_RESPONSE_CHANNEL } = require('./src/server/client-dialogs');

const {
  dedupePathList,
  excludeDirectoriesSettingIsEmpty,
  parseExcludePathList,
  parseZipPath,
  readStlHomeDirectories
} = require('./src/core/library-paths');

const {
  ADDITIONAL_FILE_TYPES_CATALOG
} = require('./src/core/model-filters');

const {
  readThumbnailColumn
} = require('./src/core/thumbnails');

const {
  EXTRACT_TEMP_DIR_NAME,
  EXTRACT_TEMP_FILE_PREFIX,
  cleanupExtractTempFile,
  ensureExtractTempDir,
  getExtractTempDir,
  getOsTempRoot,
  pendingExtractTempCleanups
} = require('./src/core/extract-temp');

const {
  repairModelTagsTable
} = require('./src/core/models');


const {
  scheduleBackgroundHashGeneration
} = require('./src/server/ipc/hashes');

const { clientDialogs } = require('./src/server/dialogs');
const {
  isServableStaticPath,
  assertNetworkIpcArgs
} = require('./server-paths');

const { getServerAuth } = require('./src/server/auth');

const {
  extractModelFromZip
} = require('./src/core/zip-entries');

const {
  resolveModelPathsForSlicer,
  runSlicerWithModelPaths
} = require('./src/server/ipc/slicers');


const { getDatabasePath } = require('./src/core/db-path');


const {
  saveModel
} = require('./src/server/ipc/models');


const { scanDirectoryHandler } = require('./src/server/ipc/scan');

const { initializeDatabase } = require('./src/core/db-init');


const { libraryPathAllowed, networkPathContext } = require('./src/server/path-context');

const { getMcpToolContext } = require('./src/server/mcp-tools');

const { requestThumbnailJobCancel, startServerThumbnailJobInternal, thumbnailJobRunning } = require('./src/server/ipc/thumbnails');


const os = require('os');
const https = require('https');
const {
  compressThumbnailBlob,
  needsCompression,
  THUMBNAIL_MAX_STORED_CHARS,
  THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS
} = require('./thumbnail-compress');

const express = require('express');
const WebSocket = require('ws');

// Near the top of the file, add this line
const { version } = require('./package.json');




let databaseClosedOnQuit = false;

/**
 * Last step of every normal quit (docker stop, closing the window, Ctrl+C): Chromium turns
 * SIGTERM/SIGINT into an app quit, so Node signal handlers never run. will-quit handlers are
 * synchronous and finish before exit. Statements are synchronous too, so no write is cut off.
 */
function closeDatabaseOnQuit() {
  if (databaseClosedOnQuit) return;
  databaseClosedOnQuit = true;
  thumbnailWorker.stop();
  try {
    requestThumbnailJobCancel();
  } catch (_) { /* job state not initialized */ }
  try {
    closeAllClients(1001, 'Server shutting down');
    closeHttpServer();
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
  const running = httpServerRunning();
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
    closeAllClients(4001, 'Password changed');
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
    if (newModels > 0 && thumbnailWorker.ready() && !thumbnailJobRunning()) {
      startServerThumbnailJobInternal('missing').catch((error) => console.error('[STL Home] thumbnail job:', error.message));
    }
  } finally {
    serverStlHomeScanRunning = false;
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

// IPC handler to expose server mode
ipcMain.handle('is-server-mode', () => {
  return true;
});

// IPC handler to restart server
ipcMain.handle('restart-server', async () => {
  return await restartHttpServer();
});

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
      await thumbnailWorker.start({
        origin: () => {
          const port = getHttpServerListenPort();
          return port ? `${resolveAppTls().options ? 'https' : 'http'}://127.0.0.1:${port}` : null;
        },
        sessionToken: () => getServerAuth().issueSessionToken()
      });
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



require('./src/server/ipc/slicers');
