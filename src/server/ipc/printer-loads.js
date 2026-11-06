'use strict';

// What is loaded in each printer (src/core/printer-ams.js), Bambu Lab cloud printers (bambu-devices.js) and their live status (bambu-live.js).

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
  require('../home-assistant').pushSoon();
  return result;
});
ipcMain.handle('list-bambu-printers', async () => (await require('../bambu-devices').listDevices()).map(({ accessCode, ...device }) => device));
ipcMain.handle('import-bambu-printers', async () => {
  const result = await require('../bambu-devices').importFromCloud();
  require('../bambu-live').printersChanged();
  return result;
});
// Bambu Lab live status over the LAN (bambu-live.js): state, progress, temperatures, AMS trays.
ipcMain.handle('get-printer-live', () => require('../bambu-live').status());
// Pause, resume, stop, speed and the chamber light of a Bambu Lab printer (src/server/bambu-control.js).
// The files on a Bambu Lab printer's storage (src/server/printer-files.js).
ipcMain.handle('get-printer-files', (event, printerId, dir) => require('../printer-files').listPrinterFiles(database.db, Number(printerId), dir || '/'));
ipcMain.handle('get-printer-file-plates', (event, printerId, filePath) =>
  require('../printer-files').printerFilePlates(database.db, Number(printerId), String(filePath))
);
ipcMain.handle('print-printer-file', (event, printerId, filePath, choices) =>
  require('../printer-files').printPrinterFile(database.db, Number(printerId), String(filePath), choices || {})
);
ipcMain.handle('delete-printer-file', (event, printerId, filePath) =>
  require('../printer-files').deletePrinterFile(database.db, Number(printerId), String(filePath))
);
ipcMain.handle('control-printer', (event, printerId, action, value) => require('../bambu-control').controlPrinter(Number(printerId), String(action), value));

// Failure detection (src/server/failure-detection.js): the detector's settings and each print it watches.
ipcMain.handle('get-failure-detection', () => require('../failure-detection').publicConfig());
ipcMain.handle('save-failure-detection', (event, config) => require('../failure-detection').saveConfig(config));
ipcMain.handle('test-failure-detection', (event, printerId) => require('../failure-detection').testDetector(printerId ? Number(printerId) : null));
