'use strict';

/**
 * The plain-HTTP listener on port 80: Let's Encrypt's HTTP-01 challenge, and the optional
 * redirect to HTTPS (server-tls.js decides which requests it answers). Started and stopped with
 * the TLS settings (http.js).
 */

const { getSettingValueOr } = require('../core/settings');
const serverTls = require('./server-tls');

let http80Server = null;

function formatPort80BindError(err) {
  if (!err) return 'Failed to bind port 80.';
  if (err.code === 'EACCES') {
    return "Could not bind port 80 (permission denied). Let's Encrypt HTTP-01 and HTTP redirect need port 80. Run as administrator/root, or in Docker publish 80:80.";
  }
  if (err.code === 'EADDRINUSE') {
    return 'Port 80 is already in use. Stop the other listener or disable HTTP-01 / redirect.';
  }
  return err.message || 'Failed to bind port 80.';
}

function stopPort80Server() {
  return new Promise((resolve) => {
    if (!http80Server) {
      resolve(undefined);
      return;
    }
    const server = http80Server;
    http80Server = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(undefined);
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
      resolve(undefined);
      return;
    }
    const http = require('http');
    const server = http.createServer((req, res) => {
      serverTls.handleAcmeOrRedirectRequest(req, res, {
        getSetting: getSettingValueOr,
        appPort: require('./http').getAppListenPort(),
        tlsActive: !!require('./http').resolveAppTls().options
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
      resolve(undefined);
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

module.exports = { formatPort80BindError, startPort80Server, stopPort80Server, syncPort80Server };
