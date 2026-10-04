'use strict';

const database = require('./database');
const { app } = require('../server/runtime');
const fs = require('fs');
const path = require('path');
const { readStlHomeDirectories } = require('./library-paths');
const os = require('os');

/** Dedicated OS-temp folder for zip-entry extracts — never the library / STL home. */
const EXTRACT_TEMP_DIR_NAME = 'justtprint-extracts';

const EXTRACT_TEMP_FILE_PREFIX = 'justtprint_';

/** Slicer may still be reading the file after launch; delay cleanup. */
const EXTRACT_TEMP_SLICER_CLEANUP_MS = 10 * 60 * 1000;

const pendingExtractTempCleanups = new Set();

function getOsTempRoot() {
  try {
    if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady()) {
      return app.getPath('temp');
    }
  } catch (_) { /* use os.tmpdir */ }
  return os.tmpdir();
}

function getExtractTempDir() {
  const osDir = path.join(getOsTempRoot(), EXTRACT_TEMP_DIR_NAME);
  // Guard: if TEMP is mounted inside the library (common Docker misconfig), use userData instead
  try {
    if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady() && database.db) {
      const resolvedDir = path.resolve(osDir);
      for (const home of readStlHomeDirectories()) {
        const stlHome = path.resolve(String(home));
        if (resolvedDir === stlHome || resolvedDir.startsWith(stlHome + path.sep)) {
          return path.join(app.getPath('userData'), EXTRACT_TEMP_DIR_NAME);
        }
      }
    }
  } catch (_) { /* keep OS temp */ }
  return osDir;
}

function ensureExtractTempDir() {
  const dir = getExtractTempDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isJusttPrintExtractTempPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  try {
    const resolved = path.resolve(filePath);
    const base = path.basename(resolved);
    if (!base.startsWith(EXTRACT_TEMP_FILE_PREFIX)) return false;

    const allowedRoots = [
      path.resolve(getExtractTempDir()),
      path.resolve(path.join(getOsTempRoot(), EXTRACT_TEMP_DIR_NAME)),
      path.resolve(getOsTempRoot())
    ];
    try {
      if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady()) {
        allowedRoots.push(path.resolve(path.join(app.getPath('userData'), EXTRACT_TEMP_DIR_NAME)));
      }
    } catch (_) { /* ignore */ }

    const parent = path.resolve(path.dirname(resolved));
    return allowedRoots.some((root) => parent === root || resolved.startsWith(root + path.sep));
  } catch (_) {
    return false;
  }
}

async function cleanupExtractTempFile(filePath) {
  if (!isJusttPrintExtractTempPath(filePath)) return false;
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    pendingExtractTempCleanups.delete(filePath);
    return true;
  } catch (err) {
    console.warn('Failed to clean up extract temp file:', filePath, err.message);
    return false;
  }
}

function scheduleExtractTempCleanup(filePath, delayMs = EXTRACT_TEMP_SLICER_CLEANUP_MS) {
  if (!isJusttPrintExtractTempPath(filePath)) return;
  pendingExtractTempCleanups.add(filePath);
  setTimeout(() => {
    cleanupExtractTempFile(filePath).catch(() => {});
  }, Math.max(0, delayMs));
}

function scheduleExtractTempCleanupMany(filePaths, delayMs = EXTRACT_TEMP_SLICER_CLEANUP_MS) {
  for (const fp of filePaths || []) {
    scheduleExtractTempCleanup(fp, delayMs);
  }
}

/** Remove leftover extract temps (startup / quit). Optionally only files older than maxAgeMs. */
async function cleanupExtractTempDirectory({
  maxAgeMs = 0,
  // Full OS TEMP readdir is slow on busy machines — skip on cold start; still run on quit.
  includeLegacyOsTempRoot = true,
} = {}) {
  const now = Date.now();
  const dirs = new Set([getExtractTempDir(), path.join(getOsTempRoot(), EXTRACT_TEMP_DIR_NAME)]);
  try {
    if (typeof app !== 'undefined' && app && typeof app.isReady === 'function' && app.isReady()) {
      dirs.add(path.join(app.getPath('userData'), EXTRACT_TEMP_DIR_NAME));
    }
  } catch (_) { /* ignore */ }

  async function sweepDir(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(EXTRACT_TEMP_FILE_PREFIX)) continue;
      const full = path.join(dir, entry.name);
      try {
        if (maxAgeMs > 0) {
          const stat = await fs.promises.stat(full);
          if (now - stat.mtimeMs < maxAgeMs) continue;
        }
        await fs.promises.unlink(full);
        pendingExtractTempCleanups.delete(full);
      } catch (_) { /* ignore busy files */ }
    }
  }

  for (const dir of dirs) {
    await sweepDir(dir);
  }
  // Legacy flat justtprint_* files written directly under OS temp (quit / explicit only)
  if (includeLegacyOsTempRoot) {
    await sweepDir(getOsTempRoot());
  }
}

module.exports = { EXTRACT_TEMP_DIR_NAME, EXTRACT_TEMP_FILE_PREFIX, cleanupExtractTempDirectory, cleanupExtractTempFile, ensureExtractTempDir, getExtractTempDir, getOsTempRoot, isJusttPrintExtractTempPath, pendingExtractTempCleanups, scheduleExtractTempCleanupMany };
