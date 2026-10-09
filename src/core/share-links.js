'use strict';

/**
 * Read-only share links for a model or a collection: a random token that opens a public page
 * (src/server/share-pages.js) without logging in. A link can allow downloads, can expire, and can
 * be revoked (deleted). The page shows what the item holds when it is opened, so models added to
 * a shared collection later are shared too.
 */

const crypto = require('crypto');
const { ensureCollectionsSchema } = require('./collections');

const KINDS = ['model', 'collection'];
const MAX_LINKS = 500;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function ensureShareSchema(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS share_links (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    allow_download INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_viewed_at TEXT,
    views INTEGER NOT NULL DEFAULT 0
  )`
  ).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_target ON share_links(kind, target_id)').run();
  ensureCollectionsSchema(db);
}

/** The model or collection a link points at, or null when it is gone. */
function targetOf(db, kind, targetId) {
  if (kind === 'model') {
    const row = db.prepare('SELECT id, fileName, filePath FROM models WHERE id = ?').get(targetId);
    return row ? { id: row.id, name: row.fileName, filePath: row.filePath } : null;
  }
  const row = db.prepare('SELECT id, name FROM collections WHERE id = ?').get(targetId);
  return row ? { id: row.id, name: row.name } : null;
}

function present(db, row, now) {
  const target = targetOf(db, row.kind, row.target_id);
  return {
    token: row.token,
    kind: row.kind,
    targetId: row.target_id,
    targetName: target ? target.name : null,
    allowDownload: !!row.allow_download,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    expired: !!row.expires_at && Date.parse(row.expires_at) <= now.getTime(),
    views: Number(row.views) || 0,
    lastViewedAt: row.last_viewed_at || null
  };
}

/**
 * @param {object} options
 * @param {'model'|'collection'} options.kind
 * @param {number} [options.targetId] The collection id, or the model id.
 * @param {string} [options.filePath] For a model: its file path instead of the id.
 * @param {boolean} [options.allowDownload]
 * @param {number} [options.expiresInDays] 0 or missing: never.
 */
function createShareLink(db, { kind, targetId, filePath, allowDownload, expiresInDays, createdBy } = {}, now = new Date()) {
  ensureShareSchema(db);
  if (!KINDS.includes(kind)) throw httpError(400, 'Share a model or a collection');
  let id = Number(targetId);
  if (kind === 'model' && filePath) {
    const row = db.prepare('SELECT id FROM models WHERE filePath = ?').get(String(filePath));
    id = row ? row.id : NaN;
  }
  if (!Number.isInteger(id) || !targetOf(db, kind, id)) throw httpError(404, `That ${kind} is not in the library`);
  if (db.prepare('SELECT COUNT(*) AS n FROM share_links').get().n >= MAX_LINKS) {
    throw httpError(429, `There are ${MAX_LINKS} share links already. Revoke some under Settings → Sharing.`);
  }
  const days = Number(expiresInDays);
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString() : null;
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare(
    `INSERT INTO share_links (token, kind, target_id, allow_download, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(token, kind, id, allowDownload ? 1 : 0, createdBy || null, now.toISOString(), expiresAt);
  return present(db, db.prepare('SELECT * FROM share_links WHERE token = ?').get(token), now);
}

/** Links, newest first: all of them, or those of one item. */
function listShareLinks(db, { kind, targetId, filePath } = {}, now = new Date()) {
  ensureShareSchema(db);
  let rows;
  if (kind) {
    let id = Number(targetId);
    if (kind === 'model' && filePath) id = (db.prepare('SELECT id FROM models WHERE filePath = ?').get(String(filePath)) || {}).id;
    rows = db.prepare('SELECT * FROM share_links WHERE kind = ? AND target_id = ? ORDER BY created_at DESC').all(kind, Number(id));
  } else {
    rows = db.prepare('SELECT * FROM share_links ORDER BY created_at DESC').all();
  }
  return rows.map((row) => present(db, row, now));
}

function revokeShareLink(db, token) {
  ensureShareSchema(db);
  const info = db.prepare('DELETE FROM share_links WHERE token = ?').run(String(token || ''));
  if (!info.changes) throw httpError(404, 'That link was already revoked');
  return { success: true };
}

/** Links of a collection go when it is deleted. */
function revokeLinksOf(db, kind, targetId) {
  ensureShareSchema(db);
  return db.prepare('DELETE FROM share_links WHERE kind = ? AND target_id = ?').run(kind, Number(targetId)).changes;
}

/** What a public visitor may see for a token, or null (unknown, revoked, expired, or the item is gone). */
function resolveShareLink(db, token, now = new Date()) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  ensureShareSchema(db);
  const row = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return null;
  const columns = 'm.id, m.filePath, m.fileName, m.designer, m.license, m.source, m.size';
  let title;
  let description = '';
  let models;
  if (row.kind === 'model') {
    models = db.prepare(`SELECT ${columns} FROM models m WHERE m.id = ?`).all(row.target_id);
    if (!models.length) return null;
    title = models[0].fileName;
  } else {
    const collection = db.prepare('SELECT name, description FROM collections WHERE id = ?').get(row.target_id);
    if (!collection) return null;
    title = collection.name;
    description = collection.description || '';
    models = db
      .prepare(
        `SELECT ${columns} FROM collection_models cm JOIN models m ON m.id = cm.model_id
      WHERE cm.collection_id = ? ORDER BY cm.added_at DESC, m.id DESC`
      )
      .all(row.target_id);
  }
  const tagsOf = db.prepare('SELECT t.name FROM tags t JOIN model_tags mt ON mt.tag_id = t.id WHERE mt.model_id = ? ORDER BY t.name COLLATE NOCASE');
  return {
    token: row.token,
    kind: row.kind,
    title,
    description,
    allowDownload: !!row.allow_download,
    expiresAt: row.expires_at || null,
    models: models.map((m) => ({ ...m, tags: tagsOf.all(m.id).map((t) => t.name) }))
  };
}

/** Count a page view (not each thumbnail). */
function recordShareView(db, token, now = new Date()) {
  try {
    db.prepare('UPDATE share_links SET views = views + 1, last_viewed_at = ? WHERE token = ?').run(now.toISOString(), token);
  } catch (_) {
    /* best effort */
  }
}

module.exports = {
  ensureShareSchema,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  revokeLinksOf,
  resolveShareLink,
  recordShareView
};
