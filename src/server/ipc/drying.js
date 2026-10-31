'use strict';

// Drying spools (src/core/drying.js).

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const drying = require('../../core/drying');

ipcMain.handle('get-drying-sessions', () => drying.listActiveDrying(database.db));

// Each person's own alerts (docs/plan-10.1.md, Phase 9): their choices, a test message.
ipcMain.handle('get-alert-prefs', (event) => {
  const alerts = require('../personal-alerts');
  return { ...alerts.publicPrefs(alerts.prefsFor(event && event.user ? event.user.id : 0)), kinds_meta: alerts.KINDS };
});
ipcMain.handle('save-alert-prefs', (event, prefs) => require('../personal-alerts').savePrefs(event && event.user ? event.user.id : 0, prefs || {}));
ipcMain.handle('send-test-alert', (event) => require('../personal-alerts').sendTest(event && event.user ? event.user.id : 0));
ipcMain.handle('start-drying', (event, spoolId, session) => drying.startDrying(database.db, Number(spoolId), session || {}));
ipcMain.handle('finish-drying', (event, sessionId, result) => drying.finishDrying(database.db, Number(sessionId), result || {}));
