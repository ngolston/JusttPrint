'use strict';

// The HTTP API's action list (src/server/api-actions.js) must match the IPC handlers and the web UI.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ACTIONS, assertActionArgs, isAction } = require('../src/server/api-actions');

const ROOT = path.join(__dirname, '..');
const ipcDir = path.join(ROOT, 'src', 'server', 'ipc');
const registered = new Set();
for (const file of fs.readdirSync(ipcDir)) {
  if (!file.endsWith('.js')) continue;
  for (const match of fs.readFileSync(path.join(ipcDir, file), 'utf8').matchAll(/ipcMain\.handle\('([^']+)'/g)) {
    registered.add(match[1]);
  }
}

// Every action runs a handler.
for (const name of Object.keys(ACTIONS)) {
  assert.ok(registered.has(name), `action ${name} has no ipcMain.handle in src/server/ipc`);
}

// Every handler the web UI calls is an action: window.electron.<method>() through the bridge's
// method list, or window.electron.invoke('<channel>').
const bridge = fs.readFileSync(path.join(ROOT, 'server-bridge.js'), 'utf8');
const methodToChannel = {};
for (const match of bridge.matchAll(/'([A-Za-z0-9]+)': '([^']+)'/g)) methodToChannel[match[1]] = match[2];
const webUi = fs.readdirSync(ROOT)
  .filter((file) => file.endsWith('.js') && file !== 'server-bridge.js')
  .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
  .join('\n');
for (const [method, channel] of Object.entries(methodToChannel)) {
  if (!registered.has(channel) || !new RegExp(`\\.${method}\\(`).test(webUi)) continue;
  assert.ok(isAction(channel), `the web UI calls ${method}() but ${channel} is not in api-actions.js`);
}
for (const match of webUi.matchAll(/\.invoke\(\s*['"]([^'"]+)['"]/g)) {
  if (registered.has(match[1])) assert.ok(isAction(match[1]), `the web UI invokes ${match[1]} but it is not in api-actions.js`);
}

// Argument checks.
const refuses = (name, args, pattern) => assert.throws(() => assertActionArgs(name, args), pattern);
assertActionArgs('get-stats', []);
assertActionArgs('get-model', ['/library/cube.stl']);
assertActionArgs('get-all-models', ['date-desc']);
assertActionArgs('get-all-models', [null, 0]);
assertActionArgs('delete-tag', [3]);
assertActionArgs('delete-tag', ['3']);
assertActionArgs('save-setting', ['key', { any: 'value' }]);
assertActionArgs('restore-database', []);
refuses('no-such-action', [], /Unknown action/);
refuses('get-stats', ['extra'], /at most 0/);
refuses('get-model', [], /argument 1 is required/);
refuses('get-model', [42], /must be a string/);
refuses('delete-tag', [''], /must be an id/);
refuses('save-model', [['not', 'an', 'object']], /must be an object/);
refuses('save-model-batch', [{}], /must be an array/);
refuses('get-all-models', ['date-desc', 'ten'], /must be a number/);
refuses('get-stats', 'not-a-list', /args must be an array/);
assert.ok(!isAction('toString'), 'object prototype keys are not actions');

console.log('api actions tests passed');
