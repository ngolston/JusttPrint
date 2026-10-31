#!/usr/bin/env node
'use strict';

// 10.2 Phase 10 (docs/plan-10.1.md): spools out as CSV or JSON, and a CSV in with its columns
// matched to spool fields.

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const spools = require('../src/core/spools');
const locations = require('../src/core/storage-locations');
const transfer = require('../src/core/spool-transfer');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.stack || err.message);
    process.exitCode = 1;
  }
}

const fresh = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'
  );
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  return db;
};

test('CSV cells: quoted when needed, formulas kept as text', () => {
  assert.strictEqual(transfer.csvCell('plain'), 'plain');
  assert.strictEqual(transfer.csvCell('a, b'), '"a, b"');
  assert.strictEqual(transfer.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(transfer.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.strictEqual(transfer.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(transfer.csvCell(-5), '-5', 'a number is a number');
  assert.strictEqual(transfer.csvCell(null), '');
});

test('reading a CSV: quotes, line breaks in quotes, semicolons, a byte order mark', () => {
  const parsed = transfer.parseCsv('\uFEFFname;notes\r\n"A; b";"line one\nline two"\r\n\r\nC;"say ""x"""\r\n');
  assert.strictEqual(parsed.delimiter, ';');
  assert.deepStrictEqual(parsed.headers, ['name', 'notes']);
  assert.deepStrictEqual(parsed.rows, [
    ['A; b', 'line one\nline two'],
    ['C', 'say "x"']
  ]);
  assert.throws(() => transfer.parseCsv(''), /empty/);
});

test('weights in any unit; columns guessed from their headings', () => {
  assert.deepStrictEqual(['1 kg', '750', '750 g', '1,5kg', '2.2 lb', ''].map(transfer.grams), [1000, 750, 750, 1500, 997.9, null]);
  assert.throws(() => transfer.grams('heavy'), /not a weight/);
  const headers = ['Spool Name', 'Vendor', 'Material', 'Color', 'Weight', 'Remaining', 'Lot #', 'Cost', 'Mystery'];
  assert.deepStrictEqual(transfer.guessMapping(headers, [['x', 'y', 'PLA', '#ff0000', '1000', '500', '7', '20', '?']]), [
    'name',
    'brand',
    'material',
    'color_hex',
    'initial_weight',
    'remaining',
    'lot_nr',
    'purchase_price',
    null
  ]);
  assert.strictEqual(transfer.guessMapping(['Colour'], [['Galaxy Black']])[0], 'color_name', 'not hex: the color name');
});

test('export and import back: the same spools, places made, a second import adds nothing', () => {
  const db = fresh();
  const shelf = locations.saveLocation(db, { name: 'Shelf 1' });
  spools.saveSpool(db, {
    name: 'Black, matte',
    brand_name: 'Bambu',
    material: 'PLA',
    material_type: 'Matte',
    color_hex: '#111111',
    initial_weight: 1000,
    remaining: 640,
    spool_weight: 230,
    location_id: shelf.id,
    purchase_price: 19.99,
    supplier: 'Shop',
    notes: '=risky'
  });
  spools.saveSpool(db, { name: 'Teal', material: 'PETG', color_hex: '#14b8a6', initial_weight: 1000, remaining: 0, status: 'archived' });
  const csv = transfer.exportSpools(db, { format: 'csv', now: new Date('2026-10-31T10:00:00Z') });
  assert.strictEqual(csv.filename, 'justtprint-spools-2026-10-31.csv');
  assert.ok(csv.content.startsWith('\uFEFFid,name,brand,material'));
  assert.ok(csv.content.includes("'=risky"), 'a formula stays text');
  const json = JSON.parse(transfer.exportSpools(db, { format: 'json' }).content);
  assert.deepStrictEqual([json.exportedFrom, json.spools.length], ['JusttPrint', 2]);

  const other = fresh();
  const preview = transfer.previewImport(other, { text: csv.content });
  assert.deepStrictEqual([preview.rows, preview.already, preview.problemCount], [2, 0, 0]);
  assert.ok(preview.mapping.includes('material') && preview.mapping.includes('remaining') && preview.mapping.includes('location'));
  const result = transfer.importCsv(other, { text: csv.content });
  assert.deepStrictEqual([result.added, result.already, result.placesAdded, result.problemCount], [2, 0, 1, 0]);
  const black = spools.listSpools(other).find((s) => s.name === 'Black, matte');
  assert.deepStrictEqual(
    [black.brand_name, black.material_type, black.color_hex, black.remaining, black.spool_weight, black.location_name, black.purchase_price, black.notes],
    ['Bambu', 'Matte', '#111111', 640, 230, 'Shelf 1', 19.99, "'=risky"]
  );
  assert.strictEqual(spools.listSpools(other).find((s) => s.name === 'Teal').status, 'archived');
  assert.deepStrictEqual([transfer.importCsv(other, { text: csv.content }).added, transfer.previewImport(other, { text: csv.content }).already], [0, 2]);
});

test("FilamentHub's CSV comes in; a bad row is reported with its line and the rest still come in", () => {
  const db = fresh();
  const text = [
    'id,registered,name,material,brand,color_name,color_hex,diameter,initial_weight_g,used_weight_g,remaining_weight_g,fill_pct,print_temp_min,print_temp_max,bed_temp_min,bed_temp_max,purchase_date,purchase_price,supplier,status,lot_nr,notes',
    '1,2025-01-02T10:00:00,Charcoal,PETG,Polymaker,Charcoal,#333333,1.75,1000,360,640,64,230,250,70,80,2025-01-01,24.5,Amazon,active,L123,',
    '2,2025-01-03T10:00:00,No material,,Polymaker,,,1.75,1000,0,1000,100,,,,,,,,storage,,',
    '3,2025-01-04T10:00:00,Heavy,PLA,eSun,,#ffffff,1.75,lots,0,1000,100,,,,,,,,storage,,'
  ].join('\n');
  const result = transfer.importCsv(db, { text });
  assert.strictEqual(result.added, 1);
  assert.deepStrictEqual(
    result.problems.map((p) => [p.line, p.error]),
    [
      [3, 'No material'],
      [4, '"lots" is not a weight']
    ]
  );
  const charcoal = spools.listSpools(db)[0];
  assert.deepStrictEqual(
    [charcoal.name, charcoal.brand_name, charcoal.remaining, charcoal.status, charcoal.lot_nr, charcoal.purchase_date, charcoal.supplier],
    ['Charcoal', 'Polymaker', 640, 'active', 'L123', '2025-01-01T00:00:00.000Z', 'Amazon']
  );
  assert.throws(() => transfer.importCsv(db, { text: 'name,colour\nA,red\n' }), /material/);
});
