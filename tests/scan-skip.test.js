#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  shouldSkipDirectoryName,
  shouldSkipFileName,
  shouldSkipEntryPath,
  isSkippedLibraryFile,
  normalizeExcludeNames
} = require('../src/core/scan-skip');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('skips dot folders, AppleDouble files, and __MACOSX', () => {
  assert.strictEqual(shouldSkipDirectoryName('.manyfold'), true);
  assert.strictEqual(shouldSkipDirectoryName('.git'), true);
  assert.strictEqual(shouldSkipDirectoryName('Kitchen'), false);
  assert.strictEqual(shouldSkipFileName('._model.stl'), true);
  assert.strictEqual(shouldSkipFileName('model.stl'), false);
  assert.strictEqual(
    shouldSkipEntryPath('library/EInk Dashboard/.manyfold/derivatives/frame-leg.stl/render.stl'),
    true
  );
  assert.strictEqual(shouldSkipEntryPath('library/Kitchen/Bagel Slicer/lid.3mf'), false);
  assert.strictEqual(shouldSkipEntryPath('__MACOSX/model.stl'), true);
});

test('extra folder names from settings are skipped', () => {
  const extra = normalizeExcludeNames('cache\nderivatives, library/temp');
  assert.strictEqual(shouldSkipDirectoryName('derivatives', extra), true);
  assert.strictEqual(shouldSkipDirectoryName('temp', extra), true);
  assert.strictEqual(shouldSkipDirectoryName('models', extra), false);
  assert.strictEqual(shouldSkipEntryPath('prints/cache/part.stl', extra), true);
});

test('stored models are judged by the path inside the scanned folder', () => {
  const root = '/home/me/.local/models';
  assert.strictEqual(isSkippedLibraryFile(`${root}/Designer B/box.3mf`, new Set(), root), false, 'a library under a dot folder is not skipped');
  assert.strictEqual(isSkippedLibraryFile(`${root}/Designer B/.manyfold/render.stl`, new Set(), root), true);
  assert.strictEqual(isSkippedLibraryFile(`${root}/cache/part.stl`, new Set(['cache']), root), true);
  assert.strictEqual(isSkippedLibraryFile(`${root}/pack.zip::inner/.hidden/a.stl`, new Set(), root), true);
  assert.strictEqual(isSkippedLibraryFile(`${root}/pack.zip::inner/a.stl`, new Set(), root), false);
  assert.strictEqual(isSkippedLibraryFile('/mnt/models/._part.stl', new Set(), '/mnt/models'), true);
});
