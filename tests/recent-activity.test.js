#!/usr/bin/env node
'use strict';

// Run with npm test, or on its own: node tests/recent-activity.test.js

const assert = require('assert');
const Database = require('better-sqlite3');
const { recentActivity } = require('../src/core/recent-activity');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

function createDb({ prints = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT, fileName TEXT, dateAdded TEXT);
    INSERT INTO models VALUES
      (1, '/lib/a.stl', 'a.stl', '2026-10-01T09:00:00.000Z'),
      (2, '/lib/b.stl', 'b.stl', '2026-10-03T10:00:00.000Z'),
      (3, '/lib/c.stl', 'c.stl', '2026-10-03T12:00:00.000Z');
  `);
  if (prints) {
    db.exec(`
      CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT);
      INSERT INTO printers VALUES (1, 'Bambu P1S');
      CREATE TABLE filaments (id INTEGER PRIMARY KEY, name TEXT, vendor TEXT, material TEXT);
      INSERT INTO filaments VALUES (1, 'PLA Basic Black', 'Bambu', 'PLA');
      CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, printed_at TEXT, outcome TEXT, quantity INTEGER, notes TEXT, created_at TEXT, printer_id INTEGER);
      INSERT INTO print_events VALUES
        (1, 1, '2026-10-02T08:00:00.000Z', 'printed', 1, NULL, '', 1),
        (2, 2, '2026-10-04T08:00:00.000Z', 'failed', 2, NULL, '', NULL);
      CREATE TABLE print_event_filaments (event_id INTEGER, filament_id INTEGER);
      INSERT INTO print_event_filaments VALUES (1, 1);
    `);
  }
  return db;
}

test('prints and added days come newest first, with printer and filaments', () => {
  const items = recentActivity(createDb());
  assert.deepStrictEqual(items.map((i) => `${i.kind}:${i.kind === 'print' ? i.id : i.day}`),
    ['print:2', 'added:2026-10-03', 'print:1', 'added:2026-10-01']);
  const first = items.find((i) => i.kind === 'print' && i.id === 1);
  assert.strictEqual(first.printer, 'Bambu P1S');
  assert.deepStrictEqual(first.filaments, ['Bambu PLA Basic Black']);
  assert.strictEqual(items.find((i) => i.kind === 'added' && i.day === '2026-10-03').count, 2);
  assert.strictEqual(items[0].quantity, 2);
  assert.strictEqual(items[0].printer, null);
});

test('the limit applies, and a database without print tables still lists added models', () => {
  assert.strictEqual(recentActivity(createDb(), 2).length, 2);
  assert.deepStrictEqual(recentActivity(createDb({ prints: false })).map((i) => i.kind), ['added', 'added']);
});

test('recent prints can be limited to one outcome', () => {
  const { recentPrints } = require('../src/core/recent-activity');
  const db = createDb();
  assert.deepStrictEqual(recentPrints(db, 10).map((p) => p.id), [2, 1]);
  assert.deepStrictEqual(recentPrints(db, 10, 'printed').map((p) => p.id), [1]);
  assert.deepStrictEqual(recentPrints(createDb({ prints: false }), 10), []);
});

test('recent prints can be limited to one printer', () => {
  const { recentPrints } = require('../src/core/recent-activity');
  const db = createDb();
  assert.deepStrictEqual(recentPrints(db, 10, null, 1).map((p) => p.id), [1]);
  assert.deepStrictEqual(recentPrints(db, 10, 'failed', 1), []);
});
