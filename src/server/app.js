'use strict';

/**
 * Server startup and shutdown: open the database, apply environment settings, start the
 * HTTP/WebSocket server, then the background work (thumbnail worker, STL Home scans, hashes).
 */
const fs = require('fs');
const path = require('path');
const { version } = require('../../package.json');
const database = require('../core/database');
const { getDatabasePath } = require('../core/db-path');
const { initializeDatabase, verifyDatabaseIntegrity } = require('../core/db-init');
const { cleanupExtractTempDirectory, ensureExtractTempDir } = require('../core/extract-temp');
const {
  applyDockerEnvSettingIfNeeded,
  applyEnvSettings,
  applyStlHomeEnvIfNeeded,
  applyStlHomeExcludeEnvIfNeeded
} = require('../core/env-settings-apply');
const { app } = require('./runtime');
require('./ipc'); // registers every IPC channel
const { getServerAuth } = require('./auth');
const {
  closeAllClients,
  closeHttpServer,
  getAppListenPort,
  getHttpServerListenPort,
  maybeRenewLetsEncryptCertificate,
  resolveAppTls,
  startHttpServer,
  stopPort80Server
} = require('./http');
const thumbnailWorker = require('./thumbnail-worker');
const { scheduleBackgroundThumbnailCompression } = require('./thumbnail-compression');
const { startServerStlHomeScans, startWatching, stopWatching } = require('./stl-home');
const autoBackup = require('./auto-backup');
const downloadFiles = require('./download-files');
const { scheduleBackgroundHashGeneration } = require('./ipc/hashes');
const { requestThumbnailJobCancel } = require('./ipc/thumbnails');
require('./ipc/server-access');

let databaseClosedOnQuit = false;

/**
 * Last step of every quit (docker stop, Ctrl+C). will-quit handlers are synchronous and
 * finish before exit, and so are the SQLite calls, so no write is cut off.
 */
function closeDatabaseOnQuit() {
  if (databaseClosedOnQuit) return;
  databaseClosedOnQuit = true;
  autoBackup.stop();
  downloadFiles.stop();
  stopWatching();
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
      fs.copyFileSync(getDatabasePath(), path.join(app.getPath('userData'), 'backup_justtprint.db'));
      console.log('[Quit] Database closed and backed up.');
    }
  } catch (error) {
    console.error('[Quit] Closing the database:', error);
  }
}

/** Stop the port 80 listener and remove extract temps. The database closes in will-quit. */
async function beforeQuit() {
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
}

/** STL_HOME and JUSTTPRINT_* settings; see env-settings-apply.js for when env wins over saved values. */
function applyEnvironment() {
  applyStlHomeEnvIfNeeded(process.env.STL_HOME);
  applyStlHomeExcludeEnvIfNeeded(process.env.STL_HOME_EXCLUDE);
  applyDockerEnvSettingIfNeeded('serverHttpPort', process.env.JUSTTPRINT_PORT);
  applyEnvSettings();
}

async function start() {
  if (!initializeDatabase()) {
    console.error('Database Error: Failed to initialize database. The application will now quit.');
    app.quit();
    return;
  }

  database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'versionCheckPerformedOnStartup');
  try {
    database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(version, 'currentVersion');
    console.log('Updated currentVersion in database to:', version);
  } catch (versionError) {
    console.error('Error updating currentVersion in database:', versionError);
  }

  applyEnvironment();

  // Clear leftover ZIP extract temps off the critical path.
  setImmediate(() => {
    try {
      ensureExtractTempDir();
    } catch (_) { /* ignore */ }
    cleanupExtractTempDirectory({ maxAgeMs: 0, includeLegacyOsTempRoot: false }).catch((error) => {
      console.warn('Extract temp cleanup on startup failed:', error.message);
    });
  });

  try {
    await startHttpServer(getAppListenPort(), false); // all interfaces
  } catch (error) {
    console.error('Server mode: failed to bind:', error.message);
    process.exit(1);
  }
  setImmediate(() => {
    maybeRenewLetsEncryptCertificate().catch((error) => {
      console.warn('[TLS] Startup renewal skipped:', error.message);
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
  startWatching().catch((error) => console.error('[Watch] Could not start folder watching:', error));
  autoBackup.schedule({ startup: true });
  downloadFiles.start();
  scheduleBackgroundHashGeneration('startup');
  scheduleBackgroundThumbnailCompression('startup');
  setTimeout(() => {
    try {
      verifyDatabaseIntegrity();
    } catch (error) {
      console.error('Deferred database integrity check failed:', error);
    }
  }, 3000);
}

app.on('will-quit', closeDatabaseOnQuit);
app.on('before-quit', beforeQuit);

app.whenReady().then(() => start().catch((error) => {
  console.error('Startup Error: Failed to start application properly:', error);
  app.quit();
}));
