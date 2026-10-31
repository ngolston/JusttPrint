'use strict';

/**
 * Spools out and in (docs/plan-10.1.md, Phase 10): export as CSV or JSON, and import a CSV
 * (FilamentHub's export, a spreadsheet, another app's) with each column matched to a spool field,
 * guessed from its heading and changeable before importing. Every row goes through saveSpool, so
 * the same checks apply; a row that fails is reported with its line and the others still come in.
 * A row already imported (the same values) is skipped, so importing a file twice adds nothing.
 */

const crypto = require('crypto');
const spools = require('./spools');

// ---- Export ----

/** The export's columns, in order (headings import back into the same fields). */
const EXPORT_COLUMNS = [
  'id',
  'name',
  'brand',
  'material',
  'material_type',
  'color_name',
  'color_hex',
  'initial_weight_g',
  'used_weight_g',
  'remaining_weight_g',
  'spool_weight_g',
  'fill_pct',
  'status',
  'location',
  'loaded_in',
  'purchase_price',
  'currency',
  'purchase_date',
  'supplier',
  'lot_nr',
  'product_url',
  'notes',
  'registered_at',
  'last_used_at'
];

/** The spools as export rows. */
function exportRows(db, { includeArchived = true } = {}) {
  const currency = require('./filament-stats').currency(db);
  return spools.listSpools(db, { includeArchived }).map((s) => ({
    id: s.id,
    name: s.display_name,
    brand: s.brand_name || '',
    material: s.material || '',
    material_type: s.material_type || '',
    color_name: s.color_name || '',
    color_hex: s.color_hex || '',
    initial_weight_g: s.initial_weight,
    used_weight_g: Math.round((Number(s.used_weight) || 0) * 10) / 10,
    remaining_weight_g: Math.round(s.remaining * 10) / 10,
    spool_weight_g: s.spool_weight ?? '',
    fill_pct: s.initial_weight > 0 ? Math.round((s.remaining / s.initial_weight) * 1000) / 10 : 0,
    status: s.status,
    location: s.location_name || '',
    loaded_in: s.loaded.map((p) => p.label).join('; '),
    purchase_price: s.purchase_price ?? '',
    currency: s.purchase_price !== null && s.purchase_price !== undefined ? currency : '',
    purchase_date: s.purchase_date || '',
    supplier: s.supplier || '',
    lot_nr: s.lot_nr || '',
    product_url: s.product_url || '',
    notes: s.notes || '',
    registered_at: s.registered_at || '',
    last_used_at: s.last_used_at || ''
  }));
}

/**
 * One CSV cell: quoted when it needs to be; text a spreadsheet would run as a formula (=, +, -, @
 * at the start) gets a leading apostrophe so it stays text.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Export the spools: { filename, mime, content }. */
function exportSpools(db, { format = 'csv', includeArchived = true, now = new Date() } = {}) {
  const rows = exportRows(db, { includeArchived });
  const day = now.toISOString().slice(0, 10);
  if (format === 'json') {
    const { version } = require('../../package.json');
    return {
      filename: `justtprint-spools-${day}.json`,
      mime: 'application/json',
      content: JSON.stringify({ exportedFrom: 'JusttPrint', version, exportedAt: now.toISOString(), spools: rows }, null, 2)
    };
  }
  const lines = [EXPORT_COLUMNS.join(','), ...rows.map((row) => EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(','))];
  // A byte order mark, so spreadsheets read the file as UTF-8.
  return { filename: `justtprint-spools-${day}.csv`, mime: 'text/csv', content: `\uFEFF${lines.join('\r\n')}\r\n` };
}

// ---- Reading a CSV ----

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000;

/** A CSV's rows (RFC 4180: quotes, doubled quotes, line breaks in quotes), comma or semicolon. */
function parseCsv(text) {
  let source = String(text || '');
  if (source.length > MAX_BYTES) throw new Error('The file is too large (5 MB at most)');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_ROWS + 1) throw new Error(`The file has more than ${MAX_ROWS} rows`);
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (!rows.length) throw new Error('The file is empty');
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1), delimiter };
}

// ---- Matching columns to fields ----

/** The fields a column can fill, with what they are called. */
const FIELDS = {
  name: 'Name',
  brand: 'Brand',
  material: 'Material',
  material_type: 'Kind (Silk, Matte, HF…)',
  color_name: 'Color name',
  color_hex: 'Color (#rrggbb)',
  initial_weight: 'Holds (g)',
  remaining: 'Left (g)',
  used_weight: 'Used (g)',
  spool_weight: 'Empty spool (g)',
  status: 'Status',
  location: 'Place',
  purchase_price: 'Price',
  purchase_date: 'Bought (date)',
  supplier: 'Shop',
  lot_nr: 'Lot',
  product_url: 'Product page',
  notes: 'Notes'
};

/** Headings each field is known by (lower case, letters and digits only). */
const SYNONYMS = {
  name: ['name', 'spool', 'spoolname', 'title', 'displayname'],
  brand: ['brand', 'vendor', 'manufacturer', 'maker', 'vendorname', 'brandname', 'filamentvendorname'],
  material: ['material', 'filamentmaterial', 'type'],
  material_type: ['materialtype', 'kind', 'subtype', 'finish', 'variant'],
  color_name: ['colorname', 'colourname', 'color', 'colour'],
  color_hex: ['colorhex', 'colourhex', 'hex', 'filamentcolorhex', 'hexcolor', 'rgb'],
  initial_weight: ['initialweight', 'initialweightg', 'weight', 'netweight', 'filamentweight', 'capacity', 'totalweight', 'holds'],
  remaining: ['remaining', 'remainingweight', 'remainingweightg', 'left', 'weightleft', 'remainingg'],
  used_weight: ['used', 'usedweight', 'usedweightg', 'usedg'],
  spool_weight: ['spoolweight', 'spoolweightg', 'emptyspool', 'emptyspoolweight', 'tare', 'emptyweight'],
  status: ['status', 'state'],
  location: ['location', 'place', 'storage', 'locationname', 'where', 'shelf', 'bin', 'box'],
  purchase_price: ['price', 'purchaseprice', 'cost', 'paid'],
  purchase_date: ['purchasedate', 'bought', 'purchased', 'dateofpurchase', 'boughton'],
  supplier: ['supplier', 'shop', 'store', 'seller', 'retailer'],
  lot_nr: ['lot', 'lotnr', 'lotnumber', 'batch', 'batchnumber'],
  product_url: ['url', 'link', 'productlink', 'producturl', 'productpage'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks']
};

const key = (heading) =>
  String(heading || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const HEX = /^#?[0-9a-f]{6}$/i;

/**
 * Each column's field (or null), from its heading: a known name first, each field to one column.
 * A "Color" column whose values are #rrggbb fills the color, not the color name.
 */
function guessMapping(headers, rows = []) {
  /** @type {(string | null)[]} */
  const mapping = headers.map(() => null);
  const taken = new Set();
  headers.forEach((heading, index) => {
    const k = key(heading);
    let field = Object.keys(SYNONYMS).find((f) => !taken.has(f) && SYNONYMS[f].includes(k)) || null;
    if (field === 'color_name') {
      const sample = rows.map((r) => String(r[index] || '').trim()).find(Boolean);
      if (sample && HEX.test(sample) && !taken.has('color_hex')) field = 'color_hex';
    }
    if (field) {
      mapping[index] = field;
      taken.add(field);
    }
  });
  return mapping;
}

// ---- Rows to spools ----

/** "1 kg", "2.2 lb", "750", "750 g", "1,5kg" → grams, or null. */
function grams(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(',', '.');
  if (!text) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*(kg|g|lb|lbs|oz)?$/.exec(text);
  if (!m) throw new Error(`"${value}" is not a weight`);
  const n = Number(m[1]);
  const factor = { kg: 1000, g: 1, lb: 453.59237, lbs: 453.59237, oz: 28.349523125 }[m[2] || 'g'];
  return Math.round(n * factor * 10) / 10;
}

/** A price: "19.99", "$19.99", "19,99 €" → 19.99, or null. */
function price(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const n = Number(text.replace(/[^\d.,-]/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`"${value}" is not a price`);
  return n;
}

const STATUS = {
  active: 'active',
  inuse: 'active',
  loaded: 'active',
  storage: 'storage',
  stored: 'storage',
  new: 'storage',
  archived: 'archived',
  usedup: 'archived',
  empty: 'archived',
  finished: 'archived'
};

/** One row → the input saveSpool takes, with the place by name. */
function rowInput(row, mapping) {
  /** @type {Record<string, string>} */
  const v = {};
  mapping.forEach((field, index) => {
    if (field) v[field] = String(row[index] ?? '').trim();
  });
  const initial = grams(v.initial_weight) ?? 1000;
  const input = {
    name: v.name || (v.color_name ? [v.material, v.color_name].filter(Boolean).join(' ') : '') || null,
    brand_name: v.brand || null,
    material: v.material || null,
    material_type: v.material_type || null,
    color_hex: v.color_hex ? (v.color_hex.startsWith('#') ? v.color_hex : `#${v.color_hex}`) : null,
    initial_weight: initial,
    spool_weight: grams(v.spool_weight),
    status: STATUS[key(v.status)] || 'storage',
    purchase_price: price(v.purchase_price),
    purchase_date: v.purchase_date ? v.purchase_date.slice(0, 10) : null,
    supplier: v.supplier || null,
    lot_nr: v.lot_nr || null,
    product_url: v.product_url || null,
    notes: v.notes || null
  };
  const remaining = grams(v.remaining);
  const used = grams(v.used_weight);
  if (remaining !== null) input.remaining = remaining;
  else if (used !== null) input.used_weight = used;
  return { input, location: v.location || null };
}

/** The row's fingerprint, so importing the same file again skips what came in. */
const fingerprint = (input, location) =>
  `csv:${crypto
    .createHash('sha1')
    .update(JSON.stringify([input, location]))
    .digest('hex')
    .slice(0, 20)}`;

/**
 * What an import would do: the mapping (guessed when not given), how many rows, a few rows as
 * spools, the rows that would fail and the ones already here.
 * @param {any} db
 * @param {{ text: string, mapping?: (string | null)[] | null }} input
 */
function previewImport(db, { text, mapping = null }) {
  const { headers, rows } = parseCsv(text);
  const map = Array.isArray(mapping) && mapping.length === headers.length ? mapping.map((f) => (f && FIELDS[f] ? f : null)) : guessMapping(headers, rows);
  const problems = [];
  const sample = [];
  let already = 0;
  rows.forEach((row, index) => {
    try {
      const { input, location } = rowInput(row, map);
      if (!input.material) throw new Error('No material');
      if (db.prepare('SELECT 1 FROM spools WHERE source_ref = ?').get(fingerprint(input, location))) already += 1;
      else if (sample.length < 5) sample.push({ ...input, location });
    } catch (error) {
      problems.push({ line: index + 2, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { headers, mapping: map, fields: FIELDS, rows: rows.length, already, problems: problems.slice(0, 50), problemCount: problems.length, sample };
}

/**
 * Import the rows: { added, already, problems, placesAdded }.
 * @param {any} db
 * @param {{ text: string, mapping?: (string | null)[] | null }} input
 * @param {{ userId?: number | null }} [options]
 */
function importCsv(db, { text, mapping }, { userId = null } = {}) {
  const preview = previewImport(db, { text, mapping });
  if (!preview.mapping.includes('material')) throw new Error('Choose the column with the material (PLA, PETG, …)');
  const { rows } = parseCsv(text);
  const places = require('./storage-locations');
  const placeIds = new Map(places.listLocations(db).map((p) => [p.name.toLowerCase(), p.id]));
  let added = 0;
  let already = 0;
  let placesAdded = 0;
  const problems = [];
  db.transaction(() => {
    rows.forEach((row, index) => {
      try {
        const { input, location } = rowInput(row, preview.mapping);
        if (!input.material) throw new Error('No material');
        const ref = fingerprint(input, location);
        if (db.prepare('SELECT 1 FROM spools WHERE source_ref = ?').get(ref)) {
          already += 1;
          return;
        }
        let locationId = null;
        if (location) {
          locationId = placeIds.get(location.toLowerCase()) ?? null;
          if (!locationId) {
            locationId = places.saveLocation(db, { name: location }, { userId }).id;
            placeIds.set(location.toLowerCase(), locationId);
            placesAdded += 1;
          }
        }
        // One row at a time, so a bad row leaves the others in.
        db.transaction(() => spools.saveSpool(db, { ...input, location_id: locationId, source_ref: ref }, { userId }))();
        added += 1;
      } catch (error) {
        problems.push({ line: index + 2, error: error instanceof Error ? error.message : String(error) });
      }
    });
  })();
  return { added, already, placesAdded, problems: problems.slice(0, 50), problemCount: problems.length };
}

module.exports = { EXPORT_COLUMNS, FIELDS, exportRows, exportSpools, csvCell, parseCsv, guessMapping, grams, rowInput, previewImport, importCsv };
