'use strict';

/**
 * QR labels anyone can scan (docs/plan-10.1.md, Phase 5). With the admin setting `publicLabels`
 * on, a spool's or a place's label opens a read-only page without signing in:
 *
 *   GET /l/spool/:token         the spool: name, brand, material, color, grams left, where it is
 *   GET /l/spool/:token/photo   its uploaded photo
 *   GET /l/place/:token         the place and the spools in it
 *
 * The token (random, per spool and per place, made the first time a label is made) is the
 * permission, not the id. Never shown: prices, shops, notes, lots, who added it. With the setting
 * off, and for unknown tokens, the same "not available" page. Mounted before requireAuth.
 */

const crypto = require('crypto');
const path = require('path');
const database = require('../core/database');
const { escapeHtml } = require('./share-pages');

const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const TABLES = { spool: 'spools', place: 'storage_locations' };

/** Are labels public (the admin setting)? */
function labelsPublic(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'publicLabels'").get();
    return !!row && (row.value === 'true' || row.value === true || row.value === 1 || row.value === '1');
  } catch (_) {
    return false;
  }
}

/** The label token of a spool or place, made when it has none. */
function tokenFor(db, kind, id) {
  const table = TABLES[kind];
  const row = db.prepare(`SELECT label_token FROM ${table} WHERE id = ?`).get(id);
  if (!row) return null;
  if (row.label_token) return row.label_token;
  const token = crypto.randomBytes(16).toString('base64url');
  db.prepare(`UPDATE ${table} SET label_token = ? WHERE id = ?`).run(token, id);
  return token;
}

/**
 * The addresses (paths) the labels' QR codes open. Public: /l/spool/<token>, /l/place/<token>
 * (tokens made as needed). Not public: the spool's panel on the Filament page, which asks to sign
 * in; places then have no label address (null).
 * @param {any} db
 * @param {{ spoolIds?: number[], placeIds?: number[] }} input
 */
function labelLinks(db, input) {
  const isPublic = labelsPublic(db);
  const ids = (list) =>
    Array.isArray(list)
      ? list
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 2000)
      : [];
  /** @type {Record<string, string | null>} */
  const spools = {};
  /** @type {Record<string, string | null>} */
  const places = {};
  db.transaction(() => {
    for (const id of ids(input && input.spoolIds)) {
      const token = isPublic ? tokenFor(db, 'spool', id) : null;
      spools[id] = isPublic ? (token ? `/l/spool/${token}` : null) : `/#/filament/${id}`;
    }
    for (const id of ids(input && input.placeIds)) {
      const token = isPublic ? tokenFor(db, 'place', id) : null;
      places[id] = token ? `/l/place/${token}` : null;
    }
  })();
  return { public: isPublic, spools, places };
}

// ---- The pages ----

const STYLE = `
  :root { --bg: #f4f6f9; --card: #ffffff; --line: #dde2ea; --text: #1e2633; --muted: #5a6779; --accent: #bb3d29; --coral: #ea6450; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f141b; --card: #171e28; --line: #2b3442; --text: #eef2f6; --muted: #a7b2c0; --accent: #f08a78; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 560px; margin: 0 auto; padding: 20px 16px 40px; }
  header.top { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  header.top img { width: 22px; height: 22px; border-radius: 6px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 20px; }
  h1 { font-size: 24px; line-height: 1.2; margin: 0 0 4px; overflow-wrap: anywhere; }
  .sub { color: var(--muted); margin: 0 0 16px; }
  .photo { width: 100%; max-height: 260px; object-fit: cover; border-radius: 14px; margin-bottom: 16px; display: block; }
  .grams { font-size: 40px; font-weight: 800; line-height: 1; }
  .of { color: var(--muted); margin: 4px 0 12px; }
  .bar { height: 10px; border-radius: 999px; background: var(--line); overflow: hidden; margin-bottom: 16px; }
  .bar span { display: block; height: 100%; background: var(--coral); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
  dt { color: var(--muted); font-size: 14px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .dot { display: inline-block; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--line); vertical-align: -2px; margin-right: 6px; }
  ul.spools { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  ul.spools li a { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--bg); color: var(--text); text-decoration: none; }
  ul.spools .n { flex: 1; font-weight: 700; overflow-wrap: anywhere; }
  ul.spools .g { color: var(--muted); white-space: nowrap; }
  .edit { display: inline-block; margin-top: 18px; color: var(--accent); font-weight: 700; }
  .gone { text-align: center; margin-top: 15vh; }
`;

function pageHtml(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · JusttPrint</title>
<link rel="icon" href="/assets/favicon.ico">
<style>${STYLE}</style>
</head>
<body><div class="wrap">
<header class="top"><img src="/assets/logo.png" alt=""><span>A label from a JusttPrint library</span></header>
${body}
</div></body>
</html>`;
}

const GONE_HTML = pageHtml(
  'Label not available',
  `<div class="gone"><h1>Label not available</h1><p class="sub">This label does not open a page, or the library does not share its labels.</p></div>`
);

const grams = (n) => {
  const g = Math.max(0, Math.round(Number(n) || 0));
  return g < 1000 ? `${g} g` : `${(Math.round(g / 100) / 10).toLocaleString('en', { maximumFractionDigits: 1 })} kg`;
};
const color = (hex) => (/^#[0-9a-f]{6}$/i.test(String(hex || '')) ? hex : '#9aa4b4');

/** Where a spool is, in words: a printer slot, drying, a place, archived. */
function whereOf(spool) {
  if (spool.status === 'archived') return 'Archived (used up)';
  const parts = [];
  if (spool.loaded && spool.loaded.length) parts.push(`Loaded in ${spool.loaded.map((p) => p.label).join(', ')}`);
  if (spool.drying) parts.push('Drying');
  if (!parts.length) parts.push(spool.location_name || 'No place');
  return parts.join(' · ');
}

function spoolPage(db, token) {
  const row = db.prepare('SELECT id FROM spools WHERE label_token = ?').get(token);
  const spool = row && require('../core/spools').getSpool(db, row.id);
  if (!spool) return null;
  const pct = spool.initial_weight > 0 ? Math.max(0, Math.min(100, Math.round((spool.remaining / spool.initial_weight) * 100))) : 0;
  const photo = spool.photo_file ? `/l/spool/${token}/photo` : spool.photo_url && /^https?:\/\//.test(spool.photo_url) ? spool.photo_url : null;
  const material = [spool.material, spool.material_type].filter(Boolean).join(' ');
  return pageHtml(
    spool.display_name,
    `<main class="card">
${photo ? `<img class="photo" src="${escapeHtml(photo)}" alt="">` : ''}
<h1>${escapeHtml(spool.display_name)}</h1>
<p class="sub">${escapeHtml([spool.brand_name, material].filter(Boolean).join(' · '))}</p>
<div class="grams">${escapeHtml(grams(spool.remaining))}</div>
<p class="of">left of ${escapeHtml(grams(spool.initial_weight))} (${pct}%)</p>
<div class="bar" role="img" aria-label="${pct}% left"><span style="width:${pct}%"></span></div>
<dl>
<dt>Color</dt><dd><span class="dot" style="background:${color(spool.color_hex)}"></span>${escapeHtml(spool.color_name || spool.color_hex || '')}</dd>
<dt>Where</dt><dd>${escapeHtml(whereOf(spool))}</dd>
${spool.diameter ? `<dt>Diameter</dt><dd>${escapeHtml(spool.diameter)} mm</dd>` : ''}
</dl>
<a class="edit" href="/#/filament/${Number(spool.id)}">Sign in to edit</a>
</main>`
  );
}

function placePage(db, token) {
  const place = db.prepare('SELECT * FROM storage_locations WHERE label_token = ?').get(token);
  if (!place) return null;
  const spools = require('../core/spools')
    .listSpools(db, { includeArchived: false })
    .filter((s) => s.location_id === place.id);
  const items = spools
    .map((s) => {
      const t = tokenFor(db, 'spool', s.id);
      return `<li><a href="/l/spool/${t}"><span class="dot" style="background:${color(s.color_hex)}"></span><span class="n">${escapeHtml(s.display_name)}</span><span class="g">${escapeHtml(grams(s.remaining))}</span></a></li>`;
    })
    .join('\n');
  return pageHtml(
    place.name,
    `<main class="card">
<h1>${escapeHtml(place.name)}</h1>
<p class="sub">${place.is_dry_box ? 'Dry box · ' : ''}${spools.length} ${spools.length === 1 ? 'spool' : 'spools'}</p>
${spools.length ? `<ul class="spools">${items}</ul>` : '<p class="sub">No spools here now.</p>'}
<a class="edit" href="/#/filament">Sign in to edit</a>
</main>`
  );
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

/** The routes; http.js mounts them before requireAuth. */
function registerLabelPages(expressApp) {
  const page = (build) => (req, res) => {
    noStore(res);
    const db = database.db;
    const html = db && labelsPublic(db) && TOKEN.test(req.params.token) ? build(db, req.params.token) : null;
    if (!html) return res.status(404).type('html').send(GONE_HTML);
    res.type('html').send(html);
  };
  expressApp.get('/l/spool/:token', page(spoolPage));
  expressApp.get('/l/place/:token', page(placePage));
  expressApp.get('/l/spool/:token/photo', (req, res) => {
    noStore(res);
    const db = database.db;
    if (!db || !labelsPublic(db) || !TOKEN.test(req.params.token)) return res.status(404).end();
    const row = db.prepare('SELECT photo_file FROM spools WHERE label_token = ?').get(req.params.token);
    if (!row || !row.photo_file || !/^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(row.photo_file)) return res.status(404).end();
    res.sendFile(path.join(require('./photos').dirFor('spool'), row.photo_file), (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });
}

module.exports = { labelsPublic, labelLinks, tokenFor, registerLabelPages, spoolPage, placePage };
