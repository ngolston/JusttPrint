'use strict';

/**
 * The plates of a 3MF project (Bambu Studio, OrcaSlicer, PrusaSlicer): [{ index, name, seconds,
 * grams }]. Plates come from the project's settings (Metadata/model_settings.config) and its plate
 * pictures (Metadata/plate_<n>.png); names, and print time and grams when the file was sliced
 * (Metadata/slice_info.config). An empty list for a 3MF with one plate or none, or that cannot be read.
 */

const { withZipFileLock } = require('../core/zip-extract');

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_PLATES = 200;

/** `key="…" value="…"` pairs of one <plate> block. */
function metadataOf(block) {
  const out = {};
  for (const m of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const decode = (text) =>
  String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Plates from the config texts and the entry names (no file access).
 * @param {{ entryNames?: string[], modelSettings?: string, sliceInfo?: string }} input
 */
/**
 * @param {{ entryNames?: string[], modelSettings?: string, sliceInfo?: string }} input
 * @param {{ single?: boolean }} [options] `single`: a file with one plate gives that plate too (its
 *   print time and grams, for the cost of a print and Log Print), instead of no plates.
 */
function platesFrom({ entryNames = [], modelSettings = '', sliceInfo = '' }, options = {}) {
  const plates = new Map();
  const plate = (index) => {
    if (!plates.has(index)) plates.set(index, { index, name: null, seconds: null, grams: null });
    return plates.get(index);
  };
  for (const name of entryNames) {
    const m = /^Metadata\/plate_(\d+)\.png$/i.exec(name);
    if (m) plate(Number(m[1]));
  }
  for (const block of String(modelSettings).match(/<plate>[\s\S]*?<\/plate>/g) || []) {
    const meta = metadataOf(block);
    const index = Number(meta.plater_id);
    if (!Number.isInteger(index) || index < 1) continue;
    const p = plate(index);
    if (meta.plater_name && meta.plater_name.trim()) p.name = decode(meta.plater_name.trim()).slice(0, 120);
  }
  for (const block of String(sliceInfo).match(/<plate>[\s\S]*?<\/plate>/g) || []) {
    const meta = metadataOf(block);
    const index = Number(meta.index);
    if (!Number.isInteger(index) || index < 1) continue;
    const p = plate(index);
    if (Number(meta.prediction) > 0) p.seconds = Math.round(Number(meta.prediction));
    if (Number(meta.weight) > 0) p.grams = Math.round(Number(meta.weight) * 10) / 10;
  }
  const list = [...plates.values()].sort((a, b) => a.index - b.index).slice(0, MAX_PLATES);
  return list.length > 1 || (options.single && list.length) ? list : [];
}

/**
 * Read a 3MF file's plates (see above).
 * @param {string} filePath
 * @param {{ single?: boolean }} [options]
 */
async function readPlates(filePath, options = {}) {
  if (!/\.3mf$/i.test(String(filePath)) || String(filePath).includes('::')) return [];
  const StreamZip = require('node-stream-zip');
  return withZipFileLock(filePath, async () => {
    const zip = new StreamZip.async({ file: filePath });
    try {
      const entries = await zip.entries();
      const read = async (name) => {
        const entry = Object.values(entries).find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (!entry || entry.size > MAX_CONFIG_BYTES) return '';
        return (await zip.entryData(entry.name)).toString('utf8');
      };
      return platesFrom(
        {
          entryNames: Object.keys(entries),
          modelSettings: await read('Metadata/model_settings.config'),
          sliceInfo: await read('Metadata/slice_info.config')
        },
        options
      );
    } finally {
      await zip.close();
    }
  });
}

module.exports = { platesFrom, readPlates };
