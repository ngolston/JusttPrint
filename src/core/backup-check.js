'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
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

/**
 * checkBackupFile in a worker thread, so the server keeps answering: quick_check reads the whole
 * file, which takes minutes on a large library. Rejects with the same error message.
 * @param {string} filePath
 * @returns {Promise<void>}
 */
function checkBackupFileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'backup-check-worker.js'), { workerData: filePath });
    worker.once('message', (/** @type {string | null} */ message) => (message === null ? resolve() : reject(new Error(message))));
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`Not a JusttPrint backup: the check stopped (exit code ${code})`)));
  });
}

module.exports = { checkBackupFile, checkBackupFileAsync };
