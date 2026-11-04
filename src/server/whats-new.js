'use strict';

/**
 * What's New after an update (src/web/startup/WhatsNew.tsx): the CHANGELOG.md entries of the
 * versions a person has not seen yet. Each "## [x.y.z] - date" section is one entry; Unreleased
 * is left out.
 */

const fs = require('fs');
const path = require('path');

const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');
/** At most this many versions at once (someone who skipped many updates). */
const MAX_ENTRIES = 5;

/** -1, 0 or 1, comparing dotted version numbers (missing parts count as 0). */
function compareVersions(a, b) {
  const pa = String(a)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The released entries of a changelog, newest first: { version, date, body } (body is Markdown).
 * @param {string} text
 */
function parseChangelog(text) {
  const entries = [];
  /** @type {{ version: string, date: string, lines: string[] } | null} */
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const heading = /^## \[(\d+(?:\.\d+)*)\](?:\s*-\s*(\S+))?/.exec(line);
    if (heading || /^## /.test(line)) {
      if (current) entries.push(current);
      current = heading ? { version: heading[1], date: heading[2] || '', lines: [] } : null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) entries.push(current);
  return entries.map(({ version, date, lines }) => ({ version, date, body: lines.join('\n').trim() }));
}

/**
 * What changed after `since` up to `current`: the entries between them (only `current`'s when
 * `since` is not known), newest first.
 * @param {string} text the changelog
 * @param {string | null} since the version the person saw last
 * @param {string} current the running version
 */
function entriesSince(text, since, current) {
  const entries = parseChangelog(text).filter((entry) => compareVersions(entry.version, current) <= 0);
  const newer = since ? entries.filter((entry) => compareVersions(entry.version, since) > 0) : entries.filter((entry) => entry.version === current);
  return newer.slice(0, MAX_ENTRIES);
}

/** @type {string | null} */
let cached = null;
/** The changelog shipped with this version (read once). */
function changelogText() {
  if (cached == null) {
    try {
      cached = fs.readFileSync(CHANGELOG, 'utf8');
    } catch (_) {
      cached = '';
    }
  }
  return cached || '';
}

module.exports = { compareVersions, parseChangelog, entriesSince, changelogText, MAX_ENTRIES };
