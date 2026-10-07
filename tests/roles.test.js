#!/usr/bin/env node
'use strict';

// What viewers and editors may do beyond the action roles (api-actions.js): which settings
// they read and save (ipc/settings.js) and which model menu items they see (ipc/context-menu.js).

const assert = require('assert');
const { ipcMain } = require('../src/server/runtime');
const { ADMIN_ONLY_SETTING, isPreferenceSetting } = require('../src/server/ipc/settings');
const { viewerMenuItems } = require('../src/server/ipc/context-menu');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const as = (role) => ({ user: { id: 3, username: role, role }, fromNetwork: true });

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
