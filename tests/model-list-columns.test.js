#!/usr/bin/env node
'use strict';

// Run with npm test, or on its own: node tests/model-list-columns.test.js
// The grid's list query runs on the models table alone (no filament join since 7.0).

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
    INSERT INTO models (filePath, fileName, thumbnail) VALUES ('/m/a.stl', 'a.stl', 'data:image/png;base64,AA'), ('/m/b.stl', 'b.stl', NULL), ('/m/c.stl', 'c.stl', 'x::y');
  `);
  return db;
}

test('list rows need only the models table, and flag thumbnails', () => {
  const db = createDb();
  for (const columns of [MODEL_LIST_COLUMNS, MODEL_LIST_COLUMNS_QUALIFIED]) {
    const rows = db.prepare(`SELECT ${columns} FROM models ORDER BY id`).all();
    assert.deepStrictEqual(rows.map((row) => [row.fileName, row.hasThumbnail, row.hasMultipleThumbnails]), [['a.stl', 1, 0], ['b.stl', 0, 0], ['c.stl', 1, 1]]);
    assert.ok(rows.every((row) => !('filamentMaterial' in row)));
  }
  db.close();
});
