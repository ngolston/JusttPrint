'use strict';

/**
 * Import spools from Spoolman (docs/merge-10.md, Phase 3; after FilamentHub's
 * services/import_export.py). Takes what Spoolman's API returns for /api/v1/spool (spools with
 * their filament and vendor nested), its JSON export (the same fields flattened to
 * "filament.vendor.name"), or { spools: [...] }. Vendors become brands, filaments profiles,
 * locations places. Each spool keeps its Spoolman id (source_ref spoolman:<id>), so importing the
 * same file again skips what is already here.
 */

const v = require('./filament-values');
const { ensureBrand, saveProfile } = require('./filament-profiles');
const { saveSpool } = require('./spools');

/** { "filament.vendor.name": "X" } → { filament: { vendor: { name: "X" } } }; nested objects pass through. */
function unflatten(record) {
  if (!record || typeof record !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }
    const last = parts[parts.length - 1];
    node[last] =
      value && typeof value === 'object' && !Array.isArray(value) && node[last] && typeof node[last] === 'object' ? { ...node[last], ...value } : value;
  }
  return out;
}

/** The spools in an uploaded Spoolman file, or an error for anything else. */
function spoolmanRecords(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.spools) ? data.spools : null;
  if (!list) throw new Error('This is not a Spoolman export: expected a list of spools');
  return list.map(unflatten);
}

/** A place by name, made when missing. */
function ensureLocation(db, name, userId) {
  const clean = v.text(name, 100);
  if (!clean) return null;
  const found = db.prepare('SELECT id FROM storage_locations WHERE name = ? COLLATE NOCASE').get(clean);
  if (found) return found.id;
  const at = v.now();
  return Number(
    db.prepare('INSERT INTO storage_locations (name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?)').run(clean, v.id(userId), at, at).lastInsertRowid
  );
}

/** The profile for a Spoolman filament: one imported before (by its id), one of the same brand, name and material, or a new one. */
function profileFor(db, filament, brandId) {
  const ref = filament.id !== undefined && filament.id !== null ? `spoolman-filament:${filament.id}` : null;
  if (ref) {
    const found = db.prepare('SELECT id FROM filament_profiles WHERE source_ref = ?').get(ref);
    if (found) return { id: found.id, created: false };
  }
  const material = v.text(filament.material, 50) || 'PLA';
  const name = v.text(filament.name, 200) || material;
  const same = db
    .prepare('SELECT id FROM filament_profiles WHERE COALESCE(brand_id, 0) = ? AND name = ? COLLATE NOCASE AND material = ? COLLATE NOCASE')
    .get(brandId || 0, name, material);
  if (same) return { id: same.id, created: false };
  const multi = String(filament.multi_color_hexes || '')
    .split(',')
    .map(v.color)
    .filter(Boolean);
  const profile = saveProfile(db, {
    brand_id: brandId,
    name,
    material,
    color_hex: v.color(filament.color_hex) || multi[0] || null,
    diameter: filament.diameter,
    density: filament.density,
    print_temp_min: filament.settings_extruder_temp,
    print_temp_max: filament.settings_extruder_temp,
    bed_temp_min: filament.settings_bed_temp,
    bed_temp_max: filament.settings_bed_temp,
    notes: v.text(filament.comment, 5000),
    source: 'spoolman',
    source_ref: ref
  });
  return { id: profile.id, created: true };
}

/**
 * Import the spools in `data`. Returns how many came in, how many were already here, how many
 * could not be read (with the first few reasons), and the brands, filaments and places made.
 */
function importSpoolman(db, data, { userId = null } = {}) {
  const records = spoolmanRecords(data);
  const summary = { imported: 0, alreadyHere: 0, skipped: 0, problems: /** @type {string[]} */ ([]), brands: 0, profiles: 0, locations: 0 };
  const brandsBefore = db.prepare('SELECT COUNT(*) AS n FROM filament_brands').get().n;
  const locationsBefore = db.prepare('SELECT COUNT(*) AS n FROM storage_locations').get().n;
  db.transaction(() => {
    records.forEach((record, index) => {
      const ref = record.id !== undefined && record.id !== null ? `spoolman:${record.id}` : null;
      if (ref && db.prepare('SELECT 1 FROM spools WHERE source_ref = ?').get(ref)) {
        summary.alreadyHere++;
        return;
      }
      try {
        const filament = record.filament && typeof record.filament === 'object' ? record.filament : {};
        const vendor = filament.vendor && typeof filament.vendor === 'object' ? filament.vendor : {};
        const brandId = ensureBrand(db, vendor.name, { website: vendor.website });
        const profile = profileFor(db, filament, brandId);
        if (profile.created) summary.profiles++;
        const initial = v.number(record.initial_weight ?? filament.weight, 'Filament weight', { min: 0 }) || 1000;
        const used =
          v.number(record.used_weight, 'Grams used', { min: 0 }) ??
          (v.number(record.remaining_weight, 'Grams left', { min: 0 }) !== null ? Math.max(0, initial - Number(record.remaining_weight)) : 0);
        const multi = String(filament.multi_color_hexes || '')
          .split(',')
          .map(v.color)
          .filter(Boolean);
        const spool = saveSpool(
          db,
          {
            profile_id: profile.id,
            brand_id: brandId,
            location_id: ensureLocation(db, record.location, userId),
            material: filament.material,
            color_hex: v.color(filament.color_hex) || multi[0] || null,
            color_hex_2: multi[1],
            color_hex_3: multi[2],
            color_hex_4: multi[3],
            initial_weight: initial,
            used_weight: Math.min(used, initial),
            spool_weight: record.spool_weight ?? filament.spool_weight,
            purchase_price: record.price ?? filament.price,
            lot_nr: record.lot_nr,
            notes: record.comment,
            status: record.archived ? 'archived' : 'storage',
            source_ref: ref
          },
          { userId }
        );
        const dates = {
          registered_at: v.date(record.registered, 'Registered'),
          first_used_at: v.date(record.first_used, 'First used'),
          last_used_at: v.date(record.last_used, 'Last used')
        };
        db.prepare(
          'UPDATE spools SET registered_at = COALESCE(@registered_at, registered_at), first_used_at = @first_used_at, last_used_at = @last_used_at WHERE id = @id'
        ).run({
          ...dates,
          id: spool.id
        });
        summary.imported++;
      } catch (error) {
        summary.skipped++;
        if (summary.problems.length < 5) summary.problems.push(`Spool ${record.id ?? index + 1}: ${error.message}`);
      }
    });
  })();
  summary.brands = db.prepare('SELECT COUNT(*) AS n FROM filament_brands').get().n - brandsBefore;
  summary.locations = db.prepare('SELECT COUNT(*) AS n FROM storage_locations').get().n - locationsBefore;
  return summary;
}

module.exports = { importSpoolman, unflatten, spoolmanRecords };
