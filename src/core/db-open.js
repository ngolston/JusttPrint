'use strict';

const Database = require('better-sqlite3');

/**
 * Open the library database in WAL mode, so reading goes on while something writes (a scan,
 * a download, a backup) instead of waiting for it. The mode is kept in the file; switching an
 * older library over happens once, on its first open. WAL needs a local disk: SQLite does not
 * support it on a network share (NFS, SMB).
 * @param {string} dbPath
 */
function openLibraryDatabase(dbPath) {
  const db = new Database(dbPath);
  const mode = db.pragma('journal_mode = WAL', { simple: true });
  if (mode !== 'wal')
    console.warn(`[Database] WAL is not available here, the database stays in ${mode} mode (is the data folder on a network share?): ${dbPath}`);
  return db;
}

/**
 * Checkpoint and close the database. True when the file then holds everything, so a plain copy
 * of it is complete; false when another connection was still reading and part of the last writes
 * stayed in the -wal file (the caller keeps its previous copy).
 * @param {any} db
 */
function checkpointAndClose(db) {
  const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  if (checkpoint && checkpoint.busy) {
    console.warn('[Quit] The database was still being read, so backup_justtprint.db was not updated (it keeps the previous copy).');
    return false;
  }
  return true;
}

/**
 * A copy made with SQLite's online backup comes out in WAL mode too. Put it back in the
 * rollback journal: one self-contained file that opens anywhere, even read-only, without
 * leaving -wal / -shm files next to it.
 * @param {string} filePath
 */
function makeSingleFile(filePath) {
  const db = new Database(filePath, { fileMustExist: true });
  try {
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

module.exports = { checkpointAndClose, makeSingleFile, openLibraryDatabase };
