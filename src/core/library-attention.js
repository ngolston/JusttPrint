'use strict';

/**
 * Home's Needs attention: how many models lack tags, a license or a thumbnail, how many sets of
 * identical files there are, and whether the automatic backups are failing or late. Read-only.
 */

const HOUR = 3600 * 1000;

/**
 * { untagged, unlicensed, noThumbnail, duplicateSets } from the models table.
 * `coverSql` adds files whose only picture is their model folder's cover (model-folders.js onlyCoverSql).
 * @param {any} db a better-sqlite3 database
 * @param {{ coverSql?: string }} [options]
 */
function libraryAttention(db, { coverSql = '' } = {}) {
  const count = (sql) => Number(db.prepare(sql).get().n) || 0;
  return {
    untagged: count('SELECT COUNT(*) AS n FROM models WHERE NOT EXISTS (SELECT 1 FROM model_tags mt WHERE mt.model_id = models.id)'),
    unlicensed: count("SELECT COUNT(*) AS n FROM models WHERE license IS NULL OR TRIM(license) = ''"),
    noThumbnail: count(`SELECT COUNT(*) AS n FROM models WHERE has_thumb = 0 ${coverSql}`),
    // As the Duplicates page finds them: the same hash at two paths or more, ZIP entries left out.
    duplicateSets: count(
      `SELECT COUNT(*) AS n FROM (SELECT hash FROM models
      WHERE hash IS NOT NULL AND LENGTH(TRIM(hash)) > 0 AND instr(filePath, '::') = 0
      GROUP BY hash HAVING COUNT(DISTINCT filePath) > 1)`
    )
  };
}

/**
 * What is wrong with the automatic backups (auto-backup.js status()), or null when nothing is:
 * { kind: 'failed', message } when the folder cannot be used or the last try failed;
 * { kind: 'late', since } when the newest backup is older than two intervals. Off is not a problem.
 * @param {{ enabled?: boolean, intervalHours?: number, newestBackup?: string, lastAttempt?: string, lastError?: string, folderProblem?: string }} status
 */
function backupProblem(status, now = Date.now()) {
  if (!status || !status.enabled) return null;
  if (status.folderProblem) return { kind: 'failed', message: status.folderProblem };
  const success = Date.parse(status.newestBackup || '');
  const attempt = Date.parse(status.lastAttempt || '');
  if (status.lastError && Number.isFinite(attempt) && (!Number.isFinite(success) || attempt > success)) {
    return { kind: 'failed', message: String(status.lastError) };
  }
  const interval = Math.max(1, Number(status.intervalHours) || 24) * HOUR;
  if (Number.isFinite(success) && now - success > 2 * interval) return { kind: 'late', since: new Date(success).toISOString() };
  return null;
}

module.exports = { backupProblem, libraryAttention };
