'use strict';

/**
 * The filament catalogue (10.4): one list in the database behind "Add from catalogue", merged from
 * its sources and kept as people change it.
 *
 * Sources: 3dfilamentprofiles.com, a snapshot bundled with JusttPrint (data/filament-catalog.json,
 * read in again when a release brings a newer one), and SpoolmanDB, downloaded when an admin asks
 * (src/server/community-catalog.js). Each update of a source merges its entries in:
 *
 * - Brands match on a folded name (case, spaces, punctuation and endings like "Inc" left out), so
 *   "SUNLU", "Sunlu" and "Sun-Lu" are one brand, named with the spelling most entries use. An
 *   admin can rename brands and merge the ones folding misses; merged keys stay as aliases, so the
 *   next update keeps them together.
 * - Filaments match on their brand, the words of their material and name (product codes in
 *   brackets and words like "Basic" left out, each word once, in any order), their diameter and a
 *   close color. Two entries of one source match only when their full names are the same too
 *   (SpoolmanDB lists each spool size separately; 3dfilamentprofiles.com's codes tell colors apart).
 * - A filament from both sources takes the name, material, color, temperatures and product link
 *   from 3dfilamentprofiles.com and the weights and density from SpoolmanDB; what one lacks the
 *   other fills in.
 *
 * Filaments added by hand (origin manual) and filaments changed by hand (edited) are never changed
 * by an update; one deleted by hand stays hidden instead of coming back. When a source drops an
 * entry, a filament no source has any more goes, unless it was added or changed by hand.
 */

const fs = require('fs');
const path = require('path');
const v = require('./filament-values');

const BUNDLED_FILE = path.join(__dirname, 'data', 'filament-catalog.json');
const SOURCES = {
  '3dfilamentprofiles': '3dfilamentprofiles.com',
  spoolmandb: 'SpoolmanDB'
};
const DETAIL_FIELDS = [
  'name',
  'material',
  'color_name',
  'color_hex',
  'diameter',
  'weight',
  'spool_weight',
  'density',
  'print_temp_min',
  'print_temp_max',
  'bed_temp_min',
  'bed_temp_max',
  'product_url'
];
/** What each source is trusted for when both have a filament. */
const PREFERRED = {
  '3dfilamentprofiles': new Set([
    'name',
    'material',
    'color_name',
    'color_hex',
    'print_temp_min',
    'print_temp_max',
    'bed_temp_min',
    'bed_temp_max',
    'product_url'
  ]),
  spoolmandb: new Set(['weight', 'spool_weight', 'density'])
};
/** Endings that do not tell brands apart ("Matter3D Inc" is Matter3D). */
const BRAND_ENDINGS = new Set(['inc', 'llc', 'ltd', 'gmbh', 'co', 'corp', 'srl', 'bv', 'sa', 'ag', 'oy', 'ab', 'pty', 'limited']);
/** Words left off when suggesting brands that may be the same ("Fusion Filaments" and "Fusion"). */
const BRAND_FILLER = new Set([
  '3d',
  'filament',
  'filaments',
  'printing',
  '3dprinting',
  'print',
  'prints',
  'official',
  'store',
  'shop',
  'tech',
  'technology',
  'the'
]);
/** Words that do not tell filaments apart. */
const FILAMENT_FILLER = new Set(['basic', 'standard', 'other', 'filament', 'the', 'and', 'mm', 'kg', '1kg', '175', '285', '1', '75', '2', '85']);
/**
 * Colors this close (RGB distance) are one color: within one source, and across sources, whose
 * color codes for the same filament often differ more (Polymaker Galaxy Black: #474648, #121d1f).
 */
const SAME_COLOR = 60;
const SAME_COLOR_ACROSS = 150;

// ---- Keys ----

/** Lower case, without accents or ™ ® ©. */
const fold = (value) =>
  String(value || '')
    // Before NFKD, which would make ™ "TM".
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const words = (value) =>
  fold(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A brand's key: its name folded, without endings like "Inc". "" for no name. */
function brandKey(name) {
  const list = words(name);
  while (list.length > 1 && BRAND_ENDINGS.has(list[list.length - 1])) list.pop();
  return list.join('');
}

/** A brand's name without filler words, for suggesting brands that may be the same. */
function brandCore(name) {
  const list = words(name).filter((word) => !BRAND_FILLER.has(word));
  while (list.length > 1 && BRAND_ENDINGS.has(list[list.length - 1])) list.pop();
  return list.join('');
}

/** The words of a filament's material and name that duplicates share, sorted, each once. */
function filamentWords(brand, material, name) {
  const own = brandKey(brand);
  const text = fold(`${material} ${name}`)
    .replace(/pla\+\s*\/\s*pro/g, 'pla+')
    .replace(/\+/g, 'plus ')
    .replace(/\([^)]*\)/g, ' ');
  const list = text.split(/[^a-z0-9]+/).filter((word) => word && !FILAMENT_FILLER.has(word) && word !== own && !words(brand).includes(word));
  return [...new Set(list)].sort().join(' ');
}

const matchKey = (brand, material, name, diameter) => `${filamentWords(brand, material, name)}|${Number(diameter) || 1.75}`;
/** A source entry's full name, to tell two entries of one source apart. */
const fullName = (material, name) => words(`${material} ${name}`).join(' ');
const searchText = (brand, item) => fold([brand, item.material, item.name, item.color_name].filter(Boolean).join(' '));

function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** How far apart two colors are; 0 when either is unknown (a missing color does not keep entries apart). */
function colorDistance(a, b) {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return 0;
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
}

// ---- Source entries ----

const number = (value) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
const text = (value, max = 200) => (value === null || value === undefined ? null : String(value).trim().slice(0, max) || null);
const hex = (value) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
};

/** A catalogue file (`{ source, fetchedAt, fields, rows }`) as entries. */
function readCatalogFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.fields) || !Array.isArray(raw.rows)) throw new Error('Not a filament catalogue file');
  const entries = raw.rows.map((row) => {
    const item = Object.fromEntries(raw.fields.map((field, i) => [field, row[i]]));
    return { ...item, ref: String(item.id) };
  });
  return { fetchedAt: raw.fetchedAt || null, entries };
}

/** An entry with its values checked; null when it has no brand or material. */
function cleanEntry(entry) {
  const brand = text(entry.brand, 100);
  const material = text(entry.material, 60);
  const ref = text(entry.ref, 160);
  if (!brand || !material || !ref || !brandKey(brand)) return null;
  return {
    ref,
    brand,
    name: text(entry.name) || text(entry.color_name) || material,
    material,
    color_name: text(entry.color_name, 100),
    color_hex: hex(entry.color_hex),
    diameter: number(entry.diameter),
    weight: number(entry.weight),
    spool_weight: number(entry.spool_weight),
    density: number(entry.density),
    print_temp_min: number(entry.print_temp_min),
    print_temp_max: number(entry.print_temp_max),
    bed_temp_min: number(entry.bed_temp_min),
    bed_temp_max: number(entry.bed_temp_max),
    product_url: v.url(entry.product_url)
  };
}

// ---- Brands ----

/** The brand a key means (its own key or an alias), or null. */
function brandByKey(db, key) {
  return (
    db.prepare('SELECT * FROM catalog_brands WHERE key = ?').get(key) ||
    db.prepare('SELECT b.* FROM catalog_brand_aliases a JOIN catalog_brands b ON b.id = a.brand_id WHERE a.key = ?').get(key) ||
    null
  );
}

/** The brand of that name, made when missing. `renamed` marks one named by a person. */
function ensureBrand(db, name, { renamed = false } = {}) {
  const clean = text(name, 100);
  const key = brandKey(clean);
  if (!key) throw new Error('A filament needs a brand');
  const found = brandByKey(db, key);
  if (found) return found;
  const at = v.now();
  const id = Number(
    db.prepare('INSERT INTO catalog_brands (name, key, renamed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(clean, key, renamed ? 1 : 0, at, at)
      .lastInsertRowid
  );
  return db.prepare('SELECT * FROM catalog_brands WHERE id = ?').get(id);
}

/** Write a brand's filaments' search text again (after it was renamed or merged). */
function refreshBrandSearch(db, brandId) {
  const brand = db.prepare('SELECT name FROM catalog_brands WHERE id = ?').get(brandId);
  if (!brand) return;
  const update = db.prepare('UPDATE catalog_filaments SET search = ?, match_key = ? WHERE id = ?');
  for (const row of db.prepare('SELECT * FROM catalog_filaments WHERE brand_id = ?').all(brandId)) {
    update.run(searchText(brand.name, row), matchKey(brand.name, row.material, row.name, row.diameter), row.id);
  }
}

/** Brands with how many filaments each has, A–Z; `search` matches the name. */
function listBrands(db, { search = '', limit = 200 } = {}) {
  ensureCatalog(db);
  const q = fold(text(search, 100) || '');
  const rows = db
    .prepare(
      `SELECT b.id, b.name, b.renamed, (SELECT COUNT(*) FROM catalog_filaments f WHERE f.brand_id = b.id AND f.hidden = 0) AS count
       FROM catalog_brands b ${q ? "WHERE lower(b.name) LIKE ? ESCAPE '\\' OR b.key LIKE ? ESCAPE '\\'" : ''}
       ORDER BY b.name COLLATE NOCASE LIMIT ?`
    )
    .all(...(q ? [`%${escapeLike(q)}%`, `%${escapeLike(brandKey(q) || q)}%`] : []), Math.min(Math.max(1, Number(limit) || 200), 1000));
  return rows.map((row) => ({ ...row, renamed: !!row.renamed }));
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Merge brands into one: their filaments move to it, their keys become its aliases (so updates
 * keep them together), and duplicates among the filaments are merged. Returns the brand kept and
 * how many duplicate filaments went.
 * @param {any} db
 * @param {number[]} fromIds
 * @param {number} intoId
 */
function mergeBrands(db, fromIds, intoId) {
  ensureCatalog(db);
  const into = db.prepare('SELECT * FROM catalog_brands WHERE id = ?').get(intoId);
  if (!into) throw new Error('That brand no longer exists');
  const from = [...new Set(fromIds.map(Number))].filter((id) => id && id !== into.id);
  if (!from.length) throw new Error('Choose the brands to merge');
  return db.transaction(() => {
    for (const id of from) {
      const brand = db.prepare('SELECT * FROM catalog_brands WHERE id = ?').get(id);
      if (!brand) continue;
      db.prepare('UPDATE catalog_filaments SET brand_id = ? WHERE brand_id = ?').run(into.id, id);
      db.prepare('UPDATE catalog_brand_aliases SET brand_id = ? WHERE brand_id = ?').run(into.id, id);
      db.prepare('DELETE FROM catalog_brands WHERE id = ?').run(id);
      db.prepare('INSERT OR REPLACE INTO catalog_brand_aliases (key, brand_id) VALUES (?, ?)').run(brand.key, into.id);
    }
    refreshBrandSearch(db, into.id);
    const merged = dedupeBrand(db, into.id);
    return { brand: db.prepare('SELECT * FROM catalog_brands WHERE id = ?').get(into.id), merged };
  })();
}

/**
 * Rename a brand. A name that folds to another brand's key merges the two. The old key stays an
 * alias, so updates still find the brand.
 */
function renameBrand(db, id, name) {
  ensureCatalog(db);
  const clean = text(name, 100);
  const key = brandKey(clean);
  if (!key) throw new Error('A brand needs a name');
  const brand = db.prepare('SELECT * FROM catalog_brands WHERE id = ?').get(id);
  if (!brand) throw new Error('That brand no longer exists');
  const other = brandByKey(db, key);
  if (other && other.id !== brand.id) {
    const result = mergeBrands(db, [brand.id], other.id);
    db.prepare('UPDATE catalog_brands SET name = ?, renamed = 1, updated_at = ? WHERE id = ?').run(clean, v.now(), other.id);
    refreshBrandSearch(db, other.id);
    return { ...result, brand: db.prepare('SELECT * FROM catalog_brands WHERE id = ?').get(other.id) };
  }
  return db.transaction(() => {
    if (key !== brand.key) {
      db.prepare('DELETE FROM catalog_brand_aliases WHERE key = ?').run(key);
      db.prepare('INSERT OR REPLACE INTO catalog_brand_aliases (key, brand_id) VALUES (?, ?)').run(brand.key, brand.id);
    }
    db.prepare('UPDATE catalog_brands SET name = ?, key = ?, renamed = 1, updated_at = ? WHERE id = ?').run(clean, key, v.now(), brand.id);
    refreshBrandSearch(db, brand.id);
    return { brand: db.prepare('SELECT * FROM catalog_brands WHERE id = ?').get(brand.id), merged: 0 };
  })();
}

/** Brands that may be the same: their names match without filler words ("Fusion Filaments", "Fusion"). */
function brandSuggestions(db, { limit = 50 } = {}) {
  ensureCatalog(db);
  const ignored = new Set(
    db
      .prepare('SELECT pair FROM catalog_brand_pairs_ignored')
      .all()
      .map((row) => row.pair)
  );
  const brands = db
    .prepare('SELECT b.id, b.name, b.key, (SELECT COUNT(*) FROM catalog_filaments f WHERE f.brand_id = b.id AND f.hidden = 0) AS count FROM catalog_brands b')
    .all()
    .filter((brand) => brand.count > 0);
  const byCore = new Map();
  for (const brand of brands) {
    const core = brandCore(brand.name);
    if (core.length < 3) continue;
    if (!byCore.has(core)) byCore.set(core, []);
    byCore.get(core).push(brand);
  }
  const groups = [];
  for (const list of byCore.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const keys = list.map((brand) => brand.key).sort();
    if (ignored.has(keys.join('|'))) continue;
    groups.push(list.map(({ id, name, count }) => ({ id, name, count })));
  }
  groups.sort((a, b) => b.reduce((n, x) => n + x.count, 0) - a.reduce((n, x) => n + x.count, 0));
  return groups.slice(0, limit);
}

/** Say brands are not the same, so they are not suggested again. */
function ignoreBrandSuggestion(db, ids) {
  const keys = db
    .prepare(`SELECT key FROM catalog_brands WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids.map(Number))
    .map((row) => row.key)
    .sort();
  if (keys.length < 2) throw new Error('Those brands no longer exist');
  db.prepare('INSERT OR IGNORE INTO catalog_brand_pairs_ignored (pair) VALUES (?)').run(keys.join('|'));
  return true;
}

// ---- Merging ----

/**
 * Merge a brand's duplicate filaments (after brands were merged): same words and diameter, a close
 * color, and not two different entries of one source. The one with the most sources stays; one
 * added or changed by hand is never merged away.
 */
function dedupeBrand(db, brandId) {
  const rows = db.prepare('SELECT * FROM catalog_filaments WHERE brand_id = ? ORDER BY id').all(brandId);
  const refsOf = db.prepare('SELECT source, full_name FROM catalog_filament_refs WHERE filament_id = ?');
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.match_key)) groups.set(row.match_key, []);
    groups.get(row.match_key).push({ ...row, refs: refsOf.all(row.id) });
  }
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) => Number(b.origin === 'manual' || !!b.edited) - Number(a.origin === 'manual' || !!a.edited) || b.refs.length - a.refs.length || a.id - b.id
    );
    const kept = [];
    for (const row of list) {
      const into = kept.find((k) => canMerge(k, row));
      if (!into || row.origin === 'manual' || row.edited) {
        kept.push(row);
        continue;
      }
      db.prepare('UPDATE catalog_filament_refs SET filament_id = ? WHERE filament_id = ?').run(into.id, row.id);
      if (row.hidden && !into.hidden) db.prepare('UPDATE catalog_filaments SET hidden = 1 WHERE id = ?').run(into.id);
      // What the one kept lacks, the other fills in (unless people wrote the one kept).
      const missing = DETAIL_FIELDS.filter((field) => (into[field] === null || into[field] === undefined) && row[field] !== null && row[field] !== undefined);
      if (missing.length && into.origin !== 'manual' && !into.edited) {
        db.prepare(`UPDATE catalog_filaments SET ${missing.map((field) => `${field} = @${field}`).join(', ')} WHERE id = @id`).run({
          ...Object.fromEntries(missing.map((field) => [field, row[field]])),
          id: into.id
        });
        for (const field of missing) into[field] = row[field];
      }
      db.prepare('DELETE FROM catalog_filaments WHERE id = ?').run(row.id);
      into.refs = into.refs.concat(row.refs);
      merged += 1;
    }
  }
  return merged;
}

/** May these two filaments (with their refs) be one? */
function canMerge(a, b) {
  // The same source's entry of the same name is another spool size of it, whatever its color says.
  if (b.refs.length && b.refs.every((ref) => a.refs.some((r) => r.source === ref.source && r.full_name === ref.full_name))) return true;
  const shared = b.refs.some((ref) => a.refs.some((r) => r.source === ref.source)) || !a.refs.length || !b.refs.length;
  if (colorDistance(a.color_hex, b.color_hex) > (shared ? SAME_COLOR : SAME_COLOR_ACROSS)) return false;
  for (const ref of b.refs) {
    const same = a.refs.filter((r) => r.source === ref.source);
    if (same.length && !same.some((r) => r.full_name === ref.full_name)) return false;
  }
  return true;
}

/**
 * Bring one source's entries into the catalogue (see the top of this file). An empty list with
 * `remove` takes the source out. Returns what changed.
 * @param {any} db
 * @param {string} sourceId
 * @param {any[]} rawEntries
 * @param {{ fetchedAt?: string | null, etag?: string | null, remove?: boolean, now?: string }} [options]
 */
function syncSource(db, sourceId, rawEntries, { fetchedAt = null, etag = null, remove = false, now = v.now() } = {}) {
  if (!SOURCES[sourceId]) throw new Error(`Unknown catalogue source ${sourceId}`);
  const entries = rawEntries.map(cleanEntry).filter((entry) => entry !== null);
  const previous = db.prepare('SELECT count FROM catalog_sources WHERE id = ?').get(sourceId);
  if (!remove && !entries.length) throw new Error(`${SOURCES[sourceId]}’s list had no filaments`);
  if (!remove && previous && previous.count > 1000 && entries.length < previous.count / 2) {
    throw new Error(`${SOURCES[sourceId]}’s list has ${entries.length} filaments, under half of the ${previous.count} it had; nothing was changed`);
  }
  // One spool size per filament first (1 kg), so the others merge into it.
  entries.sort((a, b) => Number(a.weight !== 1000) - Number(b.weight !== 1000));

  const report = { source: sourceId, entries: entries.length, added: 0, merged: 0, duplicates: 0, updated: 0, removed: 0, brands: 0 };
  db.transaction(() => {
    const brandIds = new Map();
    for (const row of db.prepare('SELECT id, key FROM catalog_brands').all()) brandIds.set(row.key, row.id);
    for (const row of db.prepare('SELECT key, brand_id FROM catalog_brand_aliases').all()) brandIds.set(row.key, row.brand_id);
    const brandNames = new Map(
      db
        .prepare('SELECT id, name FROM catalog_brands')
        .all()
        .map((row) => [row.id, row.name])
    );

    // The catalogue's filaments by brand and key, with the sources and full names they came from.
    const byKey = new Map();
    const byId = new Map();
    for (const row of db.prepare('SELECT * FROM catalog_filaments').all()) {
      const item = { ...row, refs: [] };
      byId.set(row.id, item);
      const key = `${row.brand_id}|${row.match_key}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    }
    for (const ref of db.prepare('SELECT source, ref, filament_id, full_name FROM catalog_filament_refs').all()) {
      const item = byId.get(ref.filament_id);
      if (item) item.refs.push(ref);
    }
    const ownRefs = new Map(
      db
        .prepare('SELECT ref, filament_id FROM catalog_filament_refs WHERE source = ?')
        .all(sourceId)
        .map((row) => [row.ref, row.filament_id])
    );

    const insertBrand = db.prepare('INSERT INTO catalog_brands (name, key, renamed, created_at, updated_at) VALUES (?, ?, 0, ?, ?)');
    const insertFilament = db.prepare(
      `INSERT INTO catalog_filaments (brand_id, ${DETAIL_FIELDS.join(', ')}, match_key, search, origin, created_at, updated_at)
       VALUES (@brand_id, ${DETAIL_FIELDS.map((f) => `@${f}`).join(', ')}, @match_key, @search, 'source', @at, @at)`
    );
    const updateFilament = db.prepare(
      `UPDATE catalog_filaments SET ${DETAIL_FIELDS.map((f) => `${f} = @${f}`).join(', ')}, match_key = @match_key, search = @search, updated_at = @at WHERE id = @id`
    );
    const insertRef = db.prepare('INSERT OR REPLACE INTO catalog_filament_refs (source, ref, filament_id, full_name) VALUES (?, ?, ?, ?)');

    const spellings = new Map();
    const touched = new Set();
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.ref)) continue;
      seen.add(entry.ref);
      const bKey = brandKey(entry.brand);
      let brandId = brandIds.get(bKey);
      if (!brandId) {
        brandId = Number(insertBrand.run(entry.brand, bKey, now, now).lastInsertRowid);
        brandIds.set(bKey, brandId);
        brandNames.set(brandId, entry.brand);
        report.brands += 1;
      }
      if (!spellings.has(brandId)) spellings.set(brandId, new Map());
      spellings.get(brandId).set(entry.brand, (spellings.get(brandId).get(entry.brand) || 0) + 1);

      const key = matchKey(entry.brand, entry.material, entry.name, entry.diameter);
      const full = fullName(entry.material, entry.name);
      let target = ownRefs.has(entry.ref) ? byId.get(ownRefs.get(entry.ref)) : null;
      if (!target) {
        const incoming = { color_hex: entry.color_hex, refs: [{ source: sourceId, full_name: full }] };
        let best = null;
        let bestDistance = Infinity;
        for (const candidate of byKey.get(`${brandId}|${key}`) || []) {
          if (!canMerge(candidate, incoming)) continue;
          const distance = colorDistance(candidate.color_hex, entry.color_hex);
          if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
        target = best;
        if (target) {
          if (target.refs.some((r) => r.source === sourceId)) report.duplicates += 1;
          else report.merged += 1;
        }
      }

      if (!target) {
        const values = { ...pick(entry), brand_id: brandId, match_key: key, search: searchText(brandNames.get(brandId), entry), at: now };
        const id = Number(insertFilament.run(values).lastInsertRowid);
        target = { ...values, id, origin: 'source', edited: 0, hidden: 0, refs: [] };
        byId.set(id, target);
        if (!byKey.has(`${brandId}|${key}`)) byKey.set(`${brandId}|${key}`, []);
        byKey.get(`${brandId}|${key}`).push(target);
        touched.add(id);
        report.added += 1;
      } else if (!touched.has(target.id) && !target.edited && target.origin !== 'manual') {
        // Each filament takes its details from the first of this source's entries for it (1 kg first).
        touched.add(target.id);
        const onlyThis = target.refs.every((r) => r.source === sourceId);
        const next = { ...target };
        for (const field of DETAIL_FIELDS) {
          if (entry[field] === null || entry[field] === undefined) continue;
          if (onlyThis || PREFERRED[sourceId].has(field) || next[field] === null || next[field] === undefined) next[field] = entry[field];
        }
        next.match_key = matchKey(brandNames.get(target.brand_id), next.material, next.name, next.diameter);
        next.search = searchText(brandNames.get(target.brand_id), next);
        if (DETAIL_FIELDS.some((field) => next[field] !== target[field]) || next.search !== target.search) {
          updateFilament.run({ ...pick(next), match_key: next.match_key, search: next.search, at: now, id: target.id });
          Object.assign(target, next);
          report.updated += 1;
        }
      }
      if (!ownRefs.has(entry.ref) || ownRefs.get(entry.ref) !== target.id) {
        insertRef.run(sourceId, entry.ref, target.id, full);
        target.refs.push({ source: sourceId, ref: entry.ref, full_name: full });
      }
    }

    // Entries the source no longer has; a filament no source has any more goes unless people added or changed it.
    const gone = [...ownRefs.keys()].filter((ref) => !seen.has(ref));
    const dropRef = db.prepare('DELETE FROM catalog_filament_refs WHERE source = ? AND ref = ?');
    const orphans = new Set();
    for (const ref of gone) {
      dropRef.run(sourceId, ref);
      orphans.add(ownRefs.get(ref));
    }
    const left = db.prepare('SELECT COUNT(*) AS n FROM catalog_filament_refs WHERE filament_id = ?');
    const dropFilament = db.prepare("DELETE FROM catalog_filaments WHERE id = ? AND origin = 'source' AND edited = 0");
    for (const id of orphans) {
      if (left.get(id).n === 0) report.removed += dropFilament.run(id).changes;
    }

    // Each brand named with the spelling most of its entries use, unless a person named it.
    const rename = db.prepare('UPDATE catalog_brands SET name = ?, updated_at = ? WHERE id = ? AND renamed = 0');
    for (const [brandId, counts] of spellings) {
      const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      if (best !== brandNames.get(brandId) && rename.run(best, now, brandId).changes) refreshBrandSearch(db, brandId);
    }
    // Brands left with nothing and no name of their own go.
    db.prepare(
      'DELETE FROM catalog_brands WHERE renamed = 0 AND NOT EXISTS (SELECT 1 FROM catalog_filaments f WHERE f.brand_id = catalog_brands.id) AND NOT EXISTS (SELECT 1 FROM catalog_brand_aliases a WHERE a.brand_id = catalog_brands.id)'
    ).run();

    const count = db.prepare('SELECT COUNT(*) AS n FROM catalog_filament_refs WHERE source = ?').get(sourceId).n;
    if (remove) db.prepare('DELETE FROM catalog_sources WHERE id = ?').run(sourceId);
    else {
      db.prepare(
        `INSERT INTO catalog_sources (id, name, fetched_at, checked_at, count, etag, report) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at,
           count = excluded.count, etag = excluded.etag, report = excluded.report`
      ).run(sourceId, SOURCES[sourceId], fetchedAt, now, count, etag, JSON.stringify(report));
    }
  })();
  return report;
}

const pick = (item) => Object.fromEntries(DETAIL_FIELDS.map((field) => [field, item[field] ?? null]));

// ---- Filling the catalogue ----

const ready = new WeakSet();
/** @type {{ fetchedAt: string | null } | null} */
let bundledMeta = null;

/** The bundled snapshot's date, read once. */
function bundledFetchedAt(file = BUNDLED_FILE) {
  if (file !== BUNDLED_FILE) return readCatalogFile(file).fetchedAt;
  const meta = bundledMeta || (bundledMeta = { fetchedAt: readCatalogFile(file).fetchedAt });
  return meta.fetchedAt;
}

/** Where 10.2 and 10.3 kept a downloaded SpoolmanDB (read in once, then deleted). */
function legacySpoolmanFile() {
  return path.join(path.dirname(require('./db-path').getDatabasePath()), 'catalog', 'spoolmandb.json');
}

/**
 * Fill the catalogue the first time it is used, and again when a release brings a newer bundled
 * snapshot. A SpoolmanDB downloaded before 10.4 comes in too. Cheap after the first call.
 * @param {any} db
 * @param {{ file?: string, legacyFile?: string | null }} [options]
 */
function ensureCatalog(db, { file, legacyFile } = {}) {
  // Once per database; a file given (tests: a small snapshot) checks again.
  if (ready.has(db) && !file) return;
  file = file || BUNDLED_FILE;
  const row = db.prepare("SELECT fetched_at, count FROM catalog_sources WHERE id = '3dfilamentprofiles'").get();
  const fetchedAt = bundledFetchedAt(file);
  if (!row || !row.count || row.fetched_at !== fetchedAt) {
    const bundled = readCatalogFile(file);
    const report = syncSource(db, '3dfilamentprofiles', bundled.entries, { fetchedAt: bundled.fetchedAt });
    console.log(
      `[Catalogue] 3dfilamentprofiles.com (${bundled.fetchedAt || 'no date'}): ${report.added} added, ${report.updated} updated, ${report.duplicates} duplicates merged`
    );
  }
  let legacy = legacyFile;
  if (legacy === undefined) {
    try {
      legacy = legacySpoolmanFile();
    } catch (_) {
      legacy = null;
    }
  }
  if (legacy && fs.existsSync(legacy)) {
    try {
      if (!db.prepare("SELECT 1 FROM catalog_sources WHERE id = 'spoolmandb'").get()) {
        const old = readCatalogFile(legacy);
        syncSource(db, 'spoolmandb', old.entries, { fetchedAt: old.fetchedAt });
      }
      fs.unlinkSync(legacy);
    } catch (error) {
      console.warn(`[Catalogue] Could not read the SpoolmanDB downloaded before: ${error.message}`);
    }
  }
  ready.add(db);
}

// ---- Reading ----

const SELECT = `SELECT f.*, b.name AS brand FROM catalog_filaments f JOIN catalog_brands b ON b.id = f.brand_id`;

/** Filament rows as the page shows them, with the sources each came from. */
function present(db, rows) {
  if (!rows.length) return [];
  const sources = new Map();
  for (const row of db
    .prepare(`SELECT filament_id, source FROM catalog_filament_refs WHERE filament_id IN (${rows.map(() => '?').join(',')}) GROUP BY filament_id, source`)
    .all(...rows.map((row) => row.id))) {
    if (!sources.has(row.filament_id)) sources.set(row.filament_id, []);
    sources.get(row.filament_id).push(row.source);
  }
  return rows.map((row) => ({
    id: row.id,
    brand: row.brand,
    brand_id: row.brand_id,
    ...pick(row),
    sources: (sources.get(row.id) || []).sort(),
    manual: row.origin === 'manual',
    edited: !!row.edited
  }));
}

/**
 * Search: every word must appear in the brand, material, name or color. Brands that start with the
 * first word come first. Returns at most `limit` filaments and how many matched.
 */
function search(db, query, { limit = 50 } = {}) {
  ensureCatalog(db);
  const list = fold(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!list.length) return { total: 0, items: [] };
  const where = `f.hidden = 0 AND ${list.map(() => "f.search LIKE ? ESCAPE '\\'").join(' AND ')}`;
  const args = list.map((word) => `%${escapeLike(word)}%`);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM catalog_filaments f WHERE ${where}`).get(...args).n;
  const max = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = db
    .prepare(
      `${SELECT} WHERE ${where} ORDER BY (lower(b.name) LIKE ? ESCAPE '\\') DESC, b.name COLLATE NOCASE, f.material COLLATE NOCASE, f.name COLLATE NOCASE LIMIT ?`
    )
    .all(...args, `${escapeLike(list[0])}%`, max);
  return { total, items: present(db, rows) };
}

function getFilament(db, id) {
  ensureCatalog(db);
  const row = db.prepare(`${SELECT} WHERE f.id = ?`).get(Number(id));
  return row ? present(db, [row])[0] : null;
}

/** The old catalogue ids (10.0–10.3) a filament came from, as profiles' source_ref have them. */
function oldIds(db, id) {
  return db
    .prepare('SELECT ref FROM catalog_filament_refs WHERE filament_id = ?')
    .all(Number(id))
    .map((row) => row.ref);
}

/** What the catalogue holds: each source, how many filaments and brands, and how many duplicates were merged. */
function status(db) {
  ensureCatalog(db);
  const sources = db
    .prepare('SELECT * FROM catalog_sources ORDER BY id')
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      count: row.count,
      fetchedAt: row.fetched_at,
      checkedAt: row.checked_at,
      report: row.report ? JSON.parse(row.report) : null
    }));
  const filaments = db.prepare('SELECT COUNT(*) AS n FROM catalog_filaments WHERE hidden = 0').get().n;
  const brands = db.prepare('SELECT COUNT(DISTINCT brand_id) AS n FROM catalog_filaments WHERE hidden = 0').get().n;
  const manual = db.prepare("SELECT COUNT(*) AS n FROM catalog_filaments WHERE origin = 'manual' AND hidden = 0").get().n;
  const entries = db.prepare('SELECT COUNT(*) AS n FROM catalog_filament_refs').get().n;
  const fromSources = db.prepare('SELECT COUNT(DISTINCT filament_id) AS n FROM catalog_filament_refs').get().n;
  return { sources, filaments, brands, manual, merged: entries - fromSources };
}

// ---- Changing by hand ----

/**
 * Add a filament (no id) or change one. A changed one keeps its details through updates.
 * @param {any} db
 * @param {any} input
 * @param {number | null} [userId]
 */
function saveFilament(db, input = {}, userId = null) {
  ensureCatalog(db);
  const id = v.id(input.id);
  const existing = id ? db.prepare('SELECT * FROM catalog_filaments WHERE id = ?').get(id) : null;
  if (id && !existing) throw new Error('That filament is no longer in the catalogue');
  const material = text(input.material, 60);
  if (!material) throw new Error('A filament needs a material (PLA, PETG, …)');
  const brandName = text(input.brand, 100);
  if (!brandName) throw new Error('A filament needs a brand');
  const values = {
    name: text(input.name) || text(input.color_name, 100) || material,
    material,
    color_name: text(input.color_name, 100),
    color_hex: v.color(input.color_hex),
    diameter: v.number(input.diameter, 'Diameter', { min: 0.5, max: 5 }) ?? 1.75,
    weight: v.number(input.weight, 'Weight', { min: 1, max: 100000 }),
    spool_weight: v.number(input.spool_weight, 'Empty spool', { min: 0, max: 10000 }),
    density: v.number(input.density, 'Density', { min: 0.1, max: 20 }),
    print_temp_min: v.number(input.print_temp_min, 'Nozzle temperature', { min: 0, max: 600 }),
    print_temp_max: v.number(input.print_temp_max, 'Nozzle temperature', { min: 0, max: 600 }),
    bed_temp_min: v.number(input.bed_temp_min, 'Bed temperature', { min: 0, max: 200 }),
    bed_temp_max: v.number(input.bed_temp_max, 'Bed temperature', { min: 0, max: 200 }),
    product_url: v.url(input.product_url)
  };
  const at = v.now();
  return db.transaction(() => {
    const brand = ensureBrand(db, brandName, { renamed: true });
    const row = {
      ...values,
      brand_id: brand.id,
      match_key: matchKey(brand.name, material, values.name, values.diameter),
      search: searchText(brand.name, values),
      at
    };
    if (existing) {
      db.prepare(
        `UPDATE catalog_filaments SET brand_id = @brand_id, ${DETAIL_FIELDS.map((f) => `${f} = @${f}`).join(', ')}, match_key = @match_key, search = @search,
           edited = CASE WHEN origin = 'source' THEN 1 ELSE edited END, hidden = 0, updated_at = @at WHERE id = @id`
      ).run({ ...row, id });
      return getFilament(db, id);
    }
    const made = db
      .prepare(
        `INSERT INTO catalog_filaments (brand_id, ${DETAIL_FIELDS.join(', ')}, match_key, search, origin, created_by, created_at, updated_at)
         VALUES (@brand_id, ${DETAIL_FIELDS.map((f) => `@${f}`).join(', ')}, @match_key, @search, 'manual', @user, @at, @at)`
      )
      .run({ ...row, user: userId || null });
    return getFilament(db, Number(made.lastInsertRowid));
  })();
}

/** Take a filament out of the catalogue. One from a source stays hidden, so updates do not bring it back. */
function deleteFilament(db, id) {
  ensureCatalog(db);
  const row = db.prepare('SELECT id, origin FROM catalog_filaments WHERE id = ?').get(Number(id));
  if (!row) return false;
  const refs = db.prepare('SELECT COUNT(*) AS n FROM catalog_filament_refs WHERE filament_id = ?').get(row.id).n;
  if (row.origin === 'manual' && !refs) return db.prepare('DELETE FROM catalog_filaments WHERE id = ?').run(row.id).changes > 0;
  return db.prepare('UPDATE catalog_filaments SET hidden = 1, updated_at = ? WHERE id = ?').run(v.now(), row.id).changes > 0;
}

module.exports = {
  BUNDLED_FILE,
  SOURCES,
  fold,
  brandKey,
  brandCore,
  filamentWords,
  colorDistance,
  readCatalogFile,
  ensureCatalog,
  syncSource,
  search,
  getFilament,
  oldIds,
  status,
  listBrands,
  ensureBrand,
  renameBrand,
  mergeBrands,
  brandSuggestions,
  ignoreBrandSuggestion,
  saveFilament,
  deleteFilament,
  legacySpoolmanFile
};
