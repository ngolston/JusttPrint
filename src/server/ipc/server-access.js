'use strict';

const events = require('../events');
const { flushSettingsToDisk, getSettingValueOr, persistSetting } = require('../../core/settings');
const { ipcMain } = require('../runtime');
const { closeAllClients, ensurePort80ForAcme, getAppListenPort, getConfiguredHttpPort, getHttpServerListenPort, getServerListenPort, getTlsCertsDir, getTlsStatusForUi, httpServerRunning, parseListenPort, persistTlsSettingsFromPayload, reloadTlsHttpListener, resolveAppTls, restartHttpServer, syncPort80Server } = require('../http');
const fs = require('fs');
const { buildMcpClientConfig, listToolDefinitions, SERVER_NAME: MCP_SERVER_NAME } = require('../mcp-server');
const serverTls = require('../server-tls');
const extensionInbox = require('../extension-inbox');
const { MIN_PASSWORD_LENGTH } = require('../server-auth');
const { getServerAuth } = require('../auth');
const { getDatabasePath } = require('../../core/db-path');
const { saveModel } = require('./models');
const os = require('os');

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

module.exports = { startExtensionInboxWatcher };
