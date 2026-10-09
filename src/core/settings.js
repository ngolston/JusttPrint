'use strict';

const database = require('./database');

function persistSetting(key, value) {
  if (!database.db) throw new Error('Database is not initialized');
  database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value == null ? '' : String(value));
}

function getSettingValueOr(key, fallback) {
  try {
    if (!database.db) return fallback;
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value != null && row.value !== '') return row.value;
  } catch (_) {
    /* ignore */
  }
  return fallback;
}

function envOverridesSettings() {
  return process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === '1' || process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === 'true';
}

function flushSettingsToDisk() {
  try {
    if (!database.db) return;
    database.db.pragma('synchronous = FULL');
    database.db.prepare('PRAGMA wal_checkpoint(FULL)').run();
  } catch (_) {
    /* ignore */
  }
}

module.exports = { envOverridesSettings, flushSettingsToDisk, getSettingValueOr, persistSetting };
