'use strict';

/**
 * The folder browser behind "Choose folder" in the web UI (browse-folders). It offers places to
 * start from (the volumes mounted into the container and the library folders) and lists the
 * subfolders of any folder that could be scanned: never system, app or data folders, as written
 * or after following links (the same rule as scan-directory, src/server/server-paths.js).
 */

const fs = require('fs');
const path = require('path');

/** Kernel and runtime file systems that never hold models. */
const PSEUDO_FS = new Set([
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'devtmpfs',
  'mqueue',
  'securityfs',
  'debugfs',
  'tracefs',
  'pstore',
  'bpf',
  'configfs',
  'fusectl',
  'hugetlbfs',
  'nsfs',
  'autofs',
  'binfmt_misc',
  'rpc_pipefs',
  'efivarfs',
  'selinuxfs'
]);

/** Most folders one listing returns; a bigger folder says so (`truncated`). */
const MAX_FOLDERS = 1000;

/** "\040" and friends in /proc mount files are octal escapes (space, tab, newline, backslash). */
function unescapeMountPath(value) {
  return String(value).replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/** Mount points in /proc/self/mountinfo text, without kernel file systems. */
function parseMountInfo(text) {
  const points = [];
  for (const line of String(text || '').split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(' ');
    const fsType = line.slice(separator + 3).split(' ')[0];
    if (fields.length < 5 || PSEUDO_FS.has(fsType)) continue;
    const point = unescapeMountPath(fields[4]);
    if (point.startsWith('/') && !points.includes(point)) points.push(point);
  }
  return points;
}

/** The container's mount points, or [] where there is no /proc (a Mac running the server directly). */
function mountPoints(readFile = fs.readFileSync) {
  try {
    return parseMountInfo(readFile('/proc/self/mountinfo', 'utf8'));
  } catch (_) {
    return [];
  }
}

const nameOf = (dir) => path.basename(dir) || dir;
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * @param {object} [options]
 * @param {string|null} [options.dir] Folder to list; none lists only the places.
 * @param {string[]} [options.places] Candidate starting folders (mount points, library folders).
 * @param {(dir: string) => boolean} [options.isBlocked] System, app and data folders; never listed.
 * @param {typeof import('fs')} [options.fileSystem] fs (statSync, realpathSync, readdirSync), for tests.
 * @returns {{ places: {name: string, path: string}[], path: string|null, parent: string|null,
 *   folders: {name: string, path: string}[], truncated: boolean, error?: string }} A folder that
 *   cannot be listed comes back as `error` with no `path` (an answer, not a failed request).
 */
function browseFolders({ dir = null, places = [], isBlocked = () => false, fileSystem = fs } = {}) {
  const isDirectory = (candidate) => {
    try {
      return fileSystem.statSync(candidate).isDirectory();
    } catch (_) {
      return false;
    }
  };
  const real = (candidate) => {
    try {
      return fileSystem.realpathSync(candidate);
    } catch (_) {
      return candidate;
    }
  };

  const shown = [];
  for (const place of places) {
    const text = String(place || '').trim();
    if (!text.startsWith('/')) continue;
    const resolved = path.posix.resolve(text);
    if (shown.some((other) => other.path === resolved)) continue;
    if (isBlocked(resolved) || isBlocked(real(resolved)) || !isDirectory(resolved)) continue;
    shown.push({ name: nameOf(resolved), path: resolved });
  }
  shown.sort((a, b) => a.path.localeCompare(b.path));

  // Not a blocked folder, as written or after following links.
  const allowed = (candidate) => !isBlocked(candidate) && !isBlocked(real(candidate));

  const result = { places: shown, path: null, parent: null, folders: [], truncated: false };
  if (dir === null || dir === undefined || String(dir).trim() === '') return result;

  const text = String(dir).trim();
  if (!text.startsWith('/') || text.includes('\0')) return { ...result, error: `Not a folder path: ${text}` };
  const current = path.posix.resolve(text);
  if (!allowed(current)) return { ...result, error: `This folder cannot be browsed: ${current}` };
  if (!isDirectory(current)) return { ...result, error: `Folder not found: ${current}` };

  let entries;
  try {
    entries = fileSystem.readdirSync(current, { withFileTypes: true });
  } catch (error) {
    return { ...result, error: `Cannot read ${current}: ${error.code || error.message}` };
  }
  const folders = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = path.posix.join(current, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(child))) {
      if (allowed(child)) folders.push({ name: entry.name, path: child });
    }
  }
  folders.sort(byName);
  result.path = current;
  result.truncated = folders.length > MAX_FOLDERS;
  result.folders = folders.slice(0, MAX_FOLDERS);
  const parent = path.posix.dirname(current);
  result.parent = parent !== current && allowed(parent) ? parent : null;
  return result;
}

module.exports = { browseFolders, mountPoints, parseMountInfo, MAX_FOLDERS };
