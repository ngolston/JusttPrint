'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const printEvents = require('../../core/print-events');

function normalizePartStockQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 1000000);
}

async function getAllPartsHandler() {
  try {
    printEvents.ensurePartsSchema(database.db);
    return database.db
      .prepare(
        `
      SELECT id, name, category, quantity, unit, notes, low_stock
      FROM parts
      ORDER BY name COLLATE NOCASE, id ASC
    `
      )
      .all();
  } catch (error) {
    console.error('Error getting parts:', error);
    throw error;
  }
}

ipcMain.handle('get-all-parts', getAllPartsHandler);

async function savePartHandler(event, part) {
  try {
    printEvents.ensurePartsSchema(database.db);
    const name = String(part?.name || '').trim();
    if (!name) throw new Error('Part name is required');
    const category = String(part?.category || '').trim() || null;
    const unit = String(part?.unit || '').trim() || 'pcs';
    const notes = String(part?.notes || '').trim() || null;
    const quantity = normalizePartStockQuantity(part?.quantity);
    const lowStock = normalizePartStockQuantity(part?.lowStock ?? part?.low_stock ?? 0);
    const id = part?.id != null && part.id !== '' ? Number(part.id) : null;
    if (id) {
      if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid part');
      const existing = database.db.prepare('SELECT id FROM parts WHERE id = ?').get(id);
      if (!existing) throw new Error('Part not found');
      database.db
        .prepare(
          `
        UPDATE parts
        SET name = ?, category = ?, quantity = ?, unit = ?, notes = ?, low_stock = ?
        WHERE id = ?
      `
        )
        .run(name, category, quantity, unit, notes, lowStock, id);
      return database.db.prepare('SELECT * FROM parts WHERE id = ?').get(id);
    }
    const result = database.db
      .prepare(
        `
      INSERT INTO parts (name, category, quantity, unit, notes, low_stock)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(name, category, quantity, unit, notes, lowStock);
    return database.db.prepare('SELECT * FROM parts WHERE id = ?').get(result.lastInsertRowid);
  } catch (error) {
    console.error('Error saving part:', error);
    throw error;
  }
}

ipcMain.handle('save-part', savePartHandler);

async function deletePartHandler(event, partId) {
  try {
    printEvents.ensurePartsSchema(database.db);
    const id = Number(partId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid part');
    return database.db.transaction(() => {
      const result = database.db.prepare('DELETE FROM parts WHERE id = ?').run(id);
      return result.changes > 0;
    })();
  } catch (error) {
    console.error('Error deleting part:', error);
    throw error;
  }
}

ipcMain.handle('delete-part', deletePartHandler);
