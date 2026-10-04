'use strict';

const database = require('./database');
const { settingsFromEnv, SECRET_ENV } = require('../../env-settings');
const { dedupePathList, excludeDirectoriesSettingIsEmpty, parseExcludePathList } = require('./library-paths');
const { ADDITIONAL_FILE_TYPES_CATALOG } = require('./model-filters');

/**
 * Apply Docker/env defaults without clobbering user-saved settings on every restart.
 * Set PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1 to always apply env (old behavior).
 */
/** PRINTVENTORY_ENABLE_ZIP, PRINTVENTORY_FILE_TYPES, PRINTVENTORY_AI_* and friends (env-settings.js). */
function applyEnvSettings() {
  if (!database.db) return;
  const { settings, errors } = settingsFromEnv(process.env, {
    fileTypeIds: ADDITIONAL_FILE_TYPES_CATALOG.map((entry) => entry.id)
  });
  const save = database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const { env, key, value } of settings) {
    save.run(key, value);
    console.log(`Startup env applied setting ${key} from ${env}:`, SECRET_ENV.has(env) ? '(hidden)' : value);
  }
  for (const error of errors) console.error(`Ignored environment variable ${error}`);
}

function applyDockerEnvSettingIfNeeded(key, envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const trimmed = String(envValue).trim();
  const force = process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === '1' ||
    process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const current = row?.value != null ? String(row.value).trim() : '';
    if (!force && current !== '') return;
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, trimmed);
    console.log(`Startup env applied setting ${key}:`, trimmed, force ? '(PRINTVENTORY_ENV_OVERRIDES_SETTINGS)' : '');
  } catch (e) {
    console.error(`Error applying env to setting ${key}:`, e);
  }
}

function stlHomeDirectoriesAreUnset() {
  const listRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeDirectories');
  if (!excludeDirectoriesSettingIsEmpty(listRow?.value)) return false;
  const legacy = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHome')?.value;
  return !String(legacy || '').trim();
}

/**
 * Seed STL Home directories from STL_HOME.
 * One path or several (comma, semicolon, newline, or a JSON array). The stored
 * list default is "[]", which is unset. A saved list — or a legacy stlHome path —
 * is left alone unless PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1.
 */
function applyStlHomeEnvIfNeeded(envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const paths = dedupePathList(parseExcludePathList(envValue));
  if (!paths.length) return;
  const force = process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === '1' ||
    process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    if (!force && !stlHomeDirectoriesAreUnset()) return;
    const json = JSON.stringify(paths);
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('stlHomeDirectories', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(json);
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('stlHome', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(paths[0]);
    console.log('Startup env applied setting stlHomeDirectories:', json, force ? '(PRINTVENTORY_ENV_OVERRIDES_SETTINGS)' : '');
  } catch (e) {
    console.error('Error applying STL_HOME:', e);
  }
}

/**
 * Seed STL Home excluded directories from STL_HOME_EXCLUDE.
 * The stored default is "[]", which is unset. A saved list is left alone unless
 * PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1.
 */
function applyStlHomeExcludeEnvIfNeeded(envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const paths = parseExcludePathList(envValue);
  if (!paths.length) return;
  const force = process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === '1' ||
    process.env.PRINTVENTORY_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeExcludeDirectories');
    if (!force && !excludeDirectoriesSettingIsEmpty(row?.value)) return;
    const json = JSON.stringify(paths);
    database.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('stlHomeExcludeDirectories', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(json);
    console.log('Startup env applied setting stlHomeExcludeDirectories:', json, force ? '(PRINTVENTORY_ENV_OVERRIDES_SETTINGS)' : '');
  } catch (e) {
    console.error('Error applying STL_HOME_EXCLUDE:', e);
  }
}

module.exports = { applyDockerEnvSettingIfNeeded, applyEnvSettings, applyStlHomeEnvIfNeeded, applyStlHomeExcludeEnvIfNeeded };
