'use strict';

const { app } = require('../server/runtime');
const fs = require('fs');
const path = require('path');

/** Copy SQLite main + sidecar files (-wal / -shm) when migrating paths. */
function copySqliteDbFiles(srcBase, destBase) {
  fs.copyFileSync(srcBase, destBase);
  for (const ext of ['-wal', '-shm']) {
    const s = srcBase + ext;
    const d = destBase + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, d);
  }
}

/**
 * Docker/server previously used isDev → justtprint.db in the app folder (ephemeral /app).
 * If the persisted userData DB does not exist yet, copy from that legacy file once.
 */
function migrateLegacyServerDbIfNeeded(persistedPath) {
  if (fs.existsSync(persistedPath)) return;
  const legacy = path.join(__dirname, '..', '..', 'justtprint.db');
  if (!fs.existsSync(legacy)) return;
  try {
    copySqliteDbFiles(legacy, persistedPath);
    console.log('[Server mode] Migrated SQLite from', legacy, 'to', persistedPath);
  } catch (e) {
    console.error('[Server mode] Could not migrate legacy database:', e);
  }
}

// Update the database path handling
function getDatabasePath() {
  try {
    const envDb = process.env.JUSTTPRINT_DB_PATH?.trim();
    if (envDb) {
      const resolved = path.isAbsolute(envDb) ? envDb : path.resolve(process.cwd(), envDb);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return resolved;
    }

    const userDataPath = path.join(app.getPath('userData'), 'data');

    // Ensure the directory exists
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }

    const dbPath = path.join(userDataPath, 'justtprint.db');
    migrateLegacyServerDbIfNeeded(dbPath);
    return dbPath;
  } catch (error) {
    console.error('Error setting up database path:', error);
    throw error;
  }
}

module.exports = { getDatabasePath };
