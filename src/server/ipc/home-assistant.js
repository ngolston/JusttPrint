'use strict';

// Home Assistant: one sensor per spool (src/server/home-assistant.js). Admins only.

const { ipcMain } = require('../runtime');
const homeAssistant = require('../home-assistant');

ipcMain.handle('get-home-assistant', () => homeAssistant.status());
ipcMain.handle('save-home-assistant', (event, input) => homeAssistant.save(input || {}));
ipcMain.handle('test-home-assistant', () => homeAssistant.test());
ipcMain.handle('push-home-assistant', () => homeAssistant.push());
