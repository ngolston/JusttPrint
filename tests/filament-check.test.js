#!/usr/bin/env node
'use strict';

// Phase 4 (docs/merge-10.md): what each plate needs (threemf-filaments.js, plate-filaments.js)
// and the filament check (filament-check.js), down to the library's "Fits my filament" filter.

const assert = require('assert');
const Database = require('better-sqlite3');
const { plateFilamentsFrom, slotsPerPlate } = require('../src/server/threemf-filaments');
const { needsFrom, platesOf, replacePlateFilaments } = require('../src/core/plate-filaments');
const check = require('../src/core/filament-check');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const spools = require('../src/core/spools');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.stack || err.message);
    process.exitCode = 1;
  }
}

const SLICED = `<config><plate>
  <metadata key="index" value="1"/>
  <filament id="1" tray_info_idx="GFG02" type="PETG" color="#8B8F96FF" used_m="27" used_g="82.4" />
  <filament id="4" type="PLA" color="#000000" used_g="30" />
</plate><plate>
  <metadata key="index" value="2"/>
  <filament id="1" type="PETG" color="#8B8F96" used_g="64" />
  <filament id="2" type="PLA" color="#FFFFFF" used_g="9" />
</plate></config>`;
const PROJECT = JSON.stringify({ filament_colour: ['#F8F8F8FF', '#0056B8', '#181919FF'], filament_type: ['PLA', 'PLA', 'PETG'] });
const MODEL_SETTINGS = `<config>
  <object id="2"><metadata key="extruder" value="1"/><part id="1"><metadata key="extruder" value="3"/></part></object>
  <object id="5"><metadata key="name" value="Clip"/></object>
  <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate>
  <plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="5"/></model_instance></plate>
</config>`;

test('a sliced 3MF gives each plate its filaments and grams', () => {
  const { source, rows } = plateFilamentsFrom({ sliceInfo: SLICED, projectSettings: PROJECT });
  assert.strictEqual(source, '3mf');
  assert.deepStrictEqual(rows, [
    { plate: 1, slot: 1, material: 'PETG', color: '#8b8f96', grams: 82.4 },
    { plate: 1, slot: 4, material: 'PLA', color: '#000000', grams: 30 },
    { plate: 2, slot: 1, material: 'PETG', color: '#8b8f96', grams: 64 },
    { plate: 2, slot: 2, material: 'PLA', color: '#ffffff', grams: 9 }
  ]);
});

test('an unsliced project uses the filaments its objects and parts are set to', () => {
  assert.deepStrictEqual(
    [...slotsPerPlate(MODEL_SETTINGS)].map(([plate, slots]) => [plate, [...slots]]),
    [
      [1, [1, 3]],
      [2, [1]]
    ]
  );
  const { source, rows } = plateFilamentsFrom({ sliceInfo: '<config><header/></config>', projectSettings: PROJECT, modelSettings: MODEL_SETTINGS });
  assert.strictEqual(source, '3mf-project');
  assert.deepStrictEqual(
    rows.map((r) => [r.plate, r.slot, r.color, r.grams]),
    [
      [1, 1, '#f8f8f8', null],
      [1, 3, '#181919', null],
      [2, 1, '#f8f8f8', null]
    ]
  );
});

test('a painted project needs every project filament on every plate', () => {
  const { rows } = plateFilamentsFrom({ projectSettings: PROJECT, modelSettings: MODEL_SETTINGS, painted: true });
  assert.deepStrictEqual(
    rows.map((r) => [r.plate, r.slot]),
    [
      [0, 1],
      [0, 2],
      [0, 3]
    ]
  );
  assert.deepStrictEqual(plateFilamentsFrom({ projectSettings: 'not json' }).rows, []);
});

test('needs add up grams per slot for the whole model, and plate 0 rows count for every plate', () => {
  const rows = [
    { plate_index: 1, slot: 1, material: 'PETG', color_hex: '#8b8f96', grams: 82 },
    { plate_index: 2, slot: 1, material: 'PETG', color_hex: '#8b8f96', grams: 64 },
    { plate_index: 2, slot: 2, material: 'PLA', color_hex: '#ffffff', grams: null },
    { plate_index: 0, slot: 3, material: 'PLA', color_hex: '#000000', grams: 5 }
  ];
  assert.deepStrictEqual(needsFrom(rows, null), [
    { slot: 1, material: 'PETG', color: '#8b8f96', grams: 146 },
    { slot: 2, material: 'PLA', color: '#ffffff', grams: null },
    { slot: 3, material: 'PLA', color: '#000000', grams: 5 }
  ]);
  assert.deepStrictEqual(
    needsFrom(rows, 1).map((n) => n.slot),
    [1, 3]
  );
  assert.deepStrictEqual(platesOf(rows), [1, 2]);
});

test('colors: two blacks match, black and gray do not, and names are plain', () => {
  assert.ok(check.colorDistance('#000000', '#181919') <= check.MATCH_DELTA);
  assert.ok(check.colorDistance('#ffffff', '#f5f5f0') <= check.MATCH_DELTA);
  assert.ok(check.colorDistance('#000000', '#8b8f96') > check.MATCH_DELTA);
  assert.ok(check.colorDistance('#2f6fdf', '#d23b3b') > check.MATCH_DELTA);
  assert.strictEqual(check.colorDistance('#000000', null), Infinity);
  assert.strictEqual(check.colorName('#181919'), 'black');
  assert.strictEqual(check.colorName('#0056b8'), 'blue');
  assert.strictEqual(check.colorName('#f8f8f8'), 'white');
  assert.strictEqual(check.colorName(null), 'filament');
  // A textbook CIEDE2000 pair (Sharma et al.): 2.0425.
  assert.ok(Math.abs(check.deltaE([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 0.001);
});

const fresh = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT)');
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  check.forgetFits();
  return db;
};
const spool = (db, material, color, remaining, extra = {}) => spools.saveSpool(db, { material, color_hex: color, initial_weight: 1000, remaining, ...extra });

test('the check: enough, short, missing, and loaded spools first', () => {
  const db = fresh();
  const gray = spool(db, 'PETG', '#8b8f96', 640);
  const black = spool(db, 'PLA', '#111111', 18);
  const blackShelf = spool(db, 'PLA', '#0a0a0a', 500);
  const now = new Date().toISOString();
  const printer = Number(db.prepare('INSERT INTO printers (nickname, created_at, updated_at) VALUES (?, ?, ?)').run('P1S', now, now).lastInsertRowid);
  const unit = db.prepare('INSERT INTO printer_ams_units (printer_id, unit_index) VALUES (?, 0)').run(printer).lastInsertRowid;
  db.prepare('INSERT INTO printer_ams_slots (unit_id, slot_index, spool_id) VALUES (?, 3, ?)').run(unit, black.id);

  const needs = [
    { slot: 1, material: 'PETG', color: '#8b8f96', grams: 82 },
    { slot: 2, material: 'PLA Basic', color: '#000000', grams: 30 }
  ];
  const anywhere = check.checkNeeds(needs, check.availableSpools(db));
  assert.strictEqual(anywhere.ready, true);
  assert.strictEqual(anywhere.needs[0].spool.id, gray.id);
  assert.strictEqual(anywhere.needs[0].left, 558);
  assert.strictEqual(anywhere.needs[1].spool.id, blackShelf.id, 'the black with enough on it');

  // The black loaded in the P1S comes first there, though it is 12 g short.
  const onP1S = check.checkNeeds([{ slot: 2, material: 'PLA', color: '#000000', grams: 30 }], check.availableSpools(db), { printerId: printer });
  assert.strictEqual(onP1S.needs[0].spool.id, blackShelf.id, 'a loaded spool without enough gives way to one that has enough');
  db.prepare('UPDATE spools SET status = ? WHERE id = ?').run('archived', blackShelf.id);
  const short = check.checkNeeds([{ slot: 2, material: 'PLA', color: '#000000', grams: 30 }], check.availableSpools(db), { printerId: printer });
  assert.deepStrictEqual([short.ready, short.needs[0].spool.id, short.needs[0].short, short.missing], [false, black.id, 12, ['black']]);
  assert.strictEqual(short.needs[0].spool.where, 'P1S · A4');

  const none = check.checkNeeds([{ slot: 1, material: 'PLA', color: '#2f6fdf', grams: null }], check.availableSpools(db));
  assert.deepStrictEqual([none.ready, none.needs[0].spool, none.missing], [false, null, ['blue']]);
});

test('two needs on one spool share it; grams held by queued prints are not available', () => {
  const db = fresh();
  const white = spool(db, 'PLA', '#ffffff', 100);
  const needs = [
    { slot: 1, material: 'PLA', color: '#ffffff', grams: 60 },
    { slot: 2, material: 'PLA', color: '#f8f8f8', grams: 60 }
  ];
  const result = check.checkNeeds(needs, check.availableSpools(db));
  assert.deepStrictEqual(
    result.needs.map((n) => [n.spool.id, n.left, n.short, n.ok]),
    [
      [white.id, 40, 0, true],
      [white.id, 0, 20, false]
    ]
  );
  const model = Number(db.prepare('INSERT INTO models (print_status) VALUES (NULL)').run().lastInsertRowid);
  const queue = Number(
    db.prepare('INSERT INTO print_queue (model_id, position, created_at) VALUES (?, 1, ?)').run(model, new Date().toISOString()).lastInsertRowid
  );
  db.prepare('INSERT INTO queue_spool_holds (queue_id, spool_id, grams) VALUES (?, ?, 70)').run(queue, white.id);
  assert.strictEqual(check.availableSpools(db)[0].available, 30);
  assert.strictEqual(check.availableSpools(db, { exceptQueueId: queue })[0].available, 100);
});

test('the library: models checked for all plates, kept until spools change, none without spools', () => {
  const db = fresh();
  const ready = Number(db.prepare('INSERT INTO models (print_status) VALUES (NULL)').run().lastInsertRowid);
  const needsBlue = Number(db.prepare('INSERT INTO models (print_status) VALUES (NULL)').run().lastInsertRowid);
  replacePlateFilaments(db, ready, '3mf', [{ plate: 1, slot: 1, material: 'PLA', color: '#ffffff', grams: 20 }]);
  replacePlateFilaments(db, needsBlue, '3mf-project', [
    { plate: 0, slot: 1, material: 'PLA', color: '#ffffff', grams: null },
    { plate: 0, slot: 2, material: 'PLA', color: '#0056b8', grams: null }
  ]);
  db.prepare("INSERT INTO model_plate_reads (model_id, file_key, read_at) VALUES (?, 'k', 'a'), (?, 'k', 'a')").run(ready, needsBlue);
  assert.strictEqual(check.fitForLibrary(db).size, 0, 'no spools: filament is not tracked');

  spool(db, 'PLA', '#ffffff', 500);
  let fits = check.fitForLibrary(db);
  assert.deepStrictEqual({ ready: fits.get(ready).ready, missing: fits.get(ready).missing }, { ready: true, missing: [] });
  assert.deepStrictEqual({ ready: fits.get(needsBlue).ready, missing: fits.get(needsBlue).missing }, { ready: false, missing: ['blue'] });
  assert.deepStrictEqual(
    fits.get(needsBlue).colors.map((c) => [c.name, c.ok]),
    [
      ['white', true],
      ['blue', false]
    ],
    "the card's dots: the colors it needs, the short one marked"
  );
  assert.strictEqual(check.fitForLibrary(db), fits, 'kept while nothing changed');

  spool(db, 'PLA', '#0a4fb0', 800);
  fits = check.fitForLibrary(db);
  assert.strictEqual(fits.get(needsBlue).ready, true, 'a new spool refreshes the check');
  assert.deepStrictEqual(check.checkModel(db, ready, { plate: 1 }).needs[0].left, 480);
  assert.strictEqual(check.checkModel(db, 999), null);
});

test('a logged print takes its grams off the spools, and gives them back when deleted', () => {
  const { applySpoolUsage, restoreSpoolUsage, normalizeSpoolUsage, spoolsForEvents } = require('../src/core/spool-usage');
  const db = fresh();
  const gray = spool(db, 'PETG', '#8b8f96', 640);
  const black = spool(db, 'PLA', '#111111', 500, { status: 'storage' });
  const model = Number(db.prepare('INSERT INTO models (print_status) VALUES (NULL)').run().lastInsertRowid);
  const now = new Date().toISOString();
  const event = Number(
    db.prepare("INSERT INTO print_events (model_id, printed_at, outcome, quantity, created_at) VALUES (?, ?, 'printed', 1, ?)").run(model, now, now)
      .lastInsertRowid
  );
  assert.deepStrictEqual(
    normalizeSpoolUsage([
      { spoolId: 1, grams: 10 },
      { spool_id: 1, grams: 5 },
      { spoolId: 2, grams: 0 },
      { spoolId: 'x', grams: 3 }
    ]),
    [{ spoolId: 1, grams: 15 }]
  );
  applySpoolUsage(
    db,
    event,
    [
      { spoolId: gray.id, grams: 82 },
      { spoolId: black.id, grams: 30 }
    ],
    { printedAt: now, plateIndex: 1 }
  );
  assert.strictEqual(spools.getSpool(db, gray.id).remaining, 558);
  const usedBlack = spools.getSpool(db, black.id);
  assert.deepStrictEqual([usedBlack.remaining, usedBlack.status, usedBlack.last_used_at], [470, 'active', now]);
  assert.deepStrictEqual(
    { ...db.prepare('SELECT filament_used_g, plate_index FROM print_events WHERE id = ?').get(event) },
    { filament_used_g: 112, plate_index: 1 }
  );
  assert.deepStrictEqual(
    spoolsForEvents(db, [event])
      .get(event)
      .map((s) => [s.spoolId, s.grams]),
    [
      [gray.id, 82],
      [black.id, 30]
    ]
  );
  assert.throws(() => applySpoolUsage(db, event, [{ spoolId: 999, grams: 1 }]), /no longer exists/);
  restoreSpoolUsage(db, event);
  assert.strictEqual(spools.getSpool(db, gray.id).remaining, 640);
  assert.strictEqual(spools.getSpool(db, black.id).remaining, 500);
});
