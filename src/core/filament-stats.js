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

/** The library's currency (Settings → Printers → Filament settings), an ISO 4217 code. */
function currency(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get();
    return row && /^[A-Z]{3}$/.test(String(row.value)) ? String(row.value) : 'USD';
  } catch (_) {
    return 'USD';
  }
}

module.exports = { filamentStatistics, currency };
