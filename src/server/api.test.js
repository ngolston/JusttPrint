'use strict';

// The HTTP API route (api.js): roles, status codes, binary results, keep-alive for long calls, and batches.
const assert = require('assert');
const express = require('express');
const { ipcMain } = require('./runtime');
const { registerApiRoutes, registerClient, unregisterClient, CLIENT_HEADER } = require('./api');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @type {any} */
let seenEvent = null;

// Stand-in handlers under real action names that have no path rules.
ipcMain.handle('get-stats', async (event, ...args) => {
  seenEvent = event;
  return { totalModels: 4, args, mesh: new Float32Array([1.5, 2]) };
});
ipcMain.handle('get-default-ai-prompt', async () => Buffer.from([0, 1, 2, 255]));
ipcMain.handle('get-gpu-info', async () => {
  throw new Error('no GPU here');
});
ipcMain.handle('benchmark-filesystem', async () => {
  await wait(160);
  return Buffer.from('slow bytes');
});
ipcMain.handle('benchmark-database', async () => {
  await wait(160);
  throw new Error('slow failure');
});
ipcMain.handle('internal-only', async () => 1); // a handler that is not an action

async function main() {
  const app = express();
  // Stands in for requireAuth: the X-Test-Role header picks the caller's role (default admin).
  app.use((req, res, next) => {
    const role = req.get('x-test-role') || 'admin';
    if (role !== 'none') req.user = { id: 7, username: `test-${role}`, role };
    next();
  });
  registerApiRoutes(app, { keepaliveMs: 50 });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (name, body, headers = {}) =>
    fetch(`${base}/api/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });

  try {
    const fakeSocket = { readyState: 1 };
    const clientId = registerClient(fakeSocket);
    let res = await call('get-stats', { args: [] }, { [CLIENT_HEADER]: clientId });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { result: { totalModels: 4, args: [], mesh: [1.5, 2] } });
    assert.strictEqual(seenEvent.fromNetwork, true, 'handlers see fromNetwork');
    assert.deepStrictEqual(seenEvent.user, { id: 7, username: 'test-admin', role: 'admin' }, 'handlers see the caller');
    assert.strictEqual(seenEvent.wsClient, fakeSocket, "the client header picks the caller's WebSocket");
    unregisterClient(clientId);
    await call('get-stats', {}, { [CLIENT_HEADER]: clientId });
    assert.strictEqual(seenEvent.wsClient, null, 'unknown client ids give no WebSocket');

    // Roles: get-stats only reads; get-default-ai-prompt (AI settings) needs an admin.
    assert.strictEqual((await call('get-stats', { args: [] }, { 'x-test-role': 'viewer' })).status, 200, 'viewers may read');
    res = await call('get-default-ai-prompt', { args: [] }, { 'x-test-role': 'editor' });
    assert.strictEqual(res.status, 403, 'editors cannot reach admin actions');
    assert.match((await res.json()).error, /Editor accounts cannot do this/);
    assert.strictEqual((await call('get-default-ai-prompt', { args: [] }, { 'x-test-role': 'viewer' })).status, 403);
    assert.strictEqual((await call('get-stats', { args: [] }, { 'x-test-role': 'none' })).status, 403, 'no user, no action');

    res = await call('get-default-ai-prompt', { args: [] });
    assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
    assert.deepStrictEqual([...new Uint8Array(await res.arrayBuffer())], [0, 1, 2, 255]);

    res = await call('get-gpu-info', { args: [] });
    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(await res.json(), { error: 'no GPU here' });

    assert.strictEqual((await call('internal-only', { args: [1] })).status, 404, 'handlers that are not actions are refused');
    assert.strictEqual((await call('no-such-action', { args: [] })).status, 404);
    assert.strictEqual((await call('get-stats', { args: ['extra'] })).status, 400);
    assert.strictEqual((await call('get-stats', { args: 'nope' })).status, 400);
    res = await call('get-stats', '{broken');
    assert.strictEqual(res.status, 400);
    assert.ok((await res.json()).error, 'malformed JSON gets a JSON error');

    // Long calls: 200 straight away, keep-alive spaces, then the JSON.
    res = await call('benchmark-filesystem', { args: [] });
    assert.strictEqual(res.status, 200);
    let text = await res.text();
    assert.ok(/^ +\{/.test(text), `keep-alive spaces before the JSON: ${JSON.stringify(text.slice(0, 20))}`);
    const late = JSON.parse(text).result;
    assert.strictEqual(late.__arrayBuffer, true);
    assert.strictEqual(Buffer.from(late.data, 'base64').toString(), 'slow bytes');

    res = await call('benchmark-database', { args: [] });
    assert.strictEqual(res.status, 200);
    text = await res.text();
    assert.deepStrictEqual(JSON.parse(text), { error: 'slow failure' });

    // Batches: each call checked and answered as if alone, one JSON line each as it is done.
    const batch = (calls, headers = {}) =>
      fetch(`${base}/api/batch`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ calls }) });
    /** The answer lines, by their place in the batch, and the order they came in. */
    const lines = async (response) => {
      const got = (await response.text())
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      return { byIndex: Object.fromEntries(got.map(({ i, ...rest }) => [i, rest])), order: got.map((line) => line.i) };
    };
    res = await batch(
      [
        { name: 'get-stats', args: [] },
        { name: 'get-default-ai-prompt', args: [] },
        { name: 'get-gpu-info', args: [] },
        { name: 'no-such-action', args: [] },
        { name: 'get-stats', args: ['extra'] }
      ],
      { 'x-test-role': 'viewer' }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/x-ndjson');
    let { byIndex, order } = await lines(res);
    assert.deepStrictEqual(byIndex[0], { result: { totalModels: 4, args: [], mesh: [1.5, 2] } });
    assert.strictEqual(byIndex[1].status, 403, 'roles are checked per call');
    assert.match(byIndex[1].error, /Viewer accounts cannot do this/);
    assert.deepStrictEqual(byIndex[2], { error: 'no GPU here', status: 500 });
    assert.strictEqual(byIndex[3].status, 404);
    assert.strictEqual(byIndex[4].status, 400, 'arguments are checked per call');
    // An admin's binary result comes as base64.
    ({ byIndex } = await lines(await batch([{ name: 'get-default-ai-prompt', args: [] }])));
    assert.strictEqual(byIndex[0].result.__arrayBuffer, true);
    assert.deepStrictEqual([...Buffer.from(byIndex[0].result.data, 'base64')], [0, 1, 2, 255]);
    // A slow call does not hold up a quick one: the quick answer comes first.
    ({ byIndex, order } = await lines(
      await batch([
        { name: 'benchmark-database', args: [] },
        { name: 'get-stats', args: [] }
      ])
    ));
    assert.deepStrictEqual(order, [1, 0], 'answers come as they are done');
    assert.deepStrictEqual(byIndex[0], { error: 'slow failure', status: 500 });
    assert.strictEqual((await batch([])).status, 400, 'an empty batch is refused');
    assert.strictEqual((await batch(Array.from({ length: 51 }, () => ({ name: 'get-stats', args: [] })))).status, 400, 'at most 50 calls');
    ({ byIndex } = await lines(await batch([{ name: 'get-stats', args: [] }], { 'x-test-role': 'none' })));
    assert.strictEqual(byIndex[0].status, 403, 'no user, no call in a batch either');
  } finally {
    server.close();
  }
  console.log('api route tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
