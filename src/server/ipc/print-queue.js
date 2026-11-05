'use strict';

// The print queue (src/core/print-queue.js): order, plates, printers and the filament set aside.

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const queue = require('../../core/print-queue');
const { withSeconds } = require('../queue-times');

const modelId = (filePath) => {
  const row = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(String(filePath || ''));
  if (!row) throw new Error('Model not found');
  return row.id;
};
const userId = (event) => (event && event.user && event.user.id) || null;

// Each item with its print time (from its 3MF), and what is printing now.
ipcMain.handle('get-print-queue', () => withSeconds(queue.listQueue(database.db)));
ipcMain.handle('get-printing-now', () => withSeconds(queue.listPrinting(database.db)));
ipcMain.handle('add-to-queue', (event, filePath, options) =>
  queue.addToQueue(database.db, modelId(filePath), { plate: options?.plate ?? null, printerId: options?.printerId ?? null, userId: userId(event) })
);
ipcMain.handle('update-queue-item', (event, id, changes) => queue.updateQueueItem(database.db, Number(id), changes || {}));
ipcMain.handle('move-queue-item', (event, id, toIndex) => queue.moveQueueItem(database.db, Number(id), Number(toIndex)));
ipcMain.handle('remove-from-queue', (event, id) => queue.removeFromQueue(database.db, Number(id)));
ipcMain.handle('start-queue-item', (event, id) => queue.startQueueItem(database.db, Number(id)));

// Send to a Bambu Lab printer (src/server/bambu-send.js): the sliced projects and printers to
// choose from, then upload a plate, start it, and move the item to Printing now.
ipcMain.handle('get-send-options', (event, filePath) => require('../bambu-send').sendOptions(database.db, String(filePath || '')));
ipcMain.handle('send-to-printer', async (event, queueId, filePath, options) => {
  const db = database.db;
  const item = db.prepare('SELECT q.id, m.title, m.fileName FROM print_queue q JOIN models m ON m.id = q.model_id WHERE q.id = ?').get(Number(queueId));
  if (!item) throw new Error('That queue item is gone');
  const title = (item.title && item.title.trim()) || String(item.fileName || '').replace(/(\.gcode)?\.[^.]+$/i, '');
  const sent = await require('../bambu-send').sendPrint(db, { ...(options || {}), filePath: String(filePath || ''), title });
  queue.startQueueItem(db, item.id, { printerId: Number(options.printerId), plate: sent.plate, sentFile: sent.file });
  return sent;
});

// Home's This month tile (src/core/month-summary.js).
ipcMain.handle('get-month-summary', () => require('../../core/month-summary').monthSummary(database.db));
