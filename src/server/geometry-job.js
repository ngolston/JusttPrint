'use strict';

/**
 * Geometry fingerprints for the Duplicates page's "Same geometry" (src/core/geometry-signature.js):
 * computed in the background for STL and 3MF models, one at a time in a worker thread, and kept in
 * the model_geometry table until the file changes (size or modification time).
 *
 * Progress goes to every browser as 'geometry-progress' { running, processed, total, failed },
 * and 'geometry-complete' when done.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const database = require('../core/database');
const events = require('./events');
const { buildModelFilterConditions, sqlAndFilterConditions } = require('../core/model-filters');

/** Larger files are not fingerprinted (they are read whole). */
const MAX_BYTES = 512 * 1024 * 1024;
const TYPES = "(lower(filePath) LIKE '%.stl' OR lower(filePath) LIKE '%.3mf')";
const PLAIN = "filePath NOT LIKE 'url::%' AND instr(filePath, '::') = 0";

let tableReady = false;
function table() {
  if (!tableReady) {
    database.db.prepare(`CREATE TABLE IF NOT EXISTS model_geometry (
      model_id INTEGER PRIMARY KEY,
      file_key TEXT NOT NULL,
      signature TEXT,
      triangles INTEGER,
      error TEXT,
      computed_at TEXT NOT NULL
    )`).run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_geometry_signature ON model_geometry(signature)').run();
    tableReady = true;
  }
  return database.db;
}

const state = { running: false, processed: 0, total: 0, failed: 0, cancel: false };
const snapshot = () => ({ running: state.running, processed: state.processed, total: state.total, failed: state.failed });

/** The file's identity for the fingerprint: size and modification time. Null when it cannot be read. */
function fileKey(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { key: `${stat.size}:${Math.round(stat.mtimeMs)}`, size: stat.size } : null;
  } catch (_) {
    return null;
  }
}

/** STL and 3MF models (plain files) in the filters' view: { id, filePath }. */
function candidates(filters) {
  const filter = buildModelFilterConditions(filters || null);
  return database.db.prepare(`SELECT id, filePath FROM models WHERE ${TYPES} AND ${PLAIN} ${sqlAndFilterConditions(filter.conditions)}`).all(...filter.params);
}

/** Models without a fingerprint for their current file. */
function missing(filters) {
  const kept = new Map(table().prepare('SELECT model_id, file_key FROM model_geometry').all().map((row) => [row.model_id, row.file_key]));
  return candidates(filters).filter((row) => {
    const now = fileKey(row.filePath);
    return now && kept.get(row.id) !== now.key;
  });
}

let worker = null;
const pending = new Map();
let nextId = 1;
function fingerprint(filePath) {
  if (!worker) {
    worker = new Worker(path.join(__dirname, 'geometry-worker.js'));
    worker.on('message', ({ id, ok, result, error }) => {
      const done = pending.get(id);
      pending.delete(id);
      if (done) done(ok ? { result } : { error });
    });
    worker.on('error', (error) => {
      for (const done of pending.values()) done({ error: error.message });
      pending.clear();
      worker = null;
    });
    worker.unref();
  }
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    worker.postMessage({ id, filePath });
  });
}

/** Fingerprint the models that need one (in the filters' view). Answers { started } or { alreadyRunning }. */
function start(filters = null) {
  if (state.running) return { alreadyRunning: true, ...snapshot() };
  const todo = missing(filters);
  Object.assign(state, { running: true, processed: 0, total: todo.length, failed: 0, cancel: false });
  events.broadcast('geometry-progress', snapshot());
  (async () => {
    const save = table().prepare('INSERT OR REPLACE INTO model_geometry (model_id, file_key, signature, triangles, error, computed_at) VALUES (?, ?, ?, ?, ?, ?)');
    let last = 0;
    for (const row of todo) {
      if (state.cancel) break;
      const now = fileKey(row.filePath);
      let outcome;
      if (!now) outcome = { error: 'The file cannot be read' };
      else if (now.size > MAX_BYTES) outcome = { error: 'Too large to fingerprint' };
      else outcome = await fingerprint(row.filePath);
      const result = outcome.result || null;
      if (outcome.error || !result) state.failed++;
      if (now) save.run(row.id, now.key, result ? result.signature : null, result ? result.triangles : null, outcome.error || (result ? null : 'No surface'), new Date().toISOString());
      state.processed++;
      if (Date.now() - last > 500) {
        last = Date.now();
        events.broadcast('geometry-progress', snapshot());
      }
    }
    state.running = false;
    events.broadcast('geometry-progress', snapshot());
    events.broadcast('geometry-complete', snapshot());
  })().catch((error) => {
    console.error('[Geometry] Fingerprinting stopped:', error);
    state.running = false;
    events.broadcast('geometry-complete', { ...snapshot(), error: error.message });
  });
  return { started: true, ...snapshot() };
}

/**
 * Groups of models with the same geometry but not the same file (those are the identical-file
 * duplicates): [{ hash: 'geometry:<fingerprint>', files: [{ filePath, fileName, size }] }], plus
 * how many models still need a fingerprint and whether fingerprinting is running.
 */
function duplicates(filters = null) {
  table();
  // The models in view, by the library's own filter SQL; then their fingerprints.
  const inView = filters ? new Set(candidates(filters).map((row) => row.id)) : null;
  const rows = database.db.prepare(`SELECT g.signature, m.id, m.filePath, m.fileName, m.size, m.hash
    FROM model_geometry g JOIN models m ON m.id = g.model_id
    WHERE g.signature IS NOT NULL AND m.filePath NOT LIKE 'url::%' AND instr(m.filePath, '::') = 0
    ORDER BY g.signature, m.filePath`).all().filter((row) => !inView || inView.has(row.id));
  const groups = new Map();
  for (const row of rows) {
    if (!fileKey(row.filePath)) continue;
    if (!groups.has(row.signature)) groups.set(row.signature, []);
    groups.get(row.signature).push(row);
  }
  const result = [];
  for (const [signature, files] of groups) {
    if (files.length < 2) continue;
    // All the same file: those are on the identical-files list already.
    const contents = new Set(files.map((f) => f.hash || `${f.filePath}`));
    if (contents.size < 2) continue;
    result.push({ hash: `geometry:${signature}`, files: files.map(({ filePath, fileName, size }) => ({ filePath, fileName, size })) });
  }
  return { groups: result, missing: missing(filters).length, ...snapshot() };
}

const status = () => snapshot();
const stop = () => { state.cancel = true; return snapshot(); };

module.exports = { duplicates, fileKey, missing, start, status, stop };
