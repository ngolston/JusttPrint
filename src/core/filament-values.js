'use strict';

/**
 * Checking what the Filament page sends (spools, profiles, locations, drying): text trimmed or
 * null, numbers or null, colors as #rrggbb, and the allowed values of the status columns
 * (filament-schema.js lists them).
 */

const SPOOL_STATUSES = ['active', 'storage', 'archived'];
const PROFILE_SOURCES = ['manual', 'catalog', 'spoolman'];

const now = () => new Date().toISOString();

/** Trimmed text, or null when empty. Long text is cut at `max`. */
function text(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** A finite number, or null. Throws `label` errors for values that are there but not numbers or out of range. */
function number(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  if (n < min) throw new Error(`${label} must be at least ${min}`);
  if (n > max) throw new Error(`${label} must be at most ${max}`);
  return n;
}

/** '#ABC', 'aabbcc', '#aabbcc' → '#aabbcc'; anything else → null. */
function color(value) {
  const s = String(value ?? '').trim();
  let match = /^#?([0-9a-f]{6})$/i.exec(s);
  if (match) return `#${match[1].toLowerCase()}`;
  match = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (match) return `#${match[1]}${match[1]}${match[2]}${match[2]}${match[3]}${match[3]}`.toLowerCase();
  return null;
}

/** A date or time as ISO text, or null. Throws for text that is not a date. */
function date(value, label) {
  const s = text(value, 40);
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`${label} is not a date`);
  return new Date(ms).toISOString();
}

/** A positive whole id, or null. */
function id(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A web address with http(s), or null. */
function url(value) {
  const s = text(value, 1000);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

/**
 * The base material of a catalogue or Spoolman material, for matching ("PLA Silk" → PLA,
 * "PLA+/Pro Basic" → PLA, "ABS+" → ABS, "PA12-CF" → PA12). The filament check compares these.
 */
function baseMaterial(value) {
  const first = String(value ?? '')
    .trim()
    .split(/[\s/-]+/)[0];
  const base = first.replace(/\++$/, '').toUpperCase();
  return base || null;
}

module.exports = { baseMaterial, SPOOL_STATUSES, PROFILE_SOURCES, now, text, number, color, date, id, url };
