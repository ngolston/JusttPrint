'use strict';

// Categories (src/core/categories.js) and Categorize Library (src/server/category-scan.js).
const events = require('../events');
const { ipcMain } = require('../runtime');
const categories = require('../../core/categories');
const scan = require('../category-scan');
const database = require('../../core/database');

const changed = () => events.broadcast('categories-changed');

/** The Categories and Subcategories (flat, in order; parent_id ties a Subcategory to its Category) with their model counts, and how many models have no Subcategory. */
ipcMain.handle('get-categories', async () => ({ categories: categories.listCategories(), uncategorized: categories.uncategorizedCount() }));

/** { keywords } (words separated by commas); the list's names are fixed. */
ipcMain.handle('update-category', async (event, id, changes) => {
  const result = categories.updateCategory(id, changes || {});
  changed();
  events.broadcast('refresh-grid');
  return result;
});

/**
 * Give a model its place (the Edit dialog): names, the Subcategory deciding. `source` is who placed
 * it ('manual' unless Undo puts back a place the site or the AI gave). Answers [Category, Subcategory].
 */
ipcMain.handle('set-model-categories', async (event, filePath, names, source) => {
  const model = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(filePath);
  if (!model) throw new Error('This model is not in the library');
  const history = require('../model-versions');
  const result = await history.tracking([model.id], event && event.user ? event.user.username : null, async () =>
    categories.setModelCategories(model.id, names, typeof source === 'string' && source ? source : 'manual')
  );
  changed();
  return result;
});

/** Give many models one place (Multi-edit): `name` a Subcategory (or a Category). Answers { placed }. */
ipcMain.handle('set-models-category', async (event, filePaths, name) => {
  const byPath = database.db.prepare('SELECT id FROM models WHERE filePath = ?');
  const ids = (Array.isArray(filePaths) ? filePaths : [])
    .map((p) => byPath.get(String(p)))
    .filter(Boolean)
    .map((row) => row.id);
  if (!categories.findCategory(name)) throw new Error(`Not a category: ${name}`);
  const history = require('../model-versions');
  await history.tracking(ids, event && event.user ? event.user.username : null, async () => {
    for (const id of ids) categories.setModelPlace(id, name, 'manual');
  });
  changed();
  events.broadcast('refresh-grid');
  return { placed: ids.length };
});

/** Categorize Library: { useAi, again }. Answers the run, or { busy: true } while one is going. */
ipcMain.handle('start-category-scan', async (event, options) => {
  const useAi = !!(options && options.useAi);
  if (useAi && !scan.aiReady()) throw new Error('Set up the AI service first (Settings → AI Tagging)');
  const started = scan.start({ by: event && event.user ? event.user.username : null, useAi, again: !!(options && options.again), event });
  return started || { busy: true };
});

// aiService: Puter also needs this browser to be signed in to it (the page checks).
ipcMain.handle('get-category-scan', async () => ({ job: scan.snapshot(), aiReady: scan.aiReady(), aiService: require('./ai').getAISettings().aiService }));
ipcMain.handle('stop-category-scan', async () => ({ success: scan.stop() }));

ipcMain.handle('dismiss-category-scan', async () => ({ success: scan.dismiss() }));
