#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createClientDialogs, REQUEST_CHANNEL } = require('./client-dialogs');

const pending = [];
function test(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(
        () => console.log('ok ' + name),
        (err) => {
          console.error('FAIL ' + name + ':', err.message);
          process.exitCode = 1;
        }
      )
  );
}

const quiet = { warn() {} };
function fakeSocket() {
  return {
    readyState: 1,
    /** @type {any[]} */
    sent: [],
    send(text) {
      this.sent.push(JSON.parse(text));
    }
  };
}

test('a message box goes to the browser that asked and returns its answer', async () => {
  const dialogs = createClientDialogs({ logger: quiet });
  const ws = fakeSocket();
  const answer = dialogs.messageBox({ wsClient: ws }, { title: 'Overwrite?', buttons: ['Yes', 'No'], cancelId: 1 });
  const [id, kind, options] = ws.sent[0].args;
  assert.strictEqual(ws.sent[0].channel, REQUEST_CHANNEL);
  assert.strictEqual(kind, 'message');
  assert.deepStrictEqual(options.buttons, ['Yes', 'No']);
  assert.ok(dialogs.handleResponse(ws, id, { response: 0 }));
  assert.deepStrictEqual(await answer, { response: 0, checkboxChecked: false });
});

test('without a browser, dialogs answer Cancel', async () => {
  const dialogs = createClientDialogs({ logger: quiet });
  assert.deepStrictEqual(await dialogs.messageBox(null, { buttons: ['Yes', 'No'] }), { response: 1, checkboxChecked: false });
  assert.strictEqual(await dialogs.input({}, { title: 'Folder' }), null);
});

test('only the browser that was asked can answer, and bad answers mean Cancel', async () => {
  const dialogs = createClientDialogs({ logger: quiet });
  const ws = fakeSocket();
  const answer = dialogs.messageBox({ wsClient: ws }, { buttons: ['Delete', 'Keep'], cancelId: 1 });
  const id = ws.sent[0].args[0];
  assert.strictEqual(dialogs.handleResponse(fakeSocket(), id, { response: 0 }), false);
  dialogs.handleResponse(ws, id, { response: 7 });
  assert.strictEqual((await answer).response, 1);
});

test('closing the tab or not answering in time cancels', async () => {
  const dialogs = createClientDialogs({ logger: quiet, timeoutMs: 20 });
  const ws = fakeSocket();
  const dropped = dialogs.input({ wsClient: ws }, { title: 'Name' });
  dialogs.dropClient(ws);
  assert.strictEqual(await dropped, null);
  const timedOut = dialogs.messageBox({ wsClient: fakeSocket() }, { buttons: ['OK'] });
  assert.strictEqual((await timedOut).response, 0);
  assert.strictEqual(dialogs.pendingCount(), 0);
});

test('text prompts return the entered text', async () => {
  const dialogs = createClientDialogs({ logger: quiet });
  const ws = fakeSocket();
  const answer = dialogs.input({ wsClient: ws }, { title: 'Destination', defaultValue: '/mnt/models' });
  const [id, kind, options] = ws.sent[0].args;
  assert.strictEqual(kind, 'input');
  assert.strictEqual(options.defaultValue, '/mnt/models');
  dialogs.handleResponse(ws, id, { value: '/mnt/models/out' });
  assert.strictEqual(await answer, '/mnt/models/out');
});

Promise.all(pending).then(() => process.exit(process.exitCode || 0));
