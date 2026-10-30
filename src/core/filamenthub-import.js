'use strict';

/**
 * Import a FilamentHub database (docs/merge-10.md, Phase 9): its filamenthub.db, read with
 * better-sqlite3, mapped onto JusttPrint 10's tables as the plan's data mapping says. Every row
 * brought over keeps its FilamentHub id in source_ref (filamenthub:<table>:<id>), so importing
 * again skips what is already here. Brands and places with the same name, and printers with the
 * same serial number or name, are used rather than doubled.
 *
 * Accounts: a FilamentHub user is matched to a JusttPrint account by its email's name or its
 * display name; without one, an account is made (operator → editor) with a random password an
 * admin resets. Logged prints need a library model with the job's file name; the others are
 * counted and left out. Their grams are already off FilamentHub's spools, so they are not taken
 * off again. Left out and counted: projects (not decided yet), print photos, API keys and sign-in
 * tokens.
 */

const crypto = require('crypto');
const v = require('./filament-values');

const REF = (table, id) => `filamenthub:${table}:${id}`;

/** FilamentHub's dates ("2026-01-02 10:00:00.000000", with or without a zone) as ISO, or null. */
function isoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  let s = String(value).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Every table JusttPrint reads from the file (missing ones are empty). */
const SOURCE_TABLES = [
  'users',
  'brands',
  'filament_profiles',
  'storage_locations',
  'spools',
  'weight_logs',
  'drying_sessions',
  'printers',
  'ams_units',
  'ams_slots',
  'print_jobs',
  'print_job_spools',
  'print_job_photos',
  'alert_rules',
  'webhooks',
  'system_config',
  'projects',
  'api_keys'
];

/** The file's rows, table by table. Throws when it is not a FilamentHub database. */
function readSource(source) {
  const tables = new Set(
    source
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
  if (!tables.has('spools') || !tables.has('filament_profiles')) throw new Error('This is not a FilamentHub database (no spools or filament_profiles table)');
  const data = {};
  for (const name of SOURCE_TABLES) data[name] = tables.has(name) ? source.prepare(`SELECT * FROM ${name}`).all() : [];
  return data;
}

const has = (db, table, ref) => !!db.prepare(`SELECT 1 FROM ${table} WHERE source_ref = ?`).get(ref);
const roleOf = (role) => (role === 'admin' ? 'admin' : role === 'viewer' ? 'viewer' : 'editor');

/** A username for a FilamentHub user: the email's name, made to fit JusttPrint's rules. */
function usernameFor(user) {
  const base = String(user.email || user.display_name || 'filamenthub')
    .split('@')[0]
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 60);
  return base || 'filamenthub';
}

/** Which JusttPrint account each FilamentHub user is: [{ fhId, label, match, create, role }]. */
function matchUsers(data, accounts) {
  const byName = new Map(accounts.map((account) => [String(account.username).toLowerCase(), account]));
  const taken = new Set(byName.keys());
  return data.users.map((user) => {
    const candidates = [String(user.email || '').split('@')[0], user.display_name].filter(Boolean).map((s) => String(s).toLowerCase());
    const found = candidates.map((name) => byName.get(name)).find(Boolean);
    if (found)
      return { fhId: user.id, label: user.email || user.display_name, match: found.username, matchId: found.id, create: null, role: roleOf(user.role) };
    let name = usernameFor(user);
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${usernameFor(user).slice(0, 56)}-${n}`;
    taken.add(name.toLowerCase());
    return { fhId: user.id, label: user.email || user.display_name, match: null, matchId: null, create: name, role: roleOf(user.role) };
  });
}

/** Models by file name (any case), for print jobs. */
function modelsByFileName(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT id, fileName FROM models').all()) {
    const key = String(row.fileName || '').toLowerCase();
    if (key && !map.has(key)) map.set(key, row.id);
  }
  return map;
}

/**
 * What an import would do, without changing anything: per kind, how many rows the file has and
 * how many are new; the accounts matched and made; what is left out.
 */
function preview(data, db, accounts) {
  const count = (rows, table, kind) => ({ total: rows.length, add: rows.filter((row) => !has(db, table, REF(kind, row.id))).length });
  const models = modelsByFileName(db);
  const jobs = data.print_jobs;
  return {
    users: matchUsers(data, accounts),
    counts: {
      brands: count(data.brands, 'filament_brands', 'brands'),
      profiles: count(data.filament_profiles, 'filament_profiles', 'filament_profiles'),
      // FilamentHub's printer slots as places are not places here (where a spool is loaded comes from the AMS).
      locations: count(
        data.storage_locations.filter((l) => !l.printer_id),
        'storage_locations',
        'storage_locations'
      ),
      spools: count(data.spools, 'spools', 'spools'),
      weighings: count(data.weight_logs, 'spool_weight_logs', 'weight_logs'),
      dryings: count(data.drying_sessions, 'drying_sessions', 'drying_sessions'),
      printers: count(data.printers, 'printers', 'printers'),
      amsUnits: count(data.ams_units, 'printer_ams_units', 'ams_units'),
      // Only jobs whose file is a library model become logged prints.
      prints: count(
        jobs.filter((job) => models.has(String(job.file_name || '').toLowerCase())),
        'print_events',
        'print_jobs'
      ),
      alertRules: count(data.alert_rules, 'low_stock_rules', 'alert_rules'),
      webhooks: count(data.webhooks, 'webhooks', 'webhooks')
    },
    printsWithoutModel: jobs.filter((job) => !models.has(String(job.file_name || '').toLowerCase())).length,
    leftOut: { projects: data.projects.length, printPhotos: data.print_job_photos.length, apiKeys: data.api_keys.length },
    email: data.system_config.some((config) => config.smtp_host),
    discord: data.users.some((user) => user.discord_webhook_url)
  };
}

/**
 * Import everything new in one transaction. `createUser(username, role)` makes an account and
 * returns its id. `alertDelivery` ({ read, save }) takes the email and Discord settings when
 * JusttPrint has none yet. Returns what was added.
 * @param {any} data
 * @param {any} db
 * @param {{ accounts: { id: number, username: string }[], createUser: (username: string, role: string) => number, alertDelivery?: { read: () => any, save: (input: any) => any } }} options
 */
function runImport(data, db, { accounts, createUser, alertDelivery }) {
  const plan = preview(data, db, accounts);
  const now = v.now();
  const added = {
    users: /** @type {{ username: string, role: string, from: string }[]} */ ([]),
    brands: 0,
    profiles: 0,
    locations: 0,
    spools: 0,
    weighings: 0,
    dryings: 0,
    printers: 0,
    amsUnits: 0,
    prints: 0,
    alertRules: 0,
    webhooks: 0,
    email: false,
    discord: false
  };
  const ids = {
    users: new Map(),
    brands: new Map(),
    profiles: new Map(),
    locations: new Map(),
    spools: new Map(),
    printers: new Map(),
    units: new Map(),
    jobs: new Map()
  };
  const ref = (table, kind, id) => db.prepare(`SELECT id FROM ${table} WHERE source_ref = ?`).get(REF(kind, id))?.id;

  db.transaction(() => {
    // Accounts.
    for (const user of plan.users) {
      if (user.matchId) ids.users.set(user.fhId, user.matchId);
      else {
        ids.users.set(user.fhId, createUser(String(user.create), user.role));
        added.users.push({ username: user.create, role: user.role, from: user.label });
      }
    }
    const who = (fhUserId) => ids.users.get(fhUserId) ?? null;

    // Brands (reused by name).
    for (const brand of data.brands) {
      const known =
        ref('filament_brands', 'brands', brand.id) ??
        db.prepare('SELECT id FROM filament_brands WHERE name = ? COLLATE NOCASE').get(String(brand.name || ''))?.id;
      if (known) {
        ids.brands.set(brand.id, known);
        continue;
      }
      if (!v.text(brand.name, 100)) continue;
      const id = db
        .prepare('INSERT INTO filament_brands (name, website, country, logo_url, notes, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          v.text(brand.name, 100),
          v.url(brand.website),
          v.text(brand.country_of_origin, 100),
          v.url(brand.logo_url),
          v.text(brand.notes, 5000),
          REF('brands', brand.id),
          isoDate(brand.created_at) || now,
          now
        ).lastInsertRowid;
      ids.brands.set(brand.id, Number(id));
      added.brands++;
    }

    // Filament profiles.
    for (const p of data.filament_profiles) {
      const known = ref('filament_profiles', 'filament_profiles', p.id);
      if (known) {
        ids.profiles.set(p.id, known);
        continue;
      }
      const id = db
        .prepare(
          `INSERT INTO filament_profiles (brand_id, name, material, color_name, color_hex, diameter, density, print_temp_min, print_temp_max, bed_temp_min, bed_temp_max,
             max_print_speed, drying_temp, drying_hours, product_url, photo_url, notes, source, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ids.brands.get(p.brand_id) ?? null,
          v.text(p.name, 200) || v.text(p.material, 50) || 'Filament',
          v.baseMaterial(p.material) || 'PLA',
          v.text(p.color_name, 100),
          v.color(p.color_hex),
          Number(p.diameter) > 0 ? Number(p.diameter) : 1.75,
          Number(p.density) > 0 ? Number(p.density) : null,
          p.print_temp_min ?? null,
          p.print_temp_max ?? null,
          p.bed_temp_min ?? null,
          p.bed_temp_max ?? null,
          p.max_print_speed ?? null,
          p.drying_temp ?? null,
          p.drying_duration ?? null,
          v.url(p.product_url),
          v.url(p.photo_url),
          v.text(p.notes, 5000),
          p.is_community ? 'catalog' : 'manual',
          REF('filament_profiles', p.id),
          isoDate(p.created_at) || now,
          isoDate(p.updated_at) || now
        ).lastInsertRowid;
      ids.profiles.set(p.id, Number(id));
      added.profiles++;
    }

    // Places (reused by name). FilamentHub's printer slots as places are not places here.
    for (const l of data.storage_locations) {
      if (l.printer_id) continue;
      const known =
        ref('storage_locations', 'storage_locations', l.id) ??
        db.prepare('SELECT id FROM storage_locations WHERE name = ? COLLATE NOCASE').get(String(l.name || ''))?.id;
      if (known) {
        ids.locations.set(l.id, known);
        continue;
      }
      if (!v.text(l.name, 100)) continue;
      const id = db
        .prepare('INSERT INTO storage_locations (name, description, is_dry_box, created_by, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(v.text(l.name, 100), v.text(l.description, 300), l.is_dry_box ? 1 : 0, who(l.owner_id), REF('storage_locations', l.id), now, now).lastInsertRowid;
      ids.locations.set(l.id, Number(id));
      added.locations++;
    }

    // Spools, as they are (their grams used already count FilamentHub's prints).
    for (const s of data.spools) {
      const known = ref('spools', 'spools', s.id);
      if (known) {
        ids.spools.set(s.id, known);
        continue;
      }
      const profileMaterial = data.filament_profiles.find((p) => p.id === s.filament_id)?.material;
      const status = ['active', 'storage', 'archived'].includes(String(s.status)) ? String(s.status) : 'storage';
      const id = db
        .prepare(
          `INSERT INTO spools (profile_id, brand_id, location_id, name, material, material_type, color_hex, color_hex_2, color_hex_3, color_hex_4, initial_weight, spool_weight,
             used_weight, purchase_date, purchase_price, supplier, product_url, lot_nr, photo_url, status, notes, created_by, source_ref, registered_at, first_used_at, last_used_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ids.profiles.get(s.filament_id) ?? null,
          ids.brands.get(s.brand_id) ?? null,
          ids.locations.get(s.location_id) ?? null,
          v.text(s.name, 200),
          v.baseMaterial(s.material || profileMaterial) || 'PLA',
          v.text(s.material_type, 100) || (s.material && v.baseMaterial(s.material) !== String(s.material).toUpperCase() ? v.text(s.material, 100) : null),
          v.color(s.color_hex) || v.color(data.filament_profiles.find((p) => p.id === s.filament_id)?.color_hex),
          v.color(s.extra_color_hex_2),
          v.color(s.extra_color_hex_3),
          v.color(s.extra_color_hex_4),
          Number(s.initial_weight) > 0 ? Number(s.initial_weight) : 1000,
          Number(s.spool_weight) >= 0 && s.spool_weight !== null ? Number(s.spool_weight) : null,
          Math.max(0, Number(s.used_weight) || 0),
          isoDate(s.purchase_date),
          Number(s.purchase_price) >= 0 && s.purchase_price !== null ? Number(s.purchase_price) : null,
          v.text(s.supplier, 200),
          v.url(s.product_url),
          v.text(s.lot_nr, 100),
          v.url(s.photo_url),
          status,
          v.text(s.notes, 5000),
          who(s.owner_id),
          REF('spools', s.id),
          isoDate(s.registered) || now,
          isoDate(s.first_used),
          isoDate(s.last_used),
          now
        ).lastInsertRowid;
      ids.spools.set(s.id, Number(id));
      added.spools++;
    }

    for (const w of data.weight_logs) {
      const spool = ids.spools.get(w.spool_id);
      if (!spool || has(db, 'spool_weight_logs', REF('weight_logs', w.id))) continue;
      db.prepare('INSERT INTO spool_weight_logs (spool_id, measured_weight, net_weight, notes, source_ref, logged_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        spool,
        Number(w.measured_weight) || 0,
        Number(w.net_weight) || 0,
        v.text(w.notes, 300),
        REF('weight_logs', w.id),
        isoDate(w.logged_at) || now
      );
      added.weighings++;
    }

    for (const d of data.drying_sessions) {
      const spool = ids.spools.get(d.spool_id);
      if (!spool || has(db, 'drying_sessions', REF('drying_sessions', d.id))) continue;
      db.prepare(
        'INSERT INTO drying_sessions (spool_id, drying_temp, target_hours, started_at, finished_at, humidity_before, humidity_after, notes, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        spool,
        d.drying_temp ?? null,
        d.target_duration_hours ?? null,
        isoDate(d.started_at) || now,
        isoDate(d.finished_at),
        d.humidity_before ?? null,
        d.humidity_after ?? null,
        v.text(d.notes, 1000),
        REF('drying_sessions', d.id)
      );
      added.dryings++;
    }

    // Printers: the same serial number or name is the same printer.
    for (const p of data.printers) {
      const known =
        ref('printers', 'printers', p.id) ??
        (p.serial_number ? db.prepare('SELECT id FROM printers WHERE serial_number = ?').get(String(p.serial_number))?.id : undefined) ??
        db.prepare('SELECT id FROM printers WHERE nickname = ? COLLATE NOCASE').get(String(p.name || ''))?.id;
      if (known) {
        ids.printers.set(p.id, known);
        continue;
      }
      const type = ['manual', 'octoprint', 'moonraker', 'bambu'].includes(String(p.connection_type)) ? String(p.connection_type) : 'manual';
      const status = ['idle', 'printing', 'paused', 'error', 'offline'].includes(String(p.status)) ? String(p.status) : null;
      const id = db
        .prepare(
          `INSERT INTO printers (nickname, manufacturer, model, printer_type, is_klipper, notes, connection_type, serial_number, api_url, api_secret, status, last_seen_at, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, 'FDM', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          v.text(p.name, 100) || 'Printer',
          type === 'bambu' ? 'Bambu Lab' : null,
          v.text(p.model, 100),
          v.text(p.notes, 5000),
          type,
          v.text(p.serial_number, 100),
          v.text(p.api_url, 500),
          v.text(p.api_key, 500),
          status,
          isoDate(p.last_seen_at),
          REF('printers', p.id),
          isoDate(p.created_at) || now,
          now
        ).lastInsertRowid;
      ids.printers.set(p.id, Number(id));
      added.printers++;
      if (p.direct_spool_id && ids.spools.get(p.direct_spool_id)) {
        db.prepare('UPDATE printers SET direct_spool_id = ? WHERE id = ?').run(ids.spools.get(p.direct_spool_id), Number(id));
      }
    }

    // AMS units and what is loaded in them (a spool in one slot only).
    for (const u of data.ams_units) {
      const printer = ids.printers.get(u.printer_id);
      if (!printer) continue;
      const known =
        ref('printer_ams_units', 'ams_units', u.id) ??
        db.prepare('SELECT id FROM printer_ams_units WHERE printer_id = ? AND unit_index = ?').get(printer, Number(u.unit_index) || 0)?.id;
      if (known) {
        ids.units.set(u.id, known);
        continue;
      }
      const id = Number(
        db
          .prepare('INSERT INTO printer_ams_units (printer_id, unit_index, name, source_ref) VALUES (?, ?, ?, ?)')
          .run(printer, Number(u.unit_index) || 0, v.text(u.name, 100), REF('ams_units', u.id)).lastInsertRowid
      );
      ids.units.set(u.id, id);
      added.amsUnits++;
    }
    for (const slot of data.ams_slots) {
      const unit = ids.units.get(slot.ams_unit_id);
      if (!unit || has(db, 'printer_ams_slots', REF('ams_slots', slot.id))) continue;
      if (db.prepare('SELECT 1 FROM printer_ams_slots WHERE unit_id = ? AND slot_index = ?').get(unit, Number(slot.slot_index) || 0)) continue;
      const spool = slot.spool_id ? (ids.spools.get(slot.spool_id) ?? null) : null;
      if (spool) db.prepare('UPDATE printer_ams_slots SET spool_id = NULL WHERE spool_id = ?').run(spool);
      db.prepare('INSERT INTO printer_ams_slots (unit_id, slot_index, spool_id, source_ref) VALUES (?, ?, ?, ?)').run(
        unit,
        Number(slot.slot_index) || 0,
        spool,
        REF('ams_slots', slot.id)
      );
    }

    // Logged prints, for jobs whose file is a library model; their grams are already off the spools.
    const models = modelsByFileName(db);
    const touched = new Set();
    for (const job of data.print_jobs) {
      if (has(db, 'print_events', REF('print_jobs', job.id))) continue;
      const modelId = models.get(String(job.file_name || '').toLowerCase());
      if (!modelId) continue;
      const outcome = job.outcome === 'failed' ? 'failed' : job.outcome === 'cancelled' ? 'cancelled' : 'printed';
      const at = isoDate(job.finished_at) || isoDate(job.started_at) || now;
      const event = Number(
        db
          .prepare(
            `INSERT INTO print_events (model_id, printed_at, outcome, quantity, notes, created_at, printer_id, plate_index, file_name, duration_seconds, started_at, filament_used_g, source_ref)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            modelId,
            at,
            outcome,
            v.text(job.notes, 5000),
            at,
            ids.printers.get(job.printer_id) ?? null,
            Number(job.plate_number) > 0 ? Number(job.plate_number) : null,
            v.text(job.file_name, 300),
            Number(job.duration_seconds) > 0 ? Number(job.duration_seconds) : null,
            isoDate(job.started_at),
            Number(job.filament_used_g) > 0 ? Number(job.filament_used_g) : null,
            REF('print_jobs', job.id)
          ).lastInsertRowid
      );
      const uses = data.print_job_spools.filter((use) => use.print_job_id === job.id);
      const insertUse = db.prepare('INSERT INTO print_event_spools (event_id, spool_id, grams) VALUES (?, ?, ?)');
      if (uses.length) for (const use of uses) insertUse.run(event, ids.spools.get(use.spool_id) ?? null, Number(use.filament_used_g) || 0);
      else if (job.spool_id && Number(job.filament_used_g) > 0) insertUse.run(event, ids.spools.get(job.spool_id) ?? null, Number(job.filament_used_g));
      touched.add(modelId);
      added.prints++;
    }
    // Print counts and last printed, as Log Print keeps them.
    if (touched.size) {
      const printEvents = require('./print-events');
      for (const modelId of touched) {
        const status = db.prepare('SELECT print_status FROM models WHERE id = ?').get(modelId)?.print_status;
        if (!status || status === 'unprinted' || status === 'want') db.prepare("UPDATE models SET print_status = 'printed' WHERE id = ?").run(modelId);
        printEvents.refreshPrintDerivedFields(db, modelId);
      }
    }

    for (const rule of data.alert_rules) {
      if (has(db, 'low_stock_rules', REF('alert_rules', rule.id))) continue;
      const low = Number(rule.low_threshold_pct) || 20;
      const critical = Math.min(Number(rule.critical_threshold_pct) || 10, low - 1);
      db.prepare(
        `INSERT INTO low_stock_rules (name, low_threshold_pct, critical_threshold_pct, material_filter, notify_discord, notify_email, is_active, created_by, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        v.text(rule.name, 100) || 'Low stock',
        low,
        Math.max(0, critical),
        v.baseMaterial(rule.material_filter),
        rule.notify_discord ? 1 : 0,
        rule.notify_email ? 1 : 0,
        rule.is_active === 0 ? 0 : 1,
        who(rule.owner_id),
        REF('alert_rules', rule.id),
        isoDate(rule.created_at) || now
      );
      added.alertRules++;
    }

    for (const hook of data.webhooks) {
      if (has(db, 'webhooks', REF('webhooks', hook.id))) continue;
      const events = String(hook.events || '')
        .split(',')
        .map((event) => event.trim())
        .map((event) => (event === 'spool.alert' ? 'spool.low_stock' : event))
        .filter((event) => ['spool.low_stock', 'print.logged', 'models.added'].includes(event));
      db.prepare(
        'INSERT INTO webhooks (name, url, events, secret, is_active, created_by, source_ref, created_at, last_triggered_at, last_status_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        v.text(hook.name, 100) || 'Webhook',
        String(hook.url || ''),
        events.join(' '),
        v.text(hook.secret, 500),
        hook.is_active === 0 ? 0 : 1,
        who(hook.owner_id),
        REF('webhooks', hook.id),
        isoDate(hook.created_at) || now,
        isoDate(hook.last_triggered_at),
        hook.last_status_code ?? null
      );
      added.webhooks++;
    }
  })();

  // Email and Discord, when JusttPrint has none yet (outside the transaction: a separate setting).
  if (alertDelivery) {
    const current = alertDelivery.read();
    const config = data.system_config.find((c) => c.smtp_host);
    if (config && !(current.smtp && current.smtp.host)) {
      try {
        alertDelivery.save({
          smtp: {
            host: config.smtp_host,
            port: config.smtp_port ?? null,
            secure: Number(config.smtp_port) === 465,
            user: config.smtp_user || '',
            password: config.smtp_password || '',
            from: config.smtp_from || ''
          }
        });
        added.email = true;
      } catch (_) {
        /* settings JusttPrint does not accept are left out */
      }
    }
    const discord = data.users.map((user) => user.discord_webhook_url).find(Boolean);
    if (discord && !current.discordWebhookUrl) {
      try {
        alertDelivery.save({ discordWebhookUrl: discord });
        added.discord = true;
      } catch (_) {
        /* not a Discord webhook address */
      }
    }
  }

  return { added, printsWithoutModel: plan.printsWithoutModel, leftOut: plan.leftOut };
}

/** A random password for an account made by the import (nobody knows it; an admin sets one). */
const randomPassword = () => crypto.randomBytes(18).toString('base64url');

module.exports = { readSource, preview, runImport, matchUsers, isoDate, randomPassword, REF };
