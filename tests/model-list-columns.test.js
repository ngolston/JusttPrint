#!/usr/bin/env node
'use strict';

// Run with npm test, or on its own: node tests/model-list-columns.test.js
// The grid's list query: the card's material badge comes from the model's first filament.

const assert = require('assert');
const Database = require('better-sqlite3');
const { MODEL_DETAIL_COLUMNS, MODEL_LIST_COLUMNS, MODEL_LIST_COLUMNS_QUALIFIED } = require('../src/core/models');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

function createDb() {
  const db = new Database(':memory:');
  const columns = MODEL_DETAIL_COLUMNS.split(',').map((c) => c.trim()).filter((c) => c !== 'id');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, ${columns.map((c) => `${c} TEXT`).join(', ')}, thumbnail TEXT);
    CREATE TABLE filaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, vendor TEXT, material TEXT);
    CREATE TABLE model_filaments (model_id INTEGER, filament_id INTEGER, PRIMARY KEY (model_id, filament_id));
    INSERT INTO models (filePath, fileName) VALUES ('/m/a.stl', 'a.stl'), ('/m/b.stl', 'b.stl'), ('/m/c.stl', 'c.stl');
    INSERT INTO filaments (name, vendor, material) VALUES ('Silk Red', 'Zeta', 'PLA'), ('HF Gray', 'Bambu', 'PETG'), ('Mystery', 'Acme', NULL);
    -- a: PLA (Zeta) and PETG (Bambu): Bambu sorts first, as in the details panel.
    INSERT INTO model_filaments VALUES (1, 1), (1, 2);
    -- b: only a filament without a material.
    INSERT INTO model_filaments VALUES (2, 3);
  `);
  return db;
}

test('list rows carry the first filament material, in the details panel order', () => {
  const db = createDb();
  for (const columns of [MODEL_LIST_COLUMNS, MODEL_LIST_COLUMNS_QUALIFIED]) {
    const rows = db.prepare(`SELECT ${columns} FROM models ORDER BY id`).all();
    assert.deepStrictEqual(rows.map((row) => row.filamentMaterial), ['PETG', null, null]);
  }
  db.close();
});
