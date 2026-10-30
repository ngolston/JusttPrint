'use strict';

// What is loaded in each printer (src/core/printer-ams.js) and Bambu Lab cloud printers (bambu-devices.js).

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const ams = require('../../core/printer-ams');

ipcMain.handle('get-printer-loads', (event, printerId) => ams.getPrinterLoads(database.db, Number(printerId) > 0 ? Number(printerId) : null));
ipcMain.handle('add-ams-unit', (event, printerId, options) => ams.addAmsUnit(database.db, Number(printerId), options || {}));
ipcMain.handle('update-ams-unit', (event, unitId, changes) => ams.updateAmsUnit(database.db, Number(unitId), changes || {}));
ipcMain.handle('delete-ams-unit', (event, unitId) => ams.removeAmsUnit(database.db, Number(unitId)));
ipcMain.handle('set-loaded-spool', (event, where, spoolId) => {
  const result = ams.loadSpool(database.db, where || {}, Number(spoolId) > 0 ? Number(spoolId) : null);
  // Loading a spool archived or in storage makes it available: other browsers' badges may change.
  require('../events').broadcastToOthers(event, 'filament-check-changed');
  return result;
});
ipcMain.handle('list-bambu-printers', () => require('../bambu-devices').listDevices());
ipcMain.handle('import-bambu-printers', () => require('../bambu-devices').importFromCloud());
