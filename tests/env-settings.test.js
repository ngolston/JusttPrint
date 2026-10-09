#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { settingsFromEnv } = require('../src/core/env-settings');

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

const ctx = { fileTypeIds: ['obj', 'step', 'ply'] };
const byKey = (result) => Object.fromEntries(result.settings.map((s) => [s.key, s.value]));

test('unset and blank variables change nothing', () => {
  assert.deepStrictEqual(settingsFromEnv({ JUSTTPRINT_ENABLE_ZIP: '  ' }, ctx), { settings: [], errors: [] });
});

test('zip support accepts common true/false spellings', () => {
  assert.strictEqual(byKey(settingsFromEnv({ JUSTTPRINT_ENABLE_ZIP: 'true' }, ctx)).enableZipArchives, '1');
  assert.strictEqual(byKey(settingsFromEnv({ JUSTTPRINT_ENABLE_ZIP: 'off' }, ctx)).enableZipArchives, '0');
  assert.match(settingsFromEnv({ JUSTTPRINT_ENABLE_ZIP: 'maybe' }, ctx).errors[0], /JUSTTPRINT_ENABLE_ZIP/);
});

test('file types become a JSON list and unknown ones are reported', () => {
  assert.strictEqual(byKey(settingsFromEnv({ JUSTTPRINT_FILE_TYPES: 'OBJ, .step;obj' }, ctx)).scanAdditionalFileTypes, '["obj","step"]');
  const bad = settingsFromEnv({ JUSTTPRINT_FILE_TYPES: 'obj,docx' }, ctx);
  assert.strictEqual(bad.settings.length, 0);
  assert.match(bad.errors[0], /unknown file types: docx/);
});

test('scan exclusions are stored one per line', () => {
  assert.strictEqual(byKey(settingsFromEnv({ JUSTTPRINT_SCAN_EXCLUDE: 'cache, renders' }, ctx)).scanExcludeFolders, 'cache\nrenders');
});

test('AI settings are validated', () => {
  const ok = byKey(
    settingsFromEnv(
      {
        JUSTTPRINT_AI_SERVICE: 'Claude',
        JUSTTPRINT_AI_API_KEY: ' sk-test ',
        JUSTTPRINT_AI_MODEL: 'claude-haiku-4-5',
        JUSTTPRINT_AI_ENDPOINT: 'https://llm.local/v1/'
      },
      ctx
    )
  );
  assert.deepStrictEqual(ok, { aiService: 'claude', apiKey: 'sk-test', aiModel: 'claude-haiku-4-5', apiEndpoint: 'https://llm.local/v1' });
  assert.strictEqual(settingsFromEnv({ JUSTTPRINT_AI_SERVICE: 'skynet' }, ctx).errors.length, 1);
  assert.strictEqual(settingsFromEnv({ JUSTTPRINT_AI_ENDPOINT: 'not a url' }, ctx).errors.length, 1);
});

test('folder watching can be switched off', () => {
  assert.strictEqual(byKey(settingsFromEnv({ JUSTTPRINT_WATCH_FOLDERS: 'false' }, ctx)).stlHomeWatch, '0');
});

test('automatic backup settings are validated', () => {
  const ok = byKey(
    settingsFromEnv(
      {
        JUSTTPRINT_AUTO_BACKUP: 'yes',
        JUSTTPRINT_BACKUP_INTERVAL_HOURS: '12',
        JUSTTPRINT_BACKUP_KEEP: ' 14 ',
        JUSTTPRINT_BACKUP_DIR: '/mnt/backups/'
      },
      ctx
    )
  );
  assert.deepStrictEqual(ok, { autoBackupEnabled: '1', autoBackupIntervalHours: '12', autoBackupKeep: '14', autoBackupDirectory: '/mnt/backups' });
  for (const [name, value] of [
    ['JUSTTPRINT_BACKUP_INTERVAL_HOURS', '0'],
    ['JUSTTPRINT_BACKUP_INTERVAL_HOURS', '1.5'],
    ['JUSTTPRINT_BACKUP_KEEP', 'all'],
    ['JUSTTPRINT_BACKUP_DIR', 'backups']
  ]) {
    assert.match(settingsFromEnv({ [name]: value }, ctx).errors[0] || '', new RegExp(name), `${name}=${value}`);
  }
});
