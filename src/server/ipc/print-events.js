'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const printEvents = require('../../core/print-events');
const events = require('../events');

/** The file paths a print action touched: from its payload (paths or model ids) or its result. */
function touchedPaths(payload, result) {
  const paths = [];
  const p = payload || {};
  if (typeof p.filePath === 'string') paths.push(p.filePath);
  if (Array.isArray(p.filePaths)) paths.push(...p.filePaths.filter((x) => typeof x === 'string'));
  const ids = [p.modelId, ...(Array.isArray(p.modelIds) ? p.modelIds : [])].map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const byId = database.db.prepare('SELECT filePath FROM models WHERE id = ?');
  for (const id of ids) {
    const row = byId.get(id);
    if (row) paths.push(row.filePath);
  }
  if (result && typeof result === 'object' && typeof result.filePath === 'string') paths.push(result.filePath);
  if (result && typeof result === 'object' && result.model && typeof result.model.filePath === 'string') paths.push(result.model.filePath);
  return [...new Set(paths)];
}

/** Run a print action, then tell the other browsers which models changed. */
function announcing(handler) {
  return async (event, payload) => {
    const result = await handler(event, payload);
    try {
      const paths = touchedPaths(payload, result);
      if (paths.length) events.broadcastToOthers(event, 'models-changed', { filePaths: paths, by: event && event.user ? event.user.username : null });
    } catch (_) { /* the change itself succeeded */ }
    return result;
  };
}

async function getPrintEventsHandler(event, modelId) {
  try {
    return printEvents.getPrintEvents(database.db, modelId);
  } catch (error) {
    console.error('Error getting print events:', error);
    throw error;
  }
}

ipcMain.handle('get-print-events', getPrintEventsHandler);

async function logPrintEventHandler(event, payload) {
  try {
    return printEvents.logPrintEvent(database.db, payload || {});
  } catch (error) {
    console.error('Error logging print event:', error);
    throw error;
  }
}

ipcMain.handle('log-print-event', announcing(logPrintEventHandler));

async function logPrintEventsBatchHandler(event, payload) {
  try {
    return printEvents.logPrintEventsBatch(database.db, payload || {});
  } catch (error) {
    console.error('Error logging print events batch:', error);
    throw error;
  }
}

ipcMain.handle('log-print-events-batch', announcing(logPrintEventsBatchHandler));

async function deletePrintEventHandler(event, eventId) {
  try {
    return printEvents.deletePrintEvent(database.db, eventId);
  } catch (error) {
    console.error('Error deleting print event:', error);
    throw error;
  }
}

ipcMain.handle('delete-print-event', announcing(deletePrintEventHandler));

async function setPrintStatusHandler(event, payload) {
  try {
    return printEvents.setPrintStatus(database.db, payload || {});
  } catch (error) {
    console.error('Error setting print status:', error);
    throw error;
  }
}

ipcMain.handle('set-print-status', announcing(setPrintStatusHandler));

async function setPrintStatusBatchHandler(event, payload) {
  try {
    return printEvents.setPrintStatusBatch(database.db, payload || {});
  } catch (error) {
    console.error('Error setting print status batch:', error);
    throw error;
  }
}

ipcMain.handle('set-print-status-batch', announcing(setPrintStatusBatchHandler));
