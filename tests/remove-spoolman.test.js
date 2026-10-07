#!/usr/bin/env node
'use strict';

// 6.0 removed Spoolman: its settings and filament links are deleted, the filaments stay.
const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { removeSpoolmanData } = require('../src/core/db-init');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('a database from before 6.0 loses its Spoolman settings and links, not its filaments', () => {
  database.db = new Database(':memory:');
  database.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('spoolmanUrl', 'http://spoolman:7912'), ('spoolmanApiToken', 'secret'), ('theme', 'dark');
    CREATE TABLE filaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, vendor TEXT, material TEXT, color_hex TEXT,
      diameter REAL, spoolman_id INTEGER UNIQUE, source TEXT NOT NULL DEFAULT 'manual');
    CREATE INDEX idx_filaments_spoolman_id ON filaments(spoolman_id);
    INSERT INTO filaments (name, spoolman_id, source) VALUES ('Synced PLA', 7, 'spoolman'), ('My PETG', NULL, 'manual');
  `);
  removeSpoolmanData();
  const settings = database.db.prepare('SELECT key FROM settings ORDER BY key').all().map((row) => row.key);
  assert.deepStrictEqual(settings, ['theme']);
  assert.deepStrictEqual(database.db.prepare('SELECT name, spoolman_id, source FROM filaments ORDER BY id').all(),
    [{ name: 'Synced PLA', spoolman_id: null, source: 'manual' }, { name: 'My PETG', spoolman_id: null, source: 'manual' }]);
  assert.strictEqual(database.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_filaments_spoolman_id'").get().n, 0);
  removeSpoolmanData(); // twice is harmless
  database.db.close();
});

test('a new database without the column is left alone', () => {
  database.db = new Database(':memory:');
  database.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE filaments (id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual');
    INSERT INTO filaments (name) VALUES ('PLA');`);
  removeSpoolmanData();
  assert.strictEqual(database.db.prepare('SELECT COUNT(*) AS n FROM filaments').get().n, 1);
  database.db.close();
});
