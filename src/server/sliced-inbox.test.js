#!/usr/bin/env node
'use strict';

// The sliced-files inbox (sliced-inbox.js): names OrcaSlicer gives exports, matching them to
// models, filing them beside the model and queueing it, and the ones that wait for a choice.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');
const inbox = require('./sliced-inbox');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-inbox-'));
const sliced = (plates = [1]) => Buffer.from(zipSync(Object.fromEntries(plates.map((n) => [`Metadata/plate_${n}.gcode`, strToU8('G28\n')]))));

/** A library: Gear and two Benchys in folders of their own, and an inbox folder outside it. */
function setup(name) {
  const root = path.join(dir, name);
  const library = path.join(root, 'library');
  const folder = path.join(root, 'inbox');
  for (const sub of ['Gear', 'Benchy A', 'Benchy B', 'Cable Clip']) fs.mkdirSync(path.join(library, sub), { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT, title TEXT, designer TEXT, print_status TEXT, print_count INTEGER DEFAULT 0, dateAdded TEXT);
    CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, printed_at TEXT, outcome TEXT, quantity INTEGER DEFAULT 1, notes TEXT, created_at TEXT);
  `);
  const add = db.prepare('INSERT INTO models (filePath, fileName, title, print_status) VALUES (?, ?, ?, ?)');
  add.run(path.join(library, 'Gear', 'Gear.3mf'), 'Gear.3mf', null, 'unprinted');
  add.run(path.join(library, 'Benchy A', 'benchy.stl'), 'benchy.stl', null, 'unprinted');
  add.run(path.join(library, 'Benchy B', 'benchy.stl'), 'benchy.stl', null, 'unprinted');
  add.run(path.join(library, 'Cable Clip', 'clip_v2.stl'), 'clip_v2.stl', 'Cable Clip', 'unprinted');
  const log = console.log;
  console.log = () => {};
  try {
    require('../core/filament-schema').ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  inbox.setInboxFolder(db, folder, { homes: [library] });
  /** Drop a file in the inbox, written a while ago (settled). */
  const drop = (fileName, bytes = sliced()) => {
    const file = path.join(folder, fileName);
    fs.writeFileSync(file, bytes);
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(file, past, past);
    return file;
  };
  return { db, library, folder, drop };
}

test('the names to try: whole, then without the plate, filament and print time OrcaSlicer adds', () => {
  assert.deepStrictEqual(inbox.namesToTry('Gear_PLA_1h23m.gcode.3mf'), ['gear pla 1h23m', 'gear pla', 'gear']);
  assert.deepStrictEqual(inbox.namesToTry('Cable Clip_plate_2.gcode.3mf'), ['cable clip plate 2', 'cable clip']);
  assert.deepStrictEqual(inbox.namesToTry('Benchy (1).gcode.3mf'), ['benchy 1', 'benchy']);
  assert.deepStrictEqual(inbox.namesToTry('Mount v2.gcode.3mf'), ['mount v2'], 'a version is part of the name');
  assert.deepStrictEqual(inbox.namesToTry('2026.gcode.3mf'), ['2026'], 'a name that is only a number stays');
});

test('a file named like one model is filed beside it, and the model is queued with its one plate', async () => {
  const { db, library, folder, drop } = setup('one');
  drop('Gear_PETG_2h5m.gcode.3mf');
  drop('Cable Clip_plate_1.gcode.3mf', sliced([1, 2]));
  const result = await inbox.checkInbox(db);
  assert.deepStrictEqual(result, { filed: 2, waiting: 0 });
  assert.ok(fs.existsSync(path.join(library, 'Gear', 'Gear_PETG_2h5m.gcode.3mf')), 'beside the model');
  assert.ok(fs.existsSync(path.join(library, 'Cable Clip', 'Cable Clip_plate_1.gcode.3mf')), 'matched by its title');
  assert.deepStrictEqual(fs.readdirSync(folder), [], 'gone from the inbox');
  const queue = db.prepare('SELECT m.fileName, q.plate_index FROM print_queue q JOIN models m ON m.id = q.model_id ORDER BY q.position').all();
  assert.deepStrictEqual(
    queue.map((row) => [row.fileName, row.plate_index]).sort(),
    [
      ['Gear.3mf', 1],
      ['clip_v2.stl', null]
    ],
    'one plate: that plate; several: every plate'
  );
  assert.strictEqual(db.prepare("SELECT print_status FROM models WHERE fileName = 'Gear.3mf'").get().print_status, 'queued');
  const status = inbox.inboxStatus(db);
  assert.deepStrictEqual(status.items.map((item) => [item.status, item.model && item.model.name, item.queued]).sort(), [
    ['filed', 'Cable Clip', true],
    ['filed', 'Gear', true]
  ]);
});

test('a model already in the queue is not queued twice; a new export replaces the old one', async () => {
  const { db, library, drop } = setup('again');
  drop('Gear.gcode.3mf');
  await inbox.checkInbox(db);
  drop('Gear.gcode.3mf', sliced([1, 2]));
  await inbox.checkInbox(db);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM print_queue').get().n, 1);
  assert.strictEqual(fs.readdirSync(path.join(library, 'Gear')).filter((n) => n.endsWith('.gcode.3mf')).length, 1);
  assert.strictEqual(inbox.inboxStatus(db).items[0].message, 'It was already in the queue');
});

test('a file several models match, or none, waits; choosing a model files it; Ignore leaves it', async () => {
  const { db, library, folder, drop } = setup('choose');
  drop('benchy.gcode.3mf');
  drop('Mystery thing.gcode.3mf');
  const result = await inbox.checkInbox(db);
  assert.deepStrictEqual(result, { filed: 0, waiting: 2 });
  const waiting = inbox.inboxStatus(db).items;
  const benchy = waiting.find((item) => item.fileName === 'benchy.gcode.3mf');
  assert.match(benchy.message, /2 models are named like it/);
  assert.strictEqual(benchy.suggestions.length, 2, 'the two Benchys to choose from');
  await inbox.checkInbox(db);
  assert.strictEqual(inbox.inboxStatus(db).items.length, 2, 'looking again does not list them twice');

  const chosen = path.join(library, 'Benchy B', 'benchy.stl');
  const done = await inbox.fileWaiting(db, benchy.id, chosen);
  assert.strictEqual(done.queued, 1);
  assert.ok(fs.existsSync(path.join(library, 'Benchy B', 'benchy.gcode.3mf')));

  const mystery = inbox.inboxStatus(db).items.find((item) => item.status === 'waiting');
  assert.strictEqual(mystery.fileName, 'Mystery thing.gcode.3mf');
  inbox.ignoreWaiting(db, mystery.id);
  await inbox.checkInbox(db);
  assert.ok(!inbox.inboxStatus(db).items.some((item) => item.status === 'waiting'), 'ignored stays off the list');
  assert.ok(fs.existsSync(path.join(folder, 'Mystery thing.gcode.3mf')), 'and stays in the folder');
  assert.deepStrictEqual(
    inbox.findModels(db, 'bench').map((m) => m.filePath),
    [path.join(library, 'Benchy A', 'benchy.stl'), path.join(library, 'Benchy B', 'benchy.stl')],
    'found by name, the sliced file beside one not among them'
  );
});

test('a file still being written waits for the next look', async () => {
  const { db, folder } = setup('writing');
  fs.writeFileSync(path.join(folder, 'Gear.gcode.3mf'), sliced());
  assert.deepStrictEqual(await inbox.checkInbox(db), { filed: 0, waiting: 0 });
  assert.ok(fs.existsSync(path.join(folder, 'Gear.gcode.3mf')));
});

test('the folder must exist and be outside the STL Home folders', () => {
  const { db, library } = setup('folder');
  assert.throws(() => inbox.setInboxFolder(db, path.join(library, 'Gear'), { homes: [library] }), /outside your STL Home folder/);
  assert.throws(() => inbox.setInboxFolder(db, path.join(dir, 'nope'), { homes: [] }), /There is no folder/);
  assert.throws(() => inbox.setInboxFolder(db, 'relative/path', { homes: [] }), /whole path/);
  assert.deepStrictEqual(inbox.setInboxFolder(db, '', { homes: [] }), { folder: '' }, 'empty turns it off');
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
  inbox.stop();
  fs.rmSync(dir, { recursive: true, force: true });
})();
