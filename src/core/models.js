'use strict';

const database = require('./database');
const printEvents = require('../../print-events');
const { applyThumbnailFlags, loadThumbnailForModel } = require('./thumbnails');
const { repairModelTags } = require('../../db-repair');

const MODEL_DETAIL_COLUMNS = 'id, filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, hash, size, license, modifiedDate, dateAdded, isNew, rating, favorite, bundleKey, bundleLabel, bundleKind';

/** List queries omit thumbnail blobs; these flags are computed without returning the column. */
const MODEL_LIST_THUMB_FLAGS =
  "CASE WHEN thumbnail IS NOT NULL AND thumbnail != '' AND thumbnail != '3d.png' THEN 1 ELSE 0 END AS hasThumbnail, " +
  "CASE WHEN thumbnail IS NOT NULL AND INSTR(thumbnail, '::') > 0 THEN 1 ELSE 0 END AS hasMultipleThumbnails";

const MODEL_LIST_THUMB_FLAGS_QUALIFIED =
  "CASE WHEN models.thumbnail IS NOT NULL AND models.thumbnail != '' AND models.thumbnail != '3d.png' THEN 1 ELSE 0 END AS hasThumbnail, " +
  "CASE WHEN models.thumbnail IS NOT NULL AND INSTR(models.thumbnail, '::') > 0 THEN 1 ELSE 0 END AS hasMultipleThumbnails";

const MODEL_LIST_COLUMNS = `${MODEL_DETAIL_COLUMNS}, ${MODEL_LIST_THUMB_FLAGS}`;

const MODEL_LIST_COLUMNS_QUALIFIED =
  `models.id, models.filePath, models.fileName, models.designer, models.source, models.notes, models.printed, models.print_status, models.print_count, models.last_printed_at, models.parentModel, models.hash, models.size, models.license, models.modifiedDate, models.dateAdded, models.isNew, models.rating, models.favorite, models.bundleKey, models.bundleLabel, models.bundleKind, ${MODEL_LIST_THUMB_FLAGS_QUALIFIED}`;

function getModelByFilePath(filePath, { includeThumbnail = false } = {}) {
  if (!database.db || !filePath) return null;
  const row = database.db.prepare(`SELECT ${MODEL_DETAIL_COLUMNS} FROM models WHERE filePath = ?`).get(filePath);
  if (!row) return null;
  if (includeThumbnail) {
    row.thumbnail = loadThumbnailForModel(filePath);
    applyThumbnailFlags(row);
  }
  return row;
}

function getModelById(modelId, { includeThumbnail = false } = {}) {
  if (!database.db || modelId == null) return null;
  const row = database.db.prepare(`SELECT ${MODEL_DETAIL_COLUMNS} FROM models WHERE id = ?`).get(modelId);
  if (!row) return null;
  if (includeThumbnail) {
    row.thumbnail = loadThumbnailForModel(row.filePath);
    applyThumbnailFlags(row);
  }
  return row;
}

function normalizeModelRating(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 5) return 5;
  return n;
}

function repairModelTagsTable() {
  try {
    return repairModelTags(database.db).ok;
  } catch (error) {
    console.error('Error repairing model_tags table:', error);
    return false;
  }
}

function replaceModelFilaments(modelId, filamentIds) {
  database.db.prepare('DELETE FROM model_filaments WHERE model_id = ?').run(modelId);
  if (!filamentIds || filamentIds.length === 0) return;
  const insert = database.db.prepare('INSERT OR IGNORE INTO model_filaments (model_id, filament_id) VALUES (?, ?)');
  const exists = database.db.prepare('SELECT 1 FROM filaments WHERE id = ?');
  for (const id of filamentIds) {
    if (exists.get(id)) insert.run(modelId, id);
  }
}

function deleteModelJunctionRows(modelId) {
  database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);
  database.db.prepare('DELETE FROM model_filaments WHERE model_id = ?').run(modelId);
  printEvents.deletePrintRowsForModel(database.db, modelId);
}

function deleteModelsByIds(modelIds) {
  const ids = [];
  const seen = new Set();
  for (const raw of modelIds || []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return;
  const batchSize = 500;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    printEvents.deletePrintRowsForModels(database.db, batch);
    database.db.prepare(`DELETE FROM model_tags WHERE model_id IN (${placeholders})`).run(...batch);
    database.db.prepare(`DELETE FROM model_filaments WHERE model_id IN (${placeholders})`).run(...batch);
    database.db.prepare(`DELETE FROM models WHERE id IN (${placeholders})`).run(...batch);
  }
}

function deleteModelsByFilePaths(filePaths) {
  const paths = Array.isArray(filePaths) ? filePaths.filter((p) => typeof p === 'string' && p) : [];
  const removed = [];
  const found = new Set();
  if (!paths.length) return { removed, missing: [] };
  database.db.transaction(() => {
    const batchSize = 500;
    const ids = [];
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      const rows = database.db.prepare(
        `SELECT id, filePath, fileName FROM models WHERE filePath IN (${placeholders})`
      ).all(...batch);
      for (const row of rows) {
        found.add(row.filePath);
        ids.push(row.id);
        removed.push({ id: row.id, filePath: row.filePath, fileName: row.fileName });
      }
    }
    deleteModelsByIds(ids);
  })();
  return { removed, missing: paths.filter((filePath) => !found.has(filePath)) };
}

/** Returns true when user-editable model fields differ (used to clear isNew only on real edits). */
function modelUserFieldsChanged(existing, finals) {
  if (!existing || !finals) return false;
  const norm = (v) => (v == null || String(v).trim() === '' ? null : v);
  return (
    finals.fileName !== existing.fileName ||
    norm(finals.designer) !== norm(existing.designer) ||
    norm(finals.source) !== norm(existing.source) ||
    norm(finals.notes) !== norm(existing.notes) ||
    Number(finals.printed ? 1 : 0) !== Number(existing.printed ? 1 : 0) ||
    String(finals.print_status || '') !== String(existing.print_status || '') ||
    norm(finals.parentModel) !== norm(existing.parentModel) ||
    norm(finals.license) !== norm(existing.license)
  );
}

module.exports = { MODEL_DETAIL_COLUMNS, MODEL_LIST_COLUMNS, MODEL_LIST_COLUMNS_QUALIFIED, deleteModelJunctionRows, deleteModelsByFilePaths, deleteModelsByIds, getModelByFilePath, getModelById, modelUserFieldsChanged, normalizeModelRating, repairModelTagsTable, replaceModelFilaments };
