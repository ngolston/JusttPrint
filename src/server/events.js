'use strict';

/**
 * Events the server pushes to every connected browser. The WebSocket server installs the
 * sender while it is listening; before that (and after shutdown) broadcasts are dropped.
 */
const { jsonStringifyForWs } = require('./ws-json');

const OPEN = 1; // WebSocket.OPEN
let sender = null;

/** Called by the WebSocket server: `fn(channel, ...args)`, or null when it stops. */
function setBroadcaster(fn) {
  sender = typeof fn === 'function' ? fn : null;
}

/** Send an event to every connected browser. */
function broadcast(channel, ...args) {
  if (sender) sender(channel, ...args);
}

/** Send an event to one browser: the WebSocket a request came in on (`event.wsClient`). */
function sendTo(ws, channel, ...args) {
  if (!ws || ws.readyState !== OPEN) return false;
  ws.send(jsonStringifyForWs({ type: 'event', channel, args }));
  return true;
}

module.exports = { setBroadcaster, broadcast, sendTo };
