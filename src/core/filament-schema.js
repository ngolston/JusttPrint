'use strict';

/**
 * JusttPrint 10 tables (docs/merge-10.md): filament brands and profiles, spools, storage
 * locations, weighings, drying, AMS units and slots, low-stock rules, webhooks, print photos,
 * the spools a print used, what each plate needs, and a real print queue. Created if missing,
 * columns added if missing, as the other schema functions do; safe to run on every start.
 *
 * Names never reuse 7.0's dropped ones (filaments, model_filaments, print_event_filaments):
 * removeFilamentData() in db-init.js still drops those on every start.
 *
 * Timestamps are ISO 8601 text. `created_by` is a users.id with no foreign key (accounts can be
 * deleted; what they added stays). `source_ref` keeps the id a row had in FilamentHub, so its
 * import (Phase 9) can skip what it already brought over. Allowed values of text columns are
 * listed in comments and checked by the code that writes them, not by CHECK constraints, so a new
 * value never needs a table rebuild.
 */

const { ensurePrinterSchema } = require('./printer-manager');
const { ensurePrintLifecycleSchema } = require('./print-events');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS filament_brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    website TEXT,
    country TEXT,
    logo_url TEXT,
    notes TEXT,
    source_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // source: manual | catalog (FilamentHub's filament_profiles_db.json) | spoolman
  `CREATE TABLE IF NOT EXISTS filament_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER REFERENCES filament_brands(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    material TEXT NOT NULL,
    color_name TEXT,
    color_hex TEXT,
    diameter REAL NOT NULL DEFAULT 1.75,
    density REAL,
    print_temp_min INTEGER,
    print_temp_max INTEGER,
    bed_temp_min INTEGER,
    bed_temp_max INTEGER,
    max_print_speed INTEGER,
    drying_temp INTEGER,
    drying_hours REAL,
    product_url TEXT,
    photo_url TEXT,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    source_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Where spools are kept. Where a loaded spool is comes from the AMS slots and printers.direct_spool_id.
  `CREATE TABLE IF NOT EXISTS storage_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_dry_box INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    source_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Weights in grams: remaining = initial_weight - used_weight; spool_weight is the empty spool.
  // status: active (in rotation) | storage (on the shelf) | archived (used up or retired)
  `CREATE TABLE IF NOT EXISTS spools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER REFERENCES filament_profiles(id) ON DELETE SET NULL,
    brand_id INTEGER REFERENCES filament_brands(id) ON DELETE SET NULL,
    location_id INTEGER REFERENCES storage_locations(id) ON DELETE SET NULL,
    name TEXT,
    material TEXT,
    material_type TEXT,
    color_hex TEXT,
    color_hex_2 TEXT,
    color_hex_3 TEXT,
    color_hex_4 TEXT,
    initial_weight REAL NOT NULL,
    spool_weight REAL,
    used_weight REAL NOT NULL DEFAULT 0,
    purchase_date TEXT,
    purchase_price REAL,
    supplier TEXT,
    product_url TEXT,
    lot_nr TEXT,
    photo_url TEXT,
    status TEXT NOT NULL DEFAULT 'storage',
    notes TEXT,
    created_by INTEGER,
    source_ref TEXT,
    registered_at TEXT NOT NULL,
    first_used_at TEXT,
    last_used_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  // measured_weight is spool and filament on the scale; net_weight the filament alone.
  `CREATE TABLE IF NOT EXISTS spool_weight_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spool_id INTEGER NOT NULL REFERENCES spools(id) ON DELETE CASCADE,
    measured_weight REAL NOT NULL,
    net_weight REAL NOT NULL,
    notes TEXT,
    source_ref TEXT,
    logged_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS drying_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spool_id INTEGER NOT NULL REFERENCES spools(id) ON DELETE CASCADE,
    drying_temp INTEGER,
    target_hours REAL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    humidity_before REAL,
    humidity_after REAL,
    notes TEXT,
    source_ref TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS printer_ams_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    printer_id INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
    unit_index INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    humidity REAL,
    source_ref TEXT,
    UNIQUE (printer_id, unit_index)
  )`,
  `CREATE TABLE IF NOT EXISTS printer_ams_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id INTEGER NOT NULL REFERENCES printer_ams_units(id) ON DELETE CASCADE,
    slot_index INTEGER NOT NULL,
    spool_id INTEGER REFERENCES spools(id) ON DELETE SET NULL,
    source_ref TEXT,
    UNIQUE (unit_id, slot_index)
  )`,
  // Thresholds are percent remaining; material_filter NULL means every material.
  `CREATE TABLE IF NOT EXISTS low_stock_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    low_threshold_pct REAL NOT NULL DEFAULT 20,
    critical_threshold_pct REAL NOT NULL DEFAULT 10,
    material_filter TEXT,
    notify_discord INTEGER NOT NULL DEFAULT 1,
    notify_email INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    source_ref TEXT,
    created_at TEXT NOT NULL
  )`,
  // The last time a rule fired for a spool, so a breach is told once. severity: low | critical
  `CREATE TABLE IF NOT EXISTS low_stock_fired (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL REFERENCES low_stock_rules(id) ON DELETE CASCADE,
    spool_id INTEGER NOT NULL REFERENCES spools(id) ON DELETE CASCADE,
    severity TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    UNIQUE (rule_id, spool_id)
  )`,
  // Admin-only. events: space-separated names; secret signs deliveries (HMAC-SHA256), never sent to the browser.
  `CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '',
    secret TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    source_ref TEXT,
    created_at TEXT NOT NULL,
    last_triggered_at TEXT,
    last_status_code INTEGER
  )`,
  // file_path is relative to the data volume, like thumbnails.
  `CREATE TABLE IF NOT EXISTS print_event_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES print_events(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    caption TEXT,
    source_ref TEXT,
    created_at TEXT NOT NULL
  )`,
  // Grams each spool gave to a logged print. A deleted spool leaves the row (spool_id NULL) so the history keeps its grams.
  `CREATE TABLE IF NOT EXISTS print_event_spools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES print_events(id) ON DELETE CASCADE,
    spool_id INTEGER REFERENCES spools(id) ON DELETE SET NULL,
    grams REAL NOT NULL
  )`,
  // What each plate needs: plate_index and slot as in the 3MF (from 1; plate 0 is every plate).
  // source: 3mf (sliced, with grams) | 3mf-project (not sliced: colors, no grams) | makerworld | manual
  `CREATE TABLE IF NOT EXISTS model_plate_filaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    plate_index INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    material TEXT,
    color_hex TEXT,
    grams REAL,
    source TEXT NOT NULL DEFAULT '3mf',
    UNIQUE (model_id, plate_index, slot)
  )`,
  // Which file model_plate_filaments was read from (size and time, as model_geometry), so a model is read again only when its file changes.
  `CREATE TABLE IF NOT EXISTS model_plate_reads (
    model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
    file_key TEXT NOT NULL,
    source TEXT,
    error TEXT,
    read_at TEXT NOT NULL
  )`,
  // plate_index NULL means every plate. models.print_status stays 'queued' while a model has rows here.
  `CREATE TABLE IF NOT EXISTS print_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    plate_index INTEGER,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    position INTEGER NOT NULL,
    created_by INTEGER,
    created_at TEXT NOT NULL
  )`,
  // Grams set aside for a queued print, so "Ready to print" counts what earlier prints will use.
  `CREATE TABLE IF NOT EXISTS queue_spool_holds (
    queue_id INTEGER NOT NULL REFERENCES print_queue(id) ON DELETE CASCADE,
    spool_id INTEGER NOT NULL REFERENCES spools(id) ON DELETE CASCADE,
    grams REAL NOT NULL,
    PRIMARY KEY (queue_id, spool_id)
  )`
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_filament_profiles_brand ON filament_profiles(brand_id)',
  'CREATE INDEX IF NOT EXISTS idx_filament_profiles_material ON filament_profiles(material)',
  'CREATE INDEX IF NOT EXISTS idx_spools_profile ON spools(profile_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_spools_label_token ON spools(label_token)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_locations_label_token ON storage_locations(label_token)',
  'CREATE INDEX IF NOT EXISTS idx_spools_location ON spools(location_id)',
  'CREATE INDEX IF NOT EXISTS idx_spools_status ON spools(status)',
  'CREATE INDEX IF NOT EXISTS idx_spools_material ON spools(material)',
  'CREATE INDEX IF NOT EXISTS idx_spool_weight_logs_spool ON spool_weight_logs(spool_id)',
  'CREATE INDEX IF NOT EXISTS idx_drying_sessions_spool ON drying_sessions(spool_id)',
  'CREATE INDEX IF NOT EXISTS idx_printer_ams_slots_spool ON printer_ams_slots(spool_id)',
  'CREATE INDEX IF NOT EXISTS idx_low_stock_fired_spool ON low_stock_fired(spool_id)',
  'CREATE INDEX IF NOT EXISTS idx_print_event_photos_event ON print_event_photos(event_id)',
  'CREATE INDEX IF NOT EXISTS idx_print_event_spools_event ON print_event_spools(event_id)',
  'CREATE INDEX IF NOT EXISTS idx_print_event_spools_spool ON print_event_spools(spool_id)',
  'CREATE INDEX IF NOT EXISTS idx_model_plate_filaments_model ON model_plate_filaments(model_id)',
  'CREATE INDEX IF NOT EXISTS idx_print_queue_position ON print_queue(position)',
  'CREATE INDEX IF NOT EXISTS idx_print_queue_model ON print_queue(model_id)',
  'CREATE INDEX IF NOT EXISTS idx_queue_spool_holds_spool ON queue_spool_holds(spool_id)'
];

/** Columns JusttPrint's own tables gain in 10.0: [table, column, definition]. */
const COLUMNS = [
  // connection_type: manual | octoprint | moonraker | bambu. status: idle | printing | paused | error | offline (NULL: not known).
  ['printers', 'connection_type', "TEXT NOT NULL DEFAULT 'manual'"],
  ['printers', 'serial_number', 'TEXT'],
  ['printers', 'api_url', 'TEXT'],
  // FilamentHub's api_key (an API key or a Bambu access code): never sent to the browser, never logged.
  ['printers', 'api_secret', 'TEXT'],
  ['printers', 'status', 'TEXT'],
  ['printers', 'last_seen_at', 'TEXT'],
  // The spool on the printer's own holder, outside any AMS.
  ['printers', 'direct_spool_id', 'INTEGER REFERENCES spools(id) ON DELETE SET NULL'],
  ['printers', 'source_ref', 'TEXT'],
  ['print_events', 'plate_index', 'INTEGER'],
  ['print_events', 'file_name', 'TEXT'],
  ['print_events', 'duration_seconds', 'INTEGER'],
  ['print_events', 'started_at', 'TEXT'],
  ['print_events', 'filament_used_g', 'REAL'],
  ['print_events', 'source_ref', 'TEXT'],
  // An uploaded photo (photos/<kind>/<name>, src/server/photos.js); photo_url stays for a link (10.1).
  ['spools', 'photo_file', 'TEXT'],
  ['filament_profiles', 'photo_file', 'TEXT'],
  // The token a public QR label opens (src/server/label-pages.js; 10.1).
  ['spools', 'label_token', 'TEXT'],
  ['storage_locations', 'label_token', 'TEXT'],
  // What the printer draws while printing, for the cost estimate (src/server/print-cost.js; 10.2).
  ['printers', 'power_watts', 'REAL']
];

/** @param {string} sql */
const tableName = (sql) => (/CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql) || ['', ''])[1];
const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * The first time print_queue exists, the models that are Queued go into it, oldest added first
 * (the order the Queue page showed them in before 10.0). Returns how many were added.
 */
function seedQueueFromStatus(db, now = new Date().toISOString()) {
  const queued = db.prepare("SELECT id FROM models WHERE print_status = 'queued' ORDER BY dateAdded ASC, id ASC").all();
  const insert = db.prepare('INSERT INTO print_queue (model_id, plate_index, printer_id, position, created_by, created_at) VALUES (?, NULL, NULL, ?, NULL, ?)');
  queued.forEach((row, index) => insert.run(row.id, index + 1, now));
  return queued.length;
}

/** Create the 10.0 tables and columns that are missing. Returns the names of the tables it created. */
function ensureFilamentSchema(db) {
  // The tables this one points at come first.
  ensurePrinterSchema(db);
  ensurePrintLifecycleSchema(db);
  const created = [];
  db.transaction(() => {
    for (const sql of TABLES) {
      const name = tableName(sql);
      if (!tableExists(db, name)) created.push(name);
      db.prepare(sql).run();
    }
    for (const [table, column, definition] of COLUMNS) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((c) => c.name === column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
    for (const sql of INDEXES) db.prepare(sql).run();
    if (created.includes('print_queue')) {
      const seeded = seedQueueFromStatus(db);
      if (seeded) console.log(`[Database] Put ${seeded} queued model(s) into the print queue`);
    }
  })();
  if (created.length) console.log(`[Database] Created ${created.length} JusttPrint 10 table(s): ${created.join(', ')}`);
  return created;
}

module.exports = { ensureFilamentSchema, seedQueueFromStatus, FILAMENT_TABLES: TABLES.map(tableName) };
