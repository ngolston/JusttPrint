#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-downloads-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'data', 'justtprint.db');
fs.mkdirSync(path.join(tmp, 'data'));
const downloads = require('../src/server/download-files');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const HOUR = 3600 * 1000;
const write = (file, ageMs = 0) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
};

test('new downloads go into downloads/ next to the database', () => {
  const backup = downloads.newDownloadPath('backup', 'db');
  assert.strictEqual(path.dirname(backup), path.join(tmp, 'data', 'downloads'));
  assert.match(path.basename(backup), /^justtprint-backup-[\w-]+\.db$/);
  assert.match(path.basename(downloads.newDownloadPath('library', 'json')), /^justtprint-library-[\w-]+\.json$/);
});

test('files older than an hour are deleted; newer and other files stay', () => {
  const dir = downloads.downloadsDir();
  write(path.join(dir, 'justtprint-backup-old.db'), 2 * HOUR);
  write(path.join(dir, 'justtprint-library-old.json'), 2 * HOUR);
  write(path.join(dir, 'justtprint-backup-new.db'), 10 * 60 * 1000);
  write(path.join(dir, 'notes.txt'), 5 * HOUR);
  assert.deepStrictEqual(downloads.sweep().sort(), ['justtprint-backup-old.db', 'justtprint-library-old.json']);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['justtprint-backup-new.db', 'notes.txt']);
});

test('leftovers in the data folder are listed and deleted on request only', () => {
  const data = path.join(tmp, 'data');
  write(path.join(data, 'justtprint-backup-2026-01-01T00-00-00-000Z.db'), 30 * 24 * HOUR);
  write(path.join(data, 'justtprint-library-2026-01-01T00-00-00-000Z.json'), 30 * 24 * HOUR);
  write(path.join(data, 'justtprint.db'));
  write(path.join(data, 'justtprint.db.before-restore'));
  downloads.sweep({ dir: data, maxAgeMs: Number.MAX_SAFE_INTEGER });
  const listed = downloads.leftovers();
  assert.deepStrictEqual(listed.files.map((f) => f.name).sort(), ['justtprint-backup-2026-01-01T00-00-00-000Z.db', 'justtprint-library-2026-01-01T00-00-00-000Z.json']);
  assert.strictEqual(listed.totalBytes, 2);
  assert.deepStrictEqual(downloads.deleteLeftovers(), { count: 2, bytes: 2 });
  assert.deepStrictEqual(fs.readdirSync(data).sort(), ['downloads', 'justtprint.db', 'justtprint.db.before-restore']);
});

fs.rmSync(tmp, { recursive: true, force: true });
