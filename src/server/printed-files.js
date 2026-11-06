'use strict';

/**
 * The exact file each print used (the model page's Printed files): when the queue sends a sliced
 * project to a printer, a copy is kept in the data folder (printed-files/) with its plate, printer
 * and the project's main settings, so Reprint sends the same file again and the model page shows
 * what each print was sliced with. The newest KEEP_PER_MODEL per model are kept.
 */

const fs = require('fs');
const path = require('path');
const { getDatabasePath } = require('../core/db-path');
const { withZipFileLock } = require('../core/zip-extract');

const KEEP_PER_MODEL = 10;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

const folder = () => path.join(path.dirname(getDatabasePath()), 'printed-files');

/** The settings a sliced project was made with, from Metadata/project_settings.config: what people compare. */
const SETTINGS = [
  ['print_settings_id', 'Process'],
  ['filament_settings_id', 'Filament'],
  ['printer_settings_id', 'Printer'],
  ['layer_height', 'Layer height', 'mm'],
  ['wall_loops', 'Walls'],
  ['sparse_infill_density', 'Infill'],
  ['sparse_infill_pattern', 'Infill pattern'],
  ['enable_support', 'Supports'],
  ['support_type', 'Support type'],
  ['nozzle_temperature', 'Nozzle', '°C'],
  ['hot_plate_temp', 'Bed', '°C'],
  ['curr_bed_type', 'Plate type'],
  ['nozzle_diameter', 'Nozzle size', 'mm']
];

/**
 * The project's main settings: [{ key, label, value }] (lists give their first value; flags are Yes/No).
 * @param {string} text the project_settings.config JSON
 */
function settingsFrom(text) {
  let config;
  try {
    config = JSON.parse(String(text || ''));
  } catch (_) {
    return [];
  }
  if (!config || typeof config !== 'object') return [];
  const out = [];
  for (const [key, label, unit] of SETTINGS) {
    let value = config[key];
    if (Array.isArray(value)) value = value.filter((v) => v !== '' && v !== null && v !== undefined)[0];
    if (value === undefined || value === null || value === '') continue;
    let shown = String(value);
    if (key === 'enable_support') shown = shown === '1' || shown === 'true' ? 'Yes' : 'No';
    else if (unit) shown = `${shown}${unit === '°C' ? '' : ' '}${unit}`;
    out.push({ key, label, value: shown.slice(0, 120) });
  }
  return out;
}

/** The settings of a sliced project on disk (empty when it does not say). */
async function readSettings(filePath) {
  const StreamZip = require('node-stream-zip');
  return withZipFileLock(filePath, async () => {
    const zip = new StreamZip.async({ file: filePath });
    try {
      const entries = await zip.entries();
      const name = Object.keys(entries).find((n) => n.toLowerCase() === 'metadata/project_settings.config');
      if (!name || entries[name].size > MAX_CONFIG_BYTES) return [];
      return settingsFrom((await zip.entryData(name)).toString('utf8'));
    } finally {
      await zip.close();
    }
  }).catch(() => []);
}

/**
 * Keep a copy of a file just sent to a printer. Returns its id.
 * @param {any} db
 * @param {{ modelId: number, printerId: number | null, plate: number | null, filePath: string }} sent
 */
async function keepPrintedFile(db, sent) {
  const dir = folder();
  await fs.promises.mkdir(dir, { recursive: true });
  const original = path.basename(sent.filePath);
  const storedName = `${Date.now()}-${original.replace(/[^\w .()-]+/g, '_')}`;
  await fs.promises.copyFile(sent.filePath, path.join(dir, storedName));
  const size = (await fs.promises.stat(path.join(dir, storedName))).size;
  const settings = await readSettings(sent.filePath);
  const id = Number(
    db
      .prepare(
        'INSERT INTO printed_files (model_id, printer_id, plate_index, stored_name, original_name, size, settings, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(sent.modelId, sent.printerId, sent.plate, storedName, original, size, JSON.stringify(settings), new Date().toISOString()).lastInsertRowid
  );
  // Only the newest few per model: the files are a few MB each.
  const old = db
    .prepare('SELECT id, stored_name FROM printed_files WHERE model_id = ? ORDER BY sent_at DESC, id DESC LIMIT -1 OFFSET ?')
    .all(sent.modelId, KEEP_PER_MODEL);
  for (const row of old) {
    await fs.promises.rm(path.join(dir, row.stored_name), { force: true });
    db.prepare('DELETE FROM printed_files WHERE id = ?').run(row.id);
  }
  return id;
}

/**
 * A model's printed files, newest first: when, on which printer and plate, its settings, and how
 * the print went (the print logged on that printer within two days after, if any).
 * @param {any} db
 * @param {number} modelId
 */
function listPrintedFiles(db, modelId) {
  const rows = db
    .prepare(
      `SELECT f.*, p.nickname AS printer_name FROM printed_files f LEFT JOIN printers p ON p.id = f.printer_id
       WHERE f.model_id = ? ORDER BY f.sent_at DESC, f.id DESC`
    )
    .all(modelId);
  const outcome = db.prepare(
    `SELECT outcome FROM print_events WHERE model_id = ? AND (printer_id IS ? OR ? IS NULL)
       AND julianday(COALESCE(started_at, printed_at)) BETWEEN julianday(?) AND julianday(?) ORDER BY julianday(COALESCE(started_at, printed_at)) LIMIT 1`
  );
  return rows.map((row) => {
    /** @type {{ key: string, label: string, value: string }[]} */
    let settings;
    try {
      settings = JSON.parse(row.settings || '[]');
    } catch (_) {
      settings = [];
    }
    const until = new Date(new Date(row.sent_at).getTime() + 2 * 86400000).toISOString();
    /** @type {string | null} */
    let result;
    try {
      result = outcome.get(modelId, row.printer_id, row.printer_id, row.sent_at, until)?.outcome ?? null;
    } catch (_) {
      result = null; // before print_events has started_at
    }
    return {
      id: row.id,
      name: row.original_name,
      size: row.size,
      plate: row.plate_index,
      printerId: row.printer_id,
      printerName: row.printer_name ?? null,
      sentAt: row.sent_at,
      settings,
      outcome: result
    };
  });
}

/** Where a kept file is, or null. */
function printedFilePath(db, id) {
  const row = db.prepare('SELECT stored_name FROM printed_files WHERE id = ?').get(Number(id));
  if (!row) return null;
  const file = path.join(folder(), row.stored_name);
  return fs.existsSync(file) ? file : null;
}

module.exports = { keepPrintedFile, listPrintedFiles, printedFilePath, settingsFrom, readSettings, KEEP_PER_MODEL };
