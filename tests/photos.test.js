#!/usr/bin/env node
'use strict';

// 10.1 Phase 2 (docs/plan-10.1.md): photos of spools, filaments and logged prints: kept as files
// next to the database, checked by their bytes, replaced and swept away with what they belong to.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-photos-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const photos = require('../src/server/photos');
const spools = require('../src/core/spools');
const profiles = require('../src/core/filament-profiles');
const printEvents = require('../src/core/print-events');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const fresh = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT, print_status TEXT, print_count INTEGER DEFAULT 0, dateAdded TEXT)'
  );
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  return db;
};

// The smallest pictures of each kind: their first bytes are what counts.
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64')}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]).toString('base64');
const files = (kind) => {
  try {
    return fs.readdirSync(photos.dirFor(kind)).sort();
  } catch (_) {
    return [];
  }
};

test('pictures are checked by their bytes, not their name', () => {
  assert.deepStrictEqual([photos.decode(PNG).ext, photos.decode(JPEG).ext], ['png', 'jpg']);
  assert.throws(() => photos.decode(`data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`), /not a JPEG, PNG, WebP or GIF/);
  assert.throws(() => photos.decode(''), /No picture/);
  assert.throws(() => photos.decode('A'.repeat(21 * 1024 * 1024)), /too large/);
  assert.strictEqual(photos.remove('spool', '../justtprint.db'), false, 'only names it made');
});

test("a spool's photo: upload, then a link (the file goes), then none; saving the spool keeps it", () => {
  const db = fresh();
  const spool = spools.saveSpool(db, { material: 'PLA', initial_weight: 1000, color_hex: '#ff0000', color_hex_2: '#0000ff' });
  photos.setPhoto(db, 'spool', spool.id, { dataUrl: PNG });
  const uploaded = spools.getSpool(db, spool.id);
  assert.match(uploaded.photo, /^\/api\/photo\/spool\/[a-f0-9]{32}\.png$/);
  assert.deepStrictEqual(files('spool'), [uploaded.photo_file]);
  spools.saveSpool(db, { id: spool.id, material: 'PLA', notes: 'edited' });
  const edited = spools.getSpool(db, spool.id);
  assert.deepStrictEqual([edited.photo, edited.color_hex_2], [uploaded.photo, '#0000ff'], 'an edit without them keeps the photo and the second color');
  photos.setPhoto(db, 'spool', spool.id, { url: 'https://example.com/spool.jpg' });
  assert.deepStrictEqual([spools.getSpool(db, spool.id).photo, files('spool')], ['https://example.com/spool.jpg', []]);
  assert.throws(() => photos.setPhoto(db, 'spool', spool.id, { url: 'javascript:alert(1)' }), /http/);
  spools.saveSpool(db, { id: spool.id, material: 'PLA' });
  assert.strictEqual(spools.getSpool(db, spool.id).photo, 'https://example.com/spool.jpg', 'a link stays too');
  photos.setPhoto(db, 'spool', spool.id, null);
  assert.strictEqual(spools.getSpool(db, spool.id).photo, null);
  assert.throws(() => photos.setPhoto(db, 'spool', 999, null), /no longer exists/);
});

test("a filament's photo, and a deleted filament's file is swept", () => {
  const db = fresh();
  const profile = profiles.saveProfile(db, { material: 'PETG', brand_name: 'Prusament' });
  photos.setPhoto(db, 'filament', profile.id, { dataUrl: JPEG });
  const withPhoto = profiles.getProfile(db, profile.id);
  assert.match(withPhoto.photo, /^\/api\/photo\/filament\/[a-f0-9]{32}\.jpg$/);
  profiles.saveProfile(db, { id: profile.id, material: 'PETG', name: 'Galaxy Black' });
  assert.strictEqual(profiles.getProfile(db, profile.id).photo, withPhoto.photo, 'an edit keeps it');
  assert.strictEqual(profiles.listProfiles(db)[0].photo, withPhoto.photo);
  profiles.deleteProfile(db, profile.id);
  assert.strictEqual(files('filament').length, 1);
  assert.strictEqual(photos.sweep(db), 1);
  assert.deepStrictEqual(files('filament'), []);
});

test("a logged print's photos: added, listed with the print, deleted, and gone with the print", () => {
  const db = fresh();
  const modelId = Number(db.prepare("INSERT INTO models (filePath, fileName, dateAdded) VALUES ('/lib/a.3mf', 'a.3mf', '2026-01-01')").run().lastInsertRowid);
  const at = new Date().toISOString();
  const eventId = Number(
    db.prepare("INSERT INTO print_events (model_id, printed_at, outcome, quantity, created_at) VALUES (?, ?, 'printed', 1, ?)").run(modelId, at, at)
      .lastInsertRowid
  );
  const first = photos.addPrintPhoto(db, eventId, { dataUrl: PNG, caption: '  First layer  ' });
  photos.addPrintPhoto(db, eventId, { dataUrl: JPEG });
  assert.strictEqual(first.caption, 'First layer');
  const listed = printEvents.getPrintEvents(db, modelId)[0].photos;
  assert.deepStrictEqual(
    listed.map((p) => [p.id, p.caption]),
    [
      [first.id, 'First layer'],
      [first.id + 1, null]
    ]
  );
  assert.ok(photos.deletePrintPhoto(db, first.id));
  assert.strictEqual(files('print').length, 1);
  assert.throws(() => photos.addPrintPhoto(db, 999, { dataUrl: PNG }), /no longer exists/);
  for (let i = 0; i < 11; i += 1) photos.addPrintPhoto(db, eventId, { dataUrl: PNG });
  assert.throws(() => photos.addPrintPhoto(db, eventId, { dataUrl: PNG }), /12 photos at most/);
  db.prepare('DELETE FROM print_events WHERE id = ?').run(eventId);
  photos.sweep(db);
  assert.deepStrictEqual(files('print'), []);
});

(async () => {
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`ok ${name}`);
      } catch (err) {
        console.error(`FAIL ${name}:`, err.stack || err.message);
        process.exitCode = 1;
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
