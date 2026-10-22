'use strict';

const database = require('./database');
const { settingsFromEnv, SECRET_ENV } = require('./env-settings');
const { dedupePathList, excludeDirectoriesSettingIsEmpty, parseExcludePathList, readStlHomeDirectories } = require('./library-paths');
const { ADDITIONAL_FILE_TYPES_CATALOG } = require('./model-filters');

/**
 * Apply Docker/env defaults without clobbering user-saved settings on every restart.
 * Set JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1 to always apply env (old behavior).
 */
/** JUSTTPRINT_FILE_TYPES, JUSTTPRINT_AI_* and friends (env-settings.js). */
function applyEnvSettings() {
  if (!database.db) return;
  const { settings, errors } = settingsFromEnv(process.env, {
    fileTypeIds: ADDITIONAL_FILE_TYPES_CATALOG.map((entry) => entry.id)
  });
  const save = database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const { env, key, value } of settings) {
    save.run(key, value);
    console.log(`Startup env applied setting ${key} from ${env}:`, SECRET_ENV.has(env) ? '(hidden)' : value);
    // The Upload folder is made at once, so it is watched and uploads can go there.
    if (key === 'uploadFolder') {
      try {
        require('fs').mkdirSync(value, { recursive: true });
      } catch (error) {
        console.error(`Could not make the Upload folder ${value}: ${error.message}`);
      }
    }
  }
  for (const error of errors) console.error(`Ignored environment variable ${error}`);
}

function applyDockerEnvSettingIfNeeded(key, envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const trimmed = String(envValue).trim();
  const force = process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === '1' || process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const current = row?.value != null ? String(row.value).trim() : '';
    if (!force && current !== '') return;
    database.db
      .prepare(
        `
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
      )
      .run(key, trimmed);
    console.log(`Startup env applied setting ${key}:`, trimmed, force ? '(JUSTTPRINT_ENV_OVERRIDES_SETTINGS)' : '');
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

const pathKey = (p) =>
  String(p || '')
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase();

function saveStlHomeDirectories(paths) {
  const upsert = database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  upsert.run('stlHomeDirectories', JSON.stringify(paths));
  upsert.run('stlHome', paths[0] || '');
}

/**
 * STL Home directories from STL_HOME (one path or several: comma, semicolon, newline, or a JSON
 * array). The first time, they become the list. After that the list follows changes to STL_HOME:
 * folders added to it are added, folders taken out of it are removed, and folders chosen in the
 * web UI stay. What STL_HOME held last is kept in stlHomeFromEnv; without it (an install from
 * before 7.23.0) the current value is only recorded. JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1 makes
 * STL_HOME the whole list on every start.
 */
function applyStlHomeEnvIfNeeded(envValue) {
  if (!database.db) return;
  const paths = dedupePathList(parseExcludePathList(envValue));
  const force = process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === '1' || process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    const setting = (key) => database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
    const remember = () =>
      database.db
        .prepare("INSERT INTO settings (key, value) VALUES ('stlHomeFromEnv', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(paths));
    const lastRaw = setting('stlHomeFromEnv');

    if ((force && paths.length) || (paths.length && stlHomeDirectoriesAreUnset())) {
      saveStlHomeDirectories(paths);
      remember();
      console.log('Startup env applied setting stlHomeDirectories:', JSON.stringify(paths), force ? '(JUSTTPRINT_ENV_OVERRIDES_SETTINGS)' : '');
      return;
    }
    if (lastRaw == null) {
      if (paths.length) remember();
      return;
    }

    const last = parseExcludePathList(lastRaw);
    const now = new Set(paths.map(pathKey));
    const before = new Set(last.map(pathKey));
    const added = paths.filter((p) => !before.has(pathKey(p)));
    const removed = new Set(last.filter((p) => !now.has(pathKey(p))).map(pathKey));
    if (added.length || removed.size) {
      const current = readStlHomeDirectories();
      const kept = current.filter((p) => !removed.has(pathKey(p)));
      const have = new Set(kept.map(pathKey));
      const next = [...kept, ...added.filter((p) => !have.has(pathKey(p)))];
      saveStlHomeDirectories(next);
      const changes = [];
      if (added.length) changes.push(`added ${added.join(', ')}`);
      if (removed.size) changes.push(`removed ${last.filter((p) => removed.has(pathKey(p))).join(', ')}`);
      console.log(`Startup env STL_HOME changed: ${changes.join('; ')}`);
    }
    remember();
  } catch (e) {
    console.error('Error applying STL_HOME:', e);
  }
}

/**
 * Seed STL Home excluded directories from STL_HOME_EXCLUDE.
 * The stored default is "[]", which is unset. A saved list is left alone unless
 * JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1.
 */
function applyStlHomeExcludeEnvIfNeeded(envValue) {
  if (!database.db || !envValue || !String(envValue).trim()) return;
  const paths = parseExcludePathList(envValue);
  if (!paths.length) return;
  const force = process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === '1' || process.env.JUSTTPRINT_ENV_OVERRIDES_SETTINGS === 'true';
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeExcludeDirectories');
    if (!force && !excludeDirectoriesSettingIsEmpty(row?.value)) return;
    const json = JSON.stringify(paths);
    database.db
      .prepare(
        `
      INSERT INTO settings (key, value)
      VALUES ('stlHomeExcludeDirectories', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
      )
      .run(json);
    console.log('Startup env applied setting stlHomeExcludeDirectories:', json, force ? '(JUSTTPRINT_ENV_OVERRIDES_SETTINGS)' : '');
  } catch (e) {
    console.error('Error applying STL_HOME_EXCLUDE:', e);
  }
}

module.exports = { applyDockerEnvSettingIfNeeded, applyEnvSettings, applyStlHomeEnvIfNeeded, applyStlHomeExcludeEnvIfNeeded };
