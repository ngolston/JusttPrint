'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const printEvents = require('../../../print-events');

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

ipcMain.handle('log-print-event', logPrintEventHandler);

async function logPrintEventsBatchHandler(event, payload) {
  try {
    return printEvents.logPrintEventsBatch(database.db, payload || {});
  } catch (error) {
    console.error('Error logging print events batch:', error);
    throw error;
  }
}

ipcMain.handle('log-print-events-batch', logPrintEventsBatchHandler);

async function deletePrintEventHandler(event, eventId) {
  try {
    return printEvents.deletePrintEvent(database.db, eventId);
  } catch (error) {
    console.error('Error deleting print event:', error);
    throw error;
  }
}

ipcMain.handle('delete-print-event', deletePrintEventHandler);

async function setPrintStatusHandler(event, payload) {
  try {
    return printEvents.setPrintStatus(database.db, payload || {});
  } catch (error) {
    console.error('Error setting print status:', error);
    throw error;
  }
}

ipcMain.handle('set-print-status', setPrintStatusHandler);

async function setPrintStatusBatchHandler(event, payload) {
  try {
    return printEvents.setPrintStatusBatch(database.db, payload || {});
  } catch (error) {
    console.error('Error setting print status batch:', error);
    throw error;
  }
}

ipcMain.handle('set-print-status-batch', setPrintStatusBatchHandler);
