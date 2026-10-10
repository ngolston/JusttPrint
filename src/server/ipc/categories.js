'use strict';

// Categories (src/core/categories.js) and Categorize Library (src/server/category-scan.js).
const events = require('../events');
const { ipcMain } = require('../runtime');
const categories = require('../../core/categories');
const scan = require('../category-scan');
const database = require('../../core/database');

const changed = () => events.broadcast('categories-changed');

/** The categories with their model counts, and how many models are in none. */
ipcMain.handle('get-categories', async () => ({ categories: categories.listCategories(), uncategorized: categories.uncategorizedCount() }));

ipcMain.handle('create-category', async (event, name, keywords) => {
  const result = categories.createCategory(name, keywords || '');
  changed();
  return result;
});

/** { name?, keywords? } (keywords: words separated by commas). */
ipcMain.handle('update-category', async (event, id, changes) => {
  const result = categories.updateCategory(id, changes || {});
  changed();
  events.broadcast('refresh-grid');
  return result;
});

ipcMain.handle('delete-category', async (event, id) => {
  categories.deleteCategory(id);
  changed();
  events.broadcast('refresh-grid');
  return { success: true };
});

/** Put a model in exactly these categories (the Edit dialog). Answers its category names. */
ipcMain.handle('set-model-categories', async (event, filePath, names) => {
  const model = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(filePath);
  if (!model) throw new Error('This model is not in the library');
  const result = categories.setModelCategories(model.id, names, 'manual');
  changed();
  return result;
});

/** Categorize Library: { useAi }. Answers the run, or { busy: true } while one is going. */
ipcMain.handle('start-category-scan', async (event, options) => {
  const useAi = !!(options && options.useAi);
  if (useAi && !scan.aiReady()) throw new Error('Set up the AI service first (Settings → AI Tagging)');
  const started = scan.start({ by: event && event.user ? event.user.username : null, useAi, event });
  return started || { busy: true };
});

ipcMain.handle('get-category-scan', async () => ({ job: scan.snapshot(), aiReady: scan.aiReady() }));
ipcMain.handle('stop-category-scan', async () => ({ success: scan.stop() }));

/** The AI's picks the person kept: [{ filePath, categories }]. */
ipcMain.handle('apply-category-suggestions', async (event, picks) => {
  const placed = scan.apply(picks);
  changed();
  return { placed };
});

ipcMain.handle('dismiss-category-scan', async () => ({ success: scan.dismiss() }));
