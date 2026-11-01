#!/usr/bin/env node
'use strict';

// The filament catalogue (10.4, src/core/filament-catalog.js): one list merged from
// 3dfilamentprofiles.com and SpoolmanDB, brands folded and merged, duplicates merged, and what
// people add, change or delete kept through updates.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const catalog = require('../src/core/filament-catalog');
const profiles = require('../src/core/filament-profiles');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-filament-catalog-')));

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.stack || err.message);
    process.exitCode = 1;
  }
}

const FIELDS = [
  'id',
  'brand',
  'name',
  'material',
  'color_name',
  'color_hex',
  'diameter',
  'weight',
  'spool_weight',
  'density',
  'print_temp_min',
  'print_temp_max',
  'bed_temp_min',
  'bed_temp_max',
  'product_url'
];
// 3dfilamentprofiles.com: brand spellings that fold together, an exact repeat, codes that tell colors apart.
const BUNDLED = [
  ['fp1', 'SUNLU', 'Black', 'ABS Basic', 'Black', '#000000', 1.75, 1000, null, 1.04, 240, 260, 90, 100, 'https://sunlu.example/abs'],
  ['fp2', 'Sunlu', 'White', 'PLA Basic', 'White', '#ffffff', 1.75, 1000, null, 1.24, 200, 220, 50, 60, null],
  ['fp3', 'Sunlu', 'Red', 'PLA Silk', 'Red', '#d02020', 1.75, 1000, null, 1.24, 205, 225, 50, 60, null],
  ['fp4', 'Sunlu', 'Red', 'PLA Silk', 'Red', '#d02424', 1.75, 1000, null, 1.24, 205, 225, 50, 60, null],
  ['fp5', 'Bambu Lab', 'Black (10101)', 'PLA Basic', 'Black', '#000000', 1.75, 1000, 250, 1.26, 190, 230, 35, 45, null],
  ['fp6', 'Bambu Lab', 'Black (10102)', 'PLA Basic', 'Black', '#000000', 1.75, 1000, 250, 1.26, 190, 230, 35, 45, null],
  ['fp7', 'Polymaker', 'Galaxy Black', 'ABS PolyLite', 'Galaxy Black', '#121d1f', 1.75, 1000, null, 1.04, 245, 265, 90, 105, null],
  ['fp8', 'Fusion', 'Blue', 'PLA Basic', 'Blue', '#2040d0', 1.75, 1000, null, 1.24, null, null, null, null, null],
  ['fp9', 'Fusion Filaments', 'Green', 'PLA Basic', 'Green', '#20a040', 1.75, 1000, null, 1.24, null, null, null, null, null]
];
// SpoolmanDB: its own names for the same filaments, each spool size separately, a 2.85 mm one.
const SPOOLMAN = [
  {
    ref: 'sdb:sunlu_abs_black_1000',
    brand: 'Sunlu',
    name: 'Black',
    material: 'ABS',
    color_hex: '#000000',
    diameter: 1.75,
    weight: 1000,
    spool_weight: 157,
    density: 1.05
  },
  {
    ref: 'sdb:poly_abs_gb_3000',
    brand: 'Polymaker',
    name: 'PolyLite™ ABS Galaxy Black',
    material: 'ABS',
    color_hex: '#474648',
    diameter: 1.75,
    weight: 3000,
    spool_weight: 425
  },
  {
    ref: 'sdb:poly_abs_gb_1000',
    brand: 'Polymaker',
    name: 'PolyLite™ ABS Galaxy Black',
    material: 'ABS',
    color_hex: '#474648',
    diameter: 1.75,
    weight: 1000,
    spool_weight: 140
  },
  {
    ref: 'sdb:poly_abs_gb_1000_285',
    brand: 'Polymaker',
    name: 'PolyLite™ ABS Galaxy Black',
    material: 'ABS',
    color_hex: '#474648',
    diameter: 2.85,
    weight: 1000,
    spool_weight: 140
  },
  { ref: 'sdb:newbrand_petg_teal', brand: 'Teal Works', name: 'Teal', material: 'PETG', color_hex: '#14b8a6', diameter: 1.75, weight: 1000, spool_weight: 200 }
];

const writeSnapshot = (name, fetchedAt, rows) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify({ source: 'test', fetchedAt, fields: FIELDS, rows }));
  return file;
};
const BUNDLED_FILE = writeSnapshot('bundled.json', '2026-05-30T00:00:00Z', BUNDLED);

const fresh = (file = BUNDLED_FILE) => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT)');
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
    catalog.ensureCatalog(db, { file, legacyFile: null });
  } finally {
    console.log = log;
  }
  return db;
};
const find = (db, query) => catalog.search(db, query).items;
const brandNames = (db) => catalog.listBrands(db).map((b) => `${b.name}:${b.count}`);

test('brand names fold: case, spaces, punctuation and endings like Inc', () => {
  assert.strictEqual(catalog.brandKey('SUNLU'), catalog.brandKey('Sun-Lu'));
  assert.strictEqual(catalog.brandKey('3D Fillies'), catalog.brandKey('3DFillies'));
  assert.strictEqual(catalog.brandKey('Matter3D Inc'), catalog.brandKey('Matter3D'));
  assert.strictEqual(catalog.brandKey('add:north'), 'addnorth');
  assert.notStrictEqual(catalog.brandKey('Prusa'), catalog.brandKey('Prusament'));
  assert.strictEqual(catalog.brandCore('Fusion Filaments'), catalog.brandCore('Fusion'));
});

test('filament words: codes, Basic and ™ left out, order does not matter', () => {
  const w = catalog.filamentWords;
  assert.strictEqual(w('Bambu Lab', 'PLA Basic', 'Black (10101)'), w('Bambu Lab', 'PLA', 'Black'));
  assert.strictEqual(w('Polymaker', 'ABS PolyLite', 'Galaxy Black'), w('Polymaker', 'ABS', 'PolyLite™ ABS Galaxy Black'));
  assert.strictEqual(w('eSUN', 'PLA+/Pro Basic', 'Black'), w('eSUN', 'PLA+', 'Black'));
  assert.notStrictEqual(w('Sunlu', 'PLA', 'Silk Red'), w('Sunlu', 'PLA', 'Red'));
});

test('the bundled list: one brand per spelling, its most common name; repeats merged, codes kept apart', () => {
  const db = fresh();
  assert.deepStrictEqual(brandNames(db), ['Bambu Lab:2', 'Fusion:1', 'Fusion Filaments:1', 'Polymaker:1', 'Sunlu:3']);
  assert.strictEqual(find(db, 'sunlu silk red').length, 1, 'the same name and a close color is one filament');
  assert.strictEqual(find(db, 'bambu black').length, 2, 'Black (10101) and Black (10102) stay two');
  const status = catalog.status(db);
  assert.deepStrictEqual([status.filaments, status.brands, status.merged, status.sources[0].count], [8, 5, 1, 9]);
});

test('SpoolmanDB merges in: same filaments joined with the details each list has, sizes folded, 2.85 mm apart', () => {
  const db = fresh();
  const report = catalog.syncSource(db, 'spoolmandb', SPOOLMAN, { fetchedAt: '2026-10-31T00:00:00Z' });
  assert.deepStrictEqual([report.added, report.merged, report.duplicates, report.brands], [2, 2, 1, 1], JSON.stringify(report));
  const [abs] = find(db, 'sunlu abs black');
  assert.deepStrictEqual(
    [abs.name, abs.material, abs.spool_weight, abs.density, abs.print_temp_max, abs.product_url, abs.sources],
    ['Black', 'ABS Basic', 157, 1.05, 260, 'https://sunlu.example/abs', ['3dfilamentprofiles', 'spoolmandb']],
    'name, temperatures and link from 3dfilamentprofiles.com; spool weight and density from SpoolmanDB'
  );
  const galaxy = find(db, 'polymaker galaxy');
  assert.deepStrictEqual(
    galaxy.map((f) => [f.name, f.diameter, f.weight, f.spool_weight, f.color_hex, f.sources.join('+')]),
    [
      ['PolyLite™ ABS Galaxy Black', 2.85, 1000, 140, '#474648', 'spoolmandb'],
      ['Galaxy Black', 1.75, 1000, 140, '#121d1f', '3dfilamentprofiles+spoolmandb']
    ],
    'the 3 kg size joins the 1 kg one, whose weights it keeps; 2.85 mm is its own filament'
  );
  const again = catalog.syncSource(db, 'spoolmandb', SPOOLMAN, { fetchedAt: '2026-11-01T00:00:00Z' });
  assert.deepStrictEqual([again.added, again.merged, again.updated, again.removed], [0, 0, 0, 0], 'the same list again changes nothing');
});

test('people’s changes stay: edited, added and deleted filaments through updates', () => {
  const db = fresh();
  catalog.syncSource(db, 'spoolmandb', SPOOLMAN);
  const [teal] = find(db, 'teal works');
  const edited = catalog.saveFilament(db, { ...teal, name: 'Ocean Teal', print_temp_max: 250 }, 3);
  assert.ok(edited.edited);
  const mine = catalog.saveFilament(db, { brand: 'sunlu', material: 'PLA Matte', name: 'Sage', color_hex: '#9caf88' }, 3);
  assert.deepStrictEqual([mine.manual, mine.brand], [true, 'Sunlu'], 'a brand typed in any case is the brand already there');
  const [white] = find(db, 'sunlu white');
  catalog.deleteFilament(db, white.id);
  assert.strictEqual(find(db, 'sunlu white').length, 0);

  const changed = SPOOLMAN.map((e) => (e.ref === 'sdb:newbrand_petg_teal' ? { ...e, name: 'Teal v2', spool_weight: 210 } : e));
  catalog.syncSource(db, 'spoolmandb', changed);
  const bundledAgain = writeSnapshot('bundled-2.json', '2026-11-15T00:00:00Z', BUNDLED);
  catalog.ensureCatalog(db, { file: bundledAgain, legacyFile: null });
  assert.deepStrictEqual(
    find(db, 'teal').map((f) => [f.name, f.spool_weight, f.print_temp_max]),
    [['Ocean Teal', 200, 250]],
    'updates leave a changed filament as it was left'
  );
  assert.strictEqual(find(db, 'sunlu sage').length, 1, 'one added by hand stays');
  assert.strictEqual(find(db, 'sunlu white').length, 0, 'one deleted stays out');
  assert.strictEqual(
    catalog.status(db).sources.find((s) => s.id === '3dfilamentprofiles').fetchedAt,
    '2026-11-15T00:00:00Z',
    'a newer bundled list is read in'
  );

  // A source dropping an entry: its filament goes, unless people changed it.
  const report = catalog.syncSource(
    db,
    'spoolmandb',
    SPOOLMAN.filter((e) => !e.ref.startsWith('sdb:poly_abs_gb_1000_285') && e.ref !== 'sdb:newbrand_petg_teal')
  );
  assert.strictEqual(report.removed, 1);
  assert.strictEqual(find(db, 'polymaker galaxy').length, 1);
  assert.strictEqual(find(db, 'teal').length, 1, 'the changed one stays');
  catalog.deleteFilament(db, mine.id);
  assert.strictEqual(find(db, 'sunlu sage').length, 0, 'deleting one added by hand removes it');
});

test('brands: rename, merge (keys kept as aliases), suggestions and "not the same"', () => {
  const db = fresh();
  assert.deepStrictEqual(
    catalog.brandSuggestions(db).map((g) => g.map((b) => b.name)),
    [['Fusion', 'Fusion Filaments']]
  );
  const fusion = catalog.listBrands(db, { search: 'fusion' });
  const merged = catalog.mergeBrands(
    db,
    fusion.filter((b) => b.name !== 'Fusion').map((b) => b.id),
    fusion.find((b) => b.name === 'Fusion').id
  );
  assert.strictEqual(merged.brand.name, 'Fusion');
  assert.deepStrictEqual(brandNames(db), ['Bambu Lab:2', 'Fusion:2', 'Polymaker:1', 'Sunlu:3']);
  assert.deepStrictEqual(catalog.brandSuggestions(db), []);
  // The next update keeps "Fusion Filaments" entries under Fusion.
  catalog.syncSource(db, '3dfilamentprofiles', [...BUNDLED.map((row) => ({ ...Object.fromEntries(FIELDS.map((f, i) => [f, row[i]])), ref: row[0] }))]);
  assert.deepStrictEqual(brandNames(db), ['Bambu Lab:2', 'Fusion:2', 'Polymaker:1', 'Sunlu:3']);

  const sunlu = catalog.listBrands(db, { search: 'sunlu' })[0];
  catalog.renameBrand(db, sunlu.id, 'SUNLU');
  assert.ok(
    find(db, 'sunlu').every((f) => f.brand === 'SUNLU'),
    'a rename shows on its filaments'
  );
  catalog.syncSource(
    db,
    '3dfilamentprofiles',
    BUNDLED.map((row) => ({ ...Object.fromEntries(FIELDS.map((f, i) => [f, row[i]])), ref: row[0] }))
  );
  assert.strictEqual(catalog.listBrands(db, { search: 'sunlu' })[0].name, 'SUNLU', 'updates keep the name an admin gave');
  const bambu = catalog.listBrands(db, { search: 'bambu' })[0];
  const intoSunlu = catalog.renameBrand(db, bambu.id, 'Sun lu');
  assert.strictEqual(intoSunlu.brand.id, sunlu.id, 'renaming onto another brand’s name merges them');

  const db2 = fresh();
  const pair = catalog.brandSuggestions(db2)[0].map((b) => b.id);
  catalog.ignoreBrandSuggestion(db2, pair);
  assert.deepStrictEqual(catalog.brandSuggestions(db2), [], 'brands said not to be the same are not suggested again');
});

test('merging brands merges their duplicate filaments; one added by hand is the one kept', () => {
  const db = fresh();
  catalog.syncSource(db, 'spoolmandb', [
    { ref: 'sdb:ff_blue', brand: 'Fusion Filaments', name: 'Blue', material: 'PLA', color_hex: '#2242d2', diameter: 1.75, weight: 1000, spool_weight: 190 }
  ]);
  let brands = catalog.listBrands(db, { search: 'fusion' });
  const result = catalog.mergeBrands(db, [brands.find((b) => b.name !== 'Fusion').id], brands.find((b) => b.name === 'Fusion').id);
  assert.strictEqual(result.merged, 1, 'SpoolmanDB’s Fusion Filaments Blue joins Fusion’s Blue');
  assert.deepStrictEqual(
    find(db, 'fusion blue').map((f) => [f.spool_weight, f.sources.join('+')]),
    [[190, '3dfilamentprofiles+spoolmandb']]
  );

  // A filament added by hand that a list has too: the list's entry joins it, and it stays as it was written.
  const db2 = fresh();
  const mine = catalog.saveFilament(db2, { brand: 'Teal Works', material: 'PETG', name: 'Teal', color_hex: '#10b0a0', spool_weight: 199 });
  catalog.syncSource(db2, 'spoolmandb', SPOOLMAN);
  assert.deepStrictEqual(
    find(db2, 'teal works').map((f) => [f.id, f.manual, f.spool_weight, f.sources.join('+')]),
    [[mine.id, true, 199, 'spoolmandb']],
    'no duplicate, and the update does not change it'
  );
  brands = catalog.listBrands(db2, { search: 'fusion' });
  catalog.saveFilament(db2, { brand: 'Fusion Filaments', material: 'PLA', name: 'Blue', color_hex: '#2040d0', print_temp_max: 215 });
  catalog.mergeBrands(db2, [brands.find((b) => b.name !== 'Fusion').id], brands.find((b) => b.name === 'Fusion').id);
  assert.deepStrictEqual(
    find(db2, 'fusion blue').map((f) => [f.manual, f.print_temp_max]),
    [[true, 215]],
    'merged with the list’s Blue, the one added by hand is kept'
  );
});

test('a list under half its last size is refused; removing SpoolmanDB keeps what both lists had', () => {
  const db = fresh();
  const big = Array.from({ length: 1200 }, (_, i) => ({ ref: `sdb:x${i}`, brand: 'Bulk', name: `Color ${i}`, material: 'PLA', diameter: 1.75 }));
  catalog.syncSource(db, 'spoolmandb', [...big, ...SPOOLMAN]);
  assert.throws(() => catalog.syncSource(db, 'spoolmandb', SPOOLMAN), /under half/);
  catalog.syncSource(db, 'spoolmandb', [], { remove: true });
  assert.deepStrictEqual(
    catalog.status(db).sources.map((s) => s.id),
    ['3dfilamentprofiles']
  );
  assert.strictEqual(find(db, 'bulk').length, 0);
  assert.deepStrictEqual(find(db, 'sunlu abs black')[0].sources, ['3dfilamentprofiles'], 'a filament both had stays');
  assert.strictEqual(find(db, 'polymaker galaxy').length, 1);
});

test('adding from the catalogue: one profile per filament, also for profiles made from the old catalogue ids', () => {
  const db = fresh();
  const [abs] = find(db, 'sunlu abs black');
  const first = profiles.addFromCatalog(db, abs.id);
  assert.deepStrictEqual(
    [first.profile.brand_name, first.profile.material, first.profile.name, first.materialType, first.profile.source_ref],
    ['Sunlu', 'ABS', 'ABS Basic Black', 'ABS Basic', `catalog-filament:${abs.id}`]
  );
  assert.strictEqual(profiles.addFromCatalog(db, abs.id).profile.id, first.profile.id);
  // A profile added in 10.3 from 3dfilamentprofiles.com entry fp7.
  const old = profiles.saveProfile(db, {
    brand_name: 'Polymaker',
    material: 'ABS',
    name: 'ABS PolyLite Galaxy Black',
    source: 'catalog',
    source_ref: 'catalog:fp7'
  });
  const [galaxy] = find(db, 'polymaker galaxy');
  assert.strictEqual(profiles.addFromCatalog(db, galaxy.id).profile.id, old.id);
  assert.throws(() => profiles.addFromCatalog(db, 999999), /not in the catalogue/);
});

test('a SpoolmanDB downloaded before 10.4 comes into the catalogue, and its file goes', () => {
  const legacy = path.join(tmp, 'catalog', 'spoolmandb.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(
    legacy,
    JSON.stringify({
      source: 'SpoolmanDB',
      fetchedAt: '2026-10-01T00:00:00Z',
      fields: FIELDS,
      rows: [['sdb:old_teal', 'Teal Works', 'Teal', 'PETG', null, '#14b8a6', 1.75, 1000, 200, null, null, null, null, null, null]]
    })
  );
  const db = fresh();
  catalog.ensureCatalog(db, { file: BUNDLED_FILE, legacyFile: legacy });
  assert.strictEqual(find(db, 'teal works').length, 1);
  assert.strictEqual(catalog.status(db).sources.find((s) => s.id === 'spoolmandb').fetchedAt, '2026-10-01T00:00:00Z');
  assert.ok(!fs.existsSync(legacy));
});

test('the bundled catalogue: over 27,000 filaments, Bambu PLA Basic Black among them', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT)');
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
    catalog.ensureCatalog(db, { legacyFile: null });
  } finally {
    console.log = log;
  }
  const status = catalog.status(db);
  assert.ok(status.filaments > 27000 && status.brands > 900, JSON.stringify(status));
  assert.ok(catalog.search(db, 'bambu pla basic black').total >= 1);
  assert.strictEqual(catalog.search(db, '').total, 0);
  assert.strictEqual(catalog.search(db, 'pla', { limit: 5 }).items.length, 5);
  assert.strictEqual(catalog.search(db, '100%').total, 0, 'LIKE wildcards are escaped');
});

fs.rmSync(tmp, { recursive: true, force: true });
