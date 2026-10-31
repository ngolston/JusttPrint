#!/usr/bin/env node
'use strict';

// Filament (docs/merge-10.md, Phase 3): profiles and brands, the bundled catalogue, spools
// (save, weigh, move, archive, delete, summary), places, drying and the Spoolman import.

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const profiles = require('../src/core/filament-profiles');
const spools = require('../src/core/spools');
const locations = require('../src/core/storage-locations');
const drying = require('../src/core/drying');
const { importSpoolman, unflatten } = require('../src/core/spoolman-import');
const values = require('../src/core/filament-values');

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
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT)');
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  return db;
};

test('values: colors, numbers and base materials are cleaned up', () => {
  assert.strictEqual(values.color('ABC'), '#aabbcc');
  assert.strictEqual(values.color('#2F6FDF'), '#2f6fdf');
  assert.strictEqual(values.color('blue'), null);
  assert.strictEqual(values.number('', 'x'), null);
  assert.throws(() => values.number('abc', 'Weight'), /Weight must be a number/);
  assert.throws(() => values.number(-1, 'Weight', { min: 0 }), /at least 0/);
  assert.strictEqual(values.baseMaterial('PLA+/Pro Silk'), 'PLA');
  assert.strictEqual(values.url('javascript:alert(1)'), null);
});

test('profiles: a brand is made once (any case) and a profile needs a material', () => {
  const db = fresh();
  const a = profiles.saveProfile(db, { brand_name: 'Bambu Lab', material: 'PLA', color_name: 'Black', color_hex: '111111' });
  const b = profiles.saveProfile(db, { brand_name: 'bambu lab', material: 'PETG', name: 'PETG HF Gray' });
  assert.strictEqual(a.brand_id, b.brand_id);
  assert.strictEqual(a.name, 'PLA Black');
  assert.strictEqual(a.color_hex, '#111111');
  assert.strictEqual(a.diameter, 1.75);
  assert.throws(() => profiles.saveProfile(db, { name: 'Mystery' }), /material/);
  assert.deepStrictEqual(
    profiles.listProfiles(db, { search: 'gray' }).map((p) => p.name),
    ['PETG HF Gray']
  );
  assert.strictEqual(profiles.listProfiles(db, { search: '100%' }).length, 0, 'LIKE wildcards are escaped');
  const renamed = profiles.saveProfile(db, { id: a.id, brand_id: a.brand_id, material: 'PLA', name: 'PLA Basic Black' });
  assert.strictEqual(renamed.name, 'PLA Basic Black');
  assert.strictEqual(profiles.listBrands(db)[0].profile_count, 2);
});

test('catalogue: search by words, add an entry once as a catalogue profile', () => {
  const db = fresh();
  const found = profiles.searchCatalog('bambu pla basic black');
  assert.ok(found.total >= 1, 'Bambu PLA Basic Black is in the catalogue');
  const entry = found.items[0];
  assert.strictEqual(entry.search, undefined, 'search text stays on the server');
  assert.strictEqual(profiles.searchCatalog('').total, 0);
  assert.ok(profiles.searchCatalog('pla', { limit: 5 }).items.length === 5);
  const first = profiles.addFromCatalog(db, entry.id);
  assert.strictEqual(first.profile.source, 'catalog');
  assert.strictEqual(first.profile.material, 'PLA');
  assert.strictEqual(first.materialType, entry.material);
  assert.strictEqual(first.profile.brand_name, entry.brand);
  const again = profiles.addFromCatalog(db, entry.id);
  assert.strictEqual(again.profile.id, first.profile.id);
  assert.throws(() => profiles.addFromCatalog(db, 'nope'), /not in the catalogue/);
});

test('spools: material and color come from the profile; grams left set the grams used', () => {
  const db = fresh();
  const profile = profiles.saveProfile(db, { brand_name: 'eSun', material: 'PLA', color_name: 'White', color_hex: '#f5f5f0' });
  const spool = spools.saveSpool(db, { profile_id: profile.id, initial_weight: 1000, remaining: 260, spool_weight: 220 }, { userId: 7 });
  assert.strictEqual(spool.material, 'PLA');
  assert.strictEqual(spool.color_hex, '#f5f5f0');
  assert.strictEqual(spool.used_weight, 740);
  assert.strictEqual(spool.remaining, 260);
  assert.strictEqual(spool.status, 'storage');
  assert.strictEqual(spool.created_by, 7);
  assert.strictEqual(spool.display_name, 'PLA White');
  assert.throws(() => spools.saveSpool(db, { material: 'PLA' }), /how much filament/);
  assert.throws(() => spools.saveSpool(db, { initial_weight: 1000 }), /material/);
  assert.throws(() => spools.saveSpool(db, { material: 'PLA', initial_weight: 1000, status: 'lost' }), /status/);
  const edited = spools.saveSpool(db, { id: spool.id, profile_id: profile.id, name: 'Shelf white', status: 'active' });
  assert.strictEqual(edited.name, 'Shelf white');
  assert.strictEqual(edited.remaining, 260, 'grams used stay when the form leaves them out');
});

test('weighing: with the spool, the filament alone, and a spool heavier than it was said to hold', () => {
  const db = fresh();
  const spool = spools.saveSpool(db, { material: 'PETG', initial_weight: 1000, spool_weight: 200 });
  let weighed = spools.weighSpool(db, spool.id, { weight: 840, withSpool: true, notes: 'after the bezel' });
  assert.strictEqual(weighed.remaining, 640);
  assert.strictEqual(weighed.weighings[0].net_weight, 640);
  assert.strictEqual(weighed.weighings[0].measured_weight, 840);
  weighed = spools.weighSpool(db, spool.id, { weight: 1100, withSpool: false });
  assert.strictEqual(weighed.initial_weight, 1100);
  assert.strictEqual(weighed.remaining, 1100);
  const bare = spools.saveSpool(db, { material: 'PLA', initial_weight: 1000 });
  assert.throws(() => spools.weighSpool(db, bare.id, { weight: 500 }), /empty spool's weight/);
  assert.strictEqual(spools.weighSpool(db, bare.id, { weight: 500, withSpool: false }).remaining, 500);
});

test('places: unique names, spools move between them, deleting one leaves its spools in no place', () => {
  const db = fresh();
  const shelf = locations.saveLocation(db, { name: 'Shelf 2' }, { userId: 1 });
  const box = locations.saveLocation(db, { name: 'Dry box A', is_dry_box: true });
  assert.throws(() => locations.saveLocation(db, { name: 'shelf 2' }), /already a place/);
  const spool = spools.saveSpool(db, { material: 'PLA', initial_weight: 1000, location_id: shelf.id });
  assert.strictEqual(spool.location_name, 'Shelf 2');
  assert.strictEqual(spools.moveSpool(db, spool.id, box.id).location_name, 'Dry box A');
  assert.strictEqual(locations.listLocations(db).find((l) => l.id === box.id).spool_count, 1);
  locations.deleteLocation(db, box.id);
  assert.strictEqual(spools.getSpool(db, spool.id).location_id, null);
  assert.throws(() => spools.moveSpool(db, spool.id, 999), /no longer exists/);
});

test('archiving takes a spool out of printers and the dryer; bringing it back puts it in storage', () => {
  const db = fresh();
  const now = new Date().toISOString();
  const spool = spools.saveSpool(db, { material: 'PLA', initial_weight: 1000, color_hex: '#111111' });
  const printer = db.prepare('INSERT INTO printers (nickname, created_at, updated_at) VALUES (?, ?, ?)').run('P1S', now, now).lastInsertRowid;
  const unit = db.prepare('INSERT INTO printer_ams_units (printer_id, unit_index) VALUES (?, 0)').run(printer).lastInsertRowid;
  db.prepare('INSERT INTO printer_ams_slots (unit_id, slot_index, spool_id) VALUES (?, 3, ?)').run(unit, spool.id);
  assert.deepStrictEqual(
    spools.getSpool(db, spool.id).loaded.map((place) => place.label),
    ['P1S · A4']
  );
  drying.startDrying(db, spool.id, { drying_temp: 50, target_hours: 4 });
  const archived = spools.archiveSpool(db, spool.id, true);
  assert.strictEqual(archived.status, 'archived');
  assert.deepStrictEqual(archived.loaded, []);
  assert.strictEqual(archived.drying, null);
  assert.strictEqual(spools.archiveSpool(db, spool.id, false).status, 'storage');
  assert.strictEqual(spools.deleteSpool(db, spool.id), true);
  assert.strictEqual(spools.getSpool(db, spool.id), null);
});

test('drying: defaults from the filament, one session at a time, finished once', () => {
  const db = fresh();
  const profile = profiles.saveProfile(db, { material: 'TPU', name: 'TPU 95A Clear', drying_temp: 50, drying_hours: 6 });
  const spool = spools.saveSpool(db, { profile_id: profile.id, initial_weight: 1000 });
  const session = drying.startDrying(db, spool.id, { humidity_before: 38 });
  assert.strictEqual(session.drying_temp, 50);
  assert.strictEqual(session.target_hours, 6);
  assert.throws(() => drying.startDrying(db, spool.id, {}), /already drying/);
  assert.strictEqual(spools.getSpool(db, spool.id).drying.id, session.id);
  assert.strictEqual(drying.listActiveDrying(db)[0].profile_name, 'TPU 95A Clear');
  const done = drying.finishDrying(db, session.id, { humidity_after: 12 });
  assert.ok(done.finished_at);
  assert.strictEqual(done.humidity_after, 12);
  assert.throws(() => drying.finishDrying(db, session.id), /already finished/);
  const plain = spools.saveSpool(db, { material: 'PLA', initial_weight: 1000 });
  assert.throws(() => drying.startDrying(db, plain.id, {}), /temperature and time/);
});

test('summary: grams, low spools and materials, without archived spools', () => {
  const db = fresh();
  spools.saveSpool(db, { material: 'PLA', initial_weight: 1000, remaining: 720, color_hex: '#2f6fdf' });
  spools.saveSpool(db, { material: 'PLA', initial_weight: 1000, remaining: 18, color_hex: '#111111' });
  spools.saveSpool(db, { material: 'PETG', initial_weight: 1000, remaining: 640 });
  spools.saveSpool(db, { material: 'ABS', initial_weight: 1000, status: 'archived' });
  const summary = spools.filamentSummary(db);
  assert.strictEqual(summary.spoolCount, 3);
  assert.strictEqual(summary.grams, 1378);
  assert.strictEqual(summary.lowCount, 1);
  assert.strictEqual(summary.archivedCount, 1);
  assert.deepStrictEqual(summary.materials, [
    { material: 'PLA', grams: 738 },
    { material: 'PETG', grams: 640 }
  ]);
  assert.strictEqual(summary.colors.length, 2);
  assert.strictEqual(spools.listSpools(db, { includeArchived: false }).length, 3);
  assert.strictEqual(spools.listSpools(db)[3].status, 'archived', 'archived spools come last');
});

test('Spoolman: nested and flattened exports, vendors, filaments and places, and no double import', () => {
  const db = fresh();
  const nested = [
    {
      id: 4,
      registered: '2025-01-02T10:00:00Z',
      first_used: '2025-02-01T10:00:00Z',
      used_weight: 360,
      initial_weight: 1000,
      spool_weight: 210,
      location: 'Shelf 1',
      lot_nr: 'L42',
      comment: 'opened',
      archived: false,
      filament: {
        id: 9,
        name: 'PolyTerra Charcoal',
        material: 'PLA',
        color_hex: '333333',
        weight: 1000,
        settings_extruder_temp: 210,
        vendor: { name: 'Polymaker' }
      }
    },
    { id: 5, remaining_weight: 100, archived: true, filament: { id: 9, name: 'PolyTerra Charcoal', material: 'PLA', vendor: { name: 'Polymaker' } } }
  ];
  const flat = [
    {
      id: 6,
      'filament.id': 10,
      'filament.name': 'Dual Silk',
      'filament.material': 'PLA',
      'filament.multi_color_hexes': 'ff0000,0000ff',
      'filament.vendor.name': 'polymaker',
      remaining_weight: 900,
      'filament.weight': 1000
    }
  ];
  assert.deepStrictEqual(unflatten({ 'a.b.c': 1, x: 2 }), { a: { b: { c: 1 } }, x: 2 });

  const first = importSpoolman(db, nested, { userId: 3 });
  assert.deepStrictEqual(
    { ...first, problems: undefined },
    { imported: 2, alreadyHere: 0, skipped: 0, problems: undefined, brands: 1, profiles: 1, locations: 1 }
  );
  const second = importSpoolman(db, { spools: [...nested, ...flat] });
  assert.strictEqual(second.imported, 1);
  assert.strictEqual(second.alreadyHere, 2);
  assert.strictEqual(second.brands, 0, 'the vendor is matched in any case');

  const list = spools.listSpools(db);
  const charcoal = list.find((s) => s.source_ref === 'spoolman:4');
  assert.strictEqual(charcoal.remaining, 640);
  assert.strictEqual(charcoal.location_name, 'Shelf 1');
  assert.strictEqual(charcoal.color_hex, '#333333');
  assert.strictEqual(charcoal.registered_at, '2025-01-02T10:00:00.000Z');
  assert.strictEqual(charcoal.created_by, 3);
  assert.strictEqual(list.find((s) => s.source_ref === 'spoolman:5').status, 'archived');
  const dual = list.find((s) => s.source_ref === 'spoolman:6');
  assert.deepStrictEqual([dual.color_hex, dual.color_hex_2], ['#ff0000', '#0000ff']);
  assert.throws(() => importSpoolman(db, { hello: 1 }), /not a Spoolman export/);
});

test('brands (10.1): rename, rename onto another to merge, delete; profiles and spools follow', () => {
  const db = fresh();
  const pla = profiles.saveProfile(db, { brand_name: 'Bambu', material: 'PLA', color_name: 'Black' });
  const petg = profiles.saveProfile(db, { brand_name: 'bambu lab', material: 'PETG' });
  const spool = spools.saveSpool(db, { profile_id: pla.id, brand_name: 'bambu lab', material: 'PLA', initial_weight: 1000 });
  const [bambu, bambuLab] = ['Bambu', 'bambu lab'].map((name) => profiles.listBrands(db).find((b) => b.name === name));
  assert.throws(() => profiles.saveBrand(db, { id: bambu.id, name: ' ' }), /needs a name/);
  const renamed = profiles.saveBrand(db, { id: bambuLab.id, name: 'Bambu Lab', website: 'https://bambulab.com' });
  assert.deepStrictEqual([renamed.name, renamed.website, renamed.merged], ['Bambu Lab', 'https://bambulab.com', false]);
  const merged = profiles.saveBrand(db, { id: bambu.id, name: 'BAMBU LAB' });
  assert.deepStrictEqual([merged.id, merged.name, merged.merged], [bambuLab.id, 'Bambu Lab', true], 'the other brand is kept');
  assert.deepStrictEqual(
    profiles.listBrands(db).map((b) => [b.name, b.profile_count, b.spool_count]),
    [['Bambu Lab', 2, 1]]
  );
  assert.strictEqual(profiles.getProfile(db, pla.id).brand_name, 'Bambu Lab');
  assert.ok(profiles.deleteBrand(db, bambuLab.id));
  assert.deepStrictEqual([profiles.getProfile(db, petg.id).brand_id, spools.getSpool(db, spool.id).brand_id], [null, null]);
  assert.ok(profiles.deleteProfile(db, pla.id));
  assert.deepStrictEqual([spools.getSpool(db, spool.id).profile_id, spools.getSpool(db, spool.id).material], [null, 'PLA'], 'a spool keeps its own material');
});
