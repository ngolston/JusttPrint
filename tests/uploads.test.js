#!/usr/bin/env node
'use strict';

// Uploads from the browser (src/server/uploads.js): file names, no overwrites, size limit.
// The route itself runs in the e2e suite.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { candidateName, checkUploadName, maxUploadBytes, placeWithoutReplacing, rootFor, writeBody } = require('../src/server/uploads');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const EXTENSIONS = ['.3mf', '.stl', '.zip'];

test('plain model file names pass', () => {
  assert.strictEqual(checkUploadName('Benchy.stl', EXTENSIONS), 'Benchy.stl');
  assert.strictEqual(checkUploadName('  Gear (v2).3MF ', EXTENSIONS), 'Gear (v2).3MF');
});

test('folders, hidden files, control characters and other types are refused', () => {
  assert.throws(() => checkUploadName('../escape.stl', EXTENSIONS), /plain file name/);
  assert.throws(() => checkUploadName('sub/dir.stl', EXTENSIONS), /plain file name/);
  assert.throws(() => checkUploadName('C:\\x.stl', EXTENSIONS), /plain file name/);
  assert.throws(() => checkUploadName('..', EXTENSIONS), /plain file name/);
  assert.throws(() => checkUploadName('.hidden.stl', EXTENSIONS), /Hidden/);
  assert.throws(() => checkUploadName('bad\u0007.stl', EXTENSIONS), /control characters/);
  assert.throws(() => checkUploadName('page.html', EXTENSIONS), /does not scan \.html files/);
  assert.throws(() => checkUploadName('README', EXTENSIONS), /without an extension/);
  assert.throws(() => checkUploadName('', EXTENSIONS), /no name/);
  assert.throws(() => checkUploadName(`${'a'.repeat(250)}.stl`, EXTENSIONS), /too long/);
});

test('taken names get a number', () => {
  assert.strictEqual(candidateName('Benchy.stl', 1), 'Benchy.stl');
  assert.strictEqual(candidateName('Benchy.stl', 3), 'Benchy (3).stl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-upload-'));
  try {
    fs.writeFileSync(path.join(dir, 'Benchy.stl'), 'old');
    const temp = path.join(dir, '.upload-1');
    fs.writeFileSync(temp, 'new');
    const placed = placeWithoutReplacing(temp, dir, 'Benchy.stl');
    assert.strictEqual(path.basename(placed), 'Benchy (2).stl');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Benchy.stl'), 'utf8'), 'old', 'the existing file is kept');
    assert.strictEqual(fs.readFileSync(placed, 'utf8'), 'new');
    assert.ok(!fs.existsSync(temp), 'the temp file is gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bodies are streamed to disk and stop at the size limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-upload-'));
  try {
    const ok = new PassThrough();
    const written = writeBody(ok, path.join(dir, 'a'), 10);
    ok.end(Buffer.from('12345'));
    assert.strictEqual(await written, 5);
    const big = new PassThrough();
    const tooBig = writeBody(big, path.join(dir, 'b'), 10);
    big.write(Buffer.from('123456'));
    big.write(Buffer.from('789012'));
    await assert.rejects(tooBig, (error) => error.status === 413);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the upload limit comes from JUSTTPRINT_MAX_UPLOAD_MB', () => {
  assert.strictEqual(maxUploadBytes({}), 2048 * 1024 * 1024);
  assert.strictEqual(maxUploadBytes({ JUSTTPRINT_MAX_UPLOAD_MB: '50' }), 50 * 1024 * 1024);
  assert.strictEqual(maxUploadBytes({ JUSTTPRINT_MAX_UPLOAD_MB: 'lots' }), 2048 * 1024 * 1024);
});

test('a folder belongs to the deepest library root that holds it', () => {
  assert.strictEqual(rootFor('/library/prints/toys', ['/library', '/library/prints', '/other']), '/library/prints');
  assert.strictEqual(rootFor('/elsewhere', ['/library']), '/elsewhere');
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
