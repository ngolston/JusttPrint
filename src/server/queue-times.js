'use strict';

/**
 * How long a queued or printing model takes (the queue's rows, src/web/pages/QueuePage.tsx): the
 * print time its 3MF gives for the plate, or every plate. Read once per file version (size and
 * time), so the queue lists quickly.
 */

const fs = require('fs');
const { readPlates } = require('./threemf-plates');

const MAX_FILES = 500;
/** filePath → { key, plates } */
const cache = new Map();

/** The plates of a 3MF ([{ index, seconds, grams }]), from the cache while the file is the same. */
async function platesOf(filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_) {
    return [];
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const known = cache.get(filePath);
  if (known && known.key === key) return known.plates;
  const plates = await readPlates(filePath, { single: true }).catch(() => []);
  cache.delete(filePath);
  cache.set(filePath, { key, plates });
  if (cache.size > MAX_FILES) cache.delete(cache.keys().next().value);
  return plates;
}

/**
 * Seconds to print a plate (null: every plate), or null when the file does not say for all of them.
 * @param {string} filePath
 * @param {number | null} plate
 */
async function printSeconds(filePath, plate) {
  if (!filePath || String(filePath).includes('::')) return null;
  const plates = await platesOf(filePath);
  const chosen = plate ? plates.filter((p) => Number(p.index) === Number(plate)) : plates;
  if (!chosen.length || !chosen.every((p) => Number(p.seconds) > 0)) return null;
  return Math.round(chosen.reduce((sum, p) => sum + Number(p.seconds), 0));
}

/** Items ({ model: { filePath }, plate }) with their `seconds`. */
async function withSeconds(items) {
  return Promise.all(items.map(async (item) => ({ ...item, seconds: await printSeconds(item.model.filePath, item.plate) })));
}

module.exports = { printSeconds, withSeconds };
