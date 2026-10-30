#!/usr/bin/env node
'use strict';

// Phase 9 (docs/merge-10.md): importing a FilamentHub database. The source is built here with
// FilamentHub's own tables and columns (app/models/models.py), SQLAlchemy's way of storing them
// (enum names, "YYYY-MM-DD HH:MM:SS.ffffff" dates, 0/1 booleans, UUID user ids).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-fh-import-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
process.env.JUSTTPRINT_USER_DATA = tmp;
const database = require('../src/core/database');
const { initializeDatabase } = require('../src/core/db-init');
const fhImport = require('../src/core/filamenthub-import');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.stack || err.message);
    process.exitCode = 1;
  }
}

const ALICE = '1f6d0c2e-0000-4000-8000-000000000001';
const BOB = '1f6d0c2e-0000-4000-8000-000000000002';

function filamentHub() {
  const fh = new Database(':memory:');
  fh.exec(`
    CREATE TABLE users (id VARCHAR(36) PRIMARY KEY, email VARCHAR(255), display_name VARCHAR(100), role VARCHAR(8), discord_webhook_url VARCHAR(500));
    CREATE TABLE brands (id INTEGER PRIMARY KEY, name VARCHAR(100), website VARCHAR(500), country_of_origin VARCHAR(100), logo_url VARCHAR(500), notes TEXT, created_at DATETIME);
    CREATE TABLE filament_profiles (id INTEGER PRIMARY KEY, brand_id INTEGER, name VARCHAR(200), material VARCHAR(50), color_name VARCHAR(100), color_hex VARCHAR(7), diameter FLOAT,
      density FLOAT, print_temp_min INTEGER, print_temp_max INTEGER, bed_temp_min INTEGER, bed_temp_max INTEGER, max_print_speed INTEGER, drying_temp INTEGER, drying_duration INTEGER,
      is_community BOOLEAN, is_verified BOOLEAN, product_url VARCHAR(500), photo_url VARCHAR(500), notes TEXT, created_at DATETIME, updated_at DATETIME);
    CREATE TABLE storage_locations (id INTEGER PRIMARY KEY, owner_id VARCHAR(36), name VARCHAR(100), description VARCHAR(300), is_dry_box BOOLEAN, printer_id INTEGER, slot_type VARCHAR(10),
      ams_unit_index INTEGER, ams_slot_index INTEGER);
    CREATE TABLE spools (id INTEGER PRIMARY KEY, owner_id VARCHAR(36), filament_id INTEGER, brand_id INTEGER, location_id INTEGER, name VARCHAR(200), lot_nr VARCHAR(100), photo_url VARCHAR(500),
      initial_weight FLOAT, spool_weight FLOAT, used_weight FLOAT, purchase_date DATETIME, purchase_price FLOAT, supplier VARCHAR(200), product_url VARCHAR(500), color_hex VARCHAR(7),
      extra_color_hex_2 VARCHAR(7), extra_color_hex_3 VARCHAR(7), extra_color_hex_4 VARCHAR(7), material VARCHAR(50), material_type VARCHAR(100), status VARCHAR(8), notes TEXT,
      registered DATETIME, first_used DATETIME, last_used DATETIME, updated_at DATETIME);
    CREATE TABLE weight_logs (id INTEGER PRIMARY KEY, spool_id INTEGER, measured_weight FLOAT, net_weight FLOAT, notes VARCHAR(300), logged_at DATETIME);
    CREATE TABLE drying_sessions (id INTEGER PRIMARY KEY, spool_id INTEGER, drying_temp INTEGER, target_duration_hours INTEGER, started_at DATETIME, finished_at DATETIME,
      humidity_before FLOAT, humidity_after FLOAT, notes TEXT);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, owner_id VARCHAR(36), name VARCHAR(100), model VARCHAR(100), connection_type VARCHAR(9), serial_number VARCHAR(100), api_url VARCHAR(500),
      api_key VARCHAR(200), status VARCHAR(8), notes TEXT, created_at DATETIME, last_seen_at DATETIME, direct_spool_id INTEGER);
    CREATE TABLE ams_units (id INTEGER PRIMARY KEY, printer_id INTEGER, unit_index INTEGER, name VARCHAR(100));
    CREATE TABLE ams_slots (id INTEGER PRIMARY KEY, ams_unit_id INTEGER, slot_index INTEGER, spool_id INTEGER);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, user_id VARCHAR(36), name VARCHAR(300));
    CREATE TABLE print_jobs (id INTEGER PRIMARY KEY, user_id VARCHAR(36), printer_id INTEGER, spool_id INTEGER, project_id INTEGER, plate_number INTEGER, file_name VARCHAR(300),
      filament_used_g FLOAT, duration_seconds INTEGER, outcome VARCHAR(9), notes TEXT, started_at DATETIME, finished_at DATETIME);
    CREATE TABLE print_job_spools (id INTEGER PRIMARY KEY, print_job_id INTEGER, spool_id INTEGER, filament_used_g FLOAT);
    CREATE TABLE print_job_photos (id INTEGER PRIMARY KEY, print_job_id INTEGER, url VARCHAR(500));
    CREATE TABLE alert_rules (id INTEGER PRIMARY KEY, owner_id VARCHAR(36), name VARCHAR(100), low_threshold_pct FLOAT, critical_threshold_pct FLOAT, material_filter VARCHAR(50),
      notify_discord BOOLEAN, notify_email BOOLEAN, is_active BOOLEAN, created_at DATETIME);
    CREATE TABLE webhooks (id INTEGER PRIMARY KEY, owner_id VARCHAR(36), name VARCHAR(100), url VARCHAR(500), events VARCHAR(300), secret VARCHAR(200), is_active BOOLEAN,
      created_at DATETIME, last_triggered_at DATETIME, last_status_code INTEGER);
    CREATE TABLE system_config (id INTEGER PRIMARY KEY, smtp_host VARCHAR(255), smtp_port INTEGER, smtp_user VARCHAR(255), smtp_password VARCHAR(255), smtp_from VARCHAR(255),
      smtp_tls BOOLEAN, allow_registration BOOLEAN, updated_at DATETIME);
    CREATE TABLE api_keys (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36), name VARCHAR(100));

    INSERT INTO users VALUES ('${ALICE}', 'admin@example.com', 'Alice', 'admin', 'https://discord.com/api/webhooks/9/xyz'), ('${BOB}', 'bob.builder@example.com', 'Bob', 'operator', NULL);
    INSERT INTO brands VALUES (1, 'Bambu Lab', 'https://bambulab.com', 'China', NULL, NULL, '2026-01-02 10:00:00.000000'), (2, 'Polymaker', NULL, NULL, NULL, NULL, '2026-01-02 10:00:00');
    INSERT INTO filament_profiles VALUES (1, 1, 'PLA Basic Black', 'PLA Basic', 'Black', '#111111', 1.75, 1.24, 190, 230, 35, 60, NULL, 55, 8, 1, 1, NULL, NULL, NULL,
      '2026-01-02 10:00:00', '2026-01-02 10:00:00');
    INSERT INTO storage_locations VALUES (1, '${ALICE}', 'Shelf 2', NULL, 0, NULL, NULL, NULL, NULL), (2, '${ALICE}', 'P1S AMS A1', NULL, 0, 1, 'ams', 0, 0);
    INSERT INTO spools VALUES
      (1, '${BOB}', 1, 1, 1, NULL, 'L1', NULL, 1000, 250, 982, '2026-01-02 00:00:00', 19.99, 'Bambu store', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'active', NULL,
       '2026-01-02 10:00:00+00:00', '2026-01-03 10:00:00', NULL, '2026-01-04 10:00:00'),
      (2, '${ALICE}', NULL, 2, NULL, 'PolyTerra Gray', NULL, NULL, 1000, NULL, 360, NULL, NULL, NULL, NULL, '#8b8f96', '#ffffff', NULL, NULL, 'PLA', 'PolyTerra', 'storage', 'opened',
       '2026-01-05 10:00:00', NULL, NULL, '2026-01-05 10:00:00');
    INSERT INTO weight_logs VALUES (1, 1, 268, 18, 'after the bezel', '2026-01-04 10:00:00');
    INSERT INTO drying_sessions VALUES (1, 2, 50, 4, '2026-01-05 10:00:00', '2026-01-05 14:00:00', 38, 12, NULL);
    INSERT INTO printers VALUES (1, '${ALICE}', 'Bambu P1S', 'P1S', 'bambu', '01P00A1', '192.168.1.40', '12345678', 'idle', NULL, '2026-01-01 10:00:00', NULL, 2);
    INSERT INTO ams_units VALUES (1, 1, 0, 'AMS 1');
    INSERT INTO ams_slots VALUES (1, 1, 0, 1), (2, 1, 1, NULL), (3, 1, 2, NULL), (4, 1, 3, NULL);
    INSERT INTO projects VALUES (1, '${ALICE}', 'Client order');
    INSERT INTO print_jobs VALUES (1, '${BOB}', 1, NULL, NULL, 1, 'bezel.3mf', 30, 13200, 'success', NULL, '2026-01-04 06:00:00', '2026-01-04 09:40:00'),
      (2, '${BOB}', 1, 1, NULL, NULL, 'not-in-library.3mf', 12, 600, 'failed', 'spaghetti', NULL, '2026-01-04 11:00:00');
    INSERT INTO print_job_spools VALUES (1, 1, 1, 30);
    INSERT INTO print_job_photos VALUES (1, 1, '/photos/1.jpg');
    INSERT INTO alert_rules VALUES (1, '${ALICE}', 'PLA low', 25, 5, 'PLA', 1, 0, 1, '2026-01-01 10:00:00');
    INSERT INTO webhooks VALUES (1, '${ALICE}', 'Home Assistant', 'https://ha.example.com/hook', 'spool.alert,spool.unknown', 's3cret', 1, '2026-01-01 10:00:00', NULL, NULL);
    INSERT INTO system_config VALUES (1, 'smtp.example.com', 587, 'fh', 'pw', 'fh@example.com', 1, 1, NULL);
    INSERT INTO api_keys VALUES ('k1', '${ALICE}', 'script');
  `);
  return fh;
}

try {
  const log = console.log;
  console.log = () => {};
  try {
    initializeDatabase();
  } finally {
    console.log = log;
  }
  const db = database.db;
  db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL,
    session_key TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT, can_delete_files INTEGER NOT NULL DEFAULT 0)`);
  db.prepare("INSERT INTO users (username, password_hash, role, session_key, created_at) VALUES ('admin', 'x', 'admin', 'k', 'now')").run();
  db.prepare("INSERT INTO models (filePath, fileName, dateAdded) VALUES ('/lib/bezel.3mf', 'bezel.3mf', '2026-01-01')").run();
  const accounts = () => db.prepare('SELECT id, username FROM users').all();
  const createUser = (username, role) =>
    Number(
      db.prepare("INSERT INTO users (username, password_hash, role, session_key, created_at) VALUES (?, 'x', ?, 'k', 'now')").run(username, role)
        .lastInsertRowid
    );
  const delivered = {};
  const alertDelivery = { read: () => ({}), save: (input) => Object.assign(delivered, input) };
  const data = fhImport.readSource(filamentHub());

  test('FilamentHub dates become ISO times', () => {
    assert.strictEqual(fhImport.isoDate('2026-01-02 10:00:00.000000'), '2026-01-02T10:00:00.000Z');
    assert.strictEqual(fhImport.isoDate('2026-01-02 10:00:00+02:00'), '2026-01-02T08:00:00.000Z');
    assert.strictEqual(fhImport.isoDate(null), null);
  });

  test('a file without spools is not a FilamentHub database', () => {
    assert.throws(() => fhImport.readSource(new Database(':memory:')), /not a FilamentHub database/);
  });

  test('the preview says what comes in, which accounts match, and what is left out', () => {
    const plan = fhImport.preview(data, db, accounts());
    assert.deepStrictEqual(
      plan.users.map((u) => [u.label, u.match, u.create, u.role]),
      [
        ['admin@example.com', 'admin', null, 'admin'],
        ['bob.builder@example.com', null, 'bob.builder', 'editor']
      ]
    );
    assert.deepStrictEqual(plan.counts.spools, { total: 2, add: 2 });
    assert.deepStrictEqual(
      [plan.counts.locations, plan.counts.prints],
      [
        { total: 1, add: 1 },
        { total: 1, add: 1 }
      ]
    );
    assert.strictEqual(plan.printsWithoutModel, 1);
    assert.deepStrictEqual(plan.leftOut, { projects: 1, printPhotos: 1, apiKeys: 1 });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM spools').get().n, 0, 'nothing written');
  });

  test('the import brings everything over as the plan maps it', () => {
    const result = fhImport.runImport(data, db, { accounts: accounts(), createUser, alertDelivery });
    assert.deepStrictEqual(
      result.added.users.map((u) => u.username),
      ['bob.builder']
    );
    assert.deepStrictEqual(
      { ...result.added, users: undefined },
      {
        users: undefined,
        brands: 2,
        profiles: 1,
        locations: 1,
        spools: 2,
        weighings: 1,
        dryings: 1,
        printers: 1,
        amsUnits: 1,
        prints: 1,
        alertRules: 1,
        webhooks: 1,
        email: true,
        discord: true
      }
    );
    const bob = db.prepare("SELECT id FROM users WHERE username = 'bob.builder'").get().id;
    const black = db.prepare("SELECT * FROM spools WHERE source_ref = 'filamenthub:spools:1'").get();
    assert.deepStrictEqual(
      [black.material, black.used_weight, black.status, black.created_by, black.registered_at, black.purchase_price],
      ['PLA', 982, 'active', bob, '2026-01-02T10:00:00.000Z', 19.99]
    );
    const gray = db.prepare("SELECT * FROM spools WHERE source_ref = 'filamenthub:spools:2'").get();
    assert.deepStrictEqual([gray.name, gray.color_hex, gray.color_hex_2, gray.material_type], ['PolyTerra Gray', '#8b8f96', '#ffffff', 'PolyTerra']);
    const profile = db.prepare("SELECT * FROM filament_profiles WHERE source_ref = 'filamenthub:filament_profiles:1'").get();
    assert.deepStrictEqual([profile.material, profile.source, profile.drying_hours], ['PLA', 'catalog', 8]);
    assert.deepStrictEqual(
      db
        .prepare('SELECT name FROM storage_locations')
        .all()
        .map((l) => l.name),
      ['Shelf 2'],
      "FilamentHub's AMS-slot places are not places here"
    );
    const printer = db.prepare("SELECT * FROM printers WHERE source_ref = 'filamenthub:printers:1'").get();
    assert.deepStrictEqual(
      [printer.nickname, printer.connection_type, printer.serial_number, printer.api_secret, printer.direct_spool_id],
      ['Bambu P1S', 'bambu', '01P00A1', '12345678', gray.id]
    );
    const slots = db
      .prepare(
        'SELECT s.slot_index, s.spool_id FROM printer_ams_slots s JOIN printer_ams_units u ON u.id = s.unit_id WHERE u.printer_id = ? ORDER BY s.slot_index'
      )
      .all(printer.id);
    assert.deepStrictEqual(
      slots.map((s) => s.spool_id),
      [black.id, null, null, null]
    );
    const event = db.prepare("SELECT * FROM print_events WHERE source_ref = 'filamenthub:print_jobs:1'").get();
    assert.deepStrictEqual([event.outcome, event.plate_index, event.duration_seconds, event.printer_id], ['printed', 1, 13200, printer.id]);
    assert.deepStrictEqual(
      { ...db.prepare('SELECT spool_id, grams FROM print_event_spools WHERE event_id = ?').get(event.id) },
      { spool_id: black.id, grams: 30 }
    );
    assert.strictEqual(db.prepare('SELECT used_weight FROM spools WHERE id = ?').get(black.id).used_weight, 982, 'grams are not taken off twice');
    const model = db.prepare("SELECT print_status, print_count FROM models WHERE fileName = 'bezel.3mf'").get();
    assert.deepStrictEqual([model.print_status, model.print_count], ['printed', 1]);
    const hook = db.prepare('SELECT events, secret FROM webhooks').get();
    assert.deepStrictEqual([hook.events, hook.secret], ['spool.low_stock', 's3cret']);
    const rule = db.prepare('SELECT * FROM low_stock_rules').get();
    assert.deepStrictEqual([rule.low_threshold_pct, rule.critical_threshold_pct, rule.material_filter, rule.notify_discord], [25, 5, 'PLA', 1]);
    assert.strictEqual(delivered.smtp.host, 'smtp.example.com');
    assert.strictEqual(delivered.discordWebhookUrl, 'https://discord.com/api/webhooks/9/xyz');
  });

  test('importing the same file again adds nothing', () => {
    const plan = fhImport.preview(data, db, accounts());
    assert.ok(
      Object.values(plan.counts).every((c) => c.add === 0),
      JSON.stringify(plan.counts)
    );
    assert.deepStrictEqual(
      plan.users.map((u) => u.match),
      ['admin', 'bob.builder']
    );
    const again = fhImport.runImport(data, db, {
      accounts: accounts(),
      createUser,
      alertDelivery: { read: () => ({ smtp: { host: 'x' }, discordWebhookUrl: 'y' }), save: () => assert.fail('saved') }
    });
    assert.ok(
      Object.entries(again.added).every(([k, value]) => (k === 'users' ? value.length === 0 : !value)),
      JSON.stringify(again.added)
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM spools').get().n, 2);
  });
} finally {
  if (database.db && database.db.open) database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
