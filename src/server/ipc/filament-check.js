'use strict';

// The filament check for one model (src/core/filament-check.js): Log Print fills its spools from it.

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { checkModel } = require('../../core/filament-check');
const { getPlateFilaments, platesOf } = require('../../core/plate-filaments');

/**
 * What a model needs and which spools would give it: { tracked, plates, source, check }. `tracked`
 * is false while the library has no spools; `check` is null when the model's filament is not known.
 */
// Read new and changed 3MF files' plate filament now, instead of waiting for the background job's turn.
ipcMain.handle('read-plate-filaments', () => require('../plate-filament-job').run());

ipcMain.handle('get-model-filament', (event, filePath, options) => {
  const db = database.db;
  const model = db.prepare('SELECT id FROM models WHERE filePath = ?').get(String(filePath || ''));
  const tracked = !!db.prepare('SELECT 1 FROM spools LIMIT 1').get();
  if (!model) return { tracked, plates: [], source: null, check: null };
  const rows = getPlateFilaments(db, model.id);
  const plates = Array.isArray(options && options.plates) ? options.plates.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null;
  const printerId = options && Number(options.printerId) > 0 ? Number(options.printerId) : null;
  return {
    tracked,
    plates: platesOf(rows),
    source: rows[0] ? rows[0].source : null,
    check: rows.length ? checkModel(db, model.id, { plate: plates && plates.length ? plates : null, printerId }) : null
  };
});
