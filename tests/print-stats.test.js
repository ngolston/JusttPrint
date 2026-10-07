#!/usr/bin/env node
'use strict';

// The Statistics page's numbers (src/core/print-stats.js). Run with npm test or on its own.

const assert = require('assert');
const Database = require('better-sqlite3');
const { monthRange, printStatistics } = require('../src/core/print-stats');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const NOW = new Date('2026-10-15T12:00:00.000Z');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT, fileName TEXT, designer TEXT, dateAdded TEXT);
    INSERT INTO models VALUES
      (1, '/lib/benchy.stl', 'benchy.stl', 'CreativeTools', '2026-08-02T09:00:00.000Z'),
      (2, '/lib/gear.stl', 'gear.stl', 'creativetools ', '2026-10-01T09:00:00.000Z'),
      (3, '/lib/vase.3mf', 'vase.3mf', 'Someone', '2025-01-05T09:00:00.000Z'),
      (4, '/lib/plain.stl', 'plain.stl', NULL, '2026-10-02T09:00:00.000Z');
    CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT);
    INSERT INTO printers VALUES (1, 'Voron'), (2, 'Mini');
    CREATE TABLE filaments (id INTEGER PRIMARY KEY, name TEXT, vendor TEXT, material TEXT, color_hex TEXT);
    INSERT INTO filaments VALUES (1, 'Black', 'Acme', 'pla', '000000'), (2, 'Clear', 'Acme', 'PETG', 'ffffff');
    CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, printed_at TEXT, outcome TEXT, quantity INTEGER, notes TEXT, created_at TEXT, printer_id INTEGER);
    INSERT INTO print_events VALUES
      (1, 1, '2026-08-03T10:00:00.000Z', 'printed', 2, NULL, 'x', 1),
      (2, 1, '2026-09-01T10:00:00.000Z', 'failed', 1, NULL, 'x', 1),
      (3, 2, '2026-10-02T10:00:00.000Z', 'printed', 3, NULL, 'x', 2),
      (4, 3, '2026-10-03T10:00:00.000Z', 'cancelled', 1, NULL, 'x', NULL),
      (5, 3, '2024-05-03T10:00:00.000Z', 'printed', 5, NULL, 'x', NULL);
    CREATE TABLE print_event_filaments (event_id INTEGER, filament_id INTEGER);
    INSERT INTO print_event_filaments VALUES (1, 1), (3, 1), (3, 2), (2, 2);
  `);
  return db;
}

test('months run back from this month, oldest first', () => {
  assert.deepStrictEqual(monthRange(NOW, 3), ['2026-08', '2026-09', '2026-10']);
  assert.deepStrictEqual(monthRange(new Date('2026-01-10T00:00:00Z'), 2), ['2025-12', '2026-01']);
});

test('totals, success rate and prints per month over the period', () => {
  const stats = printStatistics(createDb(), { months: 3, now: NOW });
  assert.deepStrictEqual(stats.totals, { printed: 5, failed: 1, cancelled: 1, successRate: 5 / 6 });
  assert.deepStrictEqual(stats.byMonth.map((m) => [m.month, m.printed, m.failed, m.cancelled, m.added]), [
    ['2026-08', 2, 0, 0, 1],
    ['2026-09', 0, 1, 0, 0],
    ['2026-10', 3, 0, 1, 2]
  ]);
  assert.strictEqual(stats.from, '2026-08');
  assert.strictEqual(stats.firstPrintMonth, '2024-05');
});

test('designers merge spelling and case; models, printers and filaments rank by prints', () => {
  const stats = printStatistics(createDb(), { months: 3, now: NOW });
  assert.deepStrictEqual(stats.designers.map((d) => [d.name.toLowerCase(), d.printed, d.models]), [['creativetools', 5, 2]]);
  assert.deepStrictEqual(stats.models.map((m) => [m.fileName, m.printed]), [['gear.stl', 3], ['benchy.stl', 2]]);
  assert.deepStrictEqual(stats.printers.map((p) => [p.name, p.printed, p.failed]), [['Mini', 3, 0], ['Voron', 2, 1]]);
  assert.strictEqual(stats.printers[1].successRate, 2 / 3);
  assert.deepStrictEqual(stats.filaments.map((f) => [f.name, f.prints]), [['Black', 5], ['Clear', 3]], 'failed prints do not count');
  assert.deepStrictEqual(stats.materials, [{ material: 'PLA', prints: 5 }, { material: 'PETG', prints: 3 }]);
});

test('all time starts at the first logged print', () => {
  const stats = printStatistics(createDb(), { months: 0, now: NOW });
  assert.strictEqual(stats.months, 0);
  assert.strictEqual(stats.from, '2024-05');
  assert.strictEqual(stats.byMonth.length, 30);
  assert.strictEqual(stats.totals.printed, 10);
});

test('an empty library without a print log gives zeros, not errors', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, dateAdded TEXT)');
  const stats = printStatistics(db, { months: 12, now: NOW });
  assert.deepStrictEqual(stats.totals, { printed: 0, failed: 0, cancelled: 0, successRate: null });
  assert.strictEqual(stats.byMonth.length, 12);
  assert.deepStrictEqual([stats.designers, stats.printers, stats.filaments], [[], [], []]);
});
