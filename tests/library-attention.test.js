#!/usr/bin/env node
'use strict';

// Home's Needs attention (src/core/library-attention.js).

const assert = require('assert');
const { ensureThumbnailLast } = require('../src/core/thumbnail-column');
const Database = require('better-sqlite3');
const { backupProblem, libraryAttention } = require('../src/core/library-attention');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('counts models without tags, license or thumbnail, and sets of identical files', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT, license TEXT, thumbnail TEXT, hash TEXT);
    CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER);
    INSERT INTO models VALUES
      (1, '/a/cube.stl', 'CC-BY', 'data:x', 'h1'),
      (2, '/b/cube.stl', ' ', '3d.png', 'h1'),
      (3, '/c/cone.stl', NULL, NULL, 'h2'),
      (4, '/c/pack.zip::cone.stl', 'MIT', 'data:y', 'h2'),
      (5, '/d/gear.stl', 'MIT', 'data:z', '');
    INSERT INTO model_tags VALUES (1, 1), (1, 2), (4, 1);
  `);
  ensureThumbnailLast(db, { log: () => {} });
  assert.deepStrictEqual(libraryAttention(db), { untagged: 3, unlicensed: 2, noThumbnail: 2, duplicateSets: 1 });
});

test('backups: off, fine, failed, late', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const base = {
    enabled: true,
    intervalHours: 24,
    newestBackup: '2026-10-12T02:00:00Z',
    lastAttempt: '2026-10-12T02:00:00Z',
    lastError: '',
    folderProblem: ''
  };
  assert.strictEqual(backupProblem({ ...base, enabled: false, lastError: 'disk full' }, now), null, 'off is not a problem');
  assert.strictEqual(backupProblem(base, now), null);
  assert.deepStrictEqual(backupProblem({ ...base, lastAttempt: '2026-10-12T03:00:00Z', lastError: 'disk full' }, now), {
    kind: 'failed',
    message: 'disk full'
  });
  assert.strictEqual(backupProblem({ ...base, lastAttempt: '2026-10-11T03:00:00Z', lastError: 'old' }, now), null, 'a success since the failure');
  assert.deepStrictEqual(backupProblem({ ...base, folderProblem: 'Use an absolute folder path' }, now), {
    kind: 'failed',
    message: 'Use an absolute folder path'
  });
  assert.deepStrictEqual(backupProblem({ ...base, newestBackup: '2026-10-09T12:00:00Z' }, now), { kind: 'late', since: '2026-10-09T12:00:00.000Z' });
});
