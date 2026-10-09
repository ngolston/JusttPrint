#!/usr/bin/env node
'use strict';

// 7.0 removed filament: the catalog, the filaments on models and in the print history are dropped; prints stay.
const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { removeFilamentData } = require('../src/core/db-init');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const tables = () =>
  database.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

test('a database from before 7.0 loses its filament tables and settings, not its prints', () => {
  database.db = new Database(':memory:');
  database.db.pragma('foreign_keys = ON');
  database.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('spoolmanUrl', 'http://spoolman:7912'), ('spoolmanApiToken', 'secret'), ('uiTheme', 'modern-cyan');
    CREATE TABLE models (id INTEGER PRIMARY KEY, fileName TEXT);
    CREATE TABLE filaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, spoolman_id INTEGER UNIQUE);
    CREATE TABLE model_filaments (model_id INTEGER, filament_id INTEGER, FOREIGN KEY(model_id) REFERENCES models(id), FOREIGN KEY(filament_id) REFERENCES filaments(id));
    CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, outcome TEXT);
    CREATE TABLE print_event_filaments (event_id INTEGER, filament_id INTEGER, FOREIGN KEY(event_id) REFERENCES print_events(id), FOREIGN KEY(filament_id) REFERENCES filaments(id));
    INSERT INTO models VALUES (1, 'benchy.stl');
    INSERT INTO filaments (name) VALUES ('PLA Black');
    INSERT INTO model_filaments VALUES (1, 1);
    INSERT INTO print_events VALUES (1, 1, 'printed');
    INSERT INTO print_event_filaments VALUES (1, 1);
  `);
  removeFilamentData();
  assert.deepStrictEqual(tables(), ['models', 'print_events', 'settings']);
  assert.deepStrictEqual(
    database.db
      .prepare('SELECT key FROM settings')
      .all()
      .map((row) => row.key),
    ['uiTheme']
  );
  assert.strictEqual(database.db.prepare('SELECT COUNT(*) AS n FROM print_events').get().n, 1, 'the print history stays');
  removeFilamentData(); // twice is harmless
  database.db.close();
});

test('a new database is left alone', () => {
  database.db = new Database(':memory:');
  database.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  removeFilamentData();
  assert.deepStrictEqual(tables(), ['settings']);
  database.db.close();
});
