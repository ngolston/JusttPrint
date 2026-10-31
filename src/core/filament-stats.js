'use strict';

/**
 * Filament used and what it cost (docs/merge-10.md, Phase 10): from the spools logged prints
 * used (print_event_spools). A print's cost is its grams at its spool's price per gram (purchase
 * price over the grams the spool held); spools without a price add grams but no cost, and
 * `pricedGrams` says how much of the total has a price. For the Statistics page and MCP.
 */

const MONTH = (iso) => String(iso || '').slice(0, 7);

/**
 * @param {any} db
 * @param {{ from?: string | null, months?: string[] }} [options] `from`: ISO date to count from
 *   (null: all time); `months`: the month keys ("2026-03") to fill, oldest first.
 */
function filamentStatistics(db, options = {}) {
  const from = options.from ?? null;
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'print_event_spools'").get();
  const empty = {
    grams: 0,
    cost: 0,
    pricedGrams: 0,
    byMonth: (options.months || []).map((month) => ({ month, grams: 0, cost: 0 })),
    models: [],
    printers: [],
    materials: []
  };
  if (!exists) return empty;
  const rows = db
    .prepare(
      `SELECT pes.grams, pe.printed_at, pe.model_id, pe.printer_id, m.fileName, m.filePath, m.title, p.nickname AS printer,
         s.material, s.purchase_price, s.initial_weight
       FROM print_event_spools pes
       JOIN print_events pe ON pe.id = pes.event_id
       LEFT JOIN models m ON m.id = pe.model_id
       LEFT JOIN printers p ON p.id = pe.printer_id
       LEFT JOIN spools s ON s.id = pes.spool_id
       ${from ? 'WHERE pe.printed_at >= ?' : ''}`
    )
    .all(...(from ? [from] : []));
  const byMonth = new Map((options.months || []).map((month) => [month, { month, grams: 0, cost: 0 }]));
  const models = new Map();
  const printers = new Map();
  const materials = new Map();
  const out = { ...empty };
  for (const row of rows) {
    const grams = Number(row.grams) || 0;
    const perGram = Number(row.purchase_price) > 0 && Number(row.initial_weight) > 0 ? Number(row.purchase_price) / Number(row.initial_weight) : null;
    const cost = perGram === null ? 0 : grams * perGram;
    out.grams += grams;
    out.cost += cost;
    if (perGram !== null) out.pricedGrams += grams;
    const month = byMonth.get(MONTH(row.printed_at));
    if (month) {
      month.grams += grams;
      month.cost += cost;
    }
    const model = models.get(row.model_id) || { id: row.model_id, name: row.title || row.fileName || 'Model', filePath: row.filePath, grams: 0, cost: 0 };
    model.grams += grams;
    model.cost += cost;
    models.set(row.model_id, model);
    const printerKey = row.printer_id ?? 'none';
    const printer = printers.get(printerKey) || { id: row.printer_id ?? null, name: row.printer || '', grams: 0, cost: 0 };
    printer.grams += grams;
    printer.cost += cost;
    printers.set(printerKey, printer);
    const material = String(row.material || 'Unknown spool');
    materials.set(material, (materials.get(material) || 0) + grams);
  }
  const round = (n) => Math.round(n * 100) / 100;
  const tidy = (item) => ({ ...item, grams: round(item.grams), cost: round(item.cost) });
  return {
    grams: round(out.grams),
    cost: round(out.cost),
    pricedGrams: round(out.pricedGrams),
    byMonth: [...byMonth.values()].map(tidy),
    models: [...models.values()]
      .sort((a, b) => b.grams - a.grams)
      .slice(0, 8)
      .map(tidy),
    printers: [...printers.values()].sort((a, b) => b.grams - a.grams).map(tidy),
    materials: [...materials].map(([material, grams]) => ({ material, grams: round(grams) })).sort((a, b) => b.grams - a.grams)
  };
}

const DAY_MS = 24 * 3600 * 1000;
const dayKey = (date) => date.toISOString().slice(0, 10);
/** The Monday (UTC) of a date's week, as "2026-10-26". */
function weekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return dayKey(d);
}

/**
 * Recent use, whatever period Statistics shows (docs/plan-10.1.md, Phase 7): grams per day over
 * the last 30 days (`daily`), grams per week over the last 12 weeks for the three materials used
 * most then and the rest as Other (`weekly`), and what filament costs per kg by material, from
 * every spool with a price (`costPerKg`: total paid over total grams bought).
 * @param {any} db
 * @param {Date} [now]
 */
function recentFilament(db, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = Array.from({ length: 30 }, (_, i) => dayKey(new Date(today.getTime() - (29 - i) * DAY_MS)));
  const weeks = Array.from({ length: 12 }, (_, i) => weekKey(new Date(today.getTime() - (11 - i) * 7 * DAY_MS)));
  const empty = { daily: days.map((day) => ({ day, grams: 0 })), weekly: { materials: [], rows: weeks.map((week) => ({ week, other: 0 })) }, costPerKg: [] };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'print_event_spools'").get()) return empty;
  const rows = db
    .prepare(
      `SELECT pes.grams, pe.printed_at, s.material FROM print_event_spools pes JOIN print_events pe ON pe.id = pes.event_id
       LEFT JOIN spools s ON s.id = pes.spool_id WHERE pe.printed_at >= ? AND pe.printed_at < ?`
    )
    .all(`${weeks[0]}T00:00:00.000Z`, new Date(today.getTime() + DAY_MS).toISOString());
  const daily = new Map(days.map((day) => [day, 0]));
  const byMaterial = new Map();
  for (const row of rows) {
    const grams = Number(row.grams) || 0;
    const day = String(row.printed_at).slice(0, 10);
    if (daily.has(day)) daily.set(day, (daily.get(day) || 0) + grams);
    const material = String(row.material || 'Other');
    byMaterial.set(material, (byMaterial.get(material) || 0) + grams);
  }
  // Three materials keep their own color; more fold into Other (one color per material, fixed order).
  const materials = [...byMaterial]
    .filter(([name]) => name !== 'Other')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
  const weekly = new Map(weeks.map((week) => [week, { week, ...Object.fromEntries(materials.map((m) => [m, 0])), other: 0 }]));
  for (const row of rows) {
    const bucket = weekly.get(weekKey(new Date(row.printed_at)));
    if (!bucket) continue;
    const key = materials.includes(String(row.material)) ? String(row.material) : 'other';
    bucket[key] += Number(row.grams) || 0;
  }
  const round = (n) => Math.round(n * 10) / 10;
  const costPerKg = db
    .prepare(
      `SELECT material, SUM(purchase_price) AS paid, SUM(initial_weight) AS grams, COUNT(*) AS spools FROM spools
       WHERE purchase_price > 0 AND initial_weight > 0 GROUP BY material ORDER BY material`
    )
    .all()
    .map((row) => ({ material: row.material || 'Other', perKg: Math.round((row.paid / row.grams) * 1000 * 100) / 100, spools: row.spools }))
    .sort((a, b) => b.perKg - a.perKg);
  return {
    daily: [...daily].map(([day, grams]) => ({ day, grams: round(grams) })),
    weekly: {
      materials,
      rows: [...weekly.values()].map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])))
    },
    costPerKg
  };
}

/** The library's currency (Settings → Printers → Filament settings), an ISO 4217 code. */
function currency(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get();
    return row && /^[A-Z]{3}$/.test(String(row.value)) ? String(row.value) : 'USD';
  } catch (_) {
    return 'USD';
  }
}

module.exports = { filamentStatistics, recentFilament, currency };
