#!/usr/bin/env node
'use strict';

// The exact files prints used (printed-files.js): their settings, the copy kept, the print they
// led to, and only the newest few per model.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-printed-'));
// The data folder (next to the database) is this test's.
process.env.JUSTTPRINT_DB_PATH = path.join(dir, 'data', 'justtprint.db');
const kept = require('./printed-files');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const project = (layer) =>
  Buffer.from(
    zipSync({
      'Metadata/project_settings.config': strToU8(
        JSON.stringify({
          print_settings_id: '0.20mm Standard @BBL P1S',
          layer_height: layer,
          wall_loops: '3',
          sparse_infill_density: '15%',
          enable_support: '0',
          nozzle_temperature: ['220', '220'],
          unrelated: 'x'
        })
      ),
      'Metadata/plate_1.gcode': strToU8('G28\n')
    })
  );

test('the settings people compare, in words', () => {
  assert.deepStrictEqual(
    kept.settingsFrom(JSON.stringify({ layer_height: '0.2', enable_support: '1', nozzle_temperature: ['', '215'], hot_plate_temp: ['60'] })),
    [
      { key: 'layer_height', label: 'Layer height', value: '0.2 mm' },
      { key: 'enable_support', label: 'Supports', value: 'Yes' },
      { key: 'nozzle_temperature', label: 'Nozzle', value: '215°C' },
      { key: 'hot_plate_temp', label: 'Bed', value: '60°C' }
    ]
  );
  assert.deepStrictEqual(kept.settingsFrom('not json'), []);
});

test('keeps a copy of each sent file with its settings; links the print that followed; keeps the newest few', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT, title TEXT, designer TEXT, print_status TEXT, print_count INTEGER DEFAULT 0, dateAdded TEXT);
    CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, printed_at TEXT, outcome TEXT, quantity INTEGER DEFAULT 1, notes TEXT, created_at TEXT);
    INSERT INTO models (id, filePath, fileName) VALUES (1, '/lib/robot.3mf', 'robot.3mf');
  `);
  const log = console.log;
  console.log = () => {};
  try {
    require('../core/filament-schema').ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  db.prepare("INSERT INTO printers (id, nickname, created_at, updated_at) VALUES (5, 'P1S', '2026-01-01', '2026-01-01')").run();
  const file = path.join(dir, 'Robot.gcode.3mf');
  fs.writeFileSync(file, project('0.16'));
  const id = await kept.keepPrintedFile(db, { modelId: 1, printerId: 5, plate: 1, filePath: file });
  // The print it led to, logged an hour later (as the printer job tracking does: with a space).
  const later = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare("INSERT INTO print_events (model_id, printed_at, outcome, printer_id) VALUES (1, ?, 'failed', 5)").run(later);
  fs.writeFileSync(file, project('0.28'));
  const list = kept.listPrintedFiles(db, 1);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual([list[0].name, list[0].plate, list[0].printerName, list[0].outcome], ['Robot.gcode.3mf', 1, 'P1S', 'failed']);
  assert.deepStrictEqual(
    list[0].settings.map((s) => [s.label, s.value]),
    [
      ['Process', '0.20mm Standard @BBL P1S'],
      ['Layer height', '0.16 mm'],
      ['Walls', '3'],
      ['Infill', '15%'],
      ['Supports', 'No'],
      ['Nozzle', '220°C']
    ],
    'the settings as printed, not the file as it is now'
  );
  const copy = kept.printedFilePath(db, id);
  assert.ok(copy && fs.readFileSync(copy).length > 0, 'the copy is kept');
  for (let i = 0; i < kept.KEEP_PER_MODEL + 2; i++) await kept.keepPrintedFile(db, { modelId: 1, printerId: 5, plate: 1, filePath: file });
  assert.strictEqual(kept.listPrintedFiles(db, 1).length, kept.KEEP_PER_MODEL, 'only the newest few');
  assert.strictEqual(kept.printedFilePath(db, id), null, 'the oldest copy is gone');
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
