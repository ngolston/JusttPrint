'use strict';

/**
 * The files on a Bambu Lab printer's storage (its microSD card on a P1 or A1), for the printer
 * page's Files section: list a folder, print a sliced project or G-code already there, delete one.
 * Over FTPS (bambu-ftps.js) with the printer's access code; prints start over the live connection.
 */

const crypto = require('crypto');
const live = require('./bambu-live');
const { withPrinterFiles, printerPath } = require('./bambu-ftps');
const send = require('./bambu-send');

const SLICED = /\.gcode\.3mf$/i;
const GCODE = /\.gcode$/i;

/** The printer's row and its live connection, or an error saying what is missing. */
function connectionOf(db, printerId) {
  const printer = db.prepare("SELECT id, nickname, model FROM printers WHERE id = ? AND connection_type = 'bambu'").get(Number(printerId));
  if (!printer) throw new Error('Choose a Bambu Lab printer');
  const followed = live.target(printer.id);
  if (!followed || !followed.summary.connected) throw new Error(`${printer.nickname} is not connected: check its address, serial number and access code`);
  // JUSTTPRINT_BAMBU_FTPS_PORT: a stand-in printer's port in the end-to-end checks.
  const options = { host: followed.host, port: Number(process.env.JUSTTPRINT_BAMBU_FTPS_PORT) || undefined, accessCode: followed.secret };
  return { printer, followed, options };
}

/**
 * A folder's folders (first) and files (newest first), each file saying whether it can be
 * printed (a sliced project or G-code).
 * @param {any} db
 * @param {number} printerId
 * @param {string} [dir]
 */
async function listPrinterFiles(db, printerId, dir = '/') {
  const { options } = connectionOf(db, printerId);
  const folder = printerPath(dir);
  const entries = await withPrinterFiles(options, (session) => session.list(folder));
  return {
    dir: folder,
    entries: entries
      .map((entry) => ({
        ...entry,
        path: `${folder === '/' ? '' : folder}/${entry.name}`,
        printable: !entry.folder && (SLICED.test(entry.name) || GCODE.test(entry.name))
      }))
      .sort((a, b) => Number(b.folder) - Number(a.folder) || String(b.modified || '').localeCompare(String(a.modified || '')) || a.name.localeCompare(b.name))
  };
}

/** The plates of a sliced project on the printer (read through a copy); [] for G-code. */
async function printerFilePlates(db, printerId, filePath) {
  const { options } = connectionOf(db, printerId);
  const file = printerPath(filePath);
  if (!SLICED.test(file)) return [];
  const bytes = await withPrinterFiles(options, (session) => session.download(file));
  return send.slicedPlatesOfBytes(bytes);
}

/**
 * Print a file already on the printer: a plate of a sliced project (each filament from the tray
 * of its number unless `trays` says), or a G-code file.
 * @param {any} db
 * @param {number} printerId
 * @param {string} filePath
 * @param {{ plate?: number, trays?: Record<string, number>, useAms?: boolean, bedLeveling?: boolean, timelapse?: boolean, flowCalibration?: boolean }} [choices]
 */
async function printPrinterFile(db, printerId, filePath, choices = {}) {
  const { printer, followed, options } = connectionOf(db, printerId);
  const ready = send.readiness(followed.summary);
  if (!ready.ready) throw new Error(`${printer.nickname} cannot take a print now: ${ready.reason}`);
  const file = printerPath(filePath);
  let command;
  if (SLICED.test(file)) {
    const bytes = await withPrinterFiles(options, (session) => session.download(file));
    const plates = await send.slicedPlatesOfBytes(bytes);
    const plate = plates.find((p) => p.index === Number(choices.plate)) || (choices.plate === undefined ? plates[0] : null);
    if (!plate) throw new Error(choices.plate === undefined ? 'This file holds no sliced plate' : `This file has no sliced plate ${choices.plate}`);
    command = send.projectFileCommand({
      model: printer.model,
      path: file,
      plate,
      md5: crypto.createHash('md5').update(bytes).digest('hex').toUpperCase(),
      hasAms: followed.summary.ams.length > 0,
      useAms: choices.useAms,
      trays: choices.trays,
      bedLeveling: choices.bedLeveling,
      timelapse: choices.timelapse,
      flowCalibration: choices.flowCalibration
    });
  } else if (GCODE.test(file)) {
    const root = /\bX1/i.test(String(printer.model || '')) ? '/mnt/sdcard' : '/sdcard';
    command = { print: { sequence_id: String(Date.now() % 100000), command: 'gcode_file', param: `${root}${file}` } };
  } else throw new Error('Only sliced projects (.gcode.3mf) and G-code can be printed');
  if (!live.command(printer.id, command)) throw new Error(`${printer.nickname} went offline`);
  return { printer: printer.nickname, file };
}

/** Delete a file from the printer (not the one it is printing). */
async function deletePrinterFile(db, printerId, filePath) {
  const { followed, options } = connectionOf(db, printerId);
  const file = printerPath(filePath);
  const name = file.replace(/^.*\//, '');
  const busy = followed.summary.state === 'printing' || followed.summary.state === 'paused';
  if (busy && followed.summary.job && name.replace(SLICED, '').replace(GCODE, '') === String(followed.summary.job).replace(SLICED, '').replace(GCODE, '')) {
    throw new Error('The printer is printing this file');
  }
  await withPrinterFiles(options, (session) => session.remove(file));
  return { deleted: file };
}

module.exports = { listPrinterFiles, printerFilePlates, printPrinterFile, deletePrinterFile };
