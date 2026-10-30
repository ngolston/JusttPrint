#!/usr/bin/env node
'use strict';

// 10.0 (docs/merge-10.md, Phase 2): a 9.x library is copied into the backups folder before the
// first 10.0 start changes it; the 10.0 tables and columns are added (src/core/filament-schema.js);
// Queued models go into the new print queue once; deletes cascade or clear as each table says.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-filament-schema-')));
const dbPath = path.join(tmp, 'data', 'justtprint.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
process.env.JUSTTPRINT_DB_PATH = dbPath;
process.env.JUSTTPRINT_USER_DATA = tmp;
const database = require('../src/core/database');
const { initializeDatabase, removeFilamentData } = require('../src/core/db-init');
const { FILAMENT_TABLES } = require('../src/core/filament-schema');
const { needsUpgradeBackup, upgradeBackupName, writeUpgradeBackup } = require('../src/core/upgrade-backup');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const backupsDir = path.join(tmp, 'backups');
const upgradeBackups = (dir = backupsDir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('justtprint-before-10.0-')) : []);
const tables = (db) =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
const columns = (db, table) =>
  new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  );
const reopen = () => {
  if (database.db && database.db.open) database.db.close();
  assert.ok(initializeDatabase(), 'the database opens');
  return database.db;
};

try {
  // A 9.x library: the real models and settings tables (read from a database set up now), two
  // Queued models added on different days and a Printed one, and no 10.0 tables.
  process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'scratch.db');
  reopen();
  const definitions = database.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('models', 'settings')")
    .all()
    .map((row) => row.sql);
  database.db.close();
  process.env.JUSTTPRINT_DB_PATH = dbPath;
  test('setting up a new library makes no upgrade backup', () => assert.deepStrictEqual(upgradeBackups(), []));
  const old = new Database(dbPath);
  for (const sql of definitions) old.exec(sql);
  old.exec(`
    INSERT INTO models (filePath, fileName, dateAdded, print_status) VALUES
      ('/lib/b.3mf', 'b.3mf', '2026-05-02T00:00:00Z', 'queued'),
      ('/lib/a.3mf', 'a.3mf', '2026-05-01T00:00:00Z', 'queued'),
      ('/lib/c.stl', 'c.stl', '2026-04-01T00:00:00Z', 'printed');
  `);
  old.close();
  const db = reopen();

  test('the first 10.0 start keeps a checked copy of the 9.x library in the backups folder', () => {
    const files = upgradeBackups();
    assert.strictEqual(files.length, 1, JSON.stringify(files));
    assert.match(files[0], /^justtprint-before-10\.0-\d{8}-\d{6}\.db$/);
    const copy = new Database(path.join(backupsDir, files[0]), { readonly: true });
    try {
      assert.ok(tables(copy).has('models'));
      assert.ok(!tables(copy).has('spools'), 'the copy is from before the upgrade');
      assert.strictEqual(copy.prepare('SELECT COUNT(*) AS n FROM models').get().n, 3);
    } finally {
      copy.close();
    }
    assert.ok(!fs.readdirSync(backupsDir).some((name) => name.endsWith('.partial')));
  });

  test('every 10.0 table is there', () => {
    const have = tables(db);
    for (const name of FILAMENT_TABLES) assert.ok(have.has(name), name);
    for (const old7 of ['filaments', 'model_filaments', 'print_event_filaments']) assert.ok(!have.has(old7), `${old7} is not reused`);
  });

  test('printers and print events gain their 10.0 columns', () => {
    const printers = columns(db, 'printers');
    for (const name of ['connection_type', 'serial_number', 'api_url', 'api_secret', 'status', 'last_seen_at', 'direct_spool_id', 'source_ref'])
      assert.ok(printers.has(name), name);
    const events = columns(db, 'print_events');
    for (const name of ['plate_index', 'file_name', 'duration_seconds', 'started_at', 'filament_used_g', 'source_ref']) assert.ok(events.has(name), name);
  });

  test('Queued models go into the print queue, oldest added first', () => {
    const queue = db.prepare('SELECT m.fileName, q.position, q.plate_index FROM print_queue q JOIN models m ON m.id = q.model_id ORDER BY q.position').all();
    assert.deepStrictEqual(
      queue.map((row) => [row.fileName, row.position, row.plate_index]),
      [
        ['a.3mf', 1, null],
        ['b.3mf', 2, null]
      ]
    );
  });

  test('a later start neither backs up again nor queues the models twice', () => {
    const again = reopen();
    assert.strictEqual(upgradeBackups().length, 1);
    assert.strictEqual(again.prepare('SELECT COUNT(*) AS n FROM print_queue').get().n, 2);
  });

  test('removing 7.0 filament data leaves the 10.0 tables alone', () => {
    removeFilamentData();
    for (const name of FILAMENT_TABLES) assert.ok(tables(database.db).has(name), name);
  });

  test('deleting a spool clears where it was loaded and keeps the grams a print used', () => {
    const d = database.db;
    const now = new Date().toISOString();
    const printer = d.prepare('INSERT INTO printers (nickname, created_at, updated_at) VALUES (?, ?, ?)').run('P1S', now, now).lastInsertRowid;
    const spool = d
      .prepare('INSERT INTO spools (material, color_hex, initial_weight, registered_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('PLA', '#111111', 1000, now, now).lastInsertRowid;
    d.prepare('UPDATE printers SET direct_spool_id = ? WHERE id = ?').run(spool, printer);
    const unit = d.prepare('INSERT INTO printer_ams_units (printer_id, unit_index, name) VALUES (?, 0, ?)').run(printer, 'AMS 1').lastInsertRowid;
    d.prepare('INSERT INTO printer_ams_slots (unit_id, slot_index, spool_id) VALUES (?, 0, ?)').run(unit, spool);
    d.prepare('INSERT INTO spool_weight_logs (spool_id, measured_weight, net_weight, logged_at) VALUES (?, 1200, 950, ?)').run(spool, now);
    const model = d.prepare("SELECT id FROM models WHERE fileName = 'c.stl'").get().id;
    const event = d
      .prepare("INSERT INTO print_events (model_id, printed_at, outcome, quantity, created_at) VALUES (?, ?, 'printed', 1, ?)")
      .run(model, now, now).lastInsertRowid;
    d.prepare('INSERT INTO print_event_spools (event_id, spool_id, grams) VALUES (?, ?, 30)').run(event, spool);

    d.prepare('DELETE FROM spools WHERE id = ?').run(spool);
    assert.strictEqual(d.prepare('SELECT direct_spool_id FROM printers WHERE id = ?').get(printer).direct_spool_id, null);
    assert.strictEqual(d.prepare('SELECT spool_id FROM printer_ams_slots WHERE unit_id = ?').get(unit).spool_id, null);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM spool_weight_logs WHERE spool_id = ?').get(spool).n, 0);
    assert.deepStrictEqual({ ...d.prepare('SELECT spool_id, grams FROM print_event_spools WHERE event_id = ?').get(event) }, { spool_id: null, grams: 30 });

    d.prepare('DELETE FROM printers WHERE id = ?').run(printer);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM printer_ams_units').get().n, 0);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM printer_ams_slots').get().n, 0);
  });

  test("a model's plate filaments and queue entries go with it", () => {
    const d = database.db;
    const model = d.prepare("SELECT id FROM models WHERE fileName = 'a.3mf'").get().id;
    d.prepare("INSERT INTO model_plate_filaments (model_id, plate_index, slot, material, color_hex, grams) VALUES (?, 1, 1, 'PLA', '#2f6fdf', 12.5)").run(
      model
    );
    assert.throws(
      () => d.prepare("INSERT INTO model_plate_filaments (model_id, plate_index, slot, material) VALUES (?, 1, 1, 'PETG')").run(model),
      /UNIQUE/,
      'one row per plate and slot'
    );
    d.prepare('DELETE FROM models WHERE id = ?').run(model);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM model_plate_filaments WHERE model_id = ?').get(model).n, 0);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM print_queue WHERE model_id = ?').get(model).n, 0);
  });

  test('a new, empty library is not backed up', () => {
    const fresh = new Database(':memory:');
    assert.strictEqual(needsUpgradeBackup(fresh, 'spools'), false);
    fresh.exec('CREATE TABLE models (id INTEGER PRIMARY KEY)');
    assert.strictEqual(needsUpgradeBackup(fresh, 'spools'), true);
    fresh.exec('CREATE TABLE spools (id INTEGER PRIMARY KEY)');
    assert.strictEqual(needsUpgradeBackup(fresh, 'spools'), false);
    fresh.close();
  });

  test('upgrade backups get unique names and leave nothing behind when they fail', () => {
    assert.strictEqual(upgradeBackupName('10.0', new Date('2026-10-30T06:15:00Z')), 'justtprint-before-10.0-20261030-061500.db');
    const dir = path.join(tmp, 'named');
    const when = new Date('2026-10-30T06:15:00Z');
    const first = writeUpgradeBackup(database.db, dir, '10.0', when);
    const second = writeUpgradeBackup(database.db, dir, '10.0', when);
    assert.notStrictEqual(first, second);
    assert.match(path.basename(second), /-1\.db$/);
    const blocked = path.join(tmp, 'not-a-folder');
    fs.writeFileSync(blocked, 'x');
    assert.throws(() => writeUpgradeBackup(database.db, blocked, '10.0'));
  });

  test('the backup goes into the folder chosen under Settings → Backup', () => {
    const custom = path.join(tmp, 'custom-backups');
    const second = path.join(tmp, 'second.db');
    const old = new Database(second);
    for (const sql of definitions) old.exec(sql);
    old.prepare("INSERT INTO settings (key, value) VALUES ('autoBackupDirectory', ?)").run(custom);
    old.close();
    database.db.close();
    process.env.JUSTTPRINT_DB_PATH = second;
    assert.ok(initializeDatabase());
    assert.strictEqual(upgradeBackups(custom).length, 1);
  });
} finally {
  if (database.db && database.db.open) database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
