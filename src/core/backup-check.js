'use strict';

const Database = require('better-sqlite3');

/** Throws unless the file is a readable SQLite database with a models table. */
function checkBackupFile(filePath) {
  let candidate;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    const check = candidate.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`the database is damaged (${check})`);
    const models = candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='models'").get();
    if (!models) throw new Error('it has no models table');
  } catch (error) {
    throw new Error(`Not a JusttPrint backup: ${error.message}`, { cause: error });
  } finally {
    if (candidate) candidate.close();
  }
}

module.exports = { checkBackupFile };
