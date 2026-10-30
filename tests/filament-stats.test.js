#!/usr/bin/env node
'use strict';

// Phase 10 (docs/merge-10.md): filament used and its cost per month, model, printer and material,
// the currency setting, what the spools on hand are worth, and the MCP tools for spools, the
// filament check and the queue.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-filament-stats-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
process.env.JUSTTPRINT_USER_DATA = tmp;
const database = require('../src/core/database');
const { initializeDatabase } = require('../src/core/db-init');
const { filamentStatistics, currency } = require('../src/core/filament-stats');
const spools = require('../src/core/spools');
const printEvents = require('../src/core/print-events');
const { replacePlateFilaments } = require('../src/core/plate-filaments');
const ams = require('../src/core/printer-ams');
const check = require('../src/core/filament-check');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const log = console.log;
console.log = () => {};
try {
  initializeDatabase();
} finally {
  console.log = log;
}
const db = database.db;
const model = (name) =>
  Number(
    db.prepare("INSERT INTO models (filePath, fileName, print_status, dateAdded) VALUES (?, ?, 'unprinted', '2026-01-01')").run(`/lib/${name}`, name)
      .lastInsertRowid
  );
const printer = (name) =>
  Number(db.prepare("INSERT INTO printers (nickname, created_at, updated_at) VALUES (?, '2026-01-01', '2026-01-01')").run(name).lastInsertRowid);

const red = spools.saveSpool(db, { material: 'PLA', color_hex: '#d02020', initial_weight: 1000, remaining: 1000, purchase_price: 20 });
const gray = spools.saveSpool(db, { material: 'PETG', color_hex: '#8b8f96', initial_weight: 1000, remaining: 500 });
const benchy = model('benchy.3mf');
const vase = model('vase.3mf');
const mk4 = printer('MK4');
replacePlateFilaments(db, benchy, 'test', [{ plate: 1, slot: 1, material: 'PLA', color: '#d02020', grams: 30 }]);
replacePlateFilaments(db, vase, 'test', [{ plate: 1, slot: 1, material: 'PETG', color: '#8b8f96', grams: 40 }]);
printEvents.logPrintEvent(db, {
  modelId: benchy,
  outcome: 'printed',
  printedAt: '2026-09-10T10:00:00.000Z',
  printerId: mk4,
  spools: [{ spoolId: red.id, grams: 50 }]
});
printEvents.logPrintEvent(db, { modelId: vase, outcome: 'printed', printedAt: '2026-10-02T10:00:00.000Z', spools: [{ spoolId: gray.id, grams: 100 }] });
printEvents.logPrintEvent(db, { modelId: benchy, outcome: 'printed', printedAt: '2025-01-02T10:00:00.000Z', spools: [{ spoolId: red.id, grams: 10 }] });

test('filament used and its cost: per month, model, printer and material; unpriced spools add grams only', () => {
  const stats = filamentStatistics(db, { from: '2026-09-01T00:00:00.000Z', months: ['2026-09', '2026-10'] });
  assert.deepStrictEqual([stats.grams, stats.cost, stats.pricedGrams], [150, 1, 50]);
  assert.deepStrictEqual(stats.byMonth, [
    { month: '2026-09', grams: 50, cost: 1 },
    { month: '2026-10', grams: 100, cost: 0 }
  ]);
  assert.deepStrictEqual(
    stats.models.map((m) => [m.name, m.grams, m.cost]),
    [
      ['vase.3mf', 100, 0],
      ['benchy.3mf', 50, 1]
    ]
  );
  assert.deepStrictEqual(
    stats.printers.map((p) => [p.name, p.grams]),
    [
      ['', 100],
      ['MK4', 50]
    ]
  );
  assert.deepStrictEqual(stats.materials, [
    { material: 'PETG', grams: 100 },
    { material: 'PLA', grams: 50 }
  ]);
  assert.strictEqual(filamentStatistics(db).grams, 160, 'all time');
});

test('the currency setting: an ISO code, USD when unset or wrong; the spools on hand are worth their grams at their price', () => {
  assert.strictEqual(currency(db), 'USD');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('currency', 'EUR')").run();
  assert.strictEqual(currency(db), 'EUR');
  db.prepare("UPDATE settings SET value = 'euros' WHERE key = 'currency'").run();
  assert.strictEqual(currency(db), 'USD');
  const summary = spools.filamentSummary(db);
  assert.deepStrictEqual([summary.worth, summary.currency], [18.8, 'USD'], '940 g of a 20 for 1000 g spool');
  const stats = require('../src/core/print-stats').printStatistics(db, { months: 12, now: new Date('2026-10-15T00:00:00.000Z') });
  assert.deepStrictEqual([stats.filament.grams, stats.currency], [150, 'USD']);
});

test('MCP: spools, the filament check, what can print, the queue and the stats', async () => {
  check.forgetFits();
  const ctx = require('../src/server/mcp-tools').getMcpToolContext();
  const listed = await ctx.listSpools({});
  assert.deepStrictEqual(
    listed.map((s) => [s.id, s.material, s.grams]),
    [
      [red.id, 'PLA', 940],
      [gray.id, 'PETG', 400]
    ]
  );
  assert.strictEqual((await ctx.weighSpool({ id: gray.id, weight: 300, withSpool: false })).grams, 300);
  const benchyCheck = await ctx.checkModelFilament({ id: benchy });
  assert.deepStrictEqual([benchyCheck.known, benchyCheck.plates, benchyCheck.check.ready, benchyCheck.check.needs[0].spool.id], [true, [1], true, red.id]);
  assert.strictEqual((await ctx.whatCanIPrint({})).count, 2);
  // Only the red spool is loaded in the MK4: the vase needs a swap.
  ams.loadSpool(db, { printerId: mk4 }, red.id);
  assert.deepStrictEqual(
    (await ctx.whatCanIPrint({ printerId: mk4 })).models.map((m) => m.id),
    [benchy]
  );
  const added = await ctx.addToQueue({ id: vase, plate: 1 });
  const queued = await ctx.getPrintQueue();
  assert.deepStrictEqual(
    queued.map((item) => [item.id, item.model.id, item.plate, item.ready]),
    [[added.id, vase, 1, true]]
  );
  assert.ok(Array.isArray(await ctx.getReorderList()));
  const stats = await ctx.getFilamentStats({ months: 0 });
  assert.deepStrictEqual([stats.filament.grams, stats.currency], [160, 'USD']);
  const logged = await ctx.logPrintEvent({ id: benchy, outcome: 'printed', spools: [{ spoolId: red.id, grams: 20 }], plateIndex: 1 });
  assert.ok(logged);
  assert.strictEqual(spools.getSpool(db, red.id).remaining, 920);
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
    require('../src/server/low-stock-alerts').stop?.();
    if (database.db && database.db.open) database.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
