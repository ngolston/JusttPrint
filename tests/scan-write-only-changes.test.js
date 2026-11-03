#!/usr/bin/env node
'use strict';

// A scan must not rewrite a model that did not change: SQLite rewrites the whole row, pictures
// included. Counted with a trigger, which fires only for rows really updated.
const assert = require('assert');
const Database = require('better-sqlite3');
const { UPDATE_EXISTING_SQL } = require('../src/server/ipc/scan');

const db = new Database(':memory:');
db.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, hash TEXT, size INTEGER, modifiedDate TEXT, bundleKey TEXT, bundleLabel TEXT, bundleKind TEXT);
  CREATE TABLE writes (n INTEGER); INSERT INTO writes VALUES (0);
  CREATE TRIGGER count_writes AFTER UPDATE ON models BEGIN UPDATE writes SET n = n + 1; END;`);
db.prepare('INSERT INTO models (filePath, hash, size, modifiedDate, bundleKey, bundleLabel, bundleKind) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
  '/a.stl',
  'h1',
  10,
  'd1',
  'k',
  null,
  null
);

const update = db.prepare(UPDATE_EXISTING_SQL);
const writes = () => db.prepare('SELECT n FROM writes').get().n;
const row = () => db.prepare('SELECT hash, size, modifiedDate, bundleKey, bundleLabel, bundleKind FROM models').get();

update.run('h1', 10, 'd1', 'k', null, null, '/a.stl');
assert.strictEqual(writes(), 0, 'same values: nothing written');

update.run('', 10, 'd1', 'k', null, null, '/a.stl');
assert.strictEqual(writes(), 0, 'no hash from the scan keeps the stored one: nothing written');
assert.strictEqual(row().hash, 'h1');

update.run('', 20, 'd2', 'k', null, null, '/a.stl');
assert.strictEqual(writes(), 1, 'a changed file is written');
assert.deepStrictEqual(row(), { hash: 'h1', size: 20, modifiedDate: 'd2', bundleKey: 'k', bundleLabel: null, bundleKind: null });

update.run('h2', 20, 'd2', 'k', 'L', 'zip', '/a.stl');
assert.strictEqual(writes(), 2, 'a new hash or bundle is written, NULL to a value too');
assert.strictEqual(row().hash, 'h2');
assert.strictEqual(row().bundleLabel, 'L');

update.run('h2', 20, 'd2', 'k', 'L', 'zip', '/other.stl');
assert.strictEqual(writes(), 2, 'another path changes nothing');

console.log('ok a scan writes only the models that changed');
