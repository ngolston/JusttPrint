'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { SECRET_SETTING_KEYS } = require('../server-auth');
const { version } = require('../../../package.json');

/**
 * Display preferences each user has for themselves (users.js): the view, sort and column layout,
 * panel widths, the folder panel, the accent color and color scheme, the first-run tour. Reads and saves of these
 * go to the logged-in user's row in user_settings; until a user saves one, the server-wide value
 * is their default. The API token, MCP and the thumbnail worker (no user id) use the server-wide
 * values.
 */
const PER_USER_SETTING_KEYS = new Set([
  'gridView',
  'lastUsedView',
  'listViewColumnLayout',
  'perFolderView',
  'previewTileSize',
  'sortOption',
  'searchIncludeNotes',
  'recentFolderFilters',
  'folderRailOpen',
  'organizeLibraryLayers',
  'dedupPreferredDirectory',
  'hideSkippedFileSizeNotice',
  'hasRunBefore',
  'uiTheme',
  'uiColorScheme',
  'detailsSidebar'
]);

/** Server-wide settings any user may save: the update check and the accepted terms. Everything else needs an admin. */
const SHARED_PREFERENCE_KEYS = new Set(['tosAcceptedDate', 'latestVersion', 'lastUpdateCheck', 'lastDeclinedVersion']);

/** Settings only admins may read: API keys, tokens and passwords (the AI service key, for one). */
const ADMIN_ONLY_SETTING = /(key|keypath)$|token|secret|password/i;

const isAdminCaller = (event) => !event || !event.user || event.user.role === 'admin';

function isPerUserSetting(key) {
  return PER_USER_SETTING_KEYS.has(key) || /Width$/.test(String(key));
}

/** Settings viewers and editors may save. */
function isPreferenceSetting(key) {
  return isPerUserSetting(key) || SHARED_PREFERENCE_KEYS.has(key);
}

/** The id of a real user account behind a call (not the API token or the server itself). */
const accountId = (event) => (event && event.user && Number(event.user.id) > 0 ? Number(event.user.id) : null);

let userSettingsDb = null;

function userSettingsTable() {
  const db = database.db;
  if (userSettingsDb !== db) {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (user_id, key)
    )`
    ).run();
    userSettingsDb = db;
  }
  return db;
}

/** A deleted user's preferences go with them. */
function forgetUserSettings(userId) {
  try {
    userSettingsTable().prepare('DELETE FROM user_settings WHERE user_id = ?').run(Number(userId));
  } catch (error) {
    console.warn('Could not delete the settings of a deleted user:', error.message);
  }
}

const getSettingHandler = async (event, key) => {
  try {
    if (SECRET_SETTING_KEYS.has(key)) return null;
    if (!isAdminCaller(event) && ADMIN_ONLY_SETTING.test(String(key))) return null;
    const userId = accountId(event);
    if (userId && isPerUserSetting(key)) {
      const own = userSettingsTable().prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
      if (own) return own.value || null;
    }
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
  if (!isAdminCaller(event) && !isPreferenceSetting(key)) {
    throw new Error('Only an admin can change this setting');
  }
  // Guests share one guest user: their display choices are not kept (they would change everyone's).
  if (event && event.user && event.user.guest) return true;
  try {
    if (SECRET_SETTING_KEYS.has(key)) {
      throw new Error(`Setting ${key} can only be changed under JusttPrint Backend Access`);
    }
    if (!database.db) {
      console.error('Database not initialized when saving setting');
      return false;
    }
    const userId = accountId(event);
    if (userId && isPerUserSetting(key)) {
      userSettingsTable()
        .prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(userId, key, value == null ? null : String(value));
      return true;
    }
    // Log the key only: values can be API keys.
    database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    console.debug('Saved setting:', key);
    // STL Home folders, exclusions or the watch switch changed: restart folder watching.
    require('../stl-home').settingChanged(key);
    return true;
  } catch (error) {
    console.error('Error saving setting:', error);
    return false;
  }
};

ipcMain.handle('save-setting', saveSettingHandler);

module.exports = { isPreferenceSetting, isPerUserSetting, forgetUserSettings, ADMIN_ONLY_SETTING };

// Folder watching for STL Home (src/server/stl-home.js): on or off, and what is watched.
ipcMain.handle('get-folder-watch-status', async () => require('../stl-home').watchStatus());
