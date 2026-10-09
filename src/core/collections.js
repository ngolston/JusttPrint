'use strict';

/**
 * Collections: named groups of models from any folders (a model can be in several). Read through
 * a join on models, so a model that leaves the library leaves its collections too; model ids are
 * never reused. Names are unique, ignoring case.
 */

const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;

/** Made on first use, so a restored older database gets the tables too. */
function ensureCollectionsSchema(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`
  ).run();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS collection_models (
    collection_id INTEGER NOT NULL,
    model_id INTEGER NOT NULL,
    added_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, model_id)
  )`
  ).run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_collection_models_model ON collection_models(model_id)').run();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanName(name) {
  const text = String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw httpError(400, 'Give the collection a name');
  if (text.length > MAX_NAME) throw httpError(400, `Collection names are at most ${MAX_NAME} characters`);
  return text;
}

function cleanDescription(description) {
  return String(description || '')
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

function findOrThrow(db, id) {
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(Number(id));
  if (!row) throw httpError(404, 'That collection no longer exists');
  return row;
}

function assertNameFree(db, name, exceptId = null) {
  const other = db.prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE').get(name);
  if (other && other.id !== exceptId) throw httpError(409, `There is already a collection named ${name}`);
}

const summary = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description || '',
  createdBy: row.created_by || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  modelCount: Number(row.model_count) || 0,
  coverPath: row.cover_path || null
});

/** Every collection with its model count and a cover (its most recently added model). */
function listCollections(db) {
  ensureCollectionsSchema(db);
  return db
    .prepare(
      `
    SELECT c.*,
      (SELECT COUNT(*) FROM collection_models cm JOIN models m ON m.id = cm.model_id WHERE cm.collection_id = c.id) AS model_count,
      (SELECT m.filePath FROM collection_models cm JOIN models m ON m.id = cm.model_id WHERE cm.collection_id = c.id
        ORDER BY cm.added_at DESC, m.id DESC LIMIT 1) AS cover_path
    FROM collections c
    ORDER BY c.name COLLATE NOCASE`
    )
    .all()
    .map(summary);
}

/** A collection and its models (newest added first), with the columns the model cards use. */
function getCollection(db, id) {
  ensureCollectionsSchema(db);
  const row = findOrThrow(db, id);
  const models = db
    .prepare(
      `
    SELECT m.id, m.filePath, m.fileName, m.designer, m.license, m.source, m.size, m.print_status, m.print_count,
      m.last_printed_at, m.printed, m.rating, m.favorite, m.bundleKey, m.bundleLabel, m.bundleKind, cm.added_at
    FROM collection_models cm JOIN models m ON m.id = cm.model_id
    WHERE cm.collection_id = ?
    ORDER BY cm.added_at DESC, m.id DESC`
    )
    .all(row.id);
  return { ...summary({ ...row, model_count: models.length, cover_path: models[0]?.filePath }), models };
}

function createCollection(db, { name, description, createdBy } = {}, now = new Date()) {
  ensureCollectionsSchema(db);
  const clean = cleanName(name);
  assertNameFree(db, clean);
  const at = now.toISOString();
  const info = db
    .prepare('INSERT INTO collections (name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(clean, cleanDescription(description), createdBy || null, at, at);
  return summary({ ...findOrThrow(db, info.lastInsertRowid), model_count: 0 });
}

function updateCollection(db, id, { name, description } = {}, now = new Date()) {
  ensureCollectionsSchema(db);
  const row = findOrThrow(db, id);
  const nextName = name === undefined || name === null ? row.name : cleanName(name);
  if (nextName.toLowerCase() !== row.name.toLowerCase()) assertNameFree(db, nextName, row.id);
  const nextDescription = description === undefined || description === null ? row.description : cleanDescription(description);
  db.prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(nextName, nextDescription, now.toISOString(), row.id);
  return listCollections(db).find((c) => c.id === row.id);
}

function deleteCollection(db, id) {
  ensureCollectionsSchema(db);
  const row = findOrThrow(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM collection_models WHERE collection_id = ?').run(row.id);
    db.prepare('DELETE FROM collections WHERE id = ?').run(row.id);
  })();
  return { success: true, name: row.name };
}

function modelIdsFor(db, filePaths) {
  const find = db.prepare('SELECT id FROM models WHERE filePath = ?');
  const ids = [];
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    const row = typeof filePath === 'string' ? find.get(filePath) : null;
    if (row) ids.push(row.id);
  }
  return [...new Set(ids)];
}

/** Add models (by file path) to a collection; those already in it are left as they are. */
function addToCollection(db, id, filePaths, now = new Date()) {
  ensureCollectionsSchema(db);
  const row = findOrThrow(db, id);
  const ids = modelIdsFor(db, filePaths);
  const insert = db.prepare('INSERT OR IGNORE INTO collection_models (collection_id, model_id, added_at) VALUES (?, ?, ?)');
  let added = 0;
  db.transaction(() => {
    for (const modelId of ids) added += insert.run(row.id, modelId, now.toISOString()).changes;
    db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  })();
  return { added, name: row.name };
}

function removeFromCollection(db, id, filePaths, now = new Date()) {
  ensureCollectionsSchema(db);
  const row = findOrThrow(db, id);
  const ids = modelIdsFor(db, filePaths);
  const remove = db.prepare('DELETE FROM collection_models WHERE collection_id = ? AND model_id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const modelId of ids) removed += remove.run(row.id, modelId).changes;
    db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  })();
  return { removed, name: row.name };
}

/** For each collection: how many of these models are in it (the Add to Collection dialog). */
function membership(db, filePaths) {
  ensureCollectionsSchema(db);
  const ids = modelIdsFor(db, filePaths);
  const counts = new Map();
  if (ids.length) {
    const rows = db
      .prepare(
        `SELECT collection_id, COUNT(*) AS n FROM collection_models
      WHERE model_id IN (${ids.map(() => '?').join(',')}) GROUP BY collection_id`
      )
      .all(...ids);
    for (const row of rows) counts.set(row.collection_id, Number(row.n));
  }
  return { models: ids.length, collections: listCollections(db).map((c) => ({ ...c, selectedInIt: counts.get(c.id) || 0 })) };
}

module.exports = {
  ensureCollectionsSchema,
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addToCollection,
  removeFromCollection,
  membership
};
