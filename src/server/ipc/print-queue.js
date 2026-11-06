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
ipcMain.handle('get-send-options', (event, filePath, printedFileId) =>
  require('../bambu-send').sendOptions(database.db, String(filePath || ''), printedFileId ? Number(printedFileId) : null)
);
// `filePath`: a sliced project in the library; with options.printedFileId, the kept copy of one
// printed before (Reprint) is sent instead. Every sent file is kept (printed-files.js).
ipcMain.handle('send-to-printer', async (event, queueId, filePath, options) => {
  const db = database.db;
  const kept = require('../printed-files');
  const item = db
    .prepare('SELECT q.id, q.model_id, m.title, m.fileName FROM print_queue q JOIN models m ON m.id = q.model_id WHERE q.id = ?')
    .get(Number(queueId));
  if (!item) throw new Error('That queue item is gone');
  const title = (item.title && item.title.trim()) || String(item.fileName || '').replace(/(\.gcode)?\.[^.]+$/i, '');
  let file = String(filePath || '');
  let fileName;
  if (options && options.printedFileId) {
    const stored = kept.printedFilePath(db, options.printedFileId);
    const row = db.prepare('SELECT model_id, original_name FROM printed_files WHERE id = ?').get(Number(options.printedFileId));
    if (!stored || !row || row.model_id !== item.model_id) throw new Error('That printed file is no longer kept');
    file = stored;
    fileName = row.original_name;
  }
  const sent = await require('../bambu-send').sendPrint(db, { ...(options || {}), filePath: file, fileName, title });
  queue.startQueueItem(db, item.id, { printerId: Number(options.printerId), plate: sent.plate, sentFile: sent.file });
  try {
    await kept.keepPrintedFile(db, { modelId: item.model_id, printerId: Number(options.printerId), plate: sent.plate, filePath: file });
  } catch (error) {
    console.warn('[Send] Could not keep a copy of the printed file:', error.message);
  }
  return sent;
});
// A model's printed files (printed-files.js), and one to download.
ipcMain.handle('get-printed-files', (event, filePath) => require('../printed-files').listPrintedFiles(database.db, modelId(filePath)));
ipcMain.handle('download-printed-file', async (event, id) => {
  const kept = require('../printed-files');
  const stored = kept.printedFilePath(database.db, Number(id));
  const row = database.db.prepare('SELECT original_name FROM printed_files WHERE id = ?').get(Number(id));
  if (!stored || !row) throw new Error('That printed file is no longer kept');
  const target = require('../download-files').newDownloadPath('printed', 'gcode.3mf');
  await require('fs').promises.copyFile(stored, target);
  return { filePath: target, name: row.original_name };
});

// Home's This month tile (src/core/month-summary.js).
ipcMain.handle('get-month-summary', () => require('../../core/month-summary').monthSummary(database.db));

// The sliced-files inbox (src/server/sliced-inbox.js): sliced projects exported to a folder are
// filed beside their models and queued; the ones no model matches wait for a choice.
ipcMain.handle('get-sliced-inbox', () => require('../sliced-inbox').inboxStatus(database.db));
ipcMain.handle('find-models-by-name', (event, text) => require('../sliced-inbox').findModels(database.db, text));
ipcMain.handle('set-sliced-inbox-folder', (event, folder) => require('../sliced-inbox').setInboxFolder(database.db, folder));
ipcMain.handle('check-sliced-inbox', () => require('../sliced-inbox').checkInbox(database.db));
ipcMain.handle('file-sliced-inbox', (event, id, filePath) => require('../sliced-inbox').fileWaiting(database.db, Number(id), String(filePath || '')));
ipcMain.handle('ignore-sliced-inbox', (event, id) => require('../sliced-inbox').ignoreWaiting(database.db, Number(id)));
