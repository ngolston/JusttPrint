'use strict';

/**
 * Send a queued print to a Bambu Lab printer over its own network connection (LAN mode). The
 * sliced project (.gcode.3mf: OrcaSlicer's "Export plate sliced file", or Bambu Studio's) goes
 * to the printer's storage (bambu-ftps.js), then the printer is told to print one of its plates,
 * each filament from the AMS slot chosen for it (bambu-live.js command). JusttPrint does not
 * slice: only a file that holds a plate's G-code can be sent.
 *
 * Recent Bambu firmware takes print commands from other apps only with LAN Only mode and
 * Developer Mode on (the printer's Settings → Network); the printer then ignores or refuses it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withZipFileLock } = require('../core/zip-extract');
const live = require('./bambu-live');
const { uploadToPrinter } = require('./bambu-ftps');
const { platesFrom } = require('./threemf-plates');
const { slicedFilaments } = require('./threemf-filaments');

const SLICED = /\.gcode\.3mf$/i;
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
/** The external spool holder in an AMS mapping. */
const HOLDER = 254;

/**
 * The plates of a sliced project that hold G-code, each with its print time, grams and filaments:
 * [{ index, seconds, grams, filaments: [{ slot, material, color, grams }] }]. Empty when it holds none.
 * @param {string} filePath
 */
async function slicedPlates(filePath) {
  const StreamZip = require('node-stream-zip');
  return withZipFileLock(filePath, async () => {
    const zip = new StreamZip.async({ file: filePath });
    try {
      const entries = await zip.entries();
      const names = Object.keys(entries);
      const withGcode = new Set(
        names.flatMap((name) => {
          const m = /^Metadata\/plate_(\d+)\.gcode$/i.exec(name);
          return m ? [Number(m[1])] : [];
        })
      );
      if (!withGcode.size) return [];
      const entry = names.find((name) => name.toLowerCase() === 'metadata/slice_info.config');
      const sliceInfo = entry && entries[entry].size <= MAX_CONFIG_BYTES ? (await zip.entryData(entry)).toString('utf8') : '';
      const plates = platesFrom({ entryNames: names, sliceInfo }, { single: true });
      const filaments = slicedFilaments(sliceInfo);
      return [...withGcode]
        .sort((a, b) => a - b)
        .map((index) => {
          const plate = plates.find((p) => p.index === index) || { seconds: null, grams: null };
          return {
            index,
            seconds: plate.seconds ?? null,
            grams: plate.grams ?? null,
            filaments: filaments.filter((f) => f.plate === index).map(({ slot, material, color, grams }) => ({ slot, material, color, grams }))
          };
        });
    } finally {
      await zip.close();
    }
  });
}

/**
 * The sliced projects that can print a model: the model's own file when it is one, and the
 * .gcode.3mf files beside it (those named like the model first). Each with its plates.
 * @param {string} filePath the model's file
 */
async function slicedFilesFor(filePath) {
  if (!filePath || String(filePath).includes('::')) return [];
  const dir = path.dirname(filePath);
  const base = path
    .basename(filePath)
    .replace(SLICED, '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase();
  /** @type {string[]} */
  let names;
  try {
    names = (await fs.promises.readdir(dir)).filter((name) => SLICED.test(name));
  } catch (_) {
    names = [];
  }
  const files = [...new Set([...(SLICED.test(filePath) ? [filePath] : []), ...names.map((name) => path.join(dir, name))])];
  const likeModel = (file) => (path.basename(file).toLowerCase().startsWith(base) ? 0 : 1);
  files.sort((a, b) => (a === filePath ? -1 : b === filePath ? 1 : likeModel(a) - likeModel(b) || a.localeCompare(b)));
  const out = [];
  for (const file of files.slice(0, 20)) {
    const plates = await slicedPlates(file).catch(() => []);
    if (plates.length) out.push({ filePath: file, name: path.basename(file), plates });
  }
  return out;
}

/**
 * Whether a printer can take a print now, and if not, why. Errors it shows (many are notices,
 * such as the AMS's humidity) are a warning, not a refusal: the printer refuses what it cannot print.
 */
function readiness(summary) {
  if (!summary || !summary.connected)
    return { ready: false, reason: 'Not connected: check its address, serial number and access code in Printers', warning: null };
  if (summary.state === 'printing') return { ready: false, reason: 'Printing', warning: null };
  if (summary.state === 'paused') return { ready: false, reason: 'Paused', warning: null };
  const errors = (summary.errors || []).map((error) => (error && (error.text || error.message)) || String(error || '')).filter(Boolean);
  return { ready: true, reason: null, warning: errors.length ? `The printer shows: ${errors.slice(0, 2).join('; ')}` : null };
}

/**
 * What the Send dialog shows: the sliced projects for a model, and the Bambu Lab printers on
 * the network with their state and AMS slots.
 * @param {any} db
 * @param {string} filePath
 * @param {number | null} [printedFileId] a kept file to offer first (Reprint)
 */
async function sendOptions(db, filePath, printedFileId = null) {
  const files = await slicedFilesFor(filePath);
  // Reprint: the exact file a print used before (printed-files.js), first.
  if (printedFileId) {
    const kept = require('./printed-files');
    const stored = kept.printedFilePath(db, printedFileId);
    const row = db.prepare('SELECT original_name, sent_at FROM printed_files WHERE id = ?').get(Number(printedFileId));
    const plates = stored ? await slicedPlates(stored).catch(() => []) : [];
    if (stored && row && plates.length) {
      files.unshift({ filePath: `printed:${Number(printedFileId)}`, name: `${row.original_name} (as printed ${row.sent_at.slice(0, 10)})`, plates });
    }
  }
  const printers = db
    .prepare("SELECT id, nickname, model FROM printers WHERE connection_type = 'bambu' ORDER BY nickname COLLATE NOCASE")
    .all()
    .map((row) => {
      const followed = live.target(row.id);
      const summary = followed ? followed.summary : null;
      return {
        id: row.id,
        name: row.nickname,
        model: row.model || null,
        state: summary ? summary.state : 'offline',
        ...(followed ? readiness(summary) : { ready: false, reason: 'Needs its address, serial number and access code in Printers', warning: null }),
        ams: summary
          ? summary.ams.map((unit) => ({
              id: unit.id,
              trays: unit.trays.map((tray, index) => (tray ? { index, type: tray.type, color: tray.color, name: tray.name } : null))
            }))
          : [],
        external: summary ? summary.external : null
      };
    });
  return { files, printers };
}

/** A file name the printer takes: letters, digits, spaces and a few marks, ending .gcode.3mf. */
function printerFileName(filePath) {
  const base =
    path
      .basename(filePath)
      .replace(SLICED, '')
      .replace(/[^\w .()-]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'print';
  return `${base}.gcode.3mf`;
}

/**
 * Where the printer finds the uploaded file: an X1 keeps it under /mnt/sdcard, a P1 or A1 on
 * its microSD card (/sdcard), as the apps that drive them on the network say.
 */
function printerFileUrl(model, remoteName) {
  return /\bX1/i.test(String(model || '')) ? `file:///mnt/sdcard/${remoteName}` : `file:///sdcard/${remoteName}`;
}

/** The project's filaments mapped to trays: one entry per filament slot (1…), the tray's number, HOLDER, or -1 when the plate does not use it. */
function amsMappingFor(plate, chosen) {
  const highest = Math.max(0, ...plate.filaments.map((f) => f.slot));
  const mapping = [];
  for (let slot = 1; slot <= highest; slot++) {
    const used = plate.filaments.some((f) => f.slot === slot);
    const value = chosen && Object.prototype.hasOwnProperty.call(chosen, slot) ? Number(chosen[slot]) : used ? slot - 1 : -1;
    mapping.push(used && Number.isInteger(value) ? value : -1);
  }
  return mapping;
}

/**
 * The command that starts a plate of a sliced project already on the printer (`path`, in its
 * storage): which plate, where the file is, each filament's tray, and the options.
 * @param {{ model: string | null, path: string, plate: { index: number, filaments: { slot: number }[] }, md5?: string, title?: string, hasAms: boolean, useAms?: boolean, trays?: Record<string, number>, bedLeveling?: boolean, timelapse?: boolean, flowCalibration?: boolean }} options
 */
function projectFileCommand(options) {
  const useAms = options.useAms !== false && options.hasAms;
  const name = options.path.replace(/^.*\//, '');
  return {
    print: {
      sequence_id: String(Date.now() % 100000),
      command: 'project_file',
      param: `Metadata/plate_${options.plate.index}.gcode`,
      url: printerFileUrl(options.model, options.path.replace(/^\/+/, '')),
      subtask_name: String(options.title || name.replace(SLICED, '')).slice(0, 120),
      md5: options.md5 || '',
      project_id: '0',
      profile_id: '0',
      task_id: '0',
      subtask_id: '0',
      bed_type: 'auto',
      timelapse: !!options.timelapse,
      // Spelled both ways: firmware versions read one or the other.
      bed_leveling: options.bedLeveling !== false,
      bed_levelling: options.bedLeveling !== false,
      flow_cali: !!options.flowCalibration,
      vibration_cali: false,
      layer_inspect: false,
      use_ams: useAms,
      ams_mapping: useAms ? amsMappingFor(options.plate, options.trays) : []
    }
  };
}

/** The plates of a sliced project from its bytes (a file on the printer, read through a temporary copy). */
async function slicedPlatesOfBytes(bytes) {
  const os = require('os');
  const temp = path.join(os.tmpdir(), `justtprint-printer-${process.pid}-${Date.now()}.gcode.3mf`);
  await fs.promises.writeFile(temp, bytes);
  try {
    return await slicedPlates(temp);
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
}

/**
 * Send a plate of a sliced project to a printer and start it.
 * @param {any} db
 * @param {{ printerId: number, filePath: string, fileName?: string, plate: number, trays?: Record<string, number>, useAms?: boolean, bedLeveling?: boolean, timelapse?: boolean, flowCalibration?: boolean, title?: string }} options
 *   `fileName`: the name for the printer, when the file's own is not (a kept copy's).
 *   `trays`: for each filament slot of the plate, the tray it prints from (AMS unit × 4 + slot, or 254 for the holder).
 */
async function sendPrint(db, options) {
  const printerId = Number(options.printerId);
  const printer = db.prepare("SELECT id, nickname, model FROM printers WHERE id = ? AND connection_type = 'bambu'").get(printerId);
  if (!printer) throw new Error('Choose a Bambu Lab printer');
  const followed = live.target(printerId);
  if (!followed) throw new Error(`${printer.nickname} needs its address, serial number and access code in Printers before JusttPrint can send it a print`);
  const ready = readiness(followed.summary);
  if (!ready.ready) throw new Error(`${printer.nickname} cannot take a print now: ${ready.reason}`);
  if (!SLICED.test(String(options.filePath || ''))) throw new Error('Choose a sliced project (.gcode.3mf)');
  const plates = await slicedPlates(options.filePath);
  const plate = plates.find((p) => p.index === Number(options.plate));
  if (!plate) throw new Error(`This file has no sliced plate ${options.plate}`);

  const remoteName = printerFileName(options.fileName || options.filePath);
  // JUSTTPRINT_BAMBU_FTPS_PORT: a stand-in printer's port in the end-to-end checks.
  const port = Number(process.env.JUSTTPRINT_BAMBU_FTPS_PORT) || undefined;
  await uploadToPrinter({ host: followed.host, port, accessCode: followed.secret, localPath: options.filePath, remoteName });
  const md5 = crypto
    .createHash('md5')
    .update(await fs.promises.readFile(options.filePath))
    .digest('hex')
    .toUpperCase();
  const sent = live.command(
    printerId,
    projectFileCommand({
      model: printer.model,
      path: remoteName,
      plate,
      md5,
      title: options.title,
      hasAms: followed.summary.ams.length > 0,
      useAms: options.useAms,
      trays: options.trays,
      bedLeveling: options.bedLeveling,
      timelapse: options.timelapse,
      flowCalibration: options.flowCalibration
    })
  );
  if (!sent) throw new Error(`${printer.nickname} went offline before the print could start; the file is on the printer`);
  return { printer: printer.nickname, file: remoteName, plate: plate.index };
}

module.exports = {
  slicedPlates,
  slicedPlatesOfBytes,
  slicedFilesFor,
  sendOptions,
  sendPrint,
  projectFileCommand,
  amsMappingFor,
  printerFileName,
  printerFileUrl,
  readiness,
  HOLDER
};
