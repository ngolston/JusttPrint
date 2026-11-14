'use strict';

// Runs checkBackupFile in a worker thread (backup-check.js, checkBackupFileAsync): answers null
// when the file is a good backup, or the error's message.
const workerThreads = require('worker_threads');
const { checkBackupFile } = require('./backup-check');

const parentPort = /** @type {import('worker_threads').MessagePort} */ (workerThreads.parentPort);
try {
  checkBackupFile(workerThreads.workerData);
  parentPort.postMessage(null);
} catch (error) {
  parentPort.postMessage(error.message);
}
