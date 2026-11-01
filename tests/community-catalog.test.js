#!/usr/bin/env node
'use strict';

// SpoolmanDB in the filament catalogue (10.2 Phase 13; merged since 10.4): checked for updates on
// request (an unchanged list is not downloaded again), merged into the catalogue, removed again.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-community-catalog-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const profiles = require('../src/core/filament-profiles');
const catalog = require('../src/core/filament-catalog');
const community = require('../src/server/community-catalog');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SAMPLE = [
  {
    id: 'e2etestbrand_petg_galaxyteal_1000_175_n',
    manufacturer: 'E2E Test Brand',
    name: 'Galaxy Teal',
    material: 'PETG',
    density: 1.27,
    weight: 1000,
    spool_weight: 230,
    diameter: 1.75,
    color_hex: '14B8A6',
    color_hexes: null,
    extruder_temp: null,
    extruder_temp_range: [230, 250],
    bed_temp: 80,
    bed_temp_range: null
  },
  {
    id: 'e2etestbrand_pla_dual_1000_175_n',
    manufacturer: 'E2E Test Brand',
    name: 'Dual',
    material: 'PLA',
    weight: 1000,
    diameter: 1.75,
    color_hex: null,
    color_hexes: ['FF0000', '0000FF']
  },
  { id: 'broken', manufacturer: '', material: 'PLA' },
  { id: 'e2etestbrand_petg_galaxyteal_1000_175_n', manufacturer: 'Repeat', material: 'PETG' }
];
/** A fetch that answers with `status` and `body`, an ETag, and records the headers it was asked with. */
function fakeFetch(status, body, etag = null) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push(options.headers);
    return { ok: status >= 200 && status < 300, status, headers: { get: (name) => (name === 'etag' ? etag : null) }, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const fresh = () => {
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
  return db;
};
const db = fresh();
const spoolman = (status) => status.sources.find((s) => s.id === 'spoolmandb') || null;

test("SpoolmanDB's entries become catalogue rows: colors, temperature ranges, repeats and broken ones left out", () => {
  const rows = community.rowsFrom(SAMPLE);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], [
    'sdb:e2etestbrand_petg_galaxyteal_1000_175_n',
    'E2E Test Brand',
    'Galaxy Teal',
    'PETG',
    null,
    '#14b8a6',
    1.75,
    1000,
    230,
    1.27,
    230,
    250,
    80,
    80,
    null
  ]);
  assert.strictEqual(rows[1][5], '#ff0000', 'a multi-color filament: its first color');
  assert.throws(() => community.rowsFrom({ not: 'a list' }), /not its filament list/);
  assert.throws(() => community.rowsFrom([]), /no filaments/);
});

test('check for updates: SpoolmanDB merges into the catalogue; unchanged, it is not downloaded again; remove takes it out', async () => {
  const before = community.status(db);
  assert.strictEqual(spoolman(before), null, 'nothing downloaded until an admin asks');
  assert.ok(before.filaments > 20000);
  const first = fakeFetch(200, JSON.stringify(SAMPLE), '"v1"');
  const after = await community.refresh(db, { fetchImpl: first, now: new Date('2026-10-31T12:00:00Z') });
  assert.strictEqual(first.calls[0]['if-none-match'], undefined, 'the first download asks for the whole list');
  assert.deepStrictEqual([spoolman(after).count, spoolman(after).fetchedAt, after.upToDate, after.report.added], [2, '2026-10-31T12:00:00.000Z', false, 2]);
  const found = profiles.searchCatalog(db, 'e2e test brand teal');
  assert.deepStrictEqual(
    found.items.map((i) => [i.name, i.sources]),
    [['Galaxy Teal', ['spoolmandb']]]
  );

  const unchanged = fakeFetch(304, '');
  const checked = await community.refresh(db, { fetchImpl: unchanged, now: new Date('2026-11-02T08:00:00Z') });
  assert.strictEqual(unchanged.calls[0]['if-none-match'], '"v1"', 'asks with the ETag of the list it has');
  assert.deepStrictEqual(
    [checked.upToDate, spoolman(checked).fetchedAt, spoolman(checked).checkedAt],
    [true, '2026-10-31T12:00:00.000Z', '2026-11-02T08:00:00.000Z']
  );
  const forced = fakeFetch(200, JSON.stringify(SAMPLE), '"v1"');
  await community.refresh(db, { fetchImpl: forced, force: true });
  assert.strictEqual(forced.calls[0]['if-none-match'], undefined, 'force downloads anyway');

  const added = profiles.addFromCatalog(db, found.items[0].id);
  assert.deepStrictEqual(
    [added.profile.brand_name, added.profile.material, added.profile.color_hex, added.profile.print_temp_max, added.entry.spool_weight],
    ['E2E Test Brand', 'PETG', '#14b8a6', 250, 230]
  );

  const removed = community.remove(db);
  assert.strictEqual(spoolman(removed), null);
  assert.strictEqual(profiles.searchCatalog(db, 'e2e test brand').total, 0);
  assert.strictEqual(profiles.getProfile(db, added.profile.id).brand_name, 'E2E Test Brand', 'filaments added from it stay');
});

test('a failed download says why and leaves the catalogue as it was', async () => {
  const before = community.status(db).filaments;
  await assert.rejects(() => community.refresh(db, { fetchImpl: fakeFetch(503, '') }), /answered 503/);
  await assert.rejects(() => community.refresh(db, { fetchImpl: fakeFetch(200, '<html>') }), /not its filament list/);
  await assert.rejects(
    () =>
      community.refresh(db, {
        fetchImpl: async () => {
          throw new Error('ENOTFOUND');
        }
      }),
    /Could not reach SpoolmanDB: ENOTFOUND/
  );
  assert.strictEqual(spoolman(community.status(db)), null);
  assert.strictEqual(community.status(db).filaments, before);
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
