'use strict';

/**
 * Settings that Docker users can set with environment variables. These apply on every start
 * (the container's configuration wins over the UI), unlike STL_HOME and PRINTVENTORY_PORT,
 * which only fill an empty setting unless PRINTVENTORY_ENV_OVERRIDES_SETTINGS=1.
 */

const AI_SERVICES = ['openai', 'claude', 'gemini', 'puter', 'custom'];

function parseBoolean(value) {
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return '1';
  if (['0', 'false', 'no', 'off'].includes(text)) return '0';
  throw new Error(`expected true or false, got "${value}"`);
}

function splitList(value) {
  return String(value).split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

/** [env name, setting key, convert(value, ctx) -> stored string] */
const ENV_SETTINGS = [
  ['PRINTVENTORY_ENABLE_ZIP', 'enableZipArchives', parseBoolean],
  ['PRINTVENTORY_FILE_TYPES', 'scanAdditionalFileTypes', (value, ctx) => {
    const ids = splitList(value).map((id) => id.toLowerCase().replace(/^\./, ''));
    const unknown = ids.filter((id) => !ctx.fileTypeIds.includes(id));
    if (unknown.length) throw new Error(`unknown file types: ${unknown.join(', ')} (known: ${ctx.fileTypeIds.join(', ')})`);
    return JSON.stringify([...new Set(ids)]);
  }],
  ['PRINTVENTORY_SCAN_EXCLUDE', 'scanExcludeFolders', (value) => splitList(value).join('\n')],
  ['PRINTVENTORY_AI_SERVICE', 'aiService', (value) => {
    const service = String(value).trim().toLowerCase();
    if (!AI_SERVICES.includes(service)) throw new Error(`expected one of ${AI_SERVICES.join(', ')}`);
    return service;
  }],
  ['PRINTVENTORY_AI_API_KEY', 'apiKey', (value) => String(value).trim()],
  ['PRINTVENTORY_AI_MODEL', 'aiModel', (value) => String(value).trim()],
  ['PRINTVENTORY_AI_ENDPOINT', 'apiEndpoint', (value) => {
    const url = new URL(String(value).trim());
    return url.toString().replace(/\/$/, '');
  }]
];

/** Values that must not be printed in the log. */
const SECRET_ENV = new Set(['PRINTVENTORY_AI_API_KEY']);

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
