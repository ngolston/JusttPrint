'use strict';

/**
 * Galleries over the load limit. A model's stored images are not loaded when the list is longer
 * than THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS, and the startup safeguard used to clear such lists: a
 * MakerWorld model with ~26 large pictures lost all of them on the next start. Instead, such a list is brought under the limit here, only as
 * much as needed: the largest pictures first, at the gentlest size first (2048 px), each reduced
 * from its original, stopping as soon as the list fits. The pictures keep their number and order;
 * a list that fits is never touched. Without Chromium nothing changes and the list waits.
 * Animations (GIF, WebP, APNG) are never reduced: Chromium would keep only their first frame (a
 * 239-frame GIF would become a still picture); the still pictures shrink instead.
 *
 * Models to do are kept in oversized_thumbnails by triggers (cheap: the length of the value
 * being written), so new downloads are found without reading every model's pictures.
 */

const database = require('../core/database');
const thumbnailWorker = require('./thumbnail-worker');
const { THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS } = require('../core/thumbnails');

/** A list is made to fit this share of the limit, so a small later change does not tip it over. */
const TARGET_RATIO = 0.95;
/** Sizes tried, gentlest first (longest side, px), at the grid copies' quality. */
const DIMENSIONS = [2048, 1600, 1280, 1024, 800, 640];
const QUALITY = 0.85;
/** Longer than this is a runaway value, not a gallery: the startup safeguard still clears it. */
const HARD_MAX_CHARS = 64_000_000;
const START_DELAY_MS = 60000;
const CHECK_EVERY_MS = 2 * 60000;

let readyFor = null;
function ensureTable(db = database.db, { limit = THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS } = {}) {
  if (readyFor === db) return db;
  const n = Number(limit);
  db.exec(`
    CREATE TABLE IF NOT EXISTS oversized_thumbnails (model_id INTEGER PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS oversized_thumbnails_insert AFTER INSERT ON models
      WHEN length(NEW.thumbnail) > ${n}
      BEGIN INSERT OR IGNORE INTO oversized_thumbnails (model_id) VALUES (NEW.id); END;
    CREATE TRIGGER IF NOT EXISTS oversized_thumbnails_update AFTER UPDATE OF thumbnail ON models
      BEGIN
        DELETE FROM oversized_thumbnails WHERE model_id = NEW.id AND (NEW.thumbnail IS NULL OR length(NEW.thumbnail) <= ${n});
        INSERT OR IGNORE INTO oversized_thumbnails (model_id) SELECT NEW.id WHERE length(NEW.thumbnail) > ${n};
      END;
    CREATE TRIGGER IF NOT EXISTS oversized_thumbnails_delete AFTER DELETE ON models
      BEGIN DELETE FROM oversized_thumbnails WHERE model_id = OLD.id; END;
  `);
  readyFor = db;
  return db;
}

/**
 * Whether a data URL holds an animation: a GIF that loops (NETSCAPE2.0) or has more than one frame
 * (graphic control blocks), a WebP with an ANIM chunk, a PNG with an acTL chunk (APNG).
 */
function isAnimated(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const type = dataUrl.slice(5, comma);
  if (!type.endsWith(';base64')) return false;
  if (type.startsWith('image/gif')) {
    const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    if (bytes.includes('NETSCAPE2.0')) return true;
    const frame = Buffer.from([0x21, 0xf9, 0x04]);
    const first = bytes.indexOf(frame);
    return first !== -1 && bytes.indexOf(frame, first + 3) !== -1;
  }
  // The chunk names sit near the start: enough to decode the first few hundred bytes.
  const head = Buffer.from(dataUrl.slice(comma + 1, comma + 1 + 400), 'base64');
  if (type.startsWith('image/webp')) return head.includes('ANIM');
  if (type.startsWith('image/png')) return head.includes('acTL');
  return false;
}

/**
 * The list brought under the target: a string, null when it cannot be (pictures that do not
 * decode or do not get smaller, or only animations left), or undefined when Chromium is not running.
 */
async function shrink(thumbnail, resize, limit) {
  const target = Math.floor(limit * TARGET_RATIO);
  const originals = thumbnail.split('::');
  const parts = originals.slice();
  let total = thumbnail.length;
  if (total <= target) return thumbnail;
  // Largest first; only data URLs are pictures (a path or '3d.png' stays as it is), and animations stay whole.
  const order = originals
    .map((part, i) => ({ i, len: part.length }))
    .filter(({ i }) => originals[i].startsWith('data:image') && !isAnimated(originals[i]))
    .sort((a, b) => b.len - a.len)
    .map(({ i }) => i);
  const broken = new Set();
  for (const max of DIMENSIONS) {
    for (const i of order) {
      if (broken.has(i)) continue;
      let result;
      try {
        result = await resize(originals[i], max, QUALITY);
      } catch (error) {
        broken.add(i); // Not decodable: this picture stays as it is.
        console.debug(`[Oversized thumbnails] a picture could not be decoded: ${error.message}`);
        continue;
      }
      if (!result) return undefined;
      if (!result.dataUrl || result.dataUrl.length >= parts[i].length) continue;
      total -= parts[i].length - result.dataUrl.length;
      parts[i] = result.dataUrl;
      if (total <= target) return parts.join('::');
    }
  }
  return null;
}

const state = { running: false };

/**
 * Bring the marked lists under the limit. Answers { shrunk, failed, skipped } (skipped: Chromium
 * not running; failed: could not be made to fit, left as it is until it changes or the next start).
 * @param {{ resize?: typeof thumbnailWorker.resizeImage, limit?: number }} [options] Tests pass their own.
 */
async function run({ resize = thumbnailWorker.resizeImage, limit = THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS } = {}) {
  if (state.running || !database.db) return { shrunk: 0, failed: 0, skipped: 0 };
  state.running = true;
  let shrunk = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const db = ensureTable(database.db, { limit });
    const ids = db
      .prepare('SELECT model_id FROM oversized_thumbnails ORDER BY model_id')
      .all()
      .map((r) => r.model_id);
    const read = db.prepare('SELECT thumbnail FROM models WHERE id = ?');
    const unmark = db.prepare('DELETE FROM oversized_thumbnails WHERE model_id = ?');
    // Saved only when the list did not change while it was being reduced.
    const save = db.prepare('UPDATE models SET thumbnail = ? WHERE id = ? AND thumbnail = ?');
    for (const id of ids) {
      if (db !== database.db) break; // The database was replaced (restore).
      const row = read.get(id);
      const thumbnail = row && row.thumbnail;
      if (!thumbnail || thumbnail.length <= limit || thumbnail.length > HARD_MAX_CHARS) {
        unmark.run(id);
        continue;
      }
      const result = await shrink(thumbnail, resize, limit);
      if (result === undefined) {
        skipped++;
        break;
      }
      if (result === null) {
        failed++;
        unmark.run(id); // Tried again when the list changes, or at the next start.
        console.warn(`[Oversized thumbnails] model ${id}: its ${thumbnail.split('::').length} pictures could not be brought under the limit; left as they are`);
        continue;
      }
      if (save.run(result, id, thumbnail).changes) {
        shrunk++;
        console.log(
          `[Oversized thumbnails] model ${id}: pictures reduced from ${thumbnail.length} to ${result.length} characters to fit the limit (none removed)`
        );
      }
    }
  } finally {
    state.running = false;
  }
  return { shrunk, failed, skipped };
}

/** Lists over the limit and under the runaway ceiling, marked at startup (the triggers do the rest). */
function markExisting(db = database.db, { limit = THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS, hardMax = HARD_MAX_CHARS } = {}) {
  ensureTable(db, { limit });
  return db
    .prepare('INSERT OR IGNORE INTO oversized_thumbnails (model_id) SELECT id FROM models WHERE octet_length(thumbnail) > ? AND octet_length(thumbnail) <= ?')
    .run(limit, hardMax).changes;
}

/** In the background: first after Chromium has had time to start, then whenever something is marked. */
function start() {
  const tick = () => {
    if (!database.db) return;
    const pending = ensureTable(database.db).prepare('SELECT 1 FROM oversized_thumbnails LIMIT 1').get();
    if (pending) run().catch((error) => console.error('[Oversized thumbnails]', error.message));
  };
  setTimeout(tick, START_DELAY_MS).unref?.();
  setInterval(tick, CHECK_EVERY_MS).unref?.();
}

module.exports = { TARGET_RATIO, DIMENSIONS, HARD_MAX_CHARS, ensureTable, markExisting, run, start, _internal: { shrink, isAnimated } };
