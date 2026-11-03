'use strict';

/**
 * Filament brands and profiles (docs/merge-10.md, Phase 3), and adding one from the filament
 * catalogue (src/core/filament-catalog.js) that "Add from catalogue" searches. A profile is a kind of filament (brand, material, color, temperatures);
 * spools point at one.
 */

const v = require('./filament-values');
const catalog = require('./filament-catalog');

const PROFILE_COLUMNS = [
  'brand_id',
  'name',
  'material',
  'color_name',
  'color_hex',
  'diameter',
  'density',
  'print_temp_min',
  'print_temp_max',
  'bed_temp_min',
  'bed_temp_max',
  'max_print_speed',
  'flow_ratio',
  'td',
  'drying_temp',
  'drying_hours',
  'product_url',
  'photo_url',
  'notes',
  'source',
  'source_ref'
];

/** Every brand, A–Z, with how many profiles and spools use it. */
function listBrands(db) {
  return db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM filament_profiles p WHERE p.brand_id = b.id) AS profile_count,
        (SELECT COUNT(*) FROM spools s WHERE s.brand_id = b.id) AS spool_count
       FROM filament_brands b ORDER BY b.name COLLATE NOCASE`
    )
    .all();
}

/** The brand of that name (any case), made when missing. Returns its id, or null for no name. */
function ensureBrand(db, name, extra = {}) {
  const clean = v.text(name, 100);
  if (!clean) return null;
  const found = db.prepare('SELECT id FROM filament_brands WHERE name = ? COLLATE NOCASE').get(clean);
  if (found) return found.id;
  const at = v.now();
  return Number(
    db
      .prepare('INSERT INTO filament_brands (name, website, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(clean, v.url(extra.website), v.text(extra.sourceRef, 100), at, at).lastInsertRowid
  );
}

/**
 * Rename a brand or change its website. Renaming onto another brand's name merges the two: its
 * filaments and spools move to that brand, and this one goes. Returns the brand kept.
 * @param {any} db
 * @param {{ id?: number | string, name?: string, website?: string | null }} input
 */
function saveBrand(db, input) {
  const id = v.id(input && input.id);
  const name = v.text(input && input.name, 100);
  if (!name) throw new Error('A brand needs a name');
  const at = v.now();
  if (!id) {
    const made = ensureBrand(db, name, { website: input.website });
    return db.prepare('SELECT * FROM filament_brands WHERE id = ?').get(made);
  }
  const brand = db.prepare('SELECT * FROM filament_brands WHERE id = ?').get(id);
  if (!brand) throw new Error('That brand no longer exists');
  const other = db.prepare('SELECT * FROM filament_brands WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id);
  return db.transaction(() => {
    if (other) {
      db.prepare('UPDATE filament_profiles SET brand_id = ?, updated_at = ? WHERE brand_id = ?').run(other.id, at, id);
      db.prepare('UPDATE spools SET brand_id = ?, updated_at = ? WHERE brand_id = ?').run(other.id, at, id);
      if (!other.website && brand.website) db.prepare('UPDATE filament_brands SET website = ? WHERE id = ?').run(brand.website, other.id);
      db.prepare('DELETE FROM filament_brands WHERE id = ?').run(id);
      return { ...db.prepare('SELECT * FROM filament_brands WHERE id = ?').get(other.id), merged: true };
    }
    const website = input.website === undefined ? brand.website : v.url(input.website);
    db.prepare('UPDATE filament_brands SET name = ?, website = ?, updated_at = ? WHERE id = ?').run(name, website, at, id);
    return { ...db.prepare('SELECT * FROM filament_brands WHERE id = ?').get(id), merged: false };
  })();
}

/** Delete a brand; its filaments and spools keep everything else, without a brand. */
function deleteBrand(db, id) {
  return db.prepare('DELETE FROM filament_brands WHERE id = ?').run(id).changes > 0;
}

/** Profiles with their brand name, A–Z by brand then name; `search` matches brand, name, material or color. */
function listProfiles(db, { search = '', material = '' } = {}) {
  const where = [];
  const args = [];
  const q = v.text(search, 100);
  if (q) {
    where.push("(b.name LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.material LIKE ? ESCAPE '\\' OR COALESCE(p.color_name, '') LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like, like);
  }
  const m = v.text(material, 50);
  if (m) {
    where.push('p.material = ? COLLATE NOCASE');
    args.push(m);
  }
  return db
    .prepare(
      `SELECT p.*, b.name AS brand_name, (SELECT COUNT(*) FROM spools s WHERE s.profile_id = p.id) AS spool_count
       FROM filament_profiles p LEFT JOIN filament_brands b ON b.id = p.brand_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY b.name COLLATE NOCASE, p.name COLLATE NOCASE`
    )
    .all(...args)
    .map(withPhoto);
}

/** `photo`: an uploaded photo, else a link to one (docs/plan-10.1.md, Phase 2). */
const withPhoto = (row) => ({ ...row, photo: row.photo_file ? `/api/photo/filament/${row.photo_file}` : row.photo_url || null });

function getProfile(db, id) {
  const row = db.prepare('SELECT p.*, b.name AS brand_name FROM filament_profiles p LEFT JOIN filament_brands b ON b.id = p.brand_id WHERE p.id = ?').get(id);
  return row ? withPhoto(row) : null;
}

/**
 * The checked columns of a profile from the page's form (brand by name or id).
 * @param {any} db
 * @param {any} input
 * @param {any} [existing] The profile being changed: what the input leaves out stays.
 */
function profileValues(db, input, existing = null) {
  const material = v.text(input.material, 50);
  if (!material) throw new Error('A filament needs a material (PLA, PETG, …)');
  const name = v.text(input.name, 200) || [material, v.text(input.color_name, 100)].filter(Boolean).join(' ');
  const source = v.PROFILE_SOURCES.includes(input.source) ? input.source : 'manual';
  const brandId = v.id(input.brand_id) || ensureBrand(db, input.brand_name);
  return {
    brand_id: brandId,
    name,
    material,
    color_name: v.text(input.color_name, 100),
    color_hex: v.color(input.color_hex),
    diameter: v.number(input.diameter, 'Diameter', { min: 0.5, max: 5 }) ?? 1.75,
    density: v.number(input.density, 'Density', { min: 0.1, max: 20 }),
    print_temp_min: v.number(input.print_temp_min, 'Nozzle temperature', { min: 0, max: 600 }),
    print_temp_max: v.number(input.print_temp_max, 'Nozzle temperature', { min: 0, max: 600 }),
    bed_temp_min: v.number(input.bed_temp_min, 'Bed temperature', { min: 0, max: 200 }),
    bed_temp_max: v.number(input.bed_temp_max, 'Bed temperature', { min: 0, max: 200 }),
    max_print_speed: v.number(input.max_print_speed, 'Print speed', { min: 0, max: 5000 }),
    flow_ratio: v.number(input.flow_ratio, 'Flow ratio', { min: 0.5, max: 1.5 }),
    td: v.number(input.td, 'TD', { min: 0, max: 100 }),
    drying_temp: v.number(input.drying_temp, 'Drying temperature', { min: 0, max: 150 }),
    drying_hours: v.number(input.drying_hours, 'Drying time', { min: 0, max: 200 }),
    product_url: v.url(input.product_url),
    photo_url: input.photo_url === undefined ? (existing?.photo_url ?? null) : v.url(input.photo_url),
    notes: v.text(input.notes, 5000),
    source,
    source_ref: v.text(input.source_ref, 100)
  };
}

/** Add a profile (no id) or change one. Returns the saved profile. */
function saveProfile(db, input = {}) {
  const id = v.id(input.id);
  const existing = id ? getProfile(db, id) : null;
  if (id && !existing) throw new Error('That filament no longer exists');
  const values = profileValues(db, input, existing);
  const at = v.now();
  if (id) {
    db.prepare(`UPDATE filament_profiles SET ${PROFILE_COLUMNS.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @at WHERE id = @id`).run({
      ...values,
      at,
      id
    });
    return getProfile(db, id);
  }
  const info = db
    .prepare(
      `INSERT INTO filament_profiles (${PROFILE_COLUMNS.join(', ')}, created_at, updated_at) VALUES (${PROFILE_COLUMNS.map((c) => `@${c}`).join(', ')}, @at, @at)`
    )
    .run({ ...values, at });
  return getProfile(db, Number(info.lastInsertRowid));
}

/** Delete a profile; its spools keep their own material and color. */
function deleteProfile(db, id) {
  return db.prepare('DELETE FROM filament_profiles WHERE id = ?').run(id).changes > 0;
}

// --- The catalogue (src/core/filament-catalog.js) ---

/**
 * Search the catalogue: every word must appear in the brand, material, name or color.
 * @param {any} db
 * @param {string} query
 * @param {{ limit?: number }} [options]
 */
function searchCatalog(db, query, { limit = 50 } = {}) {
  return catalog.search(db, query, { limit });
}

/**
 * The profile for a catalogue filament: the one added from it before (also from the catalogue of
 * 10.0–10.3, whose ids its refs keep), or a new one (source catalog). Returns the profile and the
 * filament, whose weights fill the spool form.
 * @param {any} db
 * @param {number | string} catalogId
 */
function addFromCatalog(db, catalogId) {
  const entry = catalog.getFilament(db, catalogId);
  if (!entry) throw new Error('That filament is not in the catalogue');
  const refs = [`catalog-filament:${entry.id}`, ...catalog.oldIds(db, entry.id).map((ref) => `catalog:${ref}`)];
  const existing = db
    .prepare(`SELECT id FROM filament_profiles WHERE source = 'catalog' AND source_ref IN (${refs.map(() => '?').join(',')}) ORDER BY id LIMIT 1`)
    .get(...refs);
  const material = v.baseMaterial(entry.material) || entry.material;
  const profile = existing
    ? getProfile(db, existing.id)
    : saveProfile(db, {
        brand_name: entry.brand,
        name: entry.name.toLowerCase().includes(entry.material.toLowerCase()) ? entry.name : `${entry.material} ${entry.name}`,
        material,
        color_name: entry.color_name,
        color_hex: entry.color_hex,
        diameter: entry.diameter,
        density: entry.density,
        print_temp_min: entry.print_temp_min,
        print_temp_max: entry.print_temp_max,
        bed_temp_min: entry.bed_temp_min,
        bed_temp_max: entry.bed_temp_max,
        product_url: entry.product_url,
        source: 'catalog',
        source_ref: `catalog-filament:${entry.id}`
      });
  // The spool form starts from the filament: its full material ("PLA Silk") is the spool's material type.
  return { profile, entry, materialType: entry.material === profile.material ? null : entry.material };
}

module.exports = {
  listBrands,
  ensureBrand,
  saveBrand,
  deleteBrand,
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  searchCatalog,
  addFromCatalog
};
