#!/usr/bin/env node
'use strict';

// Run with npm test, or on its own: node tests/model-filters.test.js

const assert = require('assert');
const Database = require('better-sqlite3');
const { buildModelFilterConditions, sqlAndFilterConditions } = require('../src/core/model-filters');

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
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT, designer TEXT, license TEXT,
      parentModel TEXT, notes TEXT, source TEXT, printed INTEGER, print_status TEXT, print_count INTEGER,
      isNew INTEGER, favorite INTEGER, rating INTEGER, dateAdded TEXT
    );
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
    CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER);
    CREATE TABLE filaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, vendor TEXT, material TEXT);
    CREATE TABLE model_filaments (model_id INTEGER, filament_id INTEGER);
  `);
  const insert = db.prepare('INSERT INTO models (filePath, fileName, designer) VALUES (?, ?, ?)');
  insert.run('/m/box.3mf', 'box.3mf', null);
  insert.run('/m/cube.stl', 'cube.stl', 'Ann');
  insert.run('/m/cone.stl', 'cone.stl', null);
  return db;
}

function names(db, filters) {
  const { conditions, params } = buildModelFilterConditions(filters);
  return db.prepare(`SELECT fileName FROM models WHERE 1${sqlAndFilterConditions(conditions)} ORDER BY id`)
    .all(...params).map((row) => row.fileName);
}

const query = [
  { t: 'clause', field: 'fileName', value: 'box' },
  { t: 'op', op: 'OR' },
  { t: 'filter', kind: 'designer', value: 'Ann' }
];

test('a query matches models with an empty designer', () => {
  assert.deepStrictEqual(names(createDb(), { searchTokens: query }), ['box.3mf', 'cube.stl']);
});

test('an inverted query keeps models with an empty designer', () => {
  assert.deepStrictEqual(names(createDb(), { searchTokens: query, searchInverted: true }), ['cone.stl']);
});

test('NOT in a query keeps models with an empty designer', () => {
  const tokens = [{ t: 'not' }, { t: 'filter', kind: 'designer', value: 'Ann' }];
  assert.deepStrictEqual(names(createDb(), { searchTokens: tokens }), ['box.3mf', 'cone.stl']);
});
