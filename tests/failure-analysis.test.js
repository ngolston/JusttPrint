#!/usr/bin/env node
'use strict';

// Failure analysis (src/core/failure-analysis.js): failure rates by printer, filament, humidity,
// length and time of day, and the groups that fail clearly more often, in words.

const assert = require('assert');
const Database = require('better-sqlite3');
const { failureAnalysis } = require('../src/core/failure-analysis');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.stack || err.message);
    process.exitCode = 1;
  }
}

function library() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT);
    CREATE TABLE filament_brands (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE spools (id INTEGER PRIMARY KEY, material TEXT, material_type TEXT, brand_id INTEGER);
    CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, printed_at TEXT, outcome TEXT, printer_id INTEGER, started_at TEXT, duration_seconds INTEGER, ams_humidity REAL);
    CREATE TABLE print_event_spools (id INTEGER PRIMARY KEY, event_id INTEGER, spool_id INTEGER, grams REAL);
    INSERT INTO printers VALUES (1, 'P1S'), (2, 'A1');
    INSERT INTO filament_brands VALUES (1, 'Bambu Lab'), (2, 'Sunlu');
    INSERT INTO spools VALUES (1, 'PLA', NULL, 1), (2, 'petg', NULL, 2);
  `);
  const add = db.prepare(
    'INSERT INTO print_events (model_id, printed_at, outcome, printer_id, started_at, duration_seconds, ams_humidity) VALUES (1, ?, ?, ?, ?, ?, ?)'
  );
  const use = db.prepare('INSERT INTO print_event_spools (event_id, spool_id, grams) VALUES (?, ?, 10)');
  const print = (outcome, { printer = 1, spool = 1, humidity = null, hours = 2, at = '2026-10-01T14:00:00' } = {}) => {
    const id = add.run(at, outcome, printer, at, hours * 3600, humidity).lastInsertRowid;
    use.run(id, spool);
  };
  // PLA on the P1S: 12 prints, 1 failed. PETG: 6 prints, 4 failed, in humid weather.
  for (let i = 0; i < 11; i++) print('printed', { humidity: 25 });
  print('failed', { humidity: 25 });
  for (let i = 0; i < 2; i++) print('printed', { spool: 2, humidity: 55 });
  for (let i = 0; i < 4; i++) print('failed', { spool: 2, humidity: 55, hours: 9, at: '2026-10-02T23:30:00' });
  print('cancelled');
  return db;
}

test('counts the prints and failures, cancelled ones left out', () => {
  const result = failureAnalysis(library());
  assert.deepStrictEqual([result.total, result.failed], [18, 5]);
  assert.strictEqual(result.humidityKnown, true);
});

test('groups by material, brand, humidity, length and time of day', () => {
  const { groups } = failureAnalysis(library());
  assert.deepStrictEqual(
    groups.material.map((g) => [g.label, g.prints, g.failed]),
    [
      ['PLA', 12, 1],
      ['PETG', 6, 4]
    ]
  );
  assert.deepStrictEqual(
    groups.brand.map((g) => g.label),
    ['Bambu Lab', 'Sunlu']
  );
  assert.deepStrictEqual(
    groups.humidity.map((g) => [g.label, g.failed]),
    [
      ['Under 30%', 1],
      ['50% or more', 4]
    ],
    'in the order of the ranges'
  );
  assert.deepStrictEqual(
    groups.duration.map((g) => g.label),
    ['1–4 h', '8 h or more']
  );
  assert.deepStrictEqual(
    groups.timeOfDay.map((g) => g.label),
    ['Afternoon', 'Night']
  );
});

test('the groups that fail clearly more often, in words; small groups are not findings', () => {
  const { findings } = failureAnalysis(library());
  const texts = findings.map((f) => f.text);
  assert.ok(texts.includes('Prints in PETG fail 67% of the time (4 of 6), 2.4 times as often as your prints overall.'), texts.join('\n'));
  assert.ok(texts.some((t) => t.startsWith('Prints with the AMS at 50% or more humidity fail 67%')));
  assert.ok(!texts.some((t) => /PLA/.test(t)), 'PLA fails less than overall');
  assert.ok(!texts.some((t) => /8 h or more/.test(t)), 'only 4 prints ran 8 h or more: too few');
});

test('only prints since a time; nothing yet gives empty groups', () => {
  assert.strictEqual(failureAnalysis(library(), { since: '2026-10-02T00:00:00' }).total, 4);
  const empty = new Database(':memory:');
  empty.exec(
    'CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT); CREATE TABLE print_events (id INTEGER PRIMARY KEY, printed_at TEXT, outcome TEXT, printer_id INTEGER);'
  );
  const none = failureAnalysis(empty);
  assert.deepStrictEqual([none.total, none.findings, none.groups.printer], [0, [], []]);
});
