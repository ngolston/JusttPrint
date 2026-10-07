'use strict';

/**
 * Backups and library exports made for a browser download (Settings → Backup → Create Backup and
 * Export Library). They go into downloads/ next to the database and are deleted an hour after
 * they are made, so the data folder does not fill up with copies of the database. (A download
 * still in progress keeps going: the open file outlives its name on Linux.) Files that versions
 * before 6.0.1 left in the data folder itself are listed as leftovers for the user to delete;
 * the MCP backup_database and export_library tools write there too, so nothing deletes them on
 * its own.
 */

const fs = require('fs');
const path = require('path');
const { getDatabasePath } = require('../core/db-path');

/** justtprint-backup-<time>.db and justtprint-library-<time>.json. */
const DOWNLOAD_FILE = /^justtprint-(backup|library)-[\w.-]+\.(db|json)$/;
const HOUR = 60 * 60 * 1000;
/** How long a download file is kept. */
const KEEP_MS = HOUR;

let timer = null;

function dataDir() {
  return path.dirname(getDatabasePath());
}

function downloadsDir() {
  return path.join(dataDir(), 'downloads');
}

/** The download-style files in a folder, with size and time. */
function listFiles(dir, fileSystem = fs) {
  let names = [];
  try {
    names = fileSystem.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!DOWNLOAD_FILE.test(name)) continue;
    try {
      const stat = fileSystem.statSync(path.join(dir, name));
      if (stat.isFile()) files.push({ name, path: path.join(dir, name), size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (_) { /* removed meanwhile */ }
  }
  return files;
}

/** Delete download files older than maxAgeMs. Returns the deleted names. */
function sweep({ dir = downloadsDir(), maxAgeMs = KEEP_MS, now = Date.now(), fileSystem = fs } = {}) {
  const removed = [];
  for (const file of listFiles(dir, fileSystem)) {
    if (now - file.mtimeMs < maxAgeMs) continue;
    try {
      fileSystem.rmSync(file.path, { force: true });
      removed.push(file.name);
    } catch (error) {
      console.warn(`[Downloads] Could not delete ${file.name}:`, error.message);
    }
  }
  if (removed.length) console.log(`[Downloads] Deleted ${removed.length} old download file(s)`);
  return removed;
}

/** A path for a new backup ('backup', .db) or library export ('library', .json) to download. */
function newDownloadPath(kind, extension) {
  const dir = downloadsDir();
  fs.mkdirSync(dir, { recursive: true });
  sweep({ dir });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `justtprint-${kind}-${timestamp}.${extension}`);
}

/** Backups and exports left in the data folder itself (before 6.0.1, or by the MCP tools). */
function leftovers() {
  const files = listFiles(dataDir());
  return {
    folder: dataDir(),
    files: files.map(({ name, size, mtimeMs }) => ({ name, size, date: new Date(mtimeMs).toISOString() })),
    totalBytes: files.reduce((sum, file) => sum + file.size, 0)
  };
}

/** Delete the leftovers. Returns how many files and bytes. */
function deleteLeftovers() {
  let count = 0;
  let bytes = 0;
  for (const file of listFiles(dataDir())) {
    try {
      fs.rmSync(file.path, { force: true });
      count++;
      bytes += file.size;
    } catch (error) {
      console.warn(`[Downloads] Could not delete ${file.name}:`, error.message);
    }
  }
  console.log(`[Downloads] Deleted ${count} leftover backup/export file(s) from the data folder`);
  return { count, bytes };
}

/** Sweep at startup and every hour. */
function start() {
  stop();
  try {
    sweep();
  } catch (error) {
    console.warn('[Downloads] Cleanup failed:', error.message);
  }
  timer = setInterval(() => {
    try {
      sweep();
    } catch (error) {
      console.warn('[Downloads] Cleanup failed:', error.message);
    }
  }, HOUR);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { DOWNLOAD_FILE, KEEP_MS, downloadsDir, listFiles, sweep, newDownloadPath, leftovers, deleteLeftovers, start, stop };
