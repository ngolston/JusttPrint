'use strict';

/**
 * Events the server pushes to every connected browser. The WebSocket server installs the
 * sender while it is listening; before that (and after shutdown) broadcasts are dropped.
 */
let sender = null;

/** Called by the WebSocket server: `fn(channel, ...args)`, or null when it stops. */
function setBroadcaster(fn) {
  sender = typeof fn === 'function' ? fn : null;
}

/** Send an event to every connected browser. */
function broadcast(channel, ...args) {
  if (sender) sender(channel, ...args);
}

module.exports = { setBroadcaster, broadcast };
