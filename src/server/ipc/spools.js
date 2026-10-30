'use strict';

// Spools (src/core/spools.js) and the Spoolman import, for the Filament page.

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const spools = require('../../core/spools');
const { importSpoolman } = require('../../core/spoolman-import');

const userId = (event) => (event && event.user && event.user.id) || null;

ipcMain.handle('get-spools', (event, options) => spools.listSpools(database.db, { includeArchived: !(options && options.includeArchived === false) }));
ipcMain.handle('get-spool', (event, id) => spools.getSpool(database.db, Number(id)));
ipcMain.handle('get-filament-summary', () => spools.filamentSummary(database.db));
ipcMain.handle('save-spool', (event, spool) => spools.saveSpool(database.db, spool, { userId: userId(event) }));
ipcMain.handle('weigh-spool', (event, id, weighing) => spools.weighSpool(database.db, Number(id), weighing || {}));
ipcMain.handle('move-spool', (event, id, locationId) => spools.moveSpool(database.db, Number(id), locationId));
ipcMain.handle('archive-spool', (event, id, archived) => spools.archiveSpool(database.db, Number(id), archived !== false));
ipcMain.handle('delete-spool', (event, id) => spools.deleteSpool(database.db, Number(id)));
ipcMain.handle('import-spoolman', (event, data) => importSpoolman(database.db, data, { userId: userId(event) }));
