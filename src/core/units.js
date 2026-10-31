'use strict';

/**
 * The library's units (docs/plan-10.1.md, Phase 6) for what the server writes itself: the public
 * label pages and the low-stock alerts (Discord, email). The same setting and rules as
 * src/web/units.ts; the database keeps grams, °C and millimetres.
 */

const GRAMS_PER = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };

/** The `units` setting, each unknown part its default. */
function readUnits(db) {
  /** @type {Record<string, unknown>} */
  let value;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'units'").get();
    const parsed = row && row.value ? JSON.parse(row.value) : null;
    value = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    value = {};
  }
  const pick = (v, options, fallback) => (options.includes(v) ? v : fallback);
  return {
    weight: pick(value.weight, ['g', 'kg', 'oz', 'lb'], 'g'),
    temperature: pick(value.temperature, ['C', 'F'], 'C'),
    length: pick(value.length, ['mm', 'in'], 'mm'),
    date: pick(value.date, ['locale', 'ymd', 'dmy', 'mdy'], 'locale')
  };
}

const num = (value, digits) => value.toLocaleString('en', { maximumFractionDigits: digits });

/** 640 → "640 g", 18600 → "18.6 kg"; kg, oz or lb when chosen. */
function formatWeight(grams, unit = 'g') {
  const g = Math.max(0, Number(grams) || 0);
  if (unit === 'kg') return `${num(Math.round((g / 1000) * 100) / 100, 2)} kg`;
  if (unit === 'oz') return `${num(Math.round((g / GRAMS_PER.oz) * 10) / 10, 1)} oz`;
  if (unit === 'lb') return `${num(Math.round((g / GRAMS_PER.lb) * 100) / 100, 2)} lb`;
  const whole = Math.round(g);
  return whole < 1000 ? `${whole} g` : `${num(Math.round(whole / 100) / 10, 1)} kg`;
}

/** 1.75 → "1.75 mm" or "0.069 in". */
function formatLength(mm, unit = 'mm') {
  if (mm === null || mm === undefined || !Number.isFinite(Number(mm))) return '';
  return unit === 'in' ? `${num(Math.round((Number(mm) / 25.4) * 1000) / 1000, 3)} in` : `${num(Number(mm), 2)} mm`;
}

module.exports = { readUnits, formatWeight, formatLength };
