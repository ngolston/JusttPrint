#!/usr/bin/env node
'use strict';

// 10.1 Phase 5 (docs/plan-10.1.md): QR labels anyone can scan, when an admin turns them on.

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const spools = require('../src/core/spools');
const locations = require('../src/core/storage-locations');
const labels = require('../src/server/label-pages');

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
    'CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'
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
const setPublic = (db, on) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('publicLabels', ?)").run(on ? 'true' : 'false');

test('off: labels open the spool in the app, places have none, and no token is made', () => {
  const db = fresh();
  const spool = spools.saveSpool(db, { material: 'PLA', initial_weight: 1000 });
  const shelf = locations.saveLocation(db, { name: 'Shelf' });
  assert.strictEqual(labels.labelsPublic(db), false);
  assert.deepStrictEqual(labels.labelLinks(db, { spoolIds: [spool.id], placeIds: [shelf.id] }), {
    public: false,
    spools: { [spool.id]: `/#/filament/${spool.id}` },
    places: { [shelf.id]: null }
  });
  assert.strictEqual(db.prepare('SELECT label_token FROM spools').get().label_token, null);
});

test('on: each spool and place gets a token once; unknown ids get nothing', () => {
  const db = fresh();
  setPublic(db, true);
  const spool = spools.saveSpool(db, { material: 'PLA', initial_weight: 1000 });
  const shelf = locations.saveLocation(db, { name: 'Shelf' });
  const first = labels.labelLinks(db, { spoolIds: [spool.id, 999, 'x'], placeIds: [shelf.id] });
  assert.match(first.spools[spool.id], /^\/l\/spool\/[A-Za-z0-9_-]{22}$/);
  assert.match(first.places[shelf.id], /^\/l\/place\/[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(first.spools[999], null);
  assert.ok(!('x' in first.spools));
  const again = labels.labelLinks(db, { spoolIds: [spool.id], placeIds: [shelf.id] });
  assert.deepStrictEqual([again.spools[spool.id], again.places[shelf.id]], [first.spools[spool.id], first.places[shelf.id]], 'the same token next time');
});

test("the spool's page: what is left and where, escaped; never its price, shop or notes", () => {
  const db = fresh();
  setPublic(db, true);
  const shelf = locations.saveLocation(db, { name: 'Shelf <2>' });
  const spool = spools.saveSpool(db, {
    name: 'Black <script>',
    brand_name: 'Bambu',
    material: 'PLA',
    color_hex: '#111111',
    initial_weight: 1000,
    remaining: 640,
    location_id: shelf.id,
    purchase_price: 19.99,
    supplier: 'SecretShop',
    notes: 'private note'
  });
  const token = labels.tokenFor(db, 'spool', spool.id);
  const html = labels.spoolPage(db, token);
  assert.match(html, /Black &lt;script&gt;/);
  assert.ok(!/<script>/.test(html));
  assert.match(html, /640 g/);
  assert.match(html, /left of 1 kg \(64%\)/);
  assert.match(html, /Shelf &lt;2&gt;/);
  assert.ok(!/19\.99|SecretShop|private note/.test(html), 'no price, shop or notes');
  assert.match(html, new RegExp(`href="/#/filament/${spool.id}">Sign in to edit`));
  assert.strictEqual(labels.spoolPage(db, 'A'.repeat(22)), null);
});

test("the place's page lists the spools in it, each linking to its own page", () => {
  const db = fresh();
  setPublic(db, true);
  const box = locations.saveLocation(db, { name: 'Dry box A', is_dry_box: true });
  spools.saveSpool(db, { name: 'Teal', material: 'PETG', initial_weight: 1000, remaining: 300, location_id: box.id });
  spools.saveSpool(db, { name: 'Elsewhere', material: 'PLA', initial_weight: 1000 });
  spools.saveSpool(db, { name: 'Used up', material: 'PLA', initial_weight: 1000, location_id: box.id, status: 'archived' });
  const html = labels.placePage(db, labels.tokenFor(db, 'place', box.id));
  assert.match(html, /Dry box · 1 spool/);
  assert.match(html, /Teal/);
  assert.ok(!/Elsewhere|Used up/.test(html));
  assert.match(html, /href="\/l\/spool\/[A-Za-z0-9_-]{22}"/);
});
