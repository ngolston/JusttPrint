'use strict';

/**
 * Library Storage in the sidebar: the size of the library's files (from the database) and how
 * full the volume holding STL Home is. Read-only; nothing is written.
 */

const fs = require('fs');

/** The first STL Home folder that exists, else null. */
function firstExistingRoot(roots, existsSync = fs.existsSync) {
  for (const root of roots || []) {
    try {
      if (root && existsSync(root)) return root;
    } catch (_) {
      /* unreadable: try the next one */
    }
  }
  return null;
}

/** Total, used and free bytes of the volume `dir` is on, or null when it cannot be read. */
async function volumeUsage(dir, statfs = fs.promises.statfs) {
  if (!dir || typeof statfs !== 'function') return null;
  try {
    const s = await statfs(dir);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const usedBytes = totalBytes - Number(s.bfree) * Number(s.bsize);
    return { totalBytes, usedBytes: Math.max(0, usedBytes), freeBytes: Math.max(0, freeBytes) };
  } catch (_) {
    return null;
  }
}

/**
 * { libraryBytes, modelCount, volume: { path, totalBytes, usedBytes, freeBytes } | null }.
 * `db` is a better-sqlite3 database; `roots` are the STL Home folders.
 * @param {{ db: any, roots: string[], existsSync?: (path: string) => boolean, statfs?: any }} options
 */
async function libraryStorage({ db, roots, existsSync, statfs }) {
  const row = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM models').get();
  const root = firstExistingRoot(roots, existsSync);
  const usage = root ? await volumeUsage(root, statfs) : null;
  return {
    libraryBytes: Number(row.bytes) || 0,
    modelCount: Number(row.count) || 0,
    volume: usage ? { path: root, ...usage } : null
  };
}

module.exports = { libraryStorage, volumeUsage, firstExistingRoot };
