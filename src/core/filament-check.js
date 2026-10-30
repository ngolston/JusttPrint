'use strict';

/**
 * The filament check (docs/merge-10.md, "The filament check"): for a model (one plate or all),
 * match each needed color to a spool and say what is left or how much is short.
 *
 * A spool matches a need when its base material is the same (filament-values.js baseMaterial:
 * "PLA Silk" is PLA; a need without a material takes any) and its color is within MATCH_DELTA
 * (CIEDE2000; about the difference between two blacks or two whites of different brands). Among
 * matches, spools loaded in the chosen printer come first, then the nearest color, then the one
 * with the most left. Grams set aside for queued prints (queue_spool_holds) are not available. Two
 * needs that pick the same spool share what is on it.
 *
 * The library's "Ready to print" badge and "Fits my filament" filter use fitForLibrary(): every
 * model with plate filaments, checked for all plates and no printer, kept until spools, holds or
 * plate filaments change.
 */

const { baseMaterial } = require('./filament-values');
const { needsFrom } = require('./plate-filaments');

/** Colors this close (CIEDE2000) count as the same filament color. */
const MATCH_DELTA = 12;

// --- Color ---

/** '#rrggbb' → CIE Lab (D65), or null. */
function hexToLab(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 color difference of two Lab colors. */
function deltaE(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (a, b) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lmp = (L1 + L2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hmp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hmp += h1p + h2p < 360 ? 360 : -360;
    hmp /= 2;
  }
  const T =
    1 - 0.17 * Math.cos((hmp - 30) * rad) + 0.24 * Math.cos(2 * hmp * rad) + 0.32 * Math.cos((3 * hmp + 6) * rad) - 0.2 * Math.cos((4 * hmp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hmp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lmp - 50) ** 2) / Math.sqrt(20 + (Lmp - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** How far apart two '#rrggbb' colors are; Infinity when either is missing. */
function colorDistance(a, b) {
  const la = hexToLab(a);
  const lb = hexToLab(b);
  return la && lb ? deltaE(la, lb) : Infinity;
}

const NAMED = [
  ['black', '#000000'],
  ['white', '#ffffff'],
  ['gray', '#8b8f96'],
  ['silver', '#c0c0c0'],
  ['red', '#d23b3b'],
  ['orange', '#e8732c'],
  ['yellow', '#fec600'],
  ['gold', '#d4a640'],
  ['green', '#2f9e44'],
  ['teal', '#14b8a6'],
  ['blue', '#2f6fdf'],
  ['navy', '#1e3a8a'],
  ['purple', '#8b5cf6'],
  ['pink', '#f472b6'],
  ['brown', '#8b5a2b'],
  ['beige', '#e6d5b8']
].map(([name, hex]) => ({ name, lab: hexToLab(hex) }));

/** The plain name nearest a color ("black", "blue"), for "Need black". */
function colorName(hex) {
  const lab = hexToLab(hex);
  if (!lab) return 'filament';
  let best = NAMED[0];
  let bestDelta = Infinity;
  for (const named of NAMED) {
    const d = deltaE(lab, /** @type {number[]} */ (named.lab));
    if (d < bestDelta) {
      bestDelta = d;
      best = named;
    }
  }
  return best.name;
}

// --- Spools ---

/**
 * The spools a check can use: not archived, with grams available (remaining less what queued
 * prints hold) and where they are loaded. `exceptQueueId` leaves one queue item's holds out (that
 * item checking itself).
 */
/**
 * @param {any} db
 * @param {{ exceptQueueId?: number | null, ignoreHolds?: boolean }} [options] `ignoreHolds`: the
 *   queue works out its own holds in order (print-queue.js recomputeHolds).
 */
function availableSpools(db, options = {}) {
  const exceptQueueId = options.exceptQueueId ?? null;
  const holds = new Map(
    options.ignoreHolds
      ? []
      : db
          .prepare('SELECT spool_id, SUM(grams) AS grams FROM queue_spool_holds WHERE queue_id != ? GROUP BY spool_id')
          .all(exceptQueueId ?? 0)
          .map((row) => [row.spool_id, Number(row.grams) || 0])
  );
  const loaded = new Map();
  for (const row of db
    .prepare(
      `SELECT s.spool_id, u.printer_id, p.nickname, u.unit_index, s.slot_index FROM printer_ams_slots s
       JOIN printer_ams_units u ON u.id = s.unit_id JOIN printers p ON p.id = u.printer_id WHERE s.spool_id IS NOT NULL`
    )
    .all()) {
    loaded.set(row.spool_id, [
      ...(loaded.get(row.spool_id) || []),
      { printerId: row.printer_id, label: `${row.nickname} · ${String.fromCharCode(65 + (row.unit_index % 26))}${row.slot_index + 1}` }
    ]);
  }
  for (const row of db.prepare('SELECT id, nickname, direct_spool_id FROM printers WHERE direct_spool_id IS NOT NULL').all()) {
    loaded.set(row.direct_spool_id, [...(loaded.get(row.direct_spool_id) || []), { printerId: row.id, label: row.nickname }]);
  }
  return db
    .prepare(
      `SELECT s.id, s.name, s.material, s.color_hex, s.initial_weight, s.used_weight, p.name AS profile_name, l.name AS location_name
       FROM spools s LEFT JOIN filament_profiles p ON p.id = s.profile_id LEFT JOIN storage_locations l ON l.id = s.location_id
       WHERE s.status != 'archived'`
    )
    .all()
    .map((row) => {
      const remaining = Math.max(0, (Number(row.initial_weight) || 0) - (Number(row.used_weight) || 0));
      const places = loaded.get(row.id) || [];
      return {
        id: row.id,
        name: row.name || row.profile_name || [row.material, colorName(row.color_hex)].filter(Boolean).join(' '),
        material: baseMaterial(row.material),
        color: row.color_hex,
        lab: hexToLab(row.color_hex),
        available: Math.max(0, remaining - (holds.get(row.id) || 0)),
        loadedIn: places.map((place) => place.printerId),
        where: places[0]?.label || row.location_name || null
      };
    });
}

/**
 * Check needs [{ slot, material, color, grams }] against spools (availableSpools). Returns
 * { ready, missing, needs } where each need gains { colorName, spool, left, short, ok }.
 * @param {{ slot: number, material: string | null, color: string | null, grams: number | null }[]} needs
 * @param {ReturnType<typeof availableSpools>} spools
 * @param {{ printerId?: number | null }} [options]
 */
function checkNeeds(needs, spools, options = {}) {
  const printerId = options.printerId ?? null;
  const used = new Map();
  const left = (spool) => spool.available - (used.get(spool.id) || 0);
  const rows = needs.map((need) => {
    const material = baseMaterial(need.material);
    const lab = hexToLab(need.color);
    const matches = spools
      .filter((spool) => (!material || !spool.material || spool.material === material) && (!lab || (spool.lab && deltaE(lab, spool.lab) <= MATCH_DELTA)))
      .map((spool) => ({ spool, delta: lab && spool.lab ? deltaE(lab, spool.lab) : 0, here: printerId !== null && spool.loadedIn.includes(printerId) }))
      .sort((a, b) => Number(b.here) - Number(a.here) || a.delta - b.delta || left(b.spool) - left(a.spool));
    const grams = need.grams === null || need.grams === undefined ? null : Number(need.grams);
    const enough = matches.find((m) => (grams === null ? left(m.spool) > 0 : left(m.spool) >= grams));
    const pick = enough || matches.slice().sort((a, b) => left(b.spool) - left(a.spool))[0] || null;
    const name = colorName(need.color);
    if (!pick) return { ...need, colorName: name, spool: null, left: null, short: grams, ok: false };
    const before = left(pick.spool);
    used.set(pick.spool.id, (used.get(pick.spool.id) || 0) + (grams || 0));
    const after = grams === null ? before : before - grams;
    return {
      ...need,
      colorName: name,
      spool: { id: pick.spool.id, name: pick.spool.name, where: pick.spool.where, available: before, color: pick.spool.color },
      left: Math.max(0, Math.round(after * 10) / 10),
      short: grams === null ? null : Math.max(0, Math.round(-after * 10) / 10),
      ok: grams === null ? before > 0 : after >= 0
    };
  });
  const missing = [...new Set(rows.filter((row) => !row.ok).map((row) => row.colorName))];
  return { ready: rows.length > 0 && missing.length === 0, missing, needs: rows };
}

/**
 * Check one model (one plate or a list of them; every plate when `plate` is null). Null when its
 * needs are not known.
 * @param {any} db
 * @param {number} modelId
 * @param {{ plate?: number | number[] | null, printerId?: number | null, exceptQueueId?: number | null }} [options]
 */
function checkModel(db, modelId, options = {}) {
  const { plate = null, printerId = null, exceptQueueId = null } = options;
  const rows = db.prepare('SELECT plate_index, slot, material, color_hex, grams FROM model_plate_filaments WHERE model_id = ?').all(modelId);
  if (!rows.length) return null;
  const needs = needsFrom(rows, plate);
  if (!needs.length) return null;
  return checkNeeds(needs, availableSpools(db, { exceptQueueId }), { printerId });
}

// --- The library's cache ---

/** @type {{ signature: string, fits: Map<number, { ready: boolean, missing: string[] }> } | null} */
let cache = null;

/** Changes when spools, holds or plate filaments change (the cache is then rebuilt). */
function signature(db) {
  const spools = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS at, COALESCE(SUM(used_weight), 0) AS used FROM spools").get();
  const holds = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(grams), 0) AS g FROM queue_spool_holds').get();
  const plates = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(read_at), '') AS at FROM model_plate_reads").get();
  const rows = db.prepare('SELECT COUNT(*) AS n FROM model_plate_filaments').get();
  return [spools.n, spools.at, spools.used, holds.n, holds.g, plates.n, plates.at, rows.n].join('|');
}

/**
 * Every model with plate filaments → { ready, missing } (all plates, no printer). Empty while the
 * library has no spools: then filament is not tracked, and no model says what it needs.
 */
function fitForLibrary(db) {
  const now = signature(db);
  if (cache && cache.signature === now) return cache.fits;
  const spools = availableSpools(db);
  if (!db.prepare('SELECT 1 FROM spools LIMIT 1').get()) {
    cache = { signature: now, fits: new Map() };
    return cache.fits;
  }
  const byModel = new Map();
  for (const row of db.prepare('SELECT model_id, plate_index, slot, material, color_hex, grams FROM model_plate_filaments').all()) {
    if (!byModel.has(row.model_id)) byModel.set(row.model_id, []);
    byModel.get(row.model_id).push(row);
  }
  const fits = new Map();
  for (const [modelId, rows] of byModel) {
    const result = checkNeeds(needsFrom(rows, null), spools);
    fits.set(modelId, { ready: result.ready, missing: result.missing });
  }
  cache = { signature: now, fits };
  return fits;
}

/** Forget the cache (tests, a restored database). */
function forgetFits() {
  cache = null;
}

module.exports = { MATCH_DELTA, hexToLab, deltaE, colorDistance, colorName, availableSpools, checkNeeds, checkModel, fitForLibrary, forgetFits };
