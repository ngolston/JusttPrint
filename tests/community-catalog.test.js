#!/usr/bin/env node
'use strict';

// 10.2 Phase 13 (docs/plan-10.1.md): SpoolmanDB downloaded on request into the filament catalogue,
// searched beside the bundled 3dfilamentprofiles.com snapshot.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-community-catalog-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const profiles = require('../src/core/filament-profiles');
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
const fakeFetch = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body });

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

test('download: SpoolmanDB is searched beside the bundled catalogue; a filament from it can be added; remove takes it out', async () => {
  const before = community.status();
  assert.strictEqual(before.spoolmandb, null, 'nothing downloaded until an admin asks');
  assert.ok(before.bundled.count > 20000);
  const after = await community.refresh({ fetchImpl: fakeFetch(200, JSON.stringify(SAMPLE)), now: new Date('2026-10-31T12:00:00Z') });
  assert.deepStrictEqual([after.spoolmandb.count, after.spoolmandb.fetchedAt], [2, '2026-10-31T12:00:00.000Z']);
  const found = profiles.searchCatalog('e2e test brand teal');
  assert.deepStrictEqual(
    found.items.map((i) => [i.id, i.from]),
    [['sdb:e2etestbrand_petg_galaxyteal_1000_175_n', 'spoolmandb']]
  );
  assert.deepStrictEqual(
    found.sources.map((s) => s.id),
    ['3dfilamentprofiles', 'spoolmandb']
  );
  assert.ok(profiles.searchCatalog('bambu pla basic black').items.every((i) => i.from === '3dfilamentprofiles'));

  const db = new Database(':memory:');
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT)');
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  const added = profiles.addFromCatalog(db, 'sdb:e2etestbrand_petg_galaxyteal_1000_175_n');
  assert.deepStrictEqual(
    [added.profile.brand_name, added.profile.material, added.profile.color_hex, added.profile.print_temp_max, added.entry.spool_weight],
    ['E2E Test Brand', 'PETG', '#14b8a6', 250, 230]
  );

  const removed = community.remove();
  assert.strictEqual(removed.spoolmandb, null);
  assert.strictEqual(profiles.searchCatalog('e2e test brand').total, 0);
  assert.strictEqual(profiles.getProfile(db, added.profile.id).brand_name, 'E2E Test Brand', 'filaments added from it stay');
});

test('a failed download says why and leaves the catalogue as it was', async () => {
  await assert.rejects(() => community.refresh({ fetchImpl: fakeFetch(503, '') }), /answered 503/);
  await assert.rejects(() => community.refresh({ fetchImpl: fakeFetch(200, '<html>') }), /not its filament list/);
  await assert.rejects(
    () =>
      community.refresh({
        fetchImpl: async () => {
          throw new Error('ENOTFOUND');
        }
      }),
    /Could not reach SpoolmanDB: ENOTFOUND/
  );
  assert.strictEqual(community.status().spoolmandb, null);
  assert.ok(!fs.existsSync(profiles.communityFile()));
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
