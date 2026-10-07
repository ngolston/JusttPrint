#!/usr/bin/env node
'use strict';

// What viewers and editors may do beyond the action roles (api-actions.js): which settings
// they read and save (ipc/settings.js) and which model menu items they see (ipc/context-menu.js).

const assert = require('assert');
const { ipcMain } = require('../src/server/runtime');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { ADMIN_ONLY_SETTING, forgetUserSettings, isPreferenceSetting } = require('../src/server/ipc/settings');
const { viewerMenuItems } = require('../src/server/ipc/context-menu');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const as = (role, id = 3) => ({ user: { id, username: `${role}-${id}`, role }, fromNetwork: true });

test('display preferences are open to everyone; the rest is for admins', () => {
  for (const key of ['gridView', 'sortOption', 'listViewColumnLayout', 'folderTreeWidth', 'detailsPanelWidth']) {
    assert.ok(isPreferenceSetting(key), key);
  }
  for (const key of ['apiKey', 'stlHomeDirectories', 'enableZipArchives', 'maxFileSizeMB', 'aiTagPrompt']) {
    assert.ok(!isPreferenceSetting(key), key);
  }
});

test('non-admins cannot save other settings', async () => {
  const save = ipcMain._handlers.get('save-setting');
  await assert.rejects(save(as('editor'), 'stlHomeDirectories', '["/x"]'), /Only an admin/);
  await assert.rejects(save(as('viewer'), 'apiKey', 'sk-stolen'), /Only an admin/);
});

test('keys and tokens are hidden from non-admins', async () => {
  for (const key of ['apiKey', 'openaiApiKey', 'tlsKeyPath', 'serverApiToken', 'smtpPassword']) assert.ok(ADMIN_ONLY_SETTING.test(key), key);
  for (const key of ['gridView', 'aiModel', 'tlsCertPath', 'sortOption']) assert.ok(!ADMIN_ONLY_SETTING.test(key), key);
  assert.strictEqual(await ipcMain._handlers.get('get-setting')(as('viewer'), 'apiKey'), null);
});

test('viewers get the menu items that only open, download or copy', () => {
  const sep = { type: 'separator' };
  const items = [
    { label: 'Preview' }, sep, { label: 'Download' }, { label: 'Copy Path' }, sep,
    { label: 'Open in Slicer' }, { label: 'Tag from Folder' }, sep, { label: 'Remove from Library' }, { label: 'Delete from Disk' }
  ];
  assert.deepStrictEqual(viewerMenuItems(items).map((item) => item.label || '-'), ['Preview', '-', 'Download', 'Copy Path', '-', 'Open in Slicer']);
});

test('display preferences are kept per user, with the server-wide value as the default', async () => {
  database.db = new Database(':memory:');
  database.db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('gridView', 'list'), ('uiTheme', 'modern-cyan')");
  const get = ipcMain._handlers.get('get-setting');
  const save = ipcMain._handlers.get('save-setting');
  const alice = as('viewer', 11);
  const bob = as('admin', 12);
  assert.strictEqual(await get(alice, 'gridView'), 'list', 'the server-wide value until the user saves one');
  assert.strictEqual(await save(alice, 'gridView', 'grid'), true);
  await save(bob, 'uiTheme', 'modern-pink');
  assert.strictEqual(await get(alice, 'gridView'), 'grid');
  assert.strictEqual(await get(bob, 'gridView'), 'list', 'one user does not change another');
  assert.strictEqual(await get(bob, 'uiTheme'), 'modern-pink');
  assert.strictEqual(await get(alice, 'uiTheme'), 'modern-cyan');
  const token = { user: { id: 0, username: 'API token', role: 'admin' } };
  assert.strictEqual(await get(token, 'gridView'), 'list', 'the API token and the server use the server-wide value');
  assert.strictEqual(database.db.prepare("SELECT value FROM settings WHERE key = 'gridView'").get().value, 'list', 'saving a preference leaves the default alone');
  await save(bob, 'stlHomeDirectories', '["/lib"]');
  assert.strictEqual(await get(alice, 'stlHomeDirectories'), '["/lib"]', 'other settings stay server-wide');
  forgetUserSettings(11);
  assert.strictEqual(await get(alice, 'gridView'), 'list', 'a deleted user\'s preferences are removed');
  database.db.close();
  database.db = null;
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.message);
      process.exitCode = 1;
    }
  }
})();
