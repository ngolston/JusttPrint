#!/usr/bin/env node
'use strict';

/**
 * Docker HEALTHCHECK: asks /api/health on the port the server reported when it started.
 * Exit 0 when healthy, 1 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let listen = {};
try {
  listen = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'justtprint-listen.json'), 'utf8'));
} catch (_) {
  // Not written yet: fall back to the configured or default port.
}
const port = Number(listen.port) || Number(process.env.JUSTTPRINT_PORT) || 5000;
const scheme = listen.scheme === 'https' ? 'https' : 'http';
const client = require(scheme);

const req = client.get(
  {
    host: '127.0.0.1',
    port,
    path: '/api/health',
    timeout: 4000,
    // The certificate is issued for the public host name, not 127.0.0.1.
    rejectUnauthorized: false
  },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  }
);
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
