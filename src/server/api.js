'use strict';

/**
 * The HTTP API the web UI calls: `POST /api/actions/<name>` with a JSON body `{ "args": [...] }`.
 * Only actions listed in api-actions.js exist, and each call is checked before it runs:
 * login (requireAuth, mounted before this), same origin for POST (rejectForeignOrigins),
 * the caller's role (api-actions.js, users.js), the argument list (api-actions.js) and
 * library paths (server-paths.js). Handlers get the caller as `event.user`.
 *
 * Responses:
 * - 200 `{ "result": ... }`, or the raw bytes (application/octet-stream) when the result is binary.
 * - 400 bad arguments, 403 role too low or path outside the library, 404 unknown action, 500 the action failed;
 *   all with `{ "error": "..." }`.
 * - Calls still running after 15 seconds (scans, hashing, large previews) commit to 200 and send
 *   a space every 15 seconds, so reverse proxies do not time them out. The JSON follows (leading
 *   whitespace is valid JSON); a binary result is then base64 `{ "__arrayBuffer": true, ... }`
 *   and a failure is `{ "error": "..." }`.
 *
 * The WebSocket stays for what the server pushes: events, and dialogs it asks one browser to show.
 * A browser sends the id it got on its WebSocket in the X-JusttPrint-Client header, so an action
 * can ask that browser (client-dialogs.js) or hand it a Puter AI request.
 */

const crypto = require('crypto');
const express = require('express');
const events = require('./events');
const { ipcMain } = require('./runtime');
const { assertActionArgs, isAction, requiredRole } = require('./api-actions');
const { ROLE_LABELS, roleAllows } = require('./users');
const { assertNetworkIpcArgs } = require('./server-paths');
const { networkPathContext } = require('./path-context');
const { jsonStringifyForWs } = require('./ws-json');

const ROUTE = '/api/actions/:name';
const CLIENT_HEADER = 'X-JusttPrint-Client';
// Database restores and model uploads arrive as base64; same cap as a WebSocket message.
const BODY_LIMIT = '100mb';
const KEEPALIVE_MS = 15000;

const clients = new Map(); // client id -> WebSocket

/** Called when a browser's WebSocket opens. Returns the id it sends back on API calls. */
function registerClient(ws) {
  const id = crypto.randomBytes(16).toString('hex');
  clients.set(id, ws);
  return id;
}

function unregisterClient(id) {
  clients.delete(id);
}

function binaryBody(result) {
  if (result instanceof ArrayBuffer) return Buffer.from(result);
  if (ArrayBuffer.isView(result)) return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  return null;
}

function sendError(res, status, message) {
  res
    .status(status)
    .type('application/json')
    .send(JSON.stringify({ error: message }));
}

async function runAction(req, res, keepaliveMs) {
  const { name } = req.params;
  const handler = ipcMain._handlers.get(name);
  if (!isAction(name) || !handler) {
    sendError(res, 404, `Unknown action: ${name}`);
    return;
  }

  const user = req.user || null;
  const role = requiredRole(name);
  if (!user || !roleAllows(user.role, role)) {
    const who = user ? `${ROLE_LABELS[user.role] || user.role} accounts` : 'This account';
    console.warn(`[API] Refused ${name} for ${user ? user.username : 'nobody'}: needs ${role}`);
    sendError(res, 403, `${who} cannot do this. Ask an admin${role === 'admin' ? '' : ' to make you an editor'}.`);
    return;
  }

  // Guests (server-auth.js) have no account to change.
  if (user.guest && name === 'set-server-password') {
    sendError(res, 403, 'Log in to change a password.');
    return;
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const args = body.args === undefined ? [] : body.args;
  try {
    assertActionArgs(name, args);
  } catch (error) {
    console.warn(`[API] Bad arguments: ${error.message}`);
    sendError(res, 400, error.message);
    return;
  }
  try {
    assertNetworkIpcArgs(name, args, networkPathContext());
  } catch (error) {
    console.warn(`[API] Refused ${name}: ${error.message}`);
    sendError(res, 403, error.message);
    return;
  }

  const wsClient = clients.get(req.get(CLIENT_HEADER) || '') || null;
  // A handler's event.sender.send answers the browser that asked (its progress, dialogs and
  // messages); changes every browser must see use events.broadcast.
  const event = {
    sender: { send: (channel, ...eventArgs) => events.toCaller({ wsClient }, channel, ...eventArgs) },
    wsClient,
    user,
    fromNetwork: true
  };

  /** @type {NodeJS.Timeout | null} */
  let keepalive = null;
  let streaming = false;
  const startStreaming = setTimeout(() => {
    streaming = true;
    res.status(200).type('application/json');
    res.write(' ');
    keepalive = setInterval(() => res.write(' '), keepaliveMs);
  }, keepaliveMs);

  let outcome;
  try {
    outcome = { result: await handler(event, ...args) };
  } catch (error) {
    console.error(`[API] ${name} failed:`, error);
    outcome = { error: (error && error.message) || String(error) };
  } finally {
    clearTimeout(startStreaming);
    if (keepalive) clearInterval(keepalive);
  }
  if (res.writableEnded || res.destroyed) return;

  const binary = outcome.error ? null : binaryBody(outcome.result);
  if (streaming) {
    const late = binary ? { result: { __arrayBuffer: true, data: binary.toString('base64'), byteLength: binary.length } } : outcome;
    res.end(jsonStringifyForWs(late));
  } else if (outcome.error) {
    sendError(res, 500, outcome.error);
  } else if (binary) {
    res.type('application/octet-stream').send(binary);
  } else {
    res.type('application/json').send(jsonStringifyForWs(outcome));
  }
}

/**
 * Mount the API. Call after requireAuth and before any other JSON body parser.
 * @param {object} [options]
 * @param {number} [options.keepaliveMs] When long calls start sending keep-alive spaces (tests use less).
 */
function registerApiRoutes(expressApp, { keepaliveMs = KEEPALIVE_MS } = {}) {
  expressApp.post(
    ROUTE,
    express.json({ limit: BODY_LIMIT }),
    (req, res) => {
      runAction(req, res, keepaliveMs).catch((error) => {
        console.error('[API] Unexpected error:', error);
        if (!res.headersSent) sendError(res, 500, 'Internal error');
        else res.end();
      });
    },
    // Body parser errors (bad JSON, too large) as JSON instead of an HTML page.

    (error, req, res, next) => sendError(res, error.status || 400, error.message || 'Bad request')
  );
}

module.exports = { CLIENT_HEADER, registerApiRoutes, registerClient, unregisterClient };
