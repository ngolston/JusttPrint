'use strict';

/**
 * SpoolmanDB in the filament catalogue (docs/plan-10.1.md, Phase 13; merged since 10.4): an admin
 * checks for updates of its published list (https://donkie.github.io/SpoolmanDB/filaments.json,
 * the one Spoolman itself uses; no GitHub API), and a new list is merged into the catalogue
 * (src/core/filament-catalog.js). Remove takes it out again. Nothing is downloaded unless an admin
 * asks.
 *
 * The bundled catalogue is a snapshot updated with JusttPrint's releases: 3dfilamentprofiles.com
 * has no list meant for downloading, and JusttPrint does not scrape it.
 */

const catalog = require('../core/filament-catalog');

const SPOOLMANDB_URL = 'https://donkie.github.io/SpoolmanDB/filaments.json';
const MAX_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;
const FIELDS = [
  'id',
  'brand',
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

const text = (value) => (value === null || value === undefined ? null : String(value).trim().slice(0, 200) || null);
const number = (value) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
const hex = (value) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
};
/** A temperature and a range ([min, max]) → [min, max]. */
const temps = (single, range) => {
  if (Array.isArray(range) && range.length === 2) return [number(range[0]), number(range[1])];
  const n = number(single);
  return [n, n];
};

/** SpoolmanDB's entries → catalogue rows ("sdb:" ids, so they never meet the bundled ones). */
function rowsFrom(list) {
  if (!Array.isArray(list)) throw new Error('SpoolmanDB answered with something that is not its filament list');
  const seen = new Set();
  const rows = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !entry.id || !entry.manufacturer || !entry.material) continue;
    const id = `sdb:${String(entry.id).slice(0, 150)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const [printMin, printMax] = temps(entry.extruder_temp, entry.extruder_temp_range);
    const [bedMin, bedMax] = temps(entry.bed_temp, entry.bed_temp_range);
    const color = hex(entry.color_hex) || (Array.isArray(entry.color_hexes) ? hex(entry.color_hexes[0]) : null);
    rows.push([
      id,
      text(entry.manufacturer),
      text(entry.name),
      text(entry.material),
      null,
      color,
      number(entry.diameter),
      number(entry.weight),
      number(entry.spool_weight),
      number(entry.density),
      printMin,
      printMax,
      bedMin,
      bedMax,
      null
    ]);
  }
  if (!rows.length) throw new Error('SpoolmanDB’s list had no filaments');
  return rows;
}

/** What the catalogue holds (filament-catalog.js status), and where SpoolmanDB comes from. */
function status(db) {
  return { ...catalog.status(db), url: SPOOLMANDB_URL };
}

/** Rows (under FIELDS) → the entries catalog.syncSource takes. */
const entriesFrom = (rows) =>
  rows.map((row) => {
    const entry = Object.fromEntries(FIELDS.map((field, i) => [field, row[i]]));
    return { ...entry, ref: entry.id };
  });

/**
 * Check SpoolmanDB for a newer list and merge it into the catalogue. Asks with the ETag of the list
 * it has, so an unchanged list is not downloaded again (`upToDate`). `force` downloads anyway.
 * @param {any} db
 * @param {{ fetchImpl?: typeof fetch, now?: Date, force?: boolean }} [options]
 */
async function refresh(db, { fetchImpl = fetch, now = new Date(), force = false } = {}) {
  const known = db.prepare("SELECT etag, count FROM catalog_sources WHERE id = 'spoolmandb'").get();
  const headers = { 'user-agent': 'JusttPrint', accept: 'application/json' };
  if (known && known.etag && known.count && !force) headers['if-none-match'] = known.etag;
  let response;
  try {
    response = await fetchImpl(SPOOLMANDB_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not reach SpoolmanDB: ${error.message}`, { cause: error });
  }
  const header = (name) => (response.headers && response.headers.get ? response.headers.get(name) : null);
  if (response.status === 304) {
    db.prepare("UPDATE catalog_sources SET checked_at = ? WHERE id = 'spoolmandb'").run(now.toISOString());
    return { ...status(db), upToDate: true, report: null };
  }
  if (!response.ok) throw new Error(`SpoolmanDB answered ${response.status}`);
  const declared = Number(header('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('SpoolmanDB’s list is larger than expected');
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error('SpoolmanDB’s list is larger than expected');
  let list;
  try {
    list = JSON.parse(body);
  } catch (error) {
    throw new Error('SpoolmanDB answered with something that is not its filament list', { cause: error });
  }
  const report = catalog.syncSource(db, 'spoolmandb', entriesFrom(rowsFrom(list)), {
    fetchedAt: now.toISOString(),
    etag: header('etag'),
    now: now.toISOString()
  });
  return { ...status(db), upToDate: false, report };
}

/** Take SpoolmanDB out of the catalogue. Filaments only it had go; profiles added from them stay. */
function remove(db) {
  catalog.ensureCatalog(db);
  const report = catalog.syncSource(db, 'spoolmandb', [], { remove: true });
  return { ...status(db), report };
}

module.exports = { SPOOLMANDB_URL, FIELDS, rowsFrom, status, refresh, remove };
