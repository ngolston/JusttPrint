'use strict';

const assert = require('assert');
const events = require('../src/server/events');

// Without a WebSocket server, broadcasts are dropped quietly.
events.broadcast('refresh-grid');

const sent = [];
events.setBroadcaster((channel, ...args) => sent.push([channel, ...args]));
events.broadcast('thumbnail-added', { id: 1 });
assert.deepStrictEqual(sent, [['thumbnail-added', { id: 1 }]]);

events.setBroadcaster(null);
events.broadcast('refresh-grid');
assert.strictEqual(sent.length, 1);

console.log('server-events tests passed');
