'use strict';

/**
 * Reads what each 3MF model's plates need (threemf-filaments.js) into model_plate_filaments, in
 * the background with a progress bar (activity.js, kind 'plates'): once after the server starts,
 * then after the library changes (refresh-grid, a scan). A model is read again only when its file
 * changes (size and time, kept in model_plate_reads). When the file is not sliced, a MakerWorld
 * link's print profile (kept site details, not fetched) gives grams instead of colors alone.
 */

const fs = require('fs');
const database = require('../core/database');
const { replacePlateFilaments } = require('../core/plate-filaments');
const { readPlateFilaments } = require('./threemf-filaments');

const STARTUP_DELAY_MS = 45 * 1000;
const AFTER_CHANGE_MS = 15 * 1000;

let running = false;
let again = false;
/** @type {NodeJS.Timeout | null} */
let timer = null;

/** A file's identity: size and modification time; null when it cannot be read. */
function fileKey(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? `${stat.size}:${Math.round(stat.mtimeMs)}` : null;
  } catch (_) {
    return null;
  }
}

/** 3MF files on disk whose rows are missing or from an older version of the file. */
function missing(db = database.db) {
  const kept = new Map(
    db
      .prepare('SELECT model_id, file_key FROM model_plate_reads')
      .all()
      .map((row) => [row.model_id, row.file_key])
  );
  return db
    .prepare("SELECT id, filePath, source FROM models WHERE lower(filePath) LIKE '%.3mf' AND filePath NOT LIKE 'url::%' AND filePath NOT LIKE '%::%'")
    .all()
    .map((row) => ({ ...row, key: fileKey(row.filePath) }))
    .filter((row) => row.key && kept.get(row.id) !== row.key);
}

/** MakerWorld print profile filaments as plate rows (every plate), or null. */
function makerWorldRows(source) {
  if (!source) return null;
  /** @type {{ type: string | null, color: string | null, grams: number | null }[] | null} */
  let filaments;
  try {
    filaments = require('./site-details').cachedProfileFilaments(String(source));
  } catch (_) {
    return null;
  }
  if (!filaments) return null;
  return filaments.map((f, index) => ({ plate: 0, slot: index + 1, material: f.type, color: f.color ? String(f.color).toLowerCase() : null, grams: f.grams }));
}

/** Read one model: the sliced file, else its MakerWorld profile, else the project's colors. */
async function readModel(db, row) {
  let outcome = { source: '3mf', rows: /** @type {any[]} */ ([]) };
  /** @type {string | null} */
  let error = null;
  try {
    outcome = await readPlateFilaments(row.filePath);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  if (outcome.source !== '3mf' || !outcome.rows.length) {
    const fromSite = makerWorldRows(row.source);
    if (fromSite) outcome = { source: 'makerworld', rows: fromSite };
  }
  if (!db.prepare('SELECT 1 FROM models WHERE id = ?').get(row.id)) return false;
  db.transaction(() => {
    replacePlateFilaments(db, row.id, outcome.source, outcome.rows);
    db.prepare('INSERT OR REPLACE INTO model_plate_reads (model_id, file_key, source, error, read_at) VALUES (?, ?, ?, ?, ?)').run(
      row.id,
      row.key,
      outcome.rows.length ? outcome.source : null,
      error,
      new Date().toISOString()
    );
  })();
  return outcome.rows.length > 0;
}

/** Read every model that needs it. Resolves to how many were read. */
async function run() {
  if (running) {
    again = true;
    return 0;
  }
  running = true;
  let read = 0;
  try {
    do {
      again = false;
      const db = database.db;
      if (!db || !db.open) break;
      const todo = missing(db);
      if (!todo.length) continue;
      const activity = require('./activity');
      await activity.track('plates', 'Reading filament from 3MF files', { total: todo.length, unit: 'files' }, async (update) => {
        for (const row of todo) {
          if (!database.db || !database.db.open) break;
          await readModel(database.db, row);
          read++;
          update({ done: read });
        }
      });
    } while (again);
  } catch (error) {
    console.error('[Plates] Reading plate filaments stopped:', error);
  } finally {
    running = false;
  }
  if (read) {
    console.log(`[Plates] Read the filament of ${read} 3MF model(s)`);
    require('./events').broadcastRaw('filament-check-changed');
  }
  return read;
}

/** Run soon (after `delay`), once, however often this is called meanwhile. */
function schedule(delay = AFTER_CHANGE_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, delay);
  timer.unref?.();
}

/** The server started: read what is missing after the startup work. */
const startup = () => schedule(STARTUP_DELAY_MS);
/** The library changed (a scan, an upload): read new and changed files. */
const libraryChanged = () => schedule(AFTER_CHANGE_MS);

module.exports = { run, schedule, startup, libraryChanged, missing, readModel, fileKey };
