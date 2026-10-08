'use strict';

/**
 * Events the server pushes to every connected browser. The WebSocket server installs the
 * sender while it is listening; before that (and after shutdown) broadcasts are dropped.
 */
const { jsonStringifyForWs } = require('./ws-json');

const OPEN = 1; // WebSocket.OPEN
let sender = null;
let otherSender = null;

/**
 * Called by the WebSocket server: `fn(channel, ...args)`, or null when it stops; `others(ws,
 * channel, ...args)` sends to every browser but one.
 */
function setBroadcaster(fn, others) {
  sender = typeof fn === 'function' ? fn : null;
  otherSender = typeof others === 'function' ? others : null;
}

/** Send an event to every connected browser. */
function broadcast(channel, ...args) {
  if (sender) sender(channel, ...args);
}

/**
 * Send an event to every browser except the one a request came from (`event.wsClient`): the
 * others learn about a change that browser made itself.
 */
function broadcastToOthers(event, channel, ...args) {
  const ws = event && event.wsClient;
  if (ws && otherSender) otherSender(ws, channel, ...args);
  else broadcast(channel, ...args);
}

/** Send an event to one browser: the WebSocket a request came in on (`event.wsClient`). */
function sendTo(ws, channel, ...args) {
  if (!ws || ws.readyState !== OPEN) return false;
  ws.send(jsonStringifyForWs({ type: 'event', channel, args }));
  return true;
}

/**
 * Send an event to the browser that made a request (a menu click, a dialog): its own preview,
 * download or file picker must not open in every other browser. Falls back to every browser
 * when the request carried no WebSocket.
 */
function toCaller(event, channel, ...args) {
  if (sendTo(event && event.wsClient, channel, ...args)) return;
  broadcast(channel, ...args);
}

module.exports = { setBroadcaster, broadcast, broadcastToOthers, sendTo, toCaller };
