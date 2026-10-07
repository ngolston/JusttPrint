'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { SECRET_SETTING_KEYS } = require('../server-auth');
const { version } = require('../../../package.json');

const getSettingHandler = async (event, key) => {
  try {
    if (SECRET_SETTING_KEYS.has(key)) return null;
    // Values are not logged: some are API keys, and reads happen constantly.
    const result = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return result?.value || null;
  } catch (error) {
    console.error('Error getting setting:', error);
    return null;
  }
};

ipcMain.handle('get-setting', getSettingHandler);

// Add handler to get app version directly (fallback for server mode)
ipcMain.handle('get-app-version', async () => {
  try {
    return version;
  } catch (error) {
    console.error('Error getting app version:', error);
    return null;
  }
});

// Add error handling to the saveSetting handler
const saveSettingHandler = async (event, key, value) => {
  try {
    if (SECRET_SETTING_KEYS.has(key)) {
      throw new Error(`Setting ${key} can only be changed under Server Access`);
    }
    if (!database.db) {
      console.error('Database not initialized when saving setting');
      return false;
    }
    // Log the key only: values can be API keys.
    database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    console.log('Saved setting:', key);
    // STL Home folders, exclusions or the watch switch changed: restart folder watching.
    require('../stl-home').settingChanged(key);
    return true;
  } catch (error) {
    console.error('Error saving setting:', error);
    return false;
  }
};

ipcMain.handle('save-setting', saveSettingHandler);

// Folder watching for STL Home (src/server/stl-home.js): on or off, and what is watched.
ipcMain.handle('get-folder-watch-status', async () => require('../stl-home').watchStatus());
