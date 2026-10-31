'use strict';

/**
 * Home Assistant (docs/plan-10.1.md, Phase 11; after FilamentHub's services/home_assistant.py):
 * one sensor per spool, `sensor.justtprint_spool_<id>`, its state the grams left, with material,
 * color, percent, place and when it runs out as attributes. Pushed through Home Assistant's REST
 * API (POST /api/states/<entity>) after spools change and every hour; the sensors of spools that
 * are archived or deleted are removed. Settings → Integrations → Home Assistant (admins): its
 * address and a long-lived access token, kept in the homeAssistant setting, which the settings
 * API never reads or writes; browsers learn only whether a token is set.
 */

const database = require('../core/database');

const KEY = 'homeAssistant';
const TIMEOUT_MS = 10000;

function read() {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    return row && row.value ? JSON.parse(row.value) : {};
  } catch (_) {
    return {};
  }
}

function write(config) {
  database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(config));
}

/** What a browser may know: the address, on or off, whether a token is set, the last push. */
function status() {
  const config = read();
  return { url: config.url || '', enabled: !!config.enabled, tokenSet: !!config.token, lastPush: config.lastPush || null };
}

/** "http://homeassistant.local:8123/" → "http://homeassistant.local:8123"; anything else is refused. */
function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error('Home Assistant’s address looks like http://homeassistant.local:8123', { cause: error });
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Home Assistant’s address starts with http:// or https://');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Save the address, on or off, and the token (left out: kept; '' or null: removed).
 * @param {{ url?: string, enabled?: boolean, token?: string | null }} input
 */
function save(input = {}) {
  const config = read();
  if (input.url !== undefined) config.url = cleanUrl(input.url);
  if (input.enabled !== undefined) config.enabled = !!input.enabled;
  if (input.token !== undefined) {
    const token = String(input.token || '').trim();
    if (token && !/^[\w.-]{20,1000}$/.test(token)) throw new Error('That does not look like a Home Assistant long-lived access token');
    config.token = token || null;
  }
  if (config.enabled && (!config.url || !config.token)) throw new Error('Enter Home Assistant’s address and a token first');
  write(config);
  if (config.enabled) pushSoon(1000);
  return status();
}

/** One request to Home Assistant's REST API. */
async function request(config, method, path, body, fetchImpl) {
  const response = await fetchImpl(`${config.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', 'user-agent': 'JusttPrint' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status === 401) throw new Error('Home Assistant refused the token (401): make a new long-lived access token');
  return response;
}

/**
 * Check the address and token: { ok, message }, Home Assistant's own answer or why not (an
 * answer, not an error: a failed test is what Test is for).
 */
async function test({ fetchImpl = fetch } = {}) {
  const config = read();
  if (!config.url || !config.token) return { ok: false, message: 'Enter Home Assistant’s address and a token first' };
  let response;
  try {
    response = await request(config, 'GET', '/api/', undefined, fetchImpl);
  } catch (error) {
    if (/401/.test(error.message)) return { ok: false, message: error.message };
    return { ok: false, message: `Could not reach Home Assistant at ${config.url}: ${error.message}` };
  }
  if (!response.ok) return { ok: false, message: `Home Assistant answered ${response.status}` };
  const answer = await response.json().catch(() => ({}));
  return { ok: true, message: answer.message || 'API running.' };
}

const entityOf = (id) => `sensor.justtprint_spool_${Number(id)}`;

/** A spool as a Home Assistant state. */
function stateOf(spool, unit) {
  const pct = spool.initial_weight > 0 ? Math.round((spool.remaining / spool.initial_weight) * 1000) / 10 : 0;
  return {
    state: Math.round(spool.remaining * 10) / 10,
    attributes: {
      friendly_name: spool.display_name,
      unit_of_measurement: 'g',
      device_class: 'weight',
      state_class: 'measurement',
      icon: 'mdi:printer-3d-nozzle',
      spool_id: spool.id,
      brand: spool.brand_name || null,
      material: spool.material || null,
      kind: spool.material_type || null,
      color_hex: spool.color_hex || null,
      color_name: spool.color_name || null,
      percent: pct,
      initial_g: spool.initial_weight,
      status: spool.status,
      location: spool.location_name || null,
      loaded_in: spool.loaded.map((p) => p.label).join(', ') || null,
      drying: !!spool.drying,
      runs_out: spool.forecast ? spool.forecast.runsOut : null,
      // As the library shows weights (core/units.js), for a card that wants text.
      remaining_text: require('../core/units').formatWeight(spool.remaining, unit)
    }
  };
}

/**
 * Push every spool on hand, and remove the sensors of spools that are gone or archived.
 * Resolves to { pushed, removed, errors }, also kept as lastPush.
 */
async function push({ fetchImpl = fetch, now = new Date() } = {}) {
  const config = read();
  if (!config.enabled || !config.url || !config.token) return { pushed: 0, removed: 0, errors: 0, skipped: true };
  const db = database.db;
  const unit = require('../core/units').readUnits(db).weight;
  const spools = require('../core/spools').listSpools(db, { includeArchived: false });
  let pushed = 0;
  let errors = 0;
  /** @type {string | null} */
  let message = null;
  for (const spool of spools) {
    try {
      const response = await request(config, 'POST', `/api/states/${entityOf(spool.id)}`, stateOf(spool, unit), fetchImpl);
      if (response.ok) pushed += 1;
      else {
        errors += 1;
        message = `Home Assistant answered ${response.status}`;
      }
    } catch (error) {
      errors += 1;
      message = error.message;
      if (/401/.test(error.message)) break;
    }
  }
  // Sensors this pushed before for spools no longer on hand: removed from Home Assistant.
  const current = new Set(spools.map((s) => s.id));
  const before = Array.isArray(config.entities) ? config.entities : [];
  let removed = 0;
  const kept = [];
  for (const id of before) {
    if (current.has(id)) continue;
    try {
      const response = await request(config, 'DELETE', `/api/states/${entityOf(id)}`, undefined, fetchImpl);
      if (response.ok || response.status === 404) removed += 1;
      else kept.push(id);
    } catch (_) {
      kept.push(id);
    }
  }
  const lastPush = { at: now.toISOString(), pushed, removed, errors, message };
  write({ ...read(), entities: [...current, ...kept], lastPush });
  return lastPush;
}

/** @type {NodeJS.Timeout | null} */
let soonTimer = null;
/** @type {NodeJS.Timeout | null} */
let hourly = null;

/** Push in a little while (spools changed); repeated calls meanwhile make one push. */
function pushSoon(delay = 30 * 1000) {
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    push().catch((error) => console.warn(`[Home Assistant] ${error.message}`));
  }, delay);
  if (soonTimer.unref) soonTimer.unref();
}

function start() {
  if (hourly) return;
  hourly = setInterval(() => pushSoon(0), 60 * 60 * 1000);
  if (hourly.unref) hourly.unref();
  pushSoon(2 * 60 * 1000);
}

function stop() {
  if (hourly) clearInterval(hourly);
  if (soonTimer) clearTimeout(soonTimer);
  hourly = null;
  soonTimer = null;
}

module.exports = { status, save, test, push, pushSoon, start, stop, stateOf, entityOf, cleanUrl, read };
