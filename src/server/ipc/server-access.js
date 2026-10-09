'use strict';

const { flushSettingsToDisk, persistSetting } = require('../../core/settings');
const { ipcMain } = require('../runtime');
const {
  closeClientsOfUser,
  ensurePort80ForAcme,
  getAppListenPort,
  getConfiguredHttpPort,
  getHttpServerListenPort,
  getServerListenPort,
  getTlsCertsDir,
  getTlsStatusForUi,
  httpServerRunning,
  parseListenPort,
  persistTlsSettingsFromPayload,
  reloadTlsHttpListener,
  resolveAppTls,
  restartHttpServer,
  syncPort80Server
} = require('../http');
const fs = require('fs');
const { buildMcpClientConfig, listToolDefinitions, SERVER_NAME: MCP_SERVER_NAME } = require('../mcp-server');
const serverTls = require('../server-tls');
const { MIN_PASSWORD_LENGTH } = require('../server-auth');
const { getServerAuth } = require('../auth');
const os = require('os');

function collectLanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets || {})) {
    for (const net of nets[name] || []) {
      if (!net || net.internal) continue;
      if (String(net.family) !== 'IPv4' && String(net.family) !== '4') continue; // Node 18.0–18.3 used the number 4
      if (net.address) out.push(net.address);
    }
  }
  return out;
}

function getMcpConnectionInfo() {
  const port = getHttpServerListenPort() || getConfiguredHttpPort();
  const enabled = true;
  const running = httpServerRunning();
  const lanAddresses = collectLanAddresses();
  const scheme = resolveAppTls().options ? 'https' : 'http';
  const localUrl = `${scheme}://127.0.0.1:${port}/mcp`;
  const urls = [`${scheme}://<server-host>:${port}/mcp`, localUrl, ...lanAddresses.map((ip) => `${scheme}://${ip}:${port}/mcp`)];
  const primaryUrl = lanAddresses[0] ? `${scheme}://${lanAddresses[0]}:${port}/mcp` : `${scheme}://0.0.0.0:${port}/mcp`;
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
  passwordFromEnv: !!process.env.JUSTTPRINT_PASSWORD,
  envUsername: getServerAuth().envUsername(),
  minPasswordLength: MIN_PASSWORD_LENGTH
}));

/** Log a user's browsers out shortly after the answer is sent (their sessions no longer work). */
function endSessionsOf(userId, reason) {
  setTimeout(() => closeClientsOfUser(userId, 4001, reason), 1500);
}

/** The caller changes their own password, which logs them out in every browser. */
ipcMain.handle('set-server-password', async (event, currentPassword, newPassword) => {
  const user = event && event.user;
  const result = getServerAuth().changeOwnPassword(user, currentPassword, newPassword);
  endSessionsOf(user.id, 'Password changed');
  return result;
});

// Settings → Users (admins only, api-actions.js).
ipcMain.handle('list-users', async () => ({
  users: getServerAuth().listUsers(),
  minPasswordLength: MIN_PASSWORD_LENGTH
}));

ipcMain.handle('create-user', async (event, details) => getServerAuth().createUser(details || {}));

ipcMain.handle('update-user', async (event, id, changes) => {
  const userId = Number(id);
  const result = getServerAuth().updateUser(userId, changes || {});
  if (changes && changes.password) endSessionsOf(userId, 'Password changed');
  return result;
});

ipcMain.handle('delete-user', async (event, id) => {
  const userId = Number(id);
  const result = getServerAuth().deleteUser(event && event.user, userId);
  require('./settings').forgetUserSettings(userId);
  endSessionsOf(userId, 'Account deleted');
  return result;
});

ipcMain.handle('regenerate-server-api-token', async () => ({
  apiToken: getServerAuth().regenerateApiToken()
}));

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
      message: 'TLS is overridden by JUSTTPRINT_TLS_CERT / JUSTTPRINT_TLS_KEY (or SSL_*). Unset those environment variables to use this UI.',
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
        throw new Error("Port 80 is reserved for Let's Encrypt HTTP-01 and HTTP redirect. Choose a different listen port.");
      }
    }
    persistTlsSettingsFromPayload(payload || {});
    const listenPort = getAppListenPort();
    if (listenPort === 80 && (mode === serverTls.TLS_MODES.LETSENCRYPT || payload.tlsRedirectHttp)) {
      throw new Error("Port 80 is reserved for Let's Encrypt HTTP-01 and HTTP redirect. Choose a different listen port.");
    }

    if (mode === serverTls.TLS_MODES.CUSTOM) {
      const certPath = String(payload.tlsCertPath || '').trim();
      const keyPath = String(payload.tlsKeyPath || '').trim();
      if (!certPath || !keyPath) {
        throw new Error('Certificate and key file paths are required for a custom certificate.');
      }
      const loaded = serverTls.readPemTlsOptions(certPath, keyPath, payload.tlsCaPath || '');
      if (!loaded) {
        throw new Error('Certificate or key file was not found. Use an absolute path inside the JusttPrint backend container.');
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
      message:
        'Self-signed certificate generated (includes localhost and 127.0.0.1). Browsers and Chrome will warn until you trust it. ' + (restart.message || ''),
      status: getTlsStatusForUi(),
      paths: generated
    };
  } catch (err) {
    serverTls.setLastTlsError(err.message);
    return { success: false, message: err.message || 'Failed to generate certificate', status: getTlsStatusForUi() };
  }
});

ipcMain.handle('get-mcp-connection-info', async () => {
  return getMcpConnectionInfo();
});

module.exports = {};
