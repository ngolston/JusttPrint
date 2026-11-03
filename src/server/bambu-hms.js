'use strict';

/**
 * Bambu Lab printer errors in plain words. A printer reports HMS codes (`print.hms`: attr and code,
 * shown as 0700_2000_0002_0001) and a print error (`print.print_error`, shown as 0300_8001).
 * Their texts come from Bambu's public error list, downloaded at most once a day and kept next
 * to the database (bambu-hms.json); without it a code is shown with a link to look it up.
 */

const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://e.bambulab.com/query.php?lang=en';
const REFRESH_MS = 24 * 3600 * 1000;
const FILE = 'bambu-hms.json';

const hex = (n, width) => (Number(n) >>> 0).toString(16).toUpperCase().padStart(width, '0');

/** "0700_2000_0002_0001" from an HMS entry's attr and code. */
function hmsCode(attr, code) {
  const a = hex(attr, 8);
  const c = hex(code, 8);
  return `${a.slice(0, 4)}_${a.slice(4)}_${c.slice(0, 4)}_${c.slice(4)}`;
}

/** "0300_8001" from a print_error number, or null for none. */
function printErrorCode(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const h = hex(n, 8);
  return `${h.slice(0, 4)}_${h.slice(4)}`;
}

/** Bambu's page for a code. */
const lookUpUrl = (code) => `https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/${code}`;

/** Every { ecode, intro } anywhere in Bambu's answer, as a map of ecode (no underscores) to text. */
function textsFrom(json) {
  const texts = new Map();
  const walk = (value, depth) => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && typeof item.ecode === 'string' && typeof item.intro === 'string') {
          const key = item.ecode.replace(/[^0-9a-f]/gi, '').toUpperCase();
          const text = item.intro.replace(/\s+/g, ' ').trim();
          if (key && text && !texts.has(key)) texts.set(key, text);
        } else walk(item, depth + 1);
      }
      return;
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(json, 0);
  return texts;
}

/** @type {Map<string, string> | null} */
let texts = null;
let loadedAt = 0;
/** @type {Promise<void> | null} */
let loading = null;

function filePath() {
  try {
    return path.join(require('./runtime').app.getPath('userData'), FILE);
  } catch (_) {
    return null;
  }
}

function readFile() {
  const file = filePath();
  if (!file) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    texts = new Map(Object.entries(saved.texts || {}));
    loadedAt = Number(saved.fetchedAt) || 0;
  } catch (_) {
    /* none yet */
  }
}

/** Download the list (in the background; once a day at most). */
function refresh(fetchImpl) {
  if (loading || Date.now() - loadedAt < REFRESH_MS) return loading;
  loading = (async () => {
    try {
      const { httpsFetch, readLimited, USER_AGENT } = require('./link-import');
      const response = await (fetchImpl || httpsFetch)(LIST_URL, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`Bambu Lab answered ${response.status}`);
      const found = textsFrom(JSON.parse((await readLimited(response, 16 * 1024 * 1024)).toString('utf8')));
      if (!found.size) throw new Error('no error texts in the list');
      texts = found;
      loadedAt = Date.now();
      const file = filePath();
      if (file) fs.writeFileSync(file, JSON.stringify({ fetchedAt: loadedAt, texts: Object.fromEntries(found) }));
    } catch (error) {
      // Tried again in an hour; codes show with their link meanwhile.
      loadedAt = Date.now() - REFRESH_MS + 3600 * 1000;
      console.warn(`[Bambu errors] Could not download the error list: ${error.message}`);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** The text for a code ("0700_2000_0002_0001" or "0300_8001"), or null when not known (yet). */
function textFor(code) {
  if (!texts) readFile();
  if (!texts || Date.now() - loadedAt >= REFRESH_MS) void refresh();
  return (texts && texts.get(String(code).replace(/_/g, '').toUpperCase())) || null;
}

/**
 * A printer's errors now: [{ code, text, url }], the print error first.
 * @param {any} print a printer's (merged) report
 */
function errorsOf(print) {
  const out = [];
  const printError = printErrorCode(print && print.print_error);
  if (printError) out.push({ code: printError, text: textFor(printError), url: lookUpUrl(printError) });
  for (const entry of Array.isArray(print && print.hms) ? print.hms : []) {
    if (!entry || entry.attr === undefined || entry.code === undefined) continue;
    const code = hmsCode(entry.attr, entry.code);
    if (!out.some((e) => e.code === code)) out.push({ code, text: textFor(code), url: lookUpUrl(code) });
  }
  return out;
}

/** For tests: use these texts. */
function setTexts(map) {
  texts = map;
  loadedAt = Date.now();
}

module.exports = { hmsCode, printErrorCode, lookUpUrl, textsFrom, textFor, errorsOf, refresh, setTexts, LIST_URL };
