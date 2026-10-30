#!/usr/bin/env node
'use strict';

// Phase 6 (docs/merge-10.md): the print queue's order, plates, printers, the grams items set aside
// in order, and models' print status kept in step with it.

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const queue = require('../src/core/print-queue');
const spools = require('../src/core/spools');
const { replacePlateFilaments } = require('../src/core/plate-filaments');
const check = require('../src/core/filament-check');

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
    'CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT, title TEXT, designer TEXT, print_status TEXT, print_count INTEGER DEFAULT 0, dateAdded TEXT)'
  );
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
const model = (db, name, status = 'unprinted', extra = {}) =>
  Number(
    db
      .prepare('INSERT INTO models (filePath, fileName, print_status, print_count, dateAdded) VALUES (?, ?, ?, ?, ?)')
      .run(`/lib/${name}`, name, status, extra.count || 0, extra.added || new Date().toISOString()).lastInsertRowid
  );
const status = (db, id) => db.prepare('SELECT print_status FROM models WHERE id = ?').get(id).print_status;
const order = (db) => queue.listQueue(db).map((item) => item.model.fileName);

test('status and rows stay in step: Queued models get a row, others lose theirs', () => {
  const db = fresh();
  const a = model(db, 'a.3mf', 'queued', { added: '2026-01-02' });
  const b = model(db, 'b.3mf', 'queued', { added: '2026-01-01' });
  const c = model(db, 'c.stl');
  assert.deepStrictEqual(order(db), ['b.3mf', 'a.3mf'], 'oldest added first');
  queue.addToQueue(db, c);
  assert.strictEqual(status(db, c), 'queued');
  db.prepare("UPDATE models SET print_status = 'printed' WHERE id = ?").run(a);
  assert.deepStrictEqual(order(db), ['b.3mf', 'c.stl'], 'set to Printed elsewhere: out of the queue');
  db.prepare("UPDATE models SET print_status = 'printing' WHERE id = ?").run(b);
  assert.deepStrictEqual(order(db), ['b.3mf', 'c.stl'], 'a Printing model keeps its rows (more copies)');
});

test('adding, moving, removing and starting', () => {
  const db = fresh();
  const a = model(db, 'a.3mf');
  const b = model(db, 'b.3mf', 'unprinted', { count: 2 });
  const c = model(db, 'c.3mf');
  const qa = queue.addToQueue(db, a);
  const qb = queue.addToQueue(db, b);
  queue.addToQueue(db, c);
  queue.moveQueueItem(db, qb, 0);
  assert.deepStrictEqual(order(db), ['b.3mf', 'a.3mf', 'c.3mf']);
  assert.deepStrictEqual(
    queue.listQueue(db).map((item) => item.position),
    [1, 2, 3]
  );
  queue.removeFromQueue(db, qb);
  assert.strictEqual(status(db, b), 'printed', 'out of the queue, a model printed before is Printed again');
  queue.startQueueItem(db, qa);
  assert.strictEqual(status(db, a), 'printing');
  assert.deepStrictEqual(order(db), ['c.3mf']);
  assert.throws(() => queue.startQueueItem(db, qa), /gone/);
  assert.strictEqual(queue.removeFromQueue(db, 999), null);
});

test('a plate must be one the model has; a printer must exist', () => {
  const db = fresh();
  const a = model(db, 'kit.3mf');
  replacePlateFilaments(db, a, '3mf', [
    { plate: 1, slot: 1, material: 'PLA', color: '#ffffff', grams: 10 },
    { plate: 2, slot: 1, material: 'PLA', color: '#ffffff', grams: 5 }
  ]);
  assert.throws(() => queue.addToQueue(db, a, { plate: 3 }), /plates 1, 2/);
  assert.throws(() => queue.addToQueue(db, a, { printerId: 9 }), /printer no longer exists/);
  const id = queue.addToQueue(db, a, { plate: 2 });
  const [item] = queue.listQueue(db);
  assert.deepStrictEqual([item.plate, item.plates], [2, [1, 2]]);
  queue.updateQueueItem(db, id, { plate: null });
  assert.strictEqual(queue.listQueue(db)[0].plate, null);
});

test('each item counts what the items before it set aside', () => {
  const db = fresh();
  const white = spools.saveSpool(db, { material: 'PLA', color_hex: '#ffffff', initial_weight: 1000, remaining: 100 });
  const first = model(db, 'first.3mf');
  const second = model(db, 'second.3mf');
  for (const id of [first, second]) replacePlateFilaments(db, id, '3mf', [{ plate: 1, slot: 1, material: 'PLA', color: '#ffffff', grams: 60 }]);
  queue.addToQueue(db, first);
  const q2 = queue.addToQueue(db, second);
  let items = queue.listQueue(db);
  assert.deepStrictEqual(
    items.map((item) => [item.model.fileName, item.check.ready, item.check.needs[0].short]),
    [
      ['first.3mf', true, 0],
      ['second.3mf', false, 20]
    ]
  );
  assert.deepStrictEqual(
    db
      .prepare('SELECT spool_id, grams FROM queue_spool_holds ORDER BY grams DESC')
      .all()
      .map((r) => [r.spool_id, r.grams]),
    [
      [white.id, 60],
      [white.id, 40]
    ],
    'the second holds what is left'
  );
  queue.moveQueueItem(db, q2, 0);
  items = queue.listQueue(db);
  assert.deepStrictEqual(
    items.map((item) => [item.model.fileName, item.check.ready]),
    [
      ['second.3mf', true],
      ['first.3mf', false]
    ]
  );
  // The library's badge counts the holds: a third model needing 10 g of white is short now.
  const third = model(db, 'third.3mf');
  replacePlateFilaments(db, third, '3mf', [{ plate: 1, slot: 1, material: 'PLA', color: '#ffffff', grams: 10 }]);
  db.prepare("INSERT INTO model_plate_reads (model_id, file_key, read_at) VALUES (?, 'k', 'x')").run(third);
  assert.strictEqual(check.fitForLibrary(db).get(third).ready, false);
});

test('a logged print finishes one of its model’s items; the model stays Queued while others remain', () => {
  const db = fresh();
  const kit = model(db, 'kit.3mf');
  replacePlateFilaments(db, kit, '3mf', [
    { plate: 1, slot: 1, material: 'PLA', color: '#ffffff', grams: 10 },
    { plate: 2, slot: 1, material: 'PLA', color: '#ffffff', grams: 5 }
  ]);
  queue.addToQueue(db, kit, { plate: 1 });
  queue.addToQueue(db, kit, { plate: 2 });
  db.prepare("UPDATE models SET print_status = 'printed' WHERE id = ?").run(kit);
  queue.printLogged(db, kit, 2);
  const left = db.prepare('SELECT plate_index FROM print_queue WHERE model_id = ?').all(kit);
  assert.deepStrictEqual(
    left.map((r) => r.plate_index),
    [1]
  );
  assert.strictEqual(status(db, kit), 'queued');
  queue.printLogged(db, kit, null);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM print_queue').get().n, 0);
});

test('an online model merged into a downloaded one hands over its queue items', () => {
  const db = fresh();
  const online = model(db, 'online');
  const local = model(db, 'local.3mf');
  queue.addToQueue(db, online);
  // merge-online-model.js moves the items, and gives the downloaded model the Queued status.
  queue.moveModelItems(db, online, local);
  db.prepare("UPDATE models SET print_status = 'queued' WHERE id = ?").run(local);
  db.prepare('DELETE FROM models WHERE id = ?').run(online);
  assert.deepStrictEqual(order(db), ['local.3mf']);
});
