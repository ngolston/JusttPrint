'use strict';

/**
 * The print queue (docs/merge-10.md, Phase 6): print_queue rows in order, each a model with a
 * plate (null: every plate) and a printer (optional), and the grams each one sets aside on spools
 * (queue_spool_holds), so the filament check of an item counts what the items before it will use.
 *
 * models.print_status stays in step: a model is Queued while it has rows. Status is written in
 * many places (details, cards, Edit, MCP), so syncWithStatus() reconciles both ways: a Queued
 * model without a row gets one at the end; rows of a model that is neither Queued nor Printing
 * go. (A Printing model may keep rows: more copies to print.)
 */

const { availableSpools, checkNeeds } = require('./filament-check');
const { getPlateFilaments, needsFrom, platesOf } = require('./plate-filaments');

const now = () => new Date().toISOString();

/** Positions 1, 2, 3… in the current order. */
function renumber(db) {
  const rows = db.prepare('SELECT id FROM print_queue ORDER BY position, id').all();
  const set = db.prepare('UPDATE print_queue SET position = ? WHERE id = ?');
  rows.forEach((row, index) => set.run(index + 1, row.id));
}

/** A model's status from its history when it leaves the queue: Printed if it ever was, else Unprinted. */
function statusWithoutQueue(db, modelId) {
  const row = db.prepare('SELECT print_count FROM models WHERE id = ?').get(modelId);
  return row && Number(row.print_count) > 0 ? 'printed' : 'unprinted';
}

/** Reconcile rows and statuses (see above). Returns { added, removed }. */
function syncWithStatus(db) {
  return db.transaction(() => {
    const removed = db
      .prepare("DELETE FROM print_queue WHERE model_id IN (SELECT id FROM models WHERE COALESCE(print_status, 'unprinted') NOT IN ('queued', 'printing'))")
      .run().changes;
    const missing = db
      .prepare("SELECT id FROM models WHERE print_status = 'queued' AND id NOT IN (SELECT model_id FROM print_queue) ORDER BY dateAdded, id")
      .all();
    let position = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM print_queue').get().p;
    const insert = db.prepare(
      'INSERT INTO print_queue (model_id, plate_index, printer_id, position, created_by, created_at) VALUES (?, NULL, NULL, ?, NULL, ?)'
    );
    for (const row of missing) insert.run(row.id, ++position, now());
    if (removed || missing.length) recomputeHolds(db);
    return { added: missing.length, removed };
  })();
}

/**
 * Work out every item's filament check in queue order, and keep what each sets aside
 * (queue_spool_holds). Returns the checks by queue id.
 */
function recomputeHolds(db) {
  const items = db.prepare('SELECT id, model_id, plate_index, printer_id FROM print_queue ORDER BY position, id').all();
  const spools = availableSpools(db, { ignoreHolds: true });
  const held = new Map();
  const checks = new Map();
  const insert = db.prepare('INSERT INTO queue_spool_holds (queue_id, spool_id, grams) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM queue_spool_holds').run();
    for (const item of items) {
      const needs = needsFrom(getPlateFilaments(db, item.model_id), item.plate_index ?? null);
      if (!needs.length || !spools.length) {
        checks.set(item.id, null);
        continue;
      }
      // What earlier items set aside is not available to this one.
      const left = spools.map((spool) => ({ ...spool, available: Math.max(0, spool.available - (held.get(spool.id) || 0)) }));
      const result = checkNeeds(needs, left, { printerId: item.printer_id });
      checks.set(item.id, result);
      const mine = new Map();
      for (const need of result.needs) {
        if (!need.spool || !(Number(need.grams) > 0)) continue;
        const grams = Math.min(Number(need.grams), Math.max(0, need.spool.available));
        if (grams <= 0) continue;
        mine.set(need.spool.id, (mine.get(need.spool.id) || 0) + grams);
      }
      for (const [spoolId, grams] of mine) {
        insert.run(item.id, spoolId, Math.round(grams * 100) / 100);
        held.set(spoolId, (held.get(spoolId) || 0) + grams);
      }
    }
  })();
  return checks;
}

/**
 * The queue in order, each item with its model, plate, printer, the plates its model has, and
 * its filament check (null when the model's filament is not known or there are no spools).
 */
function listQueue(db) {
  syncWithStatus(db);
  const checks = recomputeHolds(db);
  return db
    .prepare(
      `SELECT q.id, q.model_id, q.plate_index, q.printer_id, q.position, q.created_at,
        m.filePath, m.fileName, m.title, m.designer, m.print_status, p.nickname AS printer_name
       FROM print_queue q JOIN models m ON m.id = q.model_id LEFT JOIN printers p ON p.id = q.printer_id
       ORDER BY q.position, q.id`
    )
    .all()
    .map((row) => ({
      id: row.id,
      position: row.position,
      plate: row.plate_index,
      printerId: row.printer_id,
      printerName: row.printer_name,
      createdAt: row.created_at,
      model: { id: row.model_id, filePath: row.filePath, fileName: row.fileName, title: row.title, designer: row.designer, printStatus: row.print_status },
      plates: platesOf(getPlateFilaments(db, row.model_id)),
      check: checks.get(row.id) ?? null
    }));
}

/** Check a plate number against the model's plates: null (every plate) or one it has. */
function plateFor(db, modelId, plate) {
  if (plate === null || plate === undefined || plate === '') return null;
  const n = Number(plate);
  if (!Number.isInteger(n) || n < 1) throw new Error('A plate is a number from 1');
  const plates = platesOf(getPlateFilaments(db, modelId));
  if (plates.length && !plates.includes(n)) throw new Error(`This model has plates ${plates.join(', ')}`);
  return n;
}

function printerFor(db, printerId) {
  if (printerId === null || printerId === undefined || printerId === '') return null;
  const n = Number(printerId);
  if (!db.prepare('SELECT 1 FROM printers WHERE id = ?').get(n)) throw new Error('That printer no longer exists');
  return n;
}

/**
 * Add a model (one plate, or every plate) to the end of the queue. It is Queued from now on
 * (unless Printing). Returns the new id.
 * @param {any} db
 * @param {number} modelId
 * @param {{ plate?: number | string | null, printerId?: number | string | null, userId?: number | null }} [options]
 */
function addToQueue(db, modelId, options = {}) {
  const { plate = null, printerId = null, userId = null } = options;
  const model = db.prepare('SELECT id, print_status FROM models WHERE id = ?').get(modelId);
  if (!model) throw new Error('Model not found');
  return db.transaction(() => {
    const position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM print_queue').get().p;
    const id = Number(
      db
        .prepare('INSERT INTO print_queue (model_id, plate_index, printer_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(modelId, plateFor(db, modelId, plate), printerFor(db, printerId), position, Number(userId) > 0 ? Number(userId) : null, now()).lastInsertRowid
    );
    if (model.print_status !== 'printing') db.prepare("UPDATE models SET print_status = 'queued' WHERE id = ?").run(modelId);
    recomputeHolds(db);
    return id;
  })();
}

/** Change an item's plate or printer. */
function updateQueueItem(db, queueId, changes = {}) {
  const item = db.prepare('SELECT * FROM print_queue WHERE id = ?').get(queueId);
  if (!item) throw new Error('That queue item is gone');
  const plate = changes.plate === undefined ? item.plate_index : plateFor(db, item.model_id, changes.plate);
  const printerId = changes.printerId === undefined ? item.printer_id : printerFor(db, changes.printerId);
  db.prepare('UPDATE print_queue SET plate_index = ?, printer_id = ? WHERE id = ?').run(plate, printerId, queueId);
  recomputeHolds(db);
}

/** Move an item to a place in the queue (0 is first). */
function moveQueueItem(db, queueId, toIndex) {
  const ids = db
    .prepare('SELECT id FROM print_queue ORDER BY position, id')
    .all()
    .map((row) => row.id);
  const from = ids.indexOf(Number(queueId));
  if (from < 0) throw new Error('That queue item is gone');
  const to = Math.max(0, Math.min(ids.length - 1, Math.floor(Number(toIndex) || 0)));
  ids.splice(to, 0, ...ids.splice(from, 1));
  db.transaction(() => {
    const set = db.prepare('UPDATE print_queue SET position = ? WHERE id = ?');
    ids.forEach((id, index) => set.run(index + 1, id));
    recomputeHolds(db);
  })();
}

/** After a model's rows change: Queued while it has rows; without rows, a Queued model goes back to Printed or Unprinted. */
function settleStatus(db, modelId) {
  const status = db.prepare('SELECT print_status FROM models WHERE id = ?').get(modelId)?.print_status;
  const rows = db.prepare('SELECT COUNT(*) AS n FROM print_queue WHERE model_id = ?').get(modelId).n;
  if (!rows && status === 'queued') db.prepare('UPDATE models SET print_status = ? WHERE id = ?').run(statusWithoutQueue(db, modelId), modelId);
  if (rows && (!status || status === 'unprinted' || status === 'printed' || status === 'failed' || status === 'want')) {
    db.prepare("UPDATE models SET print_status = 'queued' WHERE id = ?").run(modelId);
  }
}

/** Take an item out of the queue. Returns its model id. */
function removeFromQueue(db, queueId) {
  const item = db.prepare('SELECT model_id FROM print_queue WHERE id = ?').get(queueId);
  if (!item) return null;
  db.transaction(() => {
    db.prepare('DELETE FROM print_queue WHERE id = ?').run(queueId);
    renumber(db);
    settleStatus(db, item.model_id);
    recomputeHolds(db);
  })();
  return item.model_id;
}

/** Start an item: its model is Printing, and the item leaves the queue (Log Print finishes it). */
function startQueueItem(db, queueId) {
  const item = db.prepare('SELECT model_id FROM print_queue WHERE id = ?').get(queueId);
  if (!item) throw new Error('That queue item is gone');
  db.transaction(() => {
    db.prepare('DELETE FROM print_queue WHERE id = ?').run(queueId);
    db.prepare("UPDATE models SET print_status = 'printing' WHERE id = ?").run(item.model_id);
    renumber(db);
    recomputeHolds(db);
  })();
  return item.model_id;
}

/**
 * A print was logged for a model: one of its queue items is done (the logged plate's, else the
 * first). Called after the print event changed the model's status; when items remain, the model
 * stays Queued.
 */
/**
 * @param {any} db
 * @param {number} modelId
 * @param {number | null} [plate]
 */
function printLogged(db, modelId, plate = null) {
  const rows = db.prepare('SELECT id, plate_index FROM print_queue WHERE model_id = ? ORDER BY position, id').all(modelId);
  if (!rows.length) return;
  const done = rows.find((row) => plate !== null && row.plate_index === plate) || rows.find((row) => row.plate_index === null) || rows[0];
  db.prepare('DELETE FROM print_queue WHERE id = ?').run(done.id);
  const status = db.prepare('SELECT print_status FROM models WHERE id = ?').get(modelId)?.print_status;
  if (rows.length > 1 && status !== 'printing') db.prepare("UPDATE models SET print_status = 'queued' WHERE id = ?").run(modelId);
  renumber(db);
  recomputeHolds(db);
}

/** Move one model's queue items to another (an online model merged into a downloaded one). */
function moveModelItems(db, fromModelId, toModelId) {
  db.prepare('UPDATE print_queue SET model_id = ?, plate_index = NULL WHERE model_id = ?').run(toModelId, fromModelId);
}

module.exports = {
  listQueue,
  addToQueue,
  updateQueueItem,
  moveQueueItem,
  removeFromQueue,
  startQueueItem,
  printLogged,
  syncWithStatus,
  recomputeHolds,
  moveModelItems,
  settleStatus
};
