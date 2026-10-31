'use strict';

/**
 * Filament brands and profiles (docs/merge-10.md, Phase 3), and the bundled filament catalogue
 * (src/core/data/filament-catalog.json, built by scripts/build-filament-catalog.js) that "Add from
 * catalogue" searches. A profile is a kind of filament (brand, material, color, temperatures);
 * spools point at one.
 */

const path = require('path');
const fs = require('fs');
const v = require('./filament-values');

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
    .all(...args);
}

function getProfile(db, id) {
  return (
    db.prepare('SELECT p.*, b.name AS brand_name FROM filament_profiles p LEFT JOIN filament_brands b ON b.id = p.brand_id WHERE p.id = ?').get(id) || null
  );
}

/** The checked columns of a profile from the page's form (brand by name or id). */
function profileValues(db, input) {
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
    drying_temp: v.number(input.drying_temp, 'Drying temperature', { min: 0, max: 150 }),
    drying_hours: v.number(input.drying_hours, 'Drying time', { min: 0, max: 200 }),
    product_url: v.url(input.product_url),
    photo_url: v.url(input.photo_url),
    notes: v.text(input.notes, 5000),
    source,
    source_ref: v.text(input.source_ref, 100)
  };
}

/** Add a profile (no id) or change one. Returns the saved profile. */
function saveProfile(db, input = {}) {
  const values = profileValues(db, input);
  const at = v.now();
  const id = v.id(input.id);
  if (id) {
    if (!getProfile(db, id)) throw new Error('That filament no longer exists');
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

// --- The bundled catalogue ---

const CATALOG_FILE = path.join(__dirname, 'data', 'filament-catalog.json');
/** @type {{ source: string, fetchedAt: string | null, items: any[] } | null} */
let catalog = null;

/** The catalogue, read once (about 27,000 filaments). */
function loadCatalog(file = CATALOG_FILE) {
  if (catalog && file === CATALOG_FILE) return catalog;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = raw.rows.map((row) => {
    const item = Object.fromEntries(raw.fields.map((field, i) => [field, row[i]]));
    item.search = `${item.brand} ${item.name} ${item.material} ${item.color_name || ''}`.toLowerCase();
    return item;
  });
  const loaded = { source: raw.source, fetchedAt: raw.fetchedAt, items };
  if (file === CATALOG_FILE) catalog = loaded;
  return loaded;
}

/** Catalogue entries as the page shows them (without the search text). */
const publicItem = ({ search, ...item }) => item;

/**
 * Search the catalogue: every word must appear in the brand, name, material or color. Brands that
 * start with the first word come first. Returns at most `limit` entries and how many matched.
 * @param {string} query
 * @param {{ limit?: number, file?: string }} [options]
 */
function searchCatalog(query, { limit = 50, file } = {}) {
  const { items, source, fetchedAt } = loadCatalog(file);
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return { total: 0, items: [], source, fetchedAt };
  const matches = items.filter((item) => words.every((word) => item.search.includes(word)));
  const first = words[0];
  matches.sort((a, b) => Number(!a.brand.toLowerCase().startsWith(first)) - Number(!b.brand.toLowerCase().startsWith(first)));
  const max = Math.min(Math.max(1, Number(limit) || 50), 200);
  return { total: matches.length, items: matches.slice(0, max).map(publicItem), source, fetchedAt };
}

/**
 * The profile for a catalogue entry: the one added from it before, or a new one (source catalog).
 * Returns the profile and the entry, whose weights fill the spool form.
 * @param {any} db
 * @param {string} catalogId
 * @param {{ file?: string }} [options]
 */
function addFromCatalog(db, catalogId, { file } = {}) {
  const entry = loadCatalog(file).items.find((item) => item.id === String(catalogId));
  if (!entry) throw new Error('That filament is not in the catalogue');
  const existing = db.prepare("SELECT id FROM filament_profiles WHERE source = 'catalog' AND source_ref = ?").get(`catalog:${entry.id}`);
  const profile = existing
    ? getProfile(db, existing.id)
    : saveProfile(db, {
        brand_name: entry.brand,
        name: `${entry.material} ${entry.name}`,
        material: v.baseMaterial(entry.material) || entry.material,
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
        source_ref: `catalog:${entry.id}`
      });
  // The spool form starts from the entry: its full material ("PLA Silk") is the spool's material type.
  return { profile, entry: publicItem(entry), materialType: entry.material === profile.material ? null : entry.material };
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
  loadCatalog,
  searchCatalog,
  addFromCatalog
};
