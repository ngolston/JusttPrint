'use strict';

/**
 * Spools (docs/merge-10.md, Phase 3): what you own and how much is left. Remaining grams are
 * initial_weight - used_weight; weighing a spool sets used_weight from the scale and logs it.
 * Everyone on the library shares the spools; created_by only records who added one.
 */

const v = require('./filament-values');
const { ensureBrand, getProfile } = require('./filament-profiles');

/** Under this many grams a spool is running low (the page's light coral ring and its filter). */
const LOW_GRAMS = 300;

const SPOOL_COLUMNS = [
  'profile_id',
  'brand_id',
  'location_id',
  'name',
  'material',
  'material_type',
  'color_hex',
  'color_hex_2',
  'color_hex_3',
  'color_hex_4',
  'initial_weight',
  'spool_weight',
  'used_weight',
  'purchase_date',
  'purchase_price',
  'supplier',
  'product_url',
  'lot_nr',
  'photo_url',
  'status',
  'notes'
];

/**
 * Where each loaded spool is: "P1S · A2" for an AMS slot (unit letter, slot from 1), the printer's
 * name for its own holder. Keyed by spool id.
 */
function loadedPlaces(db) {
  const places = new Map();
  const add = (spoolId, place) => places.set(spoolId, [...(places.get(spoolId) || []), place]);
  for (const row of db
    .prepare(
      `SELECT s.spool_id, p.id AS printer_id, p.nickname, u.unit_index, s.slot_index FROM printer_ams_slots s
       JOIN printer_ams_units u ON u.id = s.unit_id JOIN printers p ON p.id = u.printer_id WHERE s.spool_id IS NOT NULL`
    )
    .all()) {
    add(row.spool_id, { printerId: row.printer_id, label: `${row.nickname} · ${String.fromCharCode(65 + (row.unit_index % 26))}${row.slot_index + 1}` });
  }
  for (const row of db.prepare('SELECT id, nickname, direct_spool_id FROM printers WHERE direct_spool_id IS NOT NULL').all()) {
    add(row.direct_spool_id, { printerId: row.id, label: row.nickname });
  }
  return places;
}

const SPOOL_SELECT = `SELECT s.*, p.name AS profile_name, p.color_name, p.drying_temp AS profile_drying_temp, p.drying_hours AS profile_drying_hours,
    b.name AS brand_name, l.name AS location_name,
    d.id AS drying_id, d.drying_temp AS drying_temp, d.target_hours AS drying_target_hours, d.started_at AS drying_started_at
  FROM spools s
  LEFT JOIN filament_profiles p ON p.id = s.profile_id
  LEFT JOIN filament_brands b ON b.id = s.brand_id
  LEFT JOIN storage_locations l ON l.id = s.location_id
  LEFT JOIN drying_sessions d ON d.spool_id = s.id AND d.finished_at IS NULL`;

/**
 * A spool row as the page reads it: remaining grams, where it is loaded, its drying session and
 * when it runs out.
 * @param {any} row
 * @param {Map<number, any[]>} places
 * @param {Map<number, number> | null} [used] Grams used lately per spool (filament-forecast.js).
 */
function present(row, places, used = null) {
  const remaining = Math.max(0, (Number(row.initial_weight) || 0) - (Number(row.used_weight) || 0));
  const { drying_id, drying_temp, drying_target_hours, drying_started_at, ...rest } = row;
  return {
    ...rest,
    remaining,
    display_name: row.name || row.profile_name || [row.material, row.color_name].filter(Boolean).join(' ') || 'Spool',
    // An uploaded photo, else a link to one (docs/plan-10.1.md, Phase 2).
    photo: row.photo_file ? `/api/photo/spool/${row.photo_file}` : row.photo_url || null,
    loaded: places.get(row.id) || [],
    drying: drying_id ? { id: drying_id, drying_temp, target_hours: drying_target_hours, started_at: drying_started_at } : null,
    // When it runs out at the rate prints used it lately (filament-forecast.js), or null.
    forecast: used ? require('./filament-forecast').forecastOf({ ...row, remaining }, used.get(row.id) || 0) : null
  };
}

/** Spools, fullest first within each status (active, storage, then archived unless left out). */
function listSpools(db, { includeArchived = true } = {}) {
  const places = loadedPlaces(db);
  const used = require('./filament-forecast').recentUse(db);
  return db
    .prepare(
      `${SPOOL_SELECT} ${includeArchived ? '' : "WHERE s.status != 'archived'"}
       ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END, (s.initial_weight - s.used_weight) DESC, s.id`
    )
    .all()
    .map((row) => present(row, places, used));
}

/** One spool with its weighings and drying sessions, newest first; null when there is none. */
function getSpool(db, id) {
  const row = db.prepare(`${SPOOL_SELECT} WHERE s.id = ?`).get(id);
  if (!row) return null;
  return {
    ...present(row, loadedPlaces(db), require('./filament-forecast').recentUse(db)),
    weighings: db.prepare('SELECT * FROM spool_weight_logs WHERE spool_id = ? ORDER BY logged_at DESC, id DESC LIMIT 50').all(id),
    dryings: db.prepare('SELECT * FROM drying_sessions WHERE spool_id = ? ORDER BY started_at DESC, id DESC LIMIT 50').all(id)
  };
}

/**
 * The checked columns of a spool from the page's form. Material and color come from the profile
 * when the form leaves them empty. `remaining` (grams left) may stand in for used_weight.
 */
function spoolValues(db, input, existing) {
  const profile = v.id(input.profile_id) ? getProfile(db, Number(input.profile_id)) : null;
  if (v.id(input.profile_id) && !profile) throw new Error('That filament no longer exists');
  const initial = v.number(input.initial_weight, 'Filament weight', { min: 1, max: 100000 }) ?? existing?.initial_weight ?? null;
  if (initial === null) throw new Error('Enter how much filament the spool holds (grams)');
  const remaining = v.number(input.remaining, 'Grams left', { min: 0, max: 100000 });
  let used = v.number(input.used_weight, 'Grams used', { min: 0, max: 100000 });
  if (remaining !== null) used = Math.max(0, initial - remaining);
  if (used === null) used = existing?.used_weight ?? 0;
  const status = input.status === undefined ? existing?.status || 'storage' : input.status;
  if (!v.SPOOL_STATUSES.includes(status)) throw new Error(`A spool's status is one of ${v.SPOOL_STATUSES.join(', ')}`);
  const material = v.text(input.material, 50) || profile?.material || null;
  if (!material) throw new Error('A spool needs a material (PLA, PETG, …), or a filament from the list');
  const locationId = v.id(input.location_id);
  if (locationId && !db.prepare('SELECT 1 FROM storage_locations WHERE id = ?').get(locationId)) throw new Error('That place no longer exists');
  return {
    profile_id: profile ? profile.id : null,
    brand_id: v.id(input.brand_id) || ensureBrand(db, input.brand_name) || profile?.brand_id || null,
    location_id: locationId,
    name: v.text(input.name, 200),
    material,
    material_type: v.text(input.material_type, 100),
    color_hex: v.color(input.color_hex) || profile?.color_hex || null,
    // Left out of the request (the page's form has one color): kept as they are.
    color_hex_2: input.color_hex_2 === undefined ? (existing?.color_hex_2 ?? null) : v.color(input.color_hex_2),
    color_hex_3: input.color_hex_3 === undefined ? (existing?.color_hex_3 ?? null) : v.color(input.color_hex_3),
    color_hex_4: input.color_hex_4 === undefined ? (existing?.color_hex_4 ?? null) : v.color(input.color_hex_4),
    initial_weight: initial,
    spool_weight: v.number(input.spool_weight, 'Empty spool weight', { min: 0, max: 10000 }),
    used_weight: Math.min(Number(used), initial),
    purchase_date: v.date(input.purchase_date, 'Purchase date'),
    purchase_price: v.number(input.purchase_price, 'Price', { min: 0, max: 1000000 }),
    supplier: v.text(input.supplier, 200),
    product_url: v.url(input.product_url),
    lot_nr: v.text(input.lot_nr, 100),
    photo_url: input.photo_url === undefined ? (existing?.photo_url ?? null) : v.url(input.photo_url),
    status,
    notes: v.text(input.notes, 5000)
  };
}

/** Most spools one Add spool makes at once (`copies`). */
const MAX_COPIES = 50;

/**
 * Add a spool (no id) or change one. Returns the saved spool. Adding with `copies` (2 to 50) adds
 * that many of the same spool at once, in one go; the first is returned, with `added`.
 */
function saveSpool(db, input = {}, { userId = null } = {}) {
  const id = v.id(input.id);
  const copies = input.copies === undefined || input.copies === null || input.copies === '' ? 1 : Number(input.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new Error(`How many is a whole number from 1 to ${MAX_COPIES}`);
  if (!id && copies > 1) {
    return db.transaction(() => {
      const first = saveSpool(db, { ...input, copies: 1 }, { userId });
      for (let i = 1; i < copies; i += 1) saveSpool(db, { ...input, copies: 1 }, { userId });
      return { ...first, added: copies };
    })();
  }
  const existing = id ? db.prepare('SELECT * FROM spools WHERE id = ?').get(id) : null;
  if (id && !existing) throw new Error('That spool no longer exists');
  const values = spoolValues(db, input, existing);
  const at = v.now();
  if (existing) {
    db.prepare(`UPDATE spools SET ${SPOOL_COLUMNS.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @at WHERE id = @id`).run({ ...values, at, id });
    if (values.status === 'archived') unload(db, id);
    return getSpool(db, id);
  }
  const info = db
    .prepare(
      `INSERT INTO spools (${SPOOL_COLUMNS.join(', ')}, created_by, source_ref, registered_at, updated_at)
       VALUES (${SPOOL_COLUMNS.map((c) => `@${c}`).join(', ')}, @created_by, @source_ref, @at, @at)`
    )
    .run({ ...values, created_by: v.id(userId), source_ref: v.text(input.source_ref, 100), at });
  return getSpool(db, Number(info.lastInsertRowid));
}

/** Take a spool out of every AMS slot and printer holder. */
function unload(db, id) {
  db.prepare('UPDATE printer_ams_slots SET spool_id = NULL WHERE spool_id = ?').run(id);
  db.prepare('UPDATE printers SET direct_spool_id = NULL WHERE direct_spool_id = ?').run(id);
}

/**
 * Weigh a spool: `weight` is what the scale shows, with the empty spool (`withSpool`, needs the
 * spool's empty weight) or the filament alone. Sets the grams used and logs the weighing. A spool
 * that weighs more than it was said to hold now holds that much.
 * @param {any} db
 * @param {number} id
 * @param {{ weight?: number | string | null, withSpool?: boolean, notes?: string | null }} [weighing]
 */
function weighSpool(db, id, { weight, withSpool = true, notes = null } = {}) {
  const spool = db.prepare('SELECT * FROM spools WHERE id = ?').get(id);
  if (!spool) throw new Error('That spool no longer exists');
  const measured = v.number(weight, 'Weight', { min: 0, max: 100000 });
  if (measured === null) throw new Error('Enter what the scale shows (grams)');
  if (withSpool && !(Number(spool.spool_weight) >= 0 && spool.spool_weight !== null)) {
    throw new Error("Enter the empty spool's weight first (Edit), or weigh the filament alone");
  }
  const net = Math.max(0, withSpool ? measured - Number(spool.spool_weight) : measured);
  const initial = Math.max(Number(spool.initial_weight) || 0, net);
  const at = v.now();
  db.transaction(() => {
    db.prepare('UPDATE spools SET initial_weight = ?, used_weight = ?, updated_at = ? WHERE id = ?').run(initial, initial - net, at, id);
    db.prepare('INSERT INTO spool_weight_logs (spool_id, measured_weight, net_weight, notes, logged_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      measured,
      net,
      v.text(notes, 300),
      at
    );
  })();
  return getSpool(db, id);
}

/** Put a spool in a place (or none). */
function moveSpool(db, id, locationId) {
  const target = v.id(locationId);
  if (target && !db.prepare('SELECT 1 FROM storage_locations WHERE id = ?').get(target)) throw new Error('That place no longer exists');
  if (!db.prepare('UPDATE spools SET location_id = ?, updated_at = ? WHERE id = ?').run(target, v.now(), id).changes)
    throw new Error('That spool no longer exists');
  return getSpool(db, id);
}

/** Archive a spool (used up or retired: it leaves every printer) or bring it back to storage. */
function archiveSpool(db, id, archived = true) {
  const at = v.now();
  db.transaction(() => {
    if (!db.prepare('UPDATE spools SET status = ?, updated_at = ? WHERE id = ?').run(archived ? 'archived' : 'storage', at, id).changes) {
      throw new Error('That spool no longer exists');
    }
    if (archived) {
      unload(db, id);
      db.prepare('UPDATE drying_sessions SET finished_at = ? WHERE spool_id = ? AND finished_at IS NULL').run(at, id);
    }
  })();
  return getSpool(db, id);
}

/** Delete a spool and its weighings and drying; prints that used it keep their grams. */
function deleteSpool(db, id) {
  return db.prepare('DELETE FROM spools WHERE id = ?').run(id).changes > 0;
}

/**
 * The Filament page's figures, from spools that are not archived: how many, grams left, how many
 * are running low, grams per material (most first), and the colors with their grams.
 */
function filamentSummary(db) {
  const spools = listSpools(db, { includeArchived: false });
  const byMaterial = new Map();
  for (const spool of spools) byMaterial.set(spool.material || 'Other', (byMaterial.get(spool.material || 'Other') || 0) + spool.remaining);
  return {
    spoolCount: spools.length,
    grams: spools.reduce((sum, spool) => sum + spool.remaining, 0),
    lowCount: spools.filter((spool) => spool.remaining < LOW_GRAMS).length,
    archivedCount: db.prepare("SELECT COUNT(*) AS n FROM spools WHERE status = 'archived'").get().n,
    materials: [...byMaterial].map(([material, grams]) => ({ material, grams })).sort((a, b) => b.grams - a.grams),
    colors: spools
      .filter((spool) => spool.color_hex && spool.remaining > 0)
      .map((spool) => ({ color: spool.color_hex, grams: spool.remaining, name: spool.display_name })),
    // What is left is worth, at each spool's price per gram (spools without a price count nothing).
    worth:
      Math.round(
        spools.reduce(
          (sum, spool) =>
            sum +
            (Number(spool.purchase_price) > 0 && Number(spool.initial_weight) > 0
              ? (spool.remaining * Number(spool.purchase_price)) / Number(spool.initial_weight)
              : 0),
          0
        ) * 100
      ) / 100,
    currency: require('./filament-stats').currency(db)
  };
}

module.exports = { LOW_GRAMS, listSpools, getSpool, saveSpool, weighSpool, moveSpool, archiveSpool, deleteSpool, filamentSummary };
