'use strict';

/**
 * Settings that Docker users can set with environment variables. These apply on every start
 * (the container's configuration wins over the UI), unlike STL_HOME and JUSTTPRINT_PORT,
 * which only fill an empty setting unless JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1.
 */

const AI_SERVICES = ['openai', 'claude', 'gemini', 'puter', 'custom'];

function parseBoolean(value) {
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return '1';
  if (['0', 'false', 'no', 'off'].includes(text)) return '0';
  throw new Error(`expected true or false, got "${value}"`);
}

function wholeNumber(value, min, max) {
  const text = String(value).trim();
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < min || number > max) throw new Error(`expected a whole number from ${min} to ${max}, got "${value}"`);
  return number;
}

function splitList(value) {
  return String(value).split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

/** [env name, setting key, convert(value, ctx) -> stored string] */
const ENV_SETTINGS = [
  ['JUSTTPRINT_ENABLE_ZIP', 'enableZipArchives', parseBoolean],
  ['JUSTTPRINT_FILE_TYPES', 'scanAdditionalFileTypes', (value, ctx) => {
    const ids = splitList(value).map((id) => id.toLowerCase().replace(/^\./, ''));
    const unknown = ids.filter((id) => !ctx.fileTypeIds.includes(id));
    if (unknown.length) throw new Error(`unknown file types: ${unknown.join(', ')} (known: ${ctx.fileTypeIds.join(', ')})`);
    return JSON.stringify([...new Set(ids)]);
  }],
  ['JUSTTPRINT_SCAN_EXCLUDE', 'scanExcludeFolders', (value) => splitList(value).join('\n')],
  ['JUSTTPRINT_AI_SERVICE', 'aiService', (value) => {
    const service = String(value).trim().toLowerCase();
    if (!AI_SERVICES.includes(service)) throw new Error(`expected one of ${AI_SERVICES.join(', ')}`);
    return service;
  }],
  ['JUSTTPRINT_AI_API_KEY', 'apiKey', (value) => String(value).trim()],
  ['JUSTTPRINT_AI_MODEL', 'aiModel', (value) => String(value).trim()],
  ['JUSTTPRINT_AI_ENDPOINT', 'apiEndpoint', (value) => {
    const url = new URL(String(value).trim());
    return url.toString().replace(/\/$/, '');
  }],
  // Folder watching for STL Home (src/server/stl-home.js).
  ['JUSTTPRINT_WATCH_FOLDERS', 'stlHomeWatch', parseBoolean],
  // Automatic database backups (src/server/auto-backup.js).
  ['JUSTTPRINT_AUTO_BACKUP', 'autoBackupEnabled', parseBoolean],
  ['JUSTTPRINT_BACKUP_INTERVAL_HOURS', 'autoBackupIntervalHours', (value) => String(wholeNumber(value, 1, 8760))],
  ['JUSTTPRINT_BACKUP_KEEP', 'autoBackupKeep', (value) => String(wholeNumber(value, 1, 1000))],
  ['JUSTTPRINT_BACKUP_DIR', 'autoBackupDirectory', (value) => {
    const dir = String(value).trim().replace(/\/+$/, '') || '/';
    if (!dir.startsWith('/')) throw new Error(`expected an absolute container path, got "${value}"`);
    return dir;
  }]
];

/** Values that must not be printed in the log. */
const SECRET_ENV = new Set(['JUSTTPRINT_AI_API_KEY']);

/**
 * @param {object} env process.env
 * @param {{fileTypeIds: string[]}} ctx
 * @returns {{settings: Array<{env: string, key: string, value: string}>, errors: string[]}}
 */
function settingsFromEnv(env, ctx) {
  const settings = [];
  const errors = [];
  for (const [name, key, convert] of ENV_SETTINGS) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') continue;
    try {
      settings.push({ env: name, key, value: convert(raw, ctx) });
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return { settings, errors };
}

module.exports = { settingsFromEnv, ENV_SETTINGS, SECRET_ENV, AI_SERVICES };
