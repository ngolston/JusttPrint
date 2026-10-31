'use strict';

/**
 * What a print costs (docs/plan-10.1.md, Phase 8): the filament its plates need, at the price of
 * the spools the filament check picks (a spool without a price: what that material costs per kg
 * across the spools that have one), plus electricity: the printer's power for the slicer's print
 * time, at the price per kWh in Filament settings. Everything for `quantity` copies.
 */

const { getModelByFilePath } = require('../core/models');
const { readPlates } = require('./threemf-plates');

/** A number setting (admins set it in Filament settings), or null. */
function numberSetting(db, key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const n = row && row.value !== null && row.value !== '' ? Number(row.value) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) {
    return null;
  }
}

/** What each material costs per gram, across the spools with a price. */
function pricePerGramByMaterial(db) {
  const out = new Map();
  for (const row of db
    .prepare(
      'SELECT material, SUM(purchase_price) AS paid, SUM(initial_weight) AS grams FROM spools WHERE purchase_price > 0 AND initial_weight > 0 GROUP BY material'
    )
    .all()) {
    out.set(String(row.material || '').toUpperCase(), row.paid / row.grams);
  }
  return out;
}

const round = (n, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * @param {any} db
 * @param {{ filePath: string, plates?: number[] | null, printerId?: number | null, quantity?: number, hours?: number | string | null, watts?: number | string | null }} input
 *   `hours` and `watts` replace the slicer's time and the printer's power when given.
 */
async function estimatePrintCost(db, input) {
  const model = getModelByFilePath(String(input && input.filePath));
  if (!model) throw new Error('Model not found');
  const quantity = Math.max(1, Math.min(999, Math.round(Number(input.quantity) || 1)));
  const plates = Array.isArray(input.plates) && input.plates.length ? input.plates.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null;
  const printerId = Number(input.printerId) > 0 ? Number(input.printerId) : null;
  const currency = require('../core/filament-stats').currency(db);

  // Filament: the check's spool for each color, its price per gram, else its material's.
  const check = require('../core/filament-check').checkModel(db, model.id, { plate: plates, printerId });
  const byMaterial = pricePerGramByMaterial(db);
  const spoolPrice = db.prepare('SELECT purchase_price, initial_weight, material FROM spools WHERE id = ?');
  const lines = (check ? check.needs : []).map((need) => {
    const grams = need.grams === null || need.grams === undefined ? null : Number(need.grams) * quantity;
    const spool = need.spool ? spoolPrice.get(need.spool.id) : null;
    /** @type {number | null} */
    let perGram = null;
    let basis = 'none';
    if (spool && spool.purchase_price > 0 && spool.initial_weight > 0) {
      perGram = spool.purchase_price / spool.initial_weight;
      basis = 'spool';
    } else {
      const material = String((spool && spool.material) || need.material || '').toUpperCase();
      const average = byMaterial.get(material) ?? byMaterial.get(require('../core/filament-values').baseMaterial(material) || '');
      if (average !== undefined) {
        perGram = average;
        basis = 'material';
      }
    }
    return {
      label: [need.colorName, need.material].filter(Boolean).join(' '),
      color: need.color || null,
      spool: need.spool ? need.spool.name : null,
      grams: grams === null ? null : round(grams, 1),
      perKg: perGram === null ? null : round(perGram * 1000),
      cost: grams === null || perGram === null ? null : round(grams * perGram),
      basis
    };
  });
  const filamentCost = round(lines.reduce((sum, line) => sum + (line.cost || 0), 0));
  const grams = round(
    lines.reduce((sum, line) => sum + (line.grams || 0), 0),
    1
  );

  // Electricity: the slicer's time for the plates (or the hours given), the printer's power.
  /** @type {number | null} */
  let seconds = null;
  if (input.hours !== null && input.hours !== undefined && input.hours !== '') {
    const hours = Number(input.hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 30) throw new Error('Hours is a number from 0 to 720');
    seconds = hours * 3600;
  } else {
    const found = await readPlates(model.filePath, { single: true }).catch(() => []);
    const chosen = plates ? found.filter((p) => plates.includes(Number(p.index))) : found;
    const known = chosen.filter((p) => Number(p.seconds) > 0);
    if (known.length) seconds = known.reduce((sum, p) => sum + Number(p.seconds), 0) * quantity;
  }
  /** @type {number | null} */
  let watts = null;
  if (input.watts !== null && input.watts !== undefined && input.watts !== '') {
    const given = Number(input.watts);
    if (!Number.isFinite(given) || given < 0 || given > 10000) throw new Error('Power is a number of watts, up to 10,000');
    watts = given;
  } else if (printerId) {
    try {
      const row = db.prepare('SELECT power_watts FROM printers WHERE id = ?').get(printerId);
      watts = row && Number(row.power_watts) > 0 ? Number(row.power_watts) : null;
    } catch (_) {
      watts = null;
    }
  }
  const pricePerKWh = numberSetting(db, 'electricityPrice');
  const kwh = seconds !== null && watts !== null ? round((watts * seconds) / 3600 / 1000, 3) : null;
  const electricityCost = kwh !== null && pricePerKWh !== null ? round(kwh * pricePerKWh) : null;

  return {
    currency,
    quantity,
    known: !!check,
    lines,
    grams,
    filamentCost,
    /** Colors with no price to go on (no spool price, no price for the material). */
    unpriced: lines.filter((line) => line.cost === null).length,
    seconds,
    watts,
    pricePerKWh,
    kwh,
    electricityCost,
    total: round(filamentCost + (electricityCost || 0))
  };
}

module.exports = { estimatePrintCost, pricePerGramByMaterial };
