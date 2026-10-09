'use strict';

/**
 * The public pages behind share links (core/share-links.js). No login: the token in the address
 * is the permission. Mounted before requireAuth.
 *
 *   GET /s/:token               the page: the model, or the collection's models
 *   GET /s/:token/thumb/:id     a shared model's thumbnail
 *   GET /s/:token/file/:id      download a shared model (only when the link allows downloads)
 *   GET /s/:token/mesh/:id      a shared STL or 3MF for the 3D view (links with a 3D preview)
 *   GET /share-viewer/*.js      the 3D view's script (src/web/share/viewer.ts) and three.js
 *
 * Shown: names, thumbnails, designer, license, tags, source link (http/https only) and size.
 * Never shown: notes, file paths, print history, other models. Unknown, revoked and expired
 * tokens all get the same "not available" page. The page has no scripts, except the 3D view's
 * on links with a 3D preview.
 */

const database = require('../core/database');
const { getThumbnailImagePayload, readThumbnailColumn } = require('../core/thumbnails');
const { resolveShareLink, recordShareView } = require('../core/share-links');
const path = require('path');
const { sendModelFile } = require('./model-file');
const { jsonStringifyForWs } = require('./ws-json');

/** The built viewer (vite.config.mjs: share-viewer.js, and the three.js chunk it imports). */
const VIEWER_DIR = path.join(__dirname, '..', '..', 'web-build');
const VIEWER_FILES = new Set(['share-viewer.js', 'three.js']);

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]
  );
}

function safeLink(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch (_) {
    return null;
  }
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** "Benchy" for "Benchy.stl", "part" for "pack.zip::inner/part.stl". */
function displayName(fileName) {
  const base =
    String(fileName || '')
      .split('::')
      .pop()
      ?.split('/')
      .pop() || '';
  return base.replace(/\.[^.]+$/, '') || base;
}

const STYLE = `
  :root { color-scheme: dark; --bg: #081017; --card: #0e1821; --card-2: #111d27; --border: #21303b; --text: #f2f6f8; --muted: #aab9c5; --faint: #768999; --accent: #08b9f1; --on-accent: #04121a; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  header.top { display: flex; align-items: center; gap: 10px; color: var(--faint); font-size: 13px; margin-bottom: 20px; }
  header.top img { width: 22px; height: 22px; border-radius: 6px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; overflow-wrap: anywhere; }
  .lead { color: var(--muted); margin: 0 0 6px; white-space: pre-line; }
  .meta { color: var(--faint); font-size: 13px; margin: 0 0 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .card { display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .thumb { aspect-ratio: 4 / 3; background: var(--card-2); display: grid; place-items: center; }
  .thumb img { width: 100%; height: 100%; object-fit: contain; }
  .thumb svg { width: 56px; height: 56px; color: var(--faint); }
  .body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .row { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: rgba(8, 185, 241, 0.12); color: var(--muted); }
  .actions { margin-top: auto; padding-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; }
  a { color: var(--accent); }
  .btn { display: inline-block; padding: 7px 14px; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; font-size: 14px; line-height: 1.5; text-decoration: none; cursor: pointer; }
  .btn-quiet { background: var(--card-2); color: var(--text); border: 1px solid var(--border); }
  dialog.viewer { width: min(960px, calc(100vw - 32px)); height: min(720px, calc(100vh - 32px)); padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: var(--text); overflow: hidden; }
  dialog.viewer::backdrop { background: rgba(0, 0, 0, 0.7); }
  .viewer-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .viewer-bar strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .viewer-stage { position: relative; height: calc(100% - 53px); }
  .viewer-stage canvas { display: block; width: 100%; height: 100%; touch-action: none; }
  .viewer-status { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); padding: 24px; text-align: center; pointer-events: none; }
  .viewer-status[hidden] { display: none; }
  .single { display: grid; grid-template-columns: minmax(0, 560px) minmax(0, 1fr); gap: 24px; align-items: start; }
  .single .thumb { border-radius: 12px; border: 1px solid var(--border); }
  .single dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0 0 16px; }
  .single dt { color: var(--faint); font-size: 13px; }
  .single dd { margin: 0; overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 32px 0; }
  .gone { max-width: 420px; margin: 15vh auto 0; text-align: center; }
  @media (max-width: 720px) { .single { grid-template-columns: 1fr; } h1 { font-size: 22px; } }
`;

const PLACEHOLDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/></svg>';

/** 'stl' or '3mf' when a shared model can be shown in 3D (also inside a ZIP file), else null. */
function meshKind(model) {
  const name = (
    String(model.filePath || '')
      .split('::')
      .pop() || ''
  ).toLowerCase();
  return name.endsWith('.stl') ? 'stl' : name.endsWith('.3mf') ? '3mf' : null;
}

const hasPreview = (share) => share.allowPreview && share.models.some((model) => meshKind(model));

function pageHtml(title, body, { viewer = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · JusttPrint</title>
<link rel="icon" href="/assets/favicon.ico">
<style>${STYLE}</style>
${viewer ? '<script type="module" src="/share-viewer/share-viewer.js"></script>' : ''}
</head>
<body><div class="wrap">
<header class="top"><img src="/assets/logo.png" alt=""><span>Shared from a JusttPrint library</span></header>
${body}
</div></body>
</html>`;
}

function thumbHtml(share, model) {
  return model.hasThumbnail ? `<img src="/s/${share.token}/thumb/${model.id}" alt="" loading="lazy">` : PLACEHOLDER;
}

function downloadHtml(share, model) {
  return share.allowDownload ? `<a class="btn" href="/s/${share.token}/file/${model.id}" download>Download</a>` : '';
}

function previewHtml(share, model) {
  const kind = share.allowPreview && meshKind(model);
  return kind
    ? `<button type="button" class="btn btn-quiet view3d" data-mesh="/s/${share.token}/mesh/${model.id}" data-kind="${kind}" data-name="${escapeHtml(displayName(model.fileName))}">3D view</button>`
    : '';
}

function sourceHtml(model) {
  const link = safeLink(model.source);
  return link ? `<a href="${escapeHtml(link)}" rel="noopener noreferrer nofollow" target="_blank">Source</a>` : '';
}

function tagsHtml(model) {
  return model.tags.length ? `<div class="tags">${model.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
}

function cardHtml(share, model) {
  return `<article class="card">
  <div class="thumb">${thumbHtml(share, model)}</div>
  <div class="body">
    <div class="name" title="${escapeHtml(model.fileName)}">${escapeHtml(displayName(model.fileName))}</div>
    ${model.designer ? `<div class="row">By ${escapeHtml(model.designer)}</div>` : ''}
    ${model.license ? `<div class="row">${escapeHtml(model.license)}</div>` : ''}
    ${tagsHtml(model)}
    <div class="actions">${previewHtml(share, model)}${downloadHtml(share, model)}${sourceHtml(model)}</div>
  </div>
</article>`;
}

function expiryText(share) {
  if (!share.expiresAt) return '';
  return ` · This link works until ${escapeHtml(new Date(share.expiresAt).toUTCString().replace(/:\d\d GMT$/, ' UTC'))}`;
}

function sharePageHtml(share) {
  if (share.kind === 'model') {
    const model = share.models[0];
    const rows = [
      ['File', escapeHtml(String(model.fileName).split('::').pop())],
      model.designer && ['Designer', escapeHtml(model.designer)],
      model.license && ['License', escapeHtml(model.license)],
      formatSize(model.size) && ['Size', formatSize(model.size)]
    ].filter(Boolean);
    return pageHtml(
      displayName(model.fileName),
      `
<div class="single">
  <div class="thumb">${thumbHtml(share, model)}</div>
  <div>
    <h1>${escapeHtml(displayName(model.fileName))}</h1>
    <p class="meta">A 3D model${share.allowDownload ? '' : ' (view only)'}${expiryText(share)}</p>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${tagsHtml(model)}
    <div class="actions">${previewHtml(share, model)}${downloadHtml(share, model)}${sourceHtml(model)}</div>
  </div>
</div>`,
      { viewer: hasPreview(share) }
    );
  }
  const n = share.models.length;
  return pageHtml(
    share.title,
    `
<h1>${escapeHtml(share.title)}</h1>
${share.description ? `<p class="lead">${escapeHtml(share.description)}</p>` : ''}
<p class="meta">A collection of ${n} ${n === 1 ? 'model' : 'models'}${share.allowDownload ? '' : ' (view only)'}${expiryText(share)}</p>
${n ? `<div class="grid">${share.models.map((m) => cardHtml(share, m)).join('\n')}</div>` : '<p class="empty">This collection is empty.</p>'}`,
    { viewer: hasPreview(share) }
  );
}

const GONE_HTML = pageHtml(
  'Link not available',
  `
<div class="gone">
  <h1>This link is not available</h1>
  <p class="lead">It may have expired or been turned off by the person who shared it.</p>
</div>`
);

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

/** The share and the model `id` in it, or null. */
function sharedModel(req) {
  const share = resolveShareLink(database.db, req.params.token);
  if (!share) return { share: null, model: null };
  const model = share.models.find((m) => String(m.id) === String(req.params.id)) || null;
  return { share, model };
}

function withThumbFlags(share) {
  for (const model of share.models) {
    const stored = readThumbnailColumn(model.filePath);
    model.hasThumbnail = !!getThumbnailImagePayload(stored);
  }
  return share;
}

// 3MF files for share pages are parsed one at a time: visitors cannot fill the server's memory.
const MESH_QUEUE_MAX = 4;
const meshQueue = [];
function queueMesh(task) {
  const previous = meshQueue[meshQueue.length - 1] || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  meshQueue.push(run);
  const done = () => meshQueue.splice(meshQueue.indexOf(run), 1);
  run.then(done, done);
  return run;
}

function registerSharePages(expressApp) {
  expressApp.get('/s/:token', (req, res) => {
    noStore(res);
    const share = resolveShareLink(database.db, req.params.token);
    if (!share) {
      res.status(404).type('html').send(GONE_HTML);
      return;
    }
    recordShareView(database.db, share.token);
    res.type('html').send(sharePageHtml(withThumbFlags(share)));
  });

  expressApp.get('/s/:token/thumb/:id', (req, res) => {
    const { model } = sharedModel(req);
    const payload = model && getThumbnailImagePayload(readThumbnailColumn(model.filePath));
    if (!payload) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type(payload.mimeType).send(Buffer.from(payload.base64, 'base64'));
  });

  expressApp.get('/share-viewer/:file', (req, res) => {
    if (!VIEWER_FILES.has(req.params.file)) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(VIEWER_DIR, req.params.file), (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });

  expressApp.get('/s/:token/mesh/:id', (req, res) => {
    noStore(res);
    const { share, model } = sharedModel(req);
    const kind = model && meshKind(model);
    if (!share || !model || !share.allowPreview || !kind) {
      res.status(404).type('text/plain').send('Not available');
      return;
    }
    if (kind === 'stl') {
      sendModelFile(res, model.filePath, { inline: true }).catch((error) => {
        console.error('[Share] 3D view failed:', error.message);
        if (!res.headersSent) res.status(500).type('text/plain').send('Could not read the file');
      });
      return;
    }
    if (meshQueue.length >= MESH_QUEUE_MAX) {
      res.status(503).type('text/plain').send('Busy, try again in a moment');
      return;
    }
    queueMesh(() => require('./ipc/previews').parse3mfPreviewHandler(null, model.filePath, `share-${share.token}-${model.id}`, { shared: true }))
      .then((json) => {
        if (!json) throw new Error('Could not read the model');
        res.type('application/json').send(jsonStringifyForWs(json));
      })
      .catch((error) => {
        console.error('[Share] 3D view failed:', error.message);
        if (!res.headersSent) res.status(500).type('text/plain').send('Could not show this model in 3D');
      });
  });

  expressApp.get('/s/:token/file/:id', (req, res) => {
    noStore(res);
    const { share, model } = sharedModel(req);
    if (!share || !model || !share.allowDownload) {
      res.status(404).type('html').send(GONE_HTML);
      return;
    }
    console.log(`[Share] Download of ${model.fileName} through a share link`);
    sendModelFile(res, model.filePath).catch((error) => {
      console.error('[Share] Download failed:', error.message);
      if (!res.headersSent) res.status(500).type('text/plain').send('Could not read the file');
    });
  });
}

module.exports = { registerSharePages, sharePageHtml, escapeHtml, safeLink, displayName };
