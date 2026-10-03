#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { settingsFromEnv } = require('./env-settings');

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
  assert.deepStrictEqual(settingsFromEnv({ PRINTVENTORY_ENABLE_ZIP: '  ' }, ctx), { settings: [], errors: [] });
});

test('zip support accepts common true/false spellings', () => {
  assert.strictEqual(byKey(settingsFromEnv({ PRINTVENTORY_ENABLE_ZIP: 'true' }, ctx)).enableZipArchives, '1');
  assert.strictEqual(byKey(settingsFromEnv({ PRINTVENTORY_ENABLE_ZIP: 'off' }, ctx)).enableZipArchives, '0');
  assert.match(settingsFromEnv({ PRINTVENTORY_ENABLE_ZIP: 'maybe' }, ctx).errors[0], /PRINTVENTORY_ENABLE_ZIP/);
});

test('file types become a JSON list and unknown ones are reported', () => {
  assert.strictEqual(byKey(settingsFromEnv({ PRINTVENTORY_FILE_TYPES: 'OBJ, .step;obj' }, ctx)).scanAdditionalFileTypes, '["obj","step"]');
  const bad = settingsFromEnv({ PRINTVENTORY_FILE_TYPES: 'obj,docx' }, ctx);
  assert.strictEqual(bad.settings.length, 0);
  assert.match(bad.errors[0], /unknown file types: docx/);
});

test('scan exclusions are stored one per line', () => {
  assert.strictEqual(byKey(settingsFromEnv({ PRINTVENTORY_SCAN_EXCLUDE: 'cache, renders' }, ctx)).scanExcludeFolders, 'cache\nrenders');
});

test('AI settings are validated', () => {
  const ok = byKey(settingsFromEnv({
    PRINTVENTORY_AI_SERVICE: 'Claude',
    PRINTVENTORY_AI_API_KEY: ' sk-test ',
    PRINTVENTORY_AI_MODEL: 'claude-haiku-4-5',
    PRINTVENTORY_AI_ENDPOINT: 'https://llm.local/v1/'
  }, ctx));
  assert.deepStrictEqual(ok, { aiService: 'claude', apiKey: 'sk-test', aiModel: 'claude-haiku-4-5', apiEndpoint: 'https://llm.local/v1' });
  assert.strictEqual(settingsFromEnv({ PRINTVENTORY_AI_SERVICE: 'skynet' }, ctx).errors.length, 1);
  assert.strictEqual(settingsFromEnv({ PRINTVENTORY_AI_ENDPOINT: 'not a url' }, ctx).errors.length, 1);
});
