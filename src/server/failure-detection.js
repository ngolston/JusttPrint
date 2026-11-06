'use strict';

/**
 * Failure detection (the Printers page): while a Bambu Lab printer prints, its camera picture is
 * checked every so often by a detector the admin runs: Obico's ML API (github.com/
 * TheSpaghettiDetective/obico-server, ml_api), a container of its own. It answers GET
 * /p/?img=<picture address> with the spaghetti it sees: { detections: [[label, confidence, box]] }.
 *
 * The detector downloads the picture, so each one gets a short-lived address of its own on this
 * server (/api/detect-frame/<token>.jpg, before the login; 128 random bits, 60 seconds), at
 * JusttPrint's address as the detector reaches it (a setting).
 *
 * Scoring follows Obico's (backend/lib/prediction.py): a picture's score is the sum of what it
 * detected; a fast average of those (EWM) is compared with the print's own long-run average, so
 * a camera that always sees something is not a failure. Nothing counts in the first minutes.
 * Past the line, everyone is alerted ("A print looks like it is failing" in My alerts) and, when
 * the admin turned it on, the print is paused. One alert per print, again only after a resume.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const database = require('../core/database');

const CONFIG_KEY = 'failureDetection';
// The name has "token" in it: the settings API gives it to no one but admins (ipc/settings.js).
const TOKEN_KEY = 'failureDetectionToken';

/** Obico's numbers (backend/lib/prediction.py). */
const EWM_ALPHA = 2 / (12 + 1);
const THRESHOLD_LOW = 0.38;
const THRESHOLD_HIGH = 0.78;
const ROLLING_MEAN_SHORT_MULTIPLE = 3.8;
/** Obico looks at ~310 pictures (10 s apart) for the short average: ~50 minutes. */
const SHORT_WINDOW_SECONDS = 3100;
/** Nothing counts in the first five minutes (Obico: 30 pictures, 10 s apart). */
const WARMUP_SECONDS = 300;
const SENSITIVITY = { low: 0.8, medium: 1, high: 1.2 };
const FRAME_TTL_MS = 60 * 1000;
const TICK_MS = 5000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

const DEFAULTS = { enabled: false, url: '', selfUrl: '', intervalSeconds: 20, sensitivity: 'medium', autoPause: false, printers: null };

function readSetting(key) {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value ? String(row.value) : '';
  } catch (_) {
    return '';
  }
}

/** The settings, each part checked; what is missing is the default. */
function readConfig() {
  let saved;
  try {
    saved = JSON.parse(readSetting(CONFIG_KEY) || '{}') || {};
  } catch (_) {
    saved = {};
  }
  return clean(saved);
}

const httpUrl = (value, what) => {
  const text = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new Error(`${what} is not a web address`, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${what} starts with http:// or https://`);
  return text;
};

function clean(input) {
  const value = input && typeof input === 'object' ? input : {};
  const interval = Math.round(Number(value.intervalSeconds));
  let url = '';
  let selfUrl = '';
  try {
    url = httpUrl(value.url, 'The detector address');
    selfUrl = httpUrl(value.selfUrl, "JusttPrint's address");
  } catch (_) {
    /* a stored value that no longer reads: unset */
  }
  return {
    enabled: value.enabled === true,
    url,
    selfUrl,
    intervalSeconds: Number.isFinite(interval) ? Math.min(120, Math.max(10, interval)) : DEFAULTS.intervalSeconds,
    sensitivity: Object.hasOwn(SENSITIVITY, value.sensitivity) ? value.sensitivity : DEFAULTS.sensitivity,
    autoPause: value.autoPause === true,
    printers: Array.isArray(value.printers) ? [...new Set(value.printers.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : null
  };
}

/**
 * Save the settings (admins). `token` is the detector's ML_API_TOKEN: a string replaces it, ''
 * removes it, missing keeps it.
 */
function saveConfig(input) {
  const value = input && typeof input === 'object' ? input : {};
  const config = clean({
    ...value,
    url: httpUrl(value.url, 'The detector address'),
    selfUrl: httpUrl(value.selfUrl, "JusttPrint's address")
  });
  if (config.enabled && (!config.url || !config.selfUrl)) throw new Error("Give the detector's address and JusttPrint's address as the detector reaches it");
  const db = database.db;
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(CONFIG_KEY, JSON.stringify(config));
  if (typeof value.token === 'string') db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TOKEN_KEY, value.token.trim());
  if (!config.enabled) watched.clear();
  return publicConfig();
}

/** What a browser may know: the settings, whether a token is set, and each printer's watch. */
function publicConfig() {
  const config = readConfig();
  return {
    ...config,
    tokenSet: Boolean(readSetting(TOKEN_KEY)),
    printers: config.printers,
    watching: [...watched.values()].map((watch) => ({
      printerId: watch.printerId,
      pictures: watch.frames,
      score: watch.frames ? Math.round(adjusted(watch, config) * 100) / 100 : null,
      level: watch.level,
      warmingUp: watch.frames * config.intervalSeconds < WARMUP_SECONDS,
      checkedAt: watch.checkedAt ? new Date(watch.checkedAt).toISOString() : null,
      error: watch.error,
      alertedAt: watch.alertedAt ? new Date(watch.alertedAt).toISOString() : null,
      paused: watch.pausedByUs,
      flagged: !!watch.flagged
    }))
  };
}

// ---- Scoring ----

/** A picture's score: what the detector saw, added up (Obico: sum_p_in_detections). */
function scoreOf(detections) {
  if (!Array.isArray(detections)) return 0;
  let sum = 0;
  for (const detection of detections) {
    const confidence = Array.isArray(detection) ? Number(detection[1]) : Number(detection && detection.confidence);
    if (Number.isFinite(confidence) && confidence > 0) sum += confidence;
  }
  return sum;
}

function newWatch(printerId, job) {
  return {
    printerId,
    job,
    frames: 0,
    ewm: 0,
    mean: 0,
    /** @type {number[]} */
    recent: [],
    level: 'ok',
    checkedAt: 0,
    dueAt: 0,
    error: null,
    alertedAt: 0,
    pausedByUs: false,
    /** @type {Buffer | null} the picture that set off the alert */
    flagged: null,
    busy: false,
    state: 'printing'
  };
}

/** The fast average above the print's own long-run one, times the sensitivity. */
function adjusted(watch, config) {
  return (watch.ewm - watch.mean) * SENSITIVITY[config.sensitivity];
}

/**
 * Add a picture's score to a watch; returns its level: 'warming', 'ok', 'warning' or 'failing'.
 * @param {ReturnType<typeof newWatch>} watch
 * @param {number} score
 * @param {{ intervalSeconds: number, sensitivity: string }} config
 */
function addScore(watch, score, config) {
  watch.frames += 1;
  watch.ewm = watch.frames === 1 ? score : EWM_ALPHA * score + (1 - EWM_ALPHA) * watch.ewm;
  watch.mean += (score - watch.mean) / watch.frames;
  const shortCount = Math.max(5, Math.round(SHORT_WINDOW_SECONDS / config.intervalSeconds));
  watch.recent.push(score);
  if (watch.recent.length > shortCount) watch.recent.shift();
  if (watch.frames * config.intervalSeconds < WARMUP_SECONDS) return 'warming';
  const above = adjusted(watch, /** @type {any} */ (config));
  if (above < THRESHOLD_LOW) return 'ok';
  if (above > THRESHOLD_HIGH) return 'failing';
  const shortMean = watch.recent.reduce((sum, value) => sum + value, 0) / watch.recent.length;
  return above > (shortMean - watch.mean) * ROLLING_MEAN_SHORT_MULTIPLE ? 'failing' : 'warning';
}

// ---- Pictures for the detector ----

/** token -> { image, type, expires } */
const frames = new Map();

function offerPicture(image, type = 'image/jpeg', now = Date.now()) {
  for (const [token, entry] of frames) if (entry.expires <= now) frames.delete(token);
  const token = crypto.randomBytes(16).toString('hex');
  frames.set(token, { image, type, expires: now + FRAME_TTL_MS });
  return token;
}

/** GET /api/detect-frame/<token>.jpg, before the login: the detector has no session. */
function registerFrameRoutes(app) {
  app.get('/api/detect-frame/:token', (req, res) => {
    const token = String(req.params.token || '').replace(/\.(jpe?g|png)$/i, '');
    const entry = /^[0-9a-f]{32}$/.test(token) ? frames.get(token) : null;
    res.set('Cache-Control', 'no-store');
    if (!entry || entry.expires <= Date.now()) return res.status(404).end();
    res.type(entry.type).send(entry.image);
  });
}

// ---- Asking the detector ----

/**
 * Ask the detector about a picture: its detections. Throws in plain words.
 * @param {{ url: string, selfUrl: string }} config
 * @param {Buffer} image
 * @param {string} [type]
 */
async function detect(config, image, type = 'image/jpeg') {
  const token = offerPicture(image, type);
  const picture = `${config.selfUrl}/api/detect-frame/${token}.${type === 'image/png' ? 'png' : 'jpg'}`;
  const secret = readSetting(TOKEN_KEY);
  let response;
  try {
    response = await fetch(`${config.url}/p/?img=${encodeURIComponent(picture)}`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    const cause = error && error.cause && error.cause.code ? error.cause.code : error.name === 'TimeoutError' ? 'no answer' : error.message;
    throw new Error(`The detector at ${config.url} did not answer (${cause})`, { cause: error });
  } finally {
    setTimeout(() => frames.delete(token), 5000).unref?.();
  }
  if (response.status === 401) throw new Error("The detector refused the token: it must be the detector's ML_API_TOKEN");
  /** @type {any} */
  let body;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  if (!response.ok) {
    const said = body && body.message ? `: ${body.message}` : '';
    if (response.status === 400)
      throw new Error(`The detector could not get the picture from ${config.selfUrl}${said}. Check JusttPrint's address as the detector reaches it.`);
    throw new Error(`The detector answered ${response.status}${said}`);
  }
  if (!body || !Array.isArray(body.detections)) throw new Error(`${config.url} did not answer like Obico's ML API`);
  return body.detections;
}

/**
 * Settings → Test: the detector answers, and can fetch a picture from JusttPrint (the printer's
 * camera, or JusttPrint's logo when no printer is given).
 * @param {number | null} [printerId]
 */
async function testDetector(printerId = null) {
  const config = readConfig();
  if (!config.url || !config.selfUrl) throw new Error("Give the detector's address and JusttPrint's address first, and save");
  let health;
  try {
    health = await fetch(`${config.url}/hc/`, { signal: AbortSignal.timeout(10000) });
  } catch (error) {
    throw new Error(`Nothing answers at ${config.url}: is the detector running, and is the address right?`, { cause: error });
  }
  if (!health.ok || !/ok/i.test(await health.text())) throw new Error(`${config.url} answers, but its model is not loaded (yet): look at the detector's log`);
  /** @type {Buffer} */
  let image;
  let type = 'image/jpeg';
  if (printerId) {
    const picture = await require('./bambu-camera').shared().frame(Number(printerId), { waitMs: 10000 });
    if (!picture) throw new Error('JusttPrint cannot read that printer’s camera');
    if (!picture.jpeg) throw new Error(`No camera picture: ${picture.error}`);
    image = picture.jpeg;
  } else {
    image = await fs.promises.readFile(path.join(__dirname, '..', '..', 'assets', 'logo.png'));
    type = 'image/png';
  }
  const detections = await detect(config, image, type);
  return { ok: true, detections: detections.length, score: Math.round(scoreOf(detections) * 100) / 100 };
}

// ---- Watching prints ----

/** printerId -> watch, for the prints being watched now. */
const watched = new Map();
/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;

/**
 * One check of every printing printer that is due (exported for tests, with their own parts).
 * @param {{ now?: number, live?: any, cameras?: any, detectWith?: Function, alert?: Function, pause?: Function, db?: any }} [deps]
 */
async function tick(deps = {}) {
  const config = readConfig();
  if (!config.enabled || !config.url || !config.selfUrl) return;
  const now = deps.now || Date.now();
  const live = deps.live || require('./bambu-live');
  const seen = new Set();
  const checks = [];
  for (const summary of live.status()) {
    const printerId = summary.printerId;
    if (config.printers && !config.printers.includes(printerId)) continue;
    let watch = watched.get(printerId);
    if (summary.state !== 'printing' && summary.state !== 'paused') {
      watched.delete(printerId);
      continue;
    }
    seen.add(printerId);
    if (!watch || watch.job !== summary.job) {
      watch = newWatch(printerId, summary.job);
      watched.set(printerId, watch);
    }
    // Resumed after a pause: the fast average starts again from the long one, and may alert again.
    if (watch.state === 'paused' && summary.state === 'printing') {
      watch.ewm = watch.mean;
      watch.alertedAt = 0;
      watch.pausedByUs = false;
      watch.level = 'ok';
    }
    watch.state = summary.state;
    if (summary.state !== 'printing' || watch.busy || now < watch.dueAt) continue;
    watch.dueAt = now + config.intervalSeconds * 1000;
    watch.busy = true;
    checks.push(
      checkPrinter(watch, config, deps, now).finally(() => {
        watch.busy = false;
      })
    );
  }
  for (const printerId of [...watched.keys()]) if (!seen.has(printerId)) watched.delete(printerId);
  await Promise.all(checks);
}

async function checkPrinter(watch, config, deps, now) {
  try {
    const cameras = deps.cameras || require('./bambu-camera').shared();
    const picture = await cameras.frame(watch.printerId, { waitMs: 10000 });
    if (!picture) throw new Error('JusttPrint cannot read this printer’s camera');
    if (!picture.jpeg) throw new Error(`No camera picture: ${picture.error}`);
    const detections = await (deps.detectWith || detect)(config, picture.jpeg);
    watch.error = null;
    watch.checkedAt = deps.now || Date.now();
    const level = addScore(watch, scoreOf(detections), config);
    watch.level = level;
    if (level === 'failing' && !watch.alertedAt) {
      watch.alertedAt = watch.checkedAt;
      watch.flagged = picture.jpeg;
      await failing(watch, config, deps);
    }
  } catch (error) {
    watch.error = error.message;
    watch.checkedAt = now;
  }
}

async function failing(watch, config, deps) {
  const db = deps.db || database.db;
  const row = db.prepare('SELECT id, nickname FROM printers WHERE id = ?').get(watch.printerId) || { id: watch.printerId, nickname: 'A printer' };
  let paused = '';
  if (config.autoPause) {
    try {
      await (deps.pause || ((id) => require('./bambu-control').controlPrinter(id, 'pause')))(watch.printerId);
      watch.pausedByUs = true;
      paused = ' JusttPrint paused it: look at it, then resume or stop it on the Printers page.';
    } catch (error) {
      paused = ` JusttPrint could not pause it (${error.message}).`;
    }
  }
  const send = deps.alert || ((kind, a) => require('./personal-alerts').alert(kind, a));
  try {
    await send('printFailing', {
      title: `${row.nickname}: ${watch.job || 'the print'} looks like it is failing`,
      body: `The failure detector sees what looks like spaghetti on the camera.${paused || ' It is still printing: look at it on the Printers page.'}`,
      link: `#/printers/${row.id}`,
      level: 'error',
      minRole: 'viewer',
      key: `failure-detected-${row.id}-${watch.alertedAt}`
    });
  } catch (error) {
    console.warn('[Failure detection] Could not send the alert:', error.message);
  }
}

/** GET /api/printers/:id/detection-picture (signed in): the picture that set off the alert. */
function registerPictureRoutes(app) {
  app.get('/api/printers/:id/detection-picture', (req, res) => {
    const watch = watched.get(Number(req.params.id));
    res.set('Cache-Control', 'no-store');
    if (!watch || !watch.flagged) return res.status(404).end();
    res.type('image/jpeg').send(watch.flagged);
  });
}

function start() {
  stop();
  timer = setInterval(() => tick().catch((error) => console.warn('[Failure detection]', error.message)), TICK_MS);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  watched.clear();
  frames.clear();
}

module.exports = {
  readConfig,
  saveConfig,
  publicConfig,
  scoreOf,
  addScore,
  newWatch,
  detect,
  testDetector,
  tick,
  registerFrameRoutes,
  registerPictureRoutes,
  start,
  stop,
  _watched: watched,
  _frames: frames,
  THRESHOLD_HIGH,
  WARMUP_SECONDS
};
