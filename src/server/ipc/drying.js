'use strict';

// Drying spools (src/core/drying.js).

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const drying = require('../../core/drying');

ipcMain.handle('get-drying-sessions', () => drying.listActiveDrying(database.db));
ipcMain.handle('start-drying', (event, spoolId, session) => drying.startDrying(database.db, Number(spoolId), session || {}));
ipcMain.handle('finish-drying', (event, sessionId, result) => drying.finishDrying(database.db, Number(sessionId), result || {}));
