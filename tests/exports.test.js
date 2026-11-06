#!/usr/bin/env node
'use strict';

// Export from Statistics (src/server/exports.js): CSV, the Excel workbook, and what goes in them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { unzipSync, strFromU8 } = require('fflate');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-export-'));
// Downloads go next to this test's database.
process.env.JUSTTPRINT_DB_PATH = path.join(dir, 'data', 'justtprint.db');
const exports_ = require('../src/server/exports');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function library() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT, fileName TEXT, title TEXT, designer TEXT, license TEXT, print_status TEXT, print_count INTEGER, rating INTEGER, favorite INTEGER, size INTEGER, dateAdded TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER);
    CREATE TABLE model_categories (model_id INTEGER, category_id INTEGER);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT);
    CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, printed_at TEXT, outcome TEXT, quantity INTEGER, notes TEXT, printer_id INTEGER, plate_index INTEGER, duration_seconds INTEGER, filament_used_g REAL);
    INSERT INTO models VALUES (1, '/lib/Gear.3mf', 'Gear.3mf', 'Gear, "big"', 'Ann', 'CC-BY', 'printed', 2, 5, 1, 2097152, '2026-10-01');
    INSERT INTO models VALUES (2, '/lib/cube.stl', 'cube.stl', NULL, NULL, NULL, 'unprinted', 0, NULL, 0, 1000, '2026-10-02');
    INSERT INTO tags VALUES (1, 'gears'), (2, 'toys');
    INSERT INTO model_tags VALUES (1, 1), (1, 2);
    INSERT INTO categories VALUES (1, 'Toys & Games', NULL), (2, 'Puzzles', 1);
    INSERT INTO model_categories VALUES (1, 2);
    INSERT INTO printers VALUES (1, 'P1S');
    INSERT INTO print_events VALUES (1, 1, '2026-10-05T10:00:00Z', 'printed', 1, 'fine', 1, 2, 5400, 31.25);
    INSERT INTO print_events VALUES (2, 1, '2020-01-01T10:00:00Z', 'failed', 1, NULL, NULL, NULL, NULL, NULL);
  `);
  return db;
}

test('CSV: a byte-order mark for Excel, commas and quotes quoted, empty for none', () => {
  const csv = exports_.toCsv({
    name: 'x',
    columns: ['A', 'B'],
    rows: [
      ['Gear, "big"', null],
      [3, 'line\nbreak']
    ]
  });
  assert.strictEqual(csv, '\uFEFFA,B\r\n"Gear, ""big""",\r\n3,"line\nbreak"\r\n');
});

test('the print history: newest first, the period only, hours and grams as numbers', () => {
  const db = library();
  const all = exports_.printHistory(db, 0);
  assert.deepStrictEqual(
    all.rows.map((r) => [r[1], r[3], r[5], r[6], r[7], r[8]]),
    [
      ['Gear, "big"', 'printed', 'P1S', 2, 1.5, 31.3],
      ['Gear, "big"', 'failed', null, null, null, null]
    ]
  );
  assert.strictEqual(exports_.printHistory(db, 12).rows.length <= 1, true, 'the 2020 print is not in the last 12 months');
});

test('the models: category with its parent, tags, size in MB', () => {
  const { rows, columns } = exports_.models(library());
  const gear = rows.find((r) => r[1] === 'Gear.3mf');
  const at = (name) => gear[columns.indexOf(name)];
  assert.deepStrictEqual([at('Category'), at('Tags'), at('Size (MB)'), at('Favorite')], ['Toys & Games › Puzzles', 'gears, toys', 2, 'Yes']);
  assert.strictEqual(rows.find((r) => r[1] === 'cube.stl')[0], 'cube.stl', 'no title: the file name');
});

test('the Excel workbook: a sheet per table, numbers as numbers, text escaped', () => {
  const book = unzipSync(
    new Uint8Array(
      exports_.toXlsx([
        { name: 'Print history', columns: ['Model', 'Grams'], rows: [['A & <B>', 12.5]] },
        { name: 'Bad/Name?', columns: ['X'], rows: [] }
      ])
    )
  );
  const workbook = strFromU8(book['xl/workbook.xml']);
  assert.match(workbook, /<sheet name="Print history" sheetId="1"/);
  assert.match(workbook, /<sheet name="Bad Name " sheetId="2"/, 'characters Excel refuses in sheet names go');
  const sheet = strFromU8(book['xl/worksheets/sheet1.xml']);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">A &amp; &lt;B&gt;<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B2"><v>12.5<\/v><\/c>/);
  assert.ok(book['[Content_Types].xml'] && book['xl/styles.xml'] && book['_rels/.rels']);
  assert.deepStrictEqual([0, 25, 26, 701].map(exports_.columnName), ['A', 'Z', 'AA', 'ZZ']);
});

test('writes a file to download, named for the day', async () => {
  const db = library();
  const csv = await exports_.writeExport(db, { what: 'models' });
  assert.match(csv.name, /^JusttPrint Models \d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(fs.readFileSync(csv.filePath, 'utf8').includes('Gear.3mf'));
  await assert.rejects(exports_.writeExport(db, { what: 'nope' }), /Export history, models or everything/);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}:`, error.stack || error.message);
      process.exitCode = 1;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
})();
