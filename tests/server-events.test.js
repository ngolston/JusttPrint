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

// sendTo reaches one open socket only.
const frames = [];
const open = { readyState: 1, send: (text) => frames.push(JSON.parse(text)) };
assert.strictEqual(events.sendTo(open, 'execute-client-command', { type: 'open-in-slicer' }), true);
assert.deepStrictEqual(frames, [{ type: 'event', channel: 'execute-client-command', args: [{ type: 'open-in-slicer' }] }]);
assert.strictEqual(
  events.sendTo(
    {
      readyState: 3,
      send() {
        throw new Error('closed');
      }
    },
    'x'
  ),
  false
);
assert.strictEqual(events.sendTo(null, 'x'), false);

console.log('server-events tests passed');
