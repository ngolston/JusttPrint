'use strict';

const database = require('./database');
const { normalizeExcludeNames } = require('./scan-skip');

/** Library files are absolute container paths (e.g. /mnt/models/part.stl). */
function assertContainerPath(path, operation = 'operation') {
  if (isUrlModel(path)) {
    return; // URL-only models (from extension) have no file path to validate
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`${operation}: expected an absolute path inside the container (e.g. /mnt/models/part.stl), got "${path}".`);
  }
}

// Update the shouldSkipDirectory function
function getScanExcludeNames() {
  try {
    if (!database.db) return new Set();
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('scanExcludeFolders');
    return normalizeExcludeNames(row && row.value);
  } catch (_) {
    return new Set();
  }
}

function dedupePathList(paths) {
  const seen = new Set();
  const out = [];
  for (const item of paths || []) {
    const p = String(item || '').trim();
    if (!p) continue;
    const key = p.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** STL_HOME and STL_HOME_EXCLUDE: comma, semicolon, or newline separated paths, or a JSON array. */
function parseExcludePathList(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry || '').trim()).filter(Boolean);
      }
    } catch (_) {
      /* treat as a delimited list */
    }
  }
  return text
    .split(/[\r\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function excludeDirectoriesSettingIsEmpty(value) {
  const current = value == null ? '' : String(value).trim();
  if (!current || current === '[]') return true;
  try {
    const parsed = JSON.parse(current);
    if (!Array.isArray(parsed)) return false;
    return parsed.every((entry) => !String(entry || '').trim());
  } catch (_) {
    return false;
  }
}

function readLegacyStlHomePaths(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[') || /[\r\n,;]/.test(text)) return dedupePathList(parseExcludePathList(text));
  return [text];
}

/** Directories scanned as STL Home. Prefers the JSON list, then a legacy single stlHome path. */
function readStlHomeDirectories() {
  try {
    if (!database.db) return [];
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeDirectories');
    const fromList = dedupePathList(parseExcludePathList(row?.value));
    if (fromList.length) return fromList;
    const legacy = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHome')?.value;
    return readLegacyStlHomePaths(legacy);
  } catch (error) {
    console.error('Invalid STL Home directories setting:', error);
    return [];
  }
}

// Add these IPC handlers
// Helper: URL-only models (added by the old browser extension) have filePath "url::https://..."
function isUrlModel(filePath) {
  return typeof filePath === 'string' && filePath.startsWith('url::');
}

function getLibraryRootPaths() {
  const roots = [];
  const add = (value) => {
    if (value && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed && !roots.includes(trimmed)) roots.push(trimmed);
    }
  };
  for (const home of parseExcludePathList(process.env.STL_HOME)) add(home);
  try {
    if (database.db) {
      for (const home of readStlHomeDirectories()) add(home);
      add(database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value);
    }
  } catch (_) {
    /* db not ready */
  }
  return roots;
}

// Helper function to parse zip path format
function parseZipPath(filePath) {
  if (isUrlModel(filePath)) {
    return { zipPath: filePath, entryPath: null, isZipEntry: false };
  }
  if (filePath.includes('::')) {
    const [zipPath, entryPath] = filePath.split('::');
    return { zipPath, entryPath, isZipEntry: true };
  }
  return { zipPath: filePath, entryPath: null, isZipEntry: false };
}

function readScannedDirectorySetting() {
  try {
    if (!database.db) return [];
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('scannedDirectories');
    const parsed = JSON.parse(row && row.value ? row.value : '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = {
  dedupePathList,
  excludeDirectoriesSettingIsEmpty,
  getLibraryRootPaths,
  getScanExcludeNames,
  isUrlModel,
  parseExcludePathList,
  parseZipPath,
  readScannedDirectorySetting,
  readStlHomeDirectories,
  assertContainerPath
};
