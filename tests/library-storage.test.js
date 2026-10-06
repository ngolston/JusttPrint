#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { libraryStorage, volumeUsage, firstExistingRoot } = require('../src/core/library-storage');

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

function db(sizes) {
  const d = new Database(':memory:');
  d.prepare('CREATE TABLE models (id INTEGER PRIMARY KEY, size INTEGER)').run();
  for (const s of sizes) d.prepare('INSERT INTO models (size) VALUES (?)').run(s);
  return d;
}

const statfs = async () => ({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 });

(async () => {
  await test('sums the library and reads the volume of the first existing STL Home', async () => {
    const result = await libraryStorage({ db: db([100, 250, null]), roots: ['/missing', '/models'], existsSync: (p) => p === '/models', statfs });
    assert.deepStrictEqual(result, {
      libraryBytes: 350,
      modelCount: 3,
      volume: { path: '/models', totalBytes: 4096000, usedBytes: 4096 * 700, freeBytes: 4096 * 250 }
    });
  });

  await test('has no volume without an STL Home folder, or when the volume cannot be read', async () => {
    assert.strictEqual((await libraryStorage({ db: db([]), roots: [], statfs })).volume, null);
    assert.strictEqual(await volumeUsage('/x', async () => { throw new Error('EACCES'); }), null);
    assert.strictEqual(await volumeUsage('/x', async () => ({ bsize: 0, blocks: 0, bfree: 0, bavail: 0 })), null);
  });

  await test('skips folders that cannot be checked', () => {
    assert.strictEqual(firstExistingRoot(['/a', '/b'], (p) => { if (p === '/a') throw new Error('EPERM'); return true; }), '/b');
  });

  await test('reads a real volume', async () => {
    const usage = await volumeUsage(__dirname);
    assert.ok(usage && usage.totalBytes > 0 && usage.usedBytes <= usage.totalBytes);
  });
})();

const { libraryCounts } = require('../src/core/library-counts');

(async () => {
  await test('counts models, printed, queued, printing and printers like the card badges', () => {
    const d = new Database(':memory:');
    d.prepare('CREATE TABLE models (id INTEGER PRIMARY KEY, print_status TEXT, printed INTEGER, print_count INTEGER)').run();
    d.prepare('CREATE TABLE printers (id INTEGER PRIMARY KEY)').run();
    const add = d.prepare('INSERT INTO models (print_status, printed, print_count) VALUES (?, ?, ?)');
    add.run('queued', 0, 0); add.run('Queued', 0, 2); add.run('printing', 0, 0); add.run(null, 1, 0); add.run('printed', 0, 0); add.run('want', 0, 0);
    d.prepare('INSERT INTO printers DEFAULT VALUES').run();
    // The second queued model was printed before (print_count 2), so it also counts as printed.
    assert.deepStrictEqual(libraryCounts(d), { models: 6, printed: 3, queued: 2, printing: 1, printers: 1 });
  });

  await test('has zero printers before the printers table exists', () => {
    const d = new Database(':memory:');
    d.prepare('CREATE TABLE models (id INTEGER PRIMARY KEY, print_status TEXT, printed INTEGER, print_count INTEGER)').run();
    assert.strictEqual(libraryCounts(d).printers, 0);
  });
})();
