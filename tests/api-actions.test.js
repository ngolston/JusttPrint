'use strict';

// The HTTP API's action list (src/server/api-actions.js) must match the IPC handlers and the web UI.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ACTIONS, EDITOR_ACTIONS, VIEWER_ACTIONS, assertActionArgs, isAction, requiredRole } = require('../src/server/api-actions');

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

// Every handler the web UI calls is an action: the window.electron methods of the bridge's call
// list (src/web/bridge/server.ts), callAction('<name>') and invoke('<name>').
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'web', 'bridge', 'server.ts'), 'utf8');
const calls = bridge.slice(bridge.indexOf('const CALLS = {'), bridge.indexOf('} as const'));
const bridgeChannels = [...calls.matchAll(/^\s+\w+: '([^']+)'/gm)].map((match) => match[1]);
assert.ok(bridgeChannels.length >= 10, 'the bridge call list was not found');
for (const channel of bridgeChannels) assert.ok(isAction(channel), `the bridge calls ${channel} but it is not in api-actions.js`);
const webFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return webFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
const webUi = webFiles(path.join(ROOT, 'src', 'web'))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
for (const match of webUi.matchAll(/(?:\.invoke|callAction(?:<[^>(]*>)?)\(\s*['"]([^'"]+)['"]/g)) {
  if (registered.has(match[1])) assert.ok(isAction(match[1]), `the web UI calls ${match[1]} but it is not in api-actions.js`);
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

// Roles: the role lists name real actions, and the actions that hand out secrets or change the
// server stay admin-only.
for (const name of [...VIEWER_ACTIONS, ...EDITOR_ACTIONS]) assert.ok(isAction(name), `role list names ${name}, which is not an action`);
for (const name of VIEWER_ACTIONS) assert.ok(!EDITOR_ACTIONS.has(name), `${name} is in both role lists`);
for (const name of [
  'get-server-access-info',
  'get-mcp-connection-info',
  'regenerate-server-api-token',
  'list-users',
  'create-user',
  'update-user',
  'delete-user',
  'restore-database',
  'backup-database',
  'import-library',
  'restart-server',
  'apply-tls-settings',
  'purge-models',
  'organize-library-run',
  'save-slicer',
  'test-ai-config'
]) {
  assert.strictEqual(requiredRole(name), 'admin', `${name} must need an admin`);
}
for (const name of ['save-model', 'move-files', 'delete-file', 'save-tag', 'log-print-event', 'add-uploaded-files', 'scan-directory']) {
  assert.strictEqual(requiredRole(name), 'editor', `${name} must need an editor`);
}
for (const name of ['get-models-filtered', 'get-model', 'getThumbnail', 'get-print-statistics', 'set-server-password', 'get-upload-info']) {
  assert.strictEqual(requiredRole(name), 'viewer', `${name} must be open to viewers`);
}
assert.strictEqual(requiredRole('an-action-added-later'), 'admin', 'unlisted actions need an admin');

console.log('api actions tests passed');
