'use strict';

// Spools (src/core/spools.js) and the Spoolman import, for the Filament page.

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const spools = require('../../core/spools');
const { importSpoolman } = require('../../core/spoolman-import');

const userId = (event) => (event && event.user && event.user.id) || null;
/**
 * Spools changed: check for low stock soon (low-stock-alerts.js), and tell the other browsers
 * their Ready to print badges may have changed (the caller's page refreshes itself).
 */
const changed = (result, event = null) => {
  require('../low-stock-alerts').soon();
  require('../events').broadcastToOthers(event, 'filament-check-changed');
  return result;
};

ipcMain.handle('get-spools', (event, options) => spools.listSpools(database.db, { includeArchived: !(options && options.includeArchived === false) }));
ipcMain.handle('get-spool', (event, id) => spools.getSpool(database.db, Number(id)));
ipcMain.handle('get-filament-summary', () => spools.filamentSummary(database.db));
ipcMain.handle('save-spool', (event, spool) => changed(spools.saveSpool(database.db, spool, { userId: userId(event) }), event));
ipcMain.handle('weigh-spool', (event, id, weighing) => changed(spools.weighSpool(database.db, Number(id), weighing || {}), event));
ipcMain.handle('move-spool', (event, id, locationId) => spools.moveSpool(database.db, Number(id), locationId));
ipcMain.handle('archive-spool', (event, id, archived) => changed(spools.archiveSpool(database.db, Number(id), archived !== false), event));
ipcMain.handle('delete-spool', (event, id) => {
  const deleted = changed(spools.deleteSpool(database.db, Number(id)), event);
  require('../photos').sweepSoon();
  return deleted;
});
ipcMain.handle('set-spool-photo', (event, id, photo) => {
  require('../photos').setPhoto(database.db, 'spool', Number(id), photo || null);
  return spools.getSpool(database.db, Number(id));
});
ipcMain.handle('import-spoolman', (event, data) => changed(importSpoolman(database.db, data, { userId: userId(event) }), event));
