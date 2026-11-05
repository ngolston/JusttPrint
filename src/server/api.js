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
 * `POST /api/batch` with `{ "calls": [{ "name", "args" }] }` runs several calls in one request, each
 * checked as above, and answers one JSON line per call as each is done: `{ "i", "result" }` or
 * `{ "i", "error", "status" }` (`i` is the call's place in the list).
 *
 * The WebSocket stays for what the server pushes: events, and dialogs it asks one browser to show.
 * A browser sends the id it got on its WebSocket in the X-JusttPrint-Client header, so an action
 * can ask that browser (client-dialogs.js) or hand it a Puter AI request.
 */

const crypto = require('crypto');
const { sendJsonText } = require('./compress');
const express = require('express');
const events = require('./events');
const { ipcMain } = require('./runtime');
const { assertActionArgs, isAction, requiredRole } = require('./api-actions');
const { ROLE_LABELS, canDeleteFiles, roleAllows } = require('./users');

/** Actions that delete files from disk: admins, and editors allowed to (users.js canDeleteFiles). */
const DISK_DELETE_ACTIONS = new Set(['delete-file', 'trash-file']);
const { assertNetworkIpcArgs } = require('./server-paths');
const { networkPathContext } = require('./path-context');
const { jsonStringifyForWs } = require('./ws-json');

const ROUTE = '/api/actions/:name';
const BATCH_ROUTE = '/api/batch';
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

/**
 * Check one call (the action exists, the caller's role, arguments, library paths) and run it.
 * Answers { status, result } or { status, error }; the result may be binary.
 * @returns {Promise<{ status: number, result?: any, error?: string }>}
 */
async function callChecked(req, name, args) {
  const handler = ipcMain._handlers.get(name);
  if (!isAction(name) || !handler) return { status: 404, error: `Unknown action: ${name}` };

  const user = req.user || null;
  const role = requiredRole(name);
  if (!user || !roleAllows(user.role, role)) {
    const who = user ? `${ROLE_LABELS[user.role] || user.role} accounts` : 'This account';
    console.warn(`[API] Refused ${name} for ${user ? user.username : 'nobody'}: needs ${role}`);
    return { status: 403, error: `${who} cannot do this. Ask an admin${role === 'admin' ? '' : ' to make you an editor'}.` };
  }

  if (DISK_DELETE_ACTIONS.has(name) && !canDeleteFiles(user)) {
    console.warn(`[API] Refused ${name} for ${user.username}: may not delete files`);
    return { status: 403, error: 'This account cannot delete files from disk. Remove the model from the library instead, or ask an admin.' };
  }

  // Guests (server-auth.js) have no account to change.
  if (user.guest && name === 'set-server-password') return { status: 403, error: 'Log in to change a password.' };

  try {
    assertActionArgs(name, args);
  } catch (error) {
    console.warn(`[API] Bad arguments: ${error.message}`);
    return { status: 400, error: error.message };
  }
  try {
    assertNetworkIpcArgs(name, args, networkPathContext());
  } catch (error) {
    console.warn(`[API] Refused ${name}: ${error.message}`);
    return { status: 403, error: error.message };
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
  try {
    return { status: 200, result: await handler(event, ...args) };
  } catch (error) {
    console.error(`[API] ${name} failed:`, error);
    return { status: 500, error: (error && error.message) || String(error) };
  }
}

/** A binary result inside JSON (long calls, batches): base64, which the browser turns back. */
const binaryJson = (binary) => ({ __arrayBuffer: true, data: binary.toString('base64'), byteLength: binary.length });

/**
 * Calls still running after `keepaliveMs` commit to 200 and send a space now and then, so reverse
 * proxies keep the connection; `answer` then writes the JSON. Answers whether it streamed.
 */
function withKeepalive(res, keepaliveMs) {
  /** @type {NodeJS.Timeout | null} */
  let keepalive = null;
  let streaming = false;
  const startStreaming = setTimeout(() => {
    streaming = true;
    res.status(200).type('application/json');
    res.write(' ');
    keepalive = setInterval(() => res.write(' '), keepaliveMs);
  }, keepaliveMs);
  return {
    streaming: () => streaming,
    stop() {
      clearTimeout(startStreaming);
      if (keepalive) clearInterval(keepalive);
    }
  };
}

async function runAction(req, res, keepaliveMs) {
  const { name } = req.params;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const args = body.args === undefined ? [] : body.args;
  const timer = withKeepalive(res, keepaliveMs);
  let outcome;
  try {
    outcome = await callChecked(req, name, args);
  } finally {
    timer.stop();
  }
  if (res.writableEnded || res.destroyed) return;

  const binary = outcome.error ? null : binaryBody(outcome.result);
  if (timer.streaming()) {
    const late = binary ? { result: binaryJson(binary) } : outcome.error ? { error: outcome.error } : { result: outcome.result };
    res.end(jsonStringifyForWs(late));
  } else if (outcome.error) {
    sendError(res, outcome.status, outcome.error);
  } else if (binary) {
    res.type('application/octet-stream').send(binary);
  } else {
    sendJsonText(req, res, jsonStringifyForWs({ result: outcome.result }));
  }
}

/** At most this many calls in one batch. */
const BATCH_MAX = 50;

/**
 * POST /api/batch with { calls: [{ name, args }] }: several calls in one request (the browser
 * gathers the reads a page makes at once, src/web/api.ts), each checked and run as if it came
 * alone, side by side. The answer is one JSON line per call, sent as soon as that call is done
 * (so a slow one holds up no other): { i, result } or { i, error, status }, `i` its place in
 * `calls`. Empty lines keep a quiet connection alive through reverse proxies.
 */
async function runBatch(req, res, keepaliveMs) {
  const calls = req.body && Array.isArray(req.body.calls) ? req.body.calls : null;
  if (!calls || calls.length === 0 || calls.length > BATCH_MAX) {
    sendError(res, 400, `A batch is 1 to ${BATCH_MAX} calls: { "calls": [{ "name", "args" }] }`);
    return;
  }
  res.status(200).type('application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  // Proxies such as nginx pass the lines on as they come.
  res.setHeader('X-Accel-Buffering', 'no');
  const keepalive = setInterval(() => res.write('\n'), keepaliveMs);
  try {
    await Promise.all(
      calls.map(async (call, i) => {
        const name = call && typeof call.name === 'string' ? call.name : '';
        const args = call && call.args !== undefined ? call.args : [];
        const outcome = await callChecked(req, name, Array.isArray(args) ? args : [args]);
        if (res.writableEnded || res.destroyed) return;
        let line;
        if (outcome.error) line = { i, error: outcome.error, status: outcome.status };
        else {
          const binary = binaryBody(outcome.result);
          line = { i, result: binary ? binaryJson(binary) : outcome.result };
        }
        res.write(`${jsonStringifyForWs(line)}\n`);
      })
    );
  } finally {
    clearInterval(keepalive);
  }
  if (!res.writableEnded && !res.destroyed) res.end();
}

/**
 * Mount the API. Call after requireAuth and before any other JSON body parser.
 * @param {object} [options]
 * @param {number} [options.keepaliveMs] When long calls start sending keep-alive spaces (tests use less).
 */
function registerApiRoutes(expressApp, { keepaliveMs = KEEPALIVE_MS } = {}) {
  expressApp.post(
    BATCH_ROUTE,
    express.json({ limit: BODY_LIMIT }),
    (req, res) => {
      runBatch(req, res, keepaliveMs).catch((error) => {
        console.error('[API] Unexpected error in a batch:', error);
        if (!res.headersSent) sendError(res, 500, 'Internal error');
        else res.end();
      });
    },
    (error, req, res, next) => sendError(res, error.status || 400, error.message || 'Bad request')
  );
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
