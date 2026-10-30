'use strict';

// The print queue (src/core/print-queue.js): order, plates, printers and the filament set aside.

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const queue = require('../../core/print-queue');

const modelId = (filePath) => {
  const row = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(String(filePath || ''));
  if (!row) throw new Error('Model not found');
  return row.id;
};
const userId = (event) => (event && event.user && event.user.id) || null;

ipcMain.handle('get-print-queue', () => queue.listQueue(database.db));
ipcMain.handle('add-to-queue', (event, filePath, options) =>
  queue.addToQueue(database.db, modelId(filePath), { plate: options?.plate ?? null, printerId: options?.printerId ?? null, userId: userId(event) })
);
ipcMain.handle('update-queue-item', (event, id, changes) => queue.updateQueueItem(database.db, Number(id), changes || {}));
ipcMain.handle('move-queue-item', (event, id, toIndex) => queue.moveQueueItem(database.db, Number(id), Number(toIndex)));
ipcMain.handle('remove-from-queue', (event, id) => queue.removeFromQueue(database.db, Number(id)));
ipcMain.handle('start-queue-item', (event, id) => queue.startQueueItem(database.db, Number(id)));

// Home's This month tile (src/core/month-summary.js).
ipcMain.handle('get-month-summary', () => require('../../core/month-summary').monthSummary(database.db));
