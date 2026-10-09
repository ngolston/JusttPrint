'use strict';

const events = require('./events');
const thumbnailWorker = require('./thumbnail-worker');
const { jsonStringifyForWs } = require('./ws-json');
const { envOverridesSettings, flushSettingsToDisk, getSettingValueOr, persistSetting } = require('../core/settings');
const { app } = require('./runtime');
const { registerApiRoutes, registerClient, unregisterClient } = require('./api');
const { puterPendingRequests } = require('./ipc/ai');
const fs = require('fs');
const path = require('path');
const { registerMcpRoutes } = require('./mcp-server');
const serverTls = require('./server-tls');
const { registerHelperBundleRoute } = require('../../helper/install-bundle');
const { parseTrustProxy } = require('./server-auth');
const { RESPONSE_CHANNEL: DIALOG_RESPONSE_CHANNEL } = require('./client-dialogs');
const { clientDialogs } = require('./dialogs');
const { staticFilePath } = require('./server-paths');
const { getServerAuth } = require('./auth');
const { ROLE_LABELS, roleAllows } = require('./users');
const { registerUploadRoutes } = require('./uploads');
const { registerSharePages } = require('./share-pages');
const { registerSlicerFileRoutes } = require('./slicer-links');
const { registerLibraryFileRoutes } = require('./library-file-routes');
const { registerPuterAiProxyRoute } = require('./puter-ai-proxy');
const { startPort80Server, stopPort80Server, syncPort80Server } = require('./port80');
const { getMcpToolContext } = require('./mcp-tools');
const os = require('os');
const https = require('https');
const express = require('express');
const WebSocket = require('ws');
const { version } = require('../../package.json');

/** Middleware: the logged-in user (req.user, set by requireAuth) must have at least this role. */
function requireRole(role) {
  return (req, res, next) => {
    if (req.user && roleAllows(req.user.role, role)) return next();
    res.status(403).json({ error: `${req.user ? `${ROLE_LABELS[req.user.role] || req.user.role} accounts` : 'This account'} cannot do this. Ask an admin.` });
  };
}

// Server mode detection
/** @type {import('http').Server | import('https').Server | null} */
let httpServer = null;

let httpServerEpoch = 0;

/** @type {import('ws').WebSocketServer | null} */
let wss = null; // WebSocket server

/** @type {Set<any> | null} */
let wsClients = null; // WebSocket clients Set

let letsEncryptRenewInFlight = false;

/** Close every browser WebSocket with a close code and reason. */
function closeAllClients(code, reason) {
  if (!wsClients) return;
  wsClients.forEach((client) => {
    try {
      client.close(code, reason);
    } catch (_) {
      /* ignore */
    }
  });
}

/** Close the WebSockets of one user (their password changed, or the account was deleted). */
function closeClientsOfUser(userId, code, reason) {
  if (!wsClients || !userId) return;
  wsClients.forEach((client) => {
    if (!client.user || client.user.id !== userId) return;
    try {
      client.close(code, reason);
    } catch (_) {
      /* ignore */
    }
  });
}

/** Stop accepting HTTP connections (server shutdown). */
function closeHttpServer() {
  if (httpServer) httpServer.close();
}

function httpServerRunning() {
  return !!httpServer;
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
  expressApp.set('trust proxy', parseTrustProxy(process.env.JUSTTPRINT_TRUST_PROXY));
  expressApp.use((req, res, next) => {
    // Scripts only from this server's files: no inline <script>, onclick="" or eval anywhere. STEP
    // previews compile a WebAssembly module, which needs 'wasm-unsafe-eval' (WebAssembly only, not
    // JS eval); the STEP library is built without dynamic JS (vendor/occt-import-js/BUILD.md).
    // Puter.js runs only on its own sign-in popup (puter-signin.html), which hands the login token
    // back to the page.
    const scriptSrc = req.path === '/puter-signin.html' ? "script-src 'self' https://js.puter.com" : "script-src 'self' 'wasm-unsafe-eval'";
    res.setHeader('Content-Security-Policy', `${scriptSrc}; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`);
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
  // Share links (core/share-links.js): public, the token is the permission.
  registerSharePages(expressApp);
  // OrcaSlicer downloads models through short-lived per-file addresses (slicer-links.js).
  registerSlicerFileRoutes(expressApp);
  expressApp.use(auth.requireAuth);
  registerApiRoutes(expressApp);

  // MCP tools change anything (the API token is an admin); Puter AI requests come from AI tagging.
  expressApp.use('/mcp', requireRole('admin'));
  expressApp.use('/api/puter-ai', requireRole('editor'));
  registerUploadRoutes(expressApp, { requireRole });

  expressApp.use(express.json({ limit: '50mb' }));
  registerMcpRoutes(expressApp, getMcpToolContext());
  registerPuterAiProxyRoute(expressApp);

  const appDir = path.join(__dirname, '..', '..');

  /** The page. index.html loads server-bridge.js itself; nothing is inlined (CSP script-src 'self'). */
  function sendIndexHtml(res) {
    res.sendFile(path.join(appDir, 'src', 'web', 'public', 'index.html'), (err) => {
      if (err && !res.headersSent) res.status(500).send('Error loading index.html');
    });
  }

  expressApp.get('/', (req, res) => sendIndexHtml(res));

  // The images are in assets/. Two old addresses still answer: browsers ask for /favicon.ico on
  // their own, and libraries store '3d.png' (the placeholder) as a model's thumbnail.
  for (const name of ['favicon.ico', '3d.png']) {
    expressApp.get(`/${name}`, (req, res) => res.sendFile(path.join(appDir, 'assets', name)));
  }

  // The web app's files, only from the web folders (server-paths.js STATIC_FOLDERS). sendFile sets
  // the content types; these add the ones it lacks and keep the browser from caching code between updates.
  expressApp.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const filePath = staticFilePath(req.path, appDir);
    if (!filePath) return next();
    if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    if (req.path === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
    if (/\.(js|css|html|webmanifest)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  // Library files for the browser: /api/file (viewing) and /api/download (saving), library-file-routes.js.
  registerLibraryFileRoutes(expressApp);

  registerHelperBundleRoute(expressApp, appDir);

  // Other page paths get the page too (SPA routing).
  expressApp.get('*', (req, res) => {
    // Missing static files: the static handler called next(); respond or the client hangs (blocks parser on <script src>)
    if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|bmp|webp|json|webmanifest|map)$/)) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }

    sendIndexHtml(res);
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
          console.log(`[Local HTTP] TLS enabled (source: ${tlsResolved.source}) for the web UI and MCP`);
        }
        syncPort80Server().catch((err) => {
          console.warn('[TLS] Port 80 listener:', err.message);
        });
      } else {
        console.log(`JusttPrint server mode started`);
        console.log(`Server running at ${scheme}://${HOST}:${PORT}`);
        // The Docker HEALTHCHECK reads this to find the port and scheme (both can change in Settings).
        try {
          fs.writeFileSync(path.join(os.tmpdir(), 'justtprint-listen.json'), JSON.stringify({ port: PORT, scheme }));
        } catch (err) {
          console.warn('Could not write listen info for the health check:', err.message);
        }
        console.log(`Access from remote browsers: ${scheme}://<your-ip>:${PORT}`);
        if (useTls) {
          console.log(`TLS enabled (source: ${tlsResolved.source}): browser will use wss:// for the JusttPrint bridge (same port).`);
        }
        if (!localhostOnly) {
          syncPort80Server().catch((err) => {
            console.warn('[TLS] Port 80 listener:', err.message);
          });
        }
      }
      resolve(undefined);
    };

    console.log(`[Server] Binding ${scheme}://${HOST}:${PORT} (tls source: ${tlsResolved.source || 'none'})`);
    httpServerEpoch += 1;
    const server = useTls ? https.createServer(tlsOptions, expressApp).listen(PORT, HOST, onListening) : expressApp.listen(PORT, HOST, onListening);
    httpServer = server;

    server.on('error', (err) => {
      console.error('[Local HTTP] Server failed to bind:', err.message);
      console.error('[Local HTTP] Code:', err.code, '— If EACCES on macOS, add com.apple.security.network.server to entitlements and rebuild.');
      httpServer = null;
      reject(err);
    });
  });

  // WebSocket for what the server pushes to browsers (events, dialogs)
  wss = new WebSocket.Server({
    server: httpServer,
    verifyClient: (info, done) => {
      const result = getServerAuth().verifyUpgrade(info.req);
      if (!result.ok) console.warn(`[Server] WebSocket rejected: ${result.reason}`);
      else info.req.user = result.user;
      done(result.ok, result.status, result.reason);
    }
  });
  wsClients = new Set(); // Track all connected clients

  wss.on('connection', (ws, req) => {
    const isThumbnailWorker = thumbnailWorker.isWorkerRequest(req);
    console.debug(isThumbnailWorker ? 'Thumbnail worker connected' : 'WebSocket client connected');
    ws.user = req.user || null;
    wsClients?.add(ws);
    if (isThumbnailWorker) thumbnailWorker.attach(ws);

    // Actions go over the HTTP API; this id ties them back to this socket (dialogs, Puter AI).
    const clientId = registerClient(ws);
    ws.send(JSON.stringify({ type: 'hello', clientId }));

    // Browsers send only answers here: to dialogs the server asked, and to Puter AI requests.
    ws.on('message', (message) => {
      let parsed;
      try {
        parsed = JSON.parse(message.toString());
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
        return;
      }
      const { channel, args, type } = parsed || {};

      // A browser answered a dialog the server asked it to show.
      if (type === 'event' && channel === DIALOG_RESPONSE_CHANNEL) {
        const [dialogId, dialogResult] = args || [];
        clientDialogs.handleResponse(ws, dialogId, dialogResult);
        return;
      }

      // A browser answered a Puter AI request (Puter.js runs in the browser).
      if ((type === 'event' || type === 'send') && channel === 'puter-ai-chat-response') {
        const [requestId, result] = args || [];
        const pending = puterPendingRequests.get(requestId);
        if (!pending) {
          console.warn('[Puter AI] No pending request for requestId:', requestId);
          return;
        }
        puterPendingRequests.delete(requestId);
        if (result && result.error) {
          pending.reject(new Error(result.error));
        } else {
          pending.resolve(result ? result.response : null);
        }
        return;
      }

      // Actions moved to POST /api/actions/<name>.
      if (parsed && parsed.id) {
        ws.send(JSON.stringify({ id: parsed.id, type: 'error', error: 'Call actions with POST /api/actions/<name>' }));
      }
    });

    ws.on('close', () => {
      console.debug('WebSocket client disconnected');
      wsClients?.delete(ws);
      unregisterClient(clientId);
      clientDialogs.dropClient(ws);
      thumbnailWorker.detach(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      wsClients?.delete(ws);
      unregisterClient(clientId);
    });
  });

  // Broadcast events to all WebSocket clients
  function broadcastEvent(channel, ...args) {
    const message = jsonStringifyForWs({
      type: 'event',
      channel,
      args
    });
    wsClients?.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Error broadcasting event:', error);
        }
      }
    });
  }

  /** The same, to every browser except `except`. */
  function broadcastToOthers(except, channel, ...args) {
    const message = jsonStringifyForWs({ type: 'event', channel, args });
    wsClients?.forEach((client) => {
      if (client === except || client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(message);
      } catch (error) {
        console.error('Error broadcasting event:', error);
      }
    });
  }

  // Store broadcast function globally for use in IPC handlers
  events.setBroadcaster(broadcastEvent, broadcastToOthers);

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
      resolve(undefined);
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
            ws.close(1000, 'JusttPrint backend restarting');
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
      try {
        server.closeAllConnections();
      } catch (_) {
        /* ignore */
      }
    }

    // Close HTTP server
    server.close(() => {
      console.log('HTTP server closed');
      if (httpServerEpoch === epoch) {
        httpServer = null;
        wsClients = null;
        events.setBroadcaster(null);
      }
      resolve(undefined);
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
        resolve(undefined);
      }
    }, 5000);
  });
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
  const raw = process.env.JUSTTPRINT_PORT;
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

function getHttpServerListenPort() {
  if (!httpServer) return null;
  try {
    const addr = httpServer.address();
    if (addr && typeof addr === 'object' && addr.port) return addr.port;
  } catch (_) {
    /* ignore */
  }
  return null;
}

function listenWithTimeout(startPromise, ms) {
  return Promise.race([
    startPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`The JusttPrint backend did not start listening within ${ms}ms`)), ms);
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
      message: `The JusttPrint backend restarted at ${scheme}://<host>:${port}. Reopen JusttPrint with that address.`
    };
  } catch (error) {
    console.error('[Server] Restart bind failed:', error.message);
    if (httpServer) {
      try {
        if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
        httpServer.close();
      } catch (_) {
        /* ignore */
      }
      httpServer = null;
    }
    if (resolveAppTls().options) {
      console.error('[Server] Falling back to HTTP');
      try {
        await listenWithTimeout(startHttpServer(port, localhostOnly, { forcePlainHttp: true }), 8000);
        return {
          success: false,
          message: 'Could not start HTTPS; the JusttPrint backend is back on HTTP. ' + error.message
        };
      } catch (fallbackErr) {
        console.error('[Server] HTTP fallback failed:', fallbackErr.message);
        return { success: false, message: fallbackErr.message };
      }
    }
    return { success: false, message: error.message || 'Failed to restart the JusttPrint backend' };
  }
}

// Menu "Restart Server": reply on WebSocket first, then bounce the listener.
async function restartHttpServer() {
  setTimeout(() => {
    restartHttpServerNow().catch((error) => {
      console.error('Error during server restart:', error);
    });
  }, 100);
  return { success: true, message: 'JusttPrint backend restart started' };
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
    console.log("[TLS] Renewing Let's Encrypt certificate...");
    await serverTls.obtainLetsEncryptCertificate({
      certsDir: getTlsCertsDir(),
      domain: getSettingValueOr('tlsDomain', ''),
      email: getSettingValueOr('tlsEmail', ''),
      agreeTos: getSettingValueOr('tlsAgreeTos', '0') === '1',
      useStaging: getSettingValueOr('tlsUseStaging', '0') === '1'
    });
    await reloadTlsHttpListener();
  } catch (err) {
    serverTls.setLastTlsError(err.message || "Let's Encrypt renewal failed");
    console.warn('[TLS] Renewal failed:', err.message);
  } finally {
    letsEncryptRenewInFlight = false;
  }
}

module.exports = {
  closeAllClients,
  closeClientsOfUser,
  closeHttpServer,
  ensurePort80ForAcme,
  getAppListenPort,
  getConfiguredHttpPort,
  getHttpServerListenPort,
  getServerListenPort,
  getTlsCertsDir,
  getTlsStatusForUi,
  httpServerRunning,
  maybeRenewLetsEncryptCertificate,
  parseListenPort,
  persistTlsSettingsFromPayload,
  reloadTlsHttpListener,
  resolveAppTls,
  restartHttpServer,
  startHttpServer,
  stopPort80Server,
  syncPort80Server
};
