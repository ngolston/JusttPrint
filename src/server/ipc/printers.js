'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const printerManager = require('../../core/printer-manager');

async function getAllPrintersHandler() {
  try {
    return printerManager.getAllPrinters(database.db);
  } catch (error) {
    console.error('Error getting printers:', error);
    throw error;
  }
}

ipcMain.handle('get-all-printers', getAllPrintersHandler);

async function savePrinterHandler(event, printer) {
  try {
    return printerManager.savePrinter(database.db, printer);
  } catch (error) {
    console.error('Error saving printer:', error);
    throw error;
  }
}

ipcMain.handle('save-printer', savePrinterHandler);

async function deletePrinterHandler(event, printerId) {
  try {
    return printerManager.deletePrinter(database.db, printerId);
  } catch (error) {
    console.error('Error deleting printer:', error);
    throw error;
  }
}

ipcMain.handle('delete-printer', deletePrinterHandler);

async function getPrinterMaintenanceLogsHandler(event, printerId) {
  try {
    return printerManager.getPrinterMaintenanceLogs(database.db, printerId);
  } catch (error) {
    console.error('Error getting printer maintenance logs:', error);
    throw error;
  }
}

ipcMain.handle('get-printer-maintenance-logs', getPrinterMaintenanceLogsHandler);

async function savePrinterMaintenanceLogHandler(event, logEntry) {
  try {
    return printerManager.savePrinterMaintenanceLog(database.db, logEntry);
  } catch (error) {
    console.error('Error saving printer maintenance log:', error);
    throw error;
  }
}

ipcMain.handle('save-printer-maintenance-log', savePrinterMaintenanceLogHandler);

async function deletePrinterMaintenanceLogHandler(event, logId) {
  try {
    return printerManager.deletePrinterMaintenanceLog(database.db, logId);
  } catch (error) {
    console.error('Error deleting printer maintenance log:', error);
    throw error;
  }
}

ipcMain.handle('delete-printer-maintenance-log', deletePrinterMaintenanceLogHandler);

async function getPrinterRemindersHandler(event, printerId) {
  try {
    return printerManager.getPrinterReminders(database.db, printerId);
  } catch (error) {
    console.error('Error getting printer reminders:', error);
    throw error;
  }
}

ipcMain.handle('get-printer-reminders', getPrinterRemindersHandler);

async function savePrinterReminderHandler(event, reminder) {
  try {
    return printerManager.savePrinterReminder(database.db, reminder);
  } catch (error) {
    console.error('Error saving printer reminder:', error);
    throw error;
  }
}

ipcMain.handle('save-printer-reminder', savePrinterReminderHandler);

async function deletePrinterReminderHandler(event, reminderId) {
  try {
    return printerManager.deletePrinterReminder(database.db, reminderId);
  } catch (error) {
    console.error('Error deleting printer reminder:', error);
    throw error;
  }
}

ipcMain.handle('delete-printer-reminder', deletePrinterReminderHandler);

async function completePrinterReminderHandler(event, payload) {
  try {
    const reminderId = typeof payload === 'object' ? payload?.id : payload;
    const notes = typeof payload === 'object' ? payload?.notes : null;
    return printerManager.completePrinterReminder(database.db, reminderId, notes);
  } catch (error) {
    console.error('Error completing printer reminder:', error);
    throw error;
  }
}

ipcMain.handle('complete-printer-reminder', completePrinterReminderHandler);
