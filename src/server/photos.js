'use strict';

/**
 * Photos of spools, filaments and logged prints (docs/plan-10.1.md, Phase 2). They are files in
 * `photos/<kind>/` next to the database (on the data volume, as `versions/` is), named at random,
 * and served to signed-in browsers at /api/photo/<kind>/<name>. The browser shrinks a picture
 * before it sends it (data URL); the server checks it is a JPEG, PNG, WebP or GIF by its bytes.
 * Files nothing points at any more (a deleted spool, filament or print) are swept away.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDatabasePath } = require('../core/db-path');

const KINDS = ['spool', 'filament', 'print'];
const MAX_BYTES = 15 * 1024 * 1024;
const NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** @param {string} kind */
function dirFor(kind) {
  if (!KINDS.includes(kind)) throw new Error('Unknown photo kind');
  return path.join(path.dirname(getDatabasePath()), 'photos', kind);
}

/** Where a browser gets the photo. */
const urlOf = (kind, name) => (name ? `/api/photo/${kind}/${name}` : null);

/** The picture's type from its first bytes, or null when it is not one we keep. */
function sniff(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length > 6 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'gif';
  return null;
}

/** A data URL (or bare base64) → the picture's bytes and type. Throws for anything else. */
function decode(dataUrl) {
  const text = String(dataUrl || '');
  const base64 = text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text;
  if (!base64) throw new Error('No picture was sent');
  if (base64.length > Math.ceil((MAX_BYTES * 4) / 3) + 4) throw new Error('The picture is too large (15 MB at most)');
  const buffer = Buffer.from(base64, 'base64');
  const ext = sniff(buffer);
  if (!ext) throw new Error('That is not a JPEG, PNG, WebP or GIF picture');
  return { buffer, ext };
}

/** Keep a picture; returns its file name. */
function save(kind, dataUrl) {
  const { buffer, ext } = decode(dataUrl);
  const dir = dirFor(kind);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return name;
}

/** Delete one photo file (a name we made; anything else is left alone). */
function remove(kind, name) {
  if (!name || !NAME.test(name)) return false;
  try {
    fs.unlinkSync(path.join(dirFor(kind), name));
    return true;
  } catch (_) {
    return false;
  }
}

const TABLES = { spool: 'spools', filament: 'filament_profiles' };

/**
 * Set a spool's or filament's photo: an uploaded picture (`dataUrl`), a link (`url`), or none.
 * The file it replaces is deleted.
 * @param {any} db
 * @param {'spool' | 'filament'} kind
 * @param {number} id
 * @param {{ dataUrl?: string, url?: string } | null} photo
 */
function setPhoto(db, kind, id, photo) {
  const table = TABLES[kind];
  if (!table) throw new Error('Unknown photo kind');
  const row = db.prepare(`SELECT photo_file FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new Error(kind === 'spool' ? 'That spool no longer exists' : 'That filament no longer exists');
  /** @type {string | null} */
  let file = null;
  /** @type {string | null} */
  let url = null;
  if (photo && photo.dataUrl) file = save(kind, photo.dataUrl);
  else if (photo && photo.url) {
    url = require('../core/filament-values').url(photo.url);
    if (!url) throw new Error('A photo link starts with http:// or https://');
  }
  db.prepare(`UPDATE ${table} SET photo_file = ?, photo_url = ?, updated_at = ? WHERE id = ?`).run(file, url, new Date().toISOString(), id);
  if (row.photo_file && row.photo_file !== file) remove(kind, row.photo_file);
}

const MAX_PRINT_PHOTOS = 12;

/**
 * Add a photo to a logged print. Returns its row as the print history shows it.
 * @param {any} db
 * @param {number} eventId
 * @param {{ dataUrl?: string, caption?: string | null }} photo
 */
function addPrintPhoto(db, eventId, photo) {
  if (!db.prepare('SELECT 1 FROM print_events WHERE id = ?').get(eventId)) throw new Error('That logged print no longer exists');
  if (db.prepare('SELECT COUNT(*) AS n FROM print_event_photos WHERE event_id = ?').get(eventId).n >= MAX_PRINT_PHOTOS) {
    throw new Error(`A print keeps ${MAX_PRINT_PHOTOS} photos at most`);
  }
  const file = save('print', photo && photo.dataUrl);
  const caption = photo && photo.caption ? String(photo.caption).trim().slice(0, 300) || null : null;
  const id = Number(
    db
      .prepare('INSERT INTO print_event_photos (event_id, file_path, caption, created_at) VALUES (?, ?, ?, ?)')
      .run(eventId, file, caption, new Date().toISOString()).lastInsertRowid
  );
  return { id, url: urlOf('print', file), caption };
}

/** Delete a print's photo and its file. */
function deletePrintPhoto(db, photoId) {
  const row = db.prepare('SELECT file_path FROM print_event_photos WHERE id = ?').get(photoId);
  if (!row) return false;
  db.prepare('DELETE FROM print_event_photos WHERE id = ?').run(photoId);
  remove('print', row.file_path);
  return true;
}

/** The file names the database still points at, per kind. */
function referenced(db) {
  const names = (sql) => {
    try {
      return new Set(
        db
          .prepare(sql)
          .all()
          .map((row) => row.name)
      );
    } catch (_) {
      return new Set();
    }
  };
  return {
    spool: names('SELECT photo_file AS name FROM spools WHERE photo_file IS NOT NULL'),
    filament: names('SELECT photo_file AS name FROM filament_profiles WHERE photo_file IS NOT NULL'),
    print: names('SELECT file_path AS name FROM print_event_photos')
  };
}

/** Delete the photo files nothing points at. Returns how many went. */
function sweep(db) {
  const keep = referenced(db);
  let removed = 0;
  for (const kind of KINDS) {
    /** @type {string[]} */
    let files;
    try {
      files = fs.readdirSync(dirFor(kind));
    } catch (_) {
      continue;
    }
    for (const name of files) if (NAME.test(name) && !keep[kind].has(name) && remove(kind, name)) removed += 1;
  }
  return removed;
}

/** @type {NodeJS.Timeout | null} */
let sweepTimer = null;
/** Sweep a little later (after a delete); repeated calls meanwhile make one sweep. */
function sweepSoon(delay = 5000) {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    try {
      const db = require('../core/database').db;
      if (db) sweep(db);
    } catch (error) {
      console.warn('[Photos] Sweep failed:', error.message);
    }
  }, delay);
  if (sweepTimer.unref) sweepTimer.unref();
}

/** GET /api/photo/<kind>/<name>, for anyone signed in (http.js registers it after requireAuth). */
function registerPhotoRoutes(app) {
  app.get('/api/photo/:kind/:name', (req, res) => {
    const { kind, name } = req.params;
    if (!KINDS.includes(kind) || !NAME.test(name)) return res.status(404).end();
    const ext = /** @type {keyof typeof TYPES} */ (name.split('.').pop());
    // Names are never reused, so a browser may keep the picture.
    res.sendFile(
      path.join(dirFor(kind), name),
      { headers: { 'Content-Type': TYPES[ext], 'Cache-Control': 'private, max-age=31536000, immutable' } },
      (error) => {
        if (error && !res.headersSent) res.status(404).end();
      }
    );
  });
}

module.exports = { KINDS, dirFor, urlOf, sniff, decode, save, remove, setPhoto, addPrintPhoto, deletePrintPhoto, sweep, sweepSoon, registerPhotoRoutes };
