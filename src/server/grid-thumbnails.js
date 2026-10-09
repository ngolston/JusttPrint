'use strict';

/**
 * Small copies of large thumbnails for the grid. A model's stored images stay as they are: the
 * details panel, Manage Thumbnails, AI tagging and MCP use them. The grid gets a copy of the first
 * one, at most 512 px on its longest side (about twice a grid card, sharp on high-resolution
 * screens), as WebP.
 *
 * Copies are made in the background, one at a time, by the thumbnail worker's Chromium and kept in
 * the grid_thumbnails table. Triggers drop a model's copy when its thumbnails change or it is
 * removed; the grid then gets the original until the next pass makes a new copy.
 */

const database = require('../core/database');
const thumbnailWorker = require('./thumbnail-worker');

const MAX_DIMENSION = 512;
const QUALITY = 0.85;
/** First images up to this many characters (about 45 KB) go to the grid as they are. */
const SMALL_ENOUGH_CHARS = 60000;
/** Larger first images are not decoded (the same limit as for loading a thumbnail at all). */
const MAX_SOURCE_CHARS = 8_000_000;
const START_DELAY_MS = Math.max(0, Number.parseInt(process.env.JUSTTPRINT_GRID_THUMBNAIL_DELAY_MS || '20000', 10) || 0);
/** After the grid asked for a large original without a copy. */
const SOON_MS = 2000;

let readyFor = null;
function table() {
  const db = database.db;
  if (readyFor !== db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS grid_thumbnails (
        model_id INTEGER PRIMARY KEY,
        data_url TEXT,
        source_chars INTEGER NOT NULL,
        made_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS grid_thumbnails_changed AFTER UPDATE OF thumbnail ON models
        WHEN OLD.thumbnail IS NOT NEW.thumbnail
        BEGIN DELETE FROM grid_thumbnails WHERE model_id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS grid_thumbnails_removed AFTER DELETE ON models
        BEGIN DELETE FROM grid_thumbnails WHERE model_id = OLD.id; END;
    `);
    readyFor = db;
  }
  return db;
}

/** The first stored image when it is a data URL, else null. */
function firstImage(thumbnail) {
  if (typeof thumbnail !== 'string' || !thumbnail.startsWith('data:image')) return null;
  const end = thumbnail.indexOf('::');
  return end === -1 ? thumbnail : thumbnail.slice(0, end);
}

/**
 * @param {string | null | undefined} image
 * @returns {image is string}
 */
const needsCopy = (image) => !!image && image.length > SMALL_ENOUGH_CHARS;

/**
 * The grid's image for a model: { found, dataUrl }. found is false when there is no copy yet (or
 * the table is not there), and then the caller sends the original.
 */
function copyFor(filePath) {
  if (!database.db || !filePath) return { found: false, dataUrl: null };
  const row = table().prepare('SELECT g.data_url AS dataUrl FROM grid_thumbnails g JOIN models m ON m.id = g.model_id WHERE m.filePath = ?').get(filePath);
  return row ? { found: true, dataUrl: row.dataUrl } : { found: false, dataUrl: null };
}

/** Models whose first image is large and has no copy: { id, filePath }. */
function missing() {
  return table()
    .prepare(
      `SELECT m.id, m.filePath FROM models m LEFT JOIN grid_thumbnails g ON g.model_id = m.id
       WHERE g.model_id IS NULL AND m.thumbnail LIKE 'data:image%' AND octet_length(m.thumbnail) > ?
       ORDER BY m.id`
    )
    .all(SMALL_ENOUGH_CHARS);
}

/**
 * The copy of one image: a data URL, or null when it would not be smaller than the original.
 * Undefined when Chromium is not running.
 */
async function makeCopy(image, resize = thumbnailWorker.resizeImage) {
  const result = await resize(image, MAX_DIMENSION, QUALITY);
  if (!result) return undefined;
  return result.dataUrl && result.dataUrl.length < image.length ? result.dataUrl : null;
}

const state = { running: false, again: false };
/** @type {NodeJS.Timeout | null} */
let timer = null;

/**
 * Make the missing copies. Answers { made, failed, skipped } (skipped: Chromium not running).
 * @param {{ resize?: typeof thumbnailWorker.resizeImage }} [options] Tests pass their own resize.
 */
async function run({ resize } = {}) {
  if (state.running) {
    state.again = true;
    return { alreadyRunning: true };
  }
  if (!database.db) return { made: 0, failed: 0, skipped: 0 };
  state.running = true;
  let made = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const db = table();
    const read = db.prepare('SELECT thumbnail FROM models WHERE id = ?');
    const save = db.prepare('INSERT OR REPLACE INTO grid_thumbnails (model_id, data_url, source_chars, made_at) VALUES (?, ?, ?, ?)');
    for (const row of missing()) {
      if (db !== database.db) break; // The database was replaced (restore).
      const current = read.get(row.id);
      const image = current ? firstImage(current.thumbnail) : null;
      if (!image || !needsCopy(image) || image.length > MAX_SOURCE_CHARS) {
        if (image) save.run(row.id, null, image.length, new Date().toISOString());
        continue;
      }
      let copy;
      try {
        copy = await makeCopy(image, resize);
      } catch (error) {
        failed++;
        console.debug(`[Grid thumbnails] ${row.filePath}: ${error.message}`);
        copy = null; // Not decodable: the grid keeps the original.
      }
      if (copy === undefined) {
        skipped++;
        break;
      }
      // Only when the thumbnails did not change while the copy was being made.
      const after = read.get(row.id);
      if (!after || firstImage(after.thumbnail) !== image) continue;
      save.run(row.id, copy, image.length, new Date().toISOString());
      if (copy) made++;
    }
    if (made > 0) console.log(`[Grid thumbnails] Made ${made} small cop${made === 1 ? 'y' : 'ies'} of large thumbnails for the grid`);
  } finally {
    state.running = false;
    if (state.again) {
      state.again = false;
      schedule(SOON_MS);
    }
  }
  return { made, failed, skipped };
}

function schedule(delayMs) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    run().catch((error) => console.error('[Grid thumbnails]', error.message));
  }, delayMs);
  if (timer.unref) timer.unref();
}

/** First pass after the server starts (Chromium needs a moment). */
const scheduleAtStartup = () => schedule(START_DELAY_MS);

/**
 * The image to show for a model in the grid: its copy when there is one, else the first stored
 * image (loadOriginal() answers the thumbnail field), and a copy is made soon when that one is
 * large. Null when the model has none.
 */
function gridImage(filePath, loadOriginal) {
  const copy = copyFor(filePath);
  if (copy.dataUrl) return copy.dataUrl;
  const original = loadOriginal();
  if (!original) return null;
  const end = original.indexOf('::');
  const first = end === -1 ? original : original.slice(0, end);
  if (!copy.found && needsCopy(firstImage(first))) schedule(SOON_MS);
  return first || null;
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { MAX_DIMENSION, SMALL_ENOUGH_CHARS, copyFor, gridImage, run, scheduleAtStartup, stop, _internal: { makeCopy, missing, table } };
