'use strict';

/**
 * SpoolmanDB in the filament catalogue (docs/plan-10.1.md, Phase 13): an admin downloads its
 * published list (https://donkie.github.io/SpoolmanDB/filaments.json, the one Spoolman itself
 * uses; no GitHub API) into catalog/spoolmandb.json next to the database, and "Add from catalogue"
 * then searches it beside the bundled 3dfilamentprofiles.com catalogue. Refresh downloads it
 * again; Remove deletes it. Nothing is downloaded unless an admin asks.
 *
 * The bundled catalogue is a snapshot updated with JusttPrint's releases: 3dfilamentprofiles.com
 * has no list meant for downloading, and JusttPrint does not scrape it.
 */

const fs = require('fs');
const path = require('path');
const profiles = require('../core/filament-profiles');

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

/** What the catalogue holds: the bundled snapshot and SpoolmanDB (when downloaded). */
function status() {
  const { sources } = profiles.loadCatalog();
  return {
    bundled: sources.find((s) => s.id === '3dfilamentprofiles') || null,
    spoolmandb: sources.find((s) => s.id === 'spoolmandb') || null,
    url: SPOOLMANDB_URL
  };
}

/** Download SpoolmanDB (again) into the catalogue. */
async function refresh({ fetchImpl = fetch, now = new Date() } = {}) {
  let response;
  try {
    response = await fetchImpl(SPOOLMANDB_URL, {
      headers: { 'user-agent': 'JusttPrint', accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`Could not reach SpoolmanDB: ${error.message}`, { cause: error });
  }
  if (!response.ok) throw new Error(`SpoolmanDB answered ${response.status}`);
  const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
  if (declared > MAX_BYTES) throw new Error('SpoolmanDB’s list is larger than expected');
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error('SpoolmanDB’s list is larger than expected');
  let list;
  try {
    list = JSON.parse(body);
  } catch (error) {
    throw new Error('SpoolmanDB answered with something that is not its filament list', { cause: error });
  }
  const rows = rowsFrom(list);
  const file = profiles.communityFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written whole, then put in place: a failed download never leaves half a file.
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ source: 'SpoolmanDB (donkie.github.io/SpoolmanDB)', fetchedAt: now.toISOString(), fields: FIELDS, rows }));
  fs.renameSync(temporary, file);
  profiles.forgetCatalog();
  return status();
}

/** Take SpoolmanDB out of the catalogue. Filaments already added from it stay. */
function remove() {
  try {
    fs.unlinkSync(profiles.communityFile());
  } catch (_) {
    /* not there */
  }
  profiles.forgetCatalog();
  return status();
}

module.exports = { SPOOLMANDB_URL, rowsFrom, status, refresh, remove };
