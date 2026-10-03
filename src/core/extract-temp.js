'use strict';

const database = require('./database');
const { app } = require('../server/runtime');
const fs = require('fs');
const path = require('path');
const { readStlHomeDirectories } = require('./library-paths');
const os = require('os');

/** Dedicated OS-temp folder for zip-entry extracts — never the library / STL home. */
const EXTRACT_TEMP_DIR_NAME = 'printventory-extracts';

const EXTRACT_TEMP_FILE_PREFIX = 'printventory_';

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

function isPrintventoryExtractTempPath(filePath) {
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
  if (!isPrintventoryExtractTempPath(filePath)) return false;
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
  if (!isPrintventoryExtractTempPath(filePath)) return;
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

module.exports = { EXTRACT_TEMP_DIR_NAME, EXTRACT_TEMP_FILE_PREFIX, cleanupExtractTempFile, ensureExtractTempDir, getExtractTempDir, getOsTempRoot, isPrintventoryExtractTempPath, pendingExtractTempCleanups, scheduleExtractTempCleanupMany };
