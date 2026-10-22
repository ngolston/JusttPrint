'use strict';

/**
 * Delete the models chosen in Multi-edit, one of two ways:
 *
 * - 'library': out of the library, files kept: they move to a ".JusttPrint Trash" folder at the
 *   top of their library folder (STL Home, a scanned folder), keeping their path inside it, so no
 *   scan finds them again (folders starting with a dot are never scanned) and they can be put back
 *   by hand. The same drive, so a move is instant.
 * - 'disk': deleted for good.
 *
 * What is moved or deleted: a model's file and its parts' files; a ZIP entry's whole ZIP (an entry cannot be taken out
 * alone); a model folder whose every model is chosen, as a whole (its pictures and documents go
 * with it). Link-only models have no file: only their record goes. The records of what was moved
 * or deleted leave the library (tags, notes, history with them).
 */

const fs = require('fs');
const path = require('path');
const database = require('../core/database');

const TRASH_DIR = '.JusttPrint Trash';

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The models whose file is `target` (a file, a ZIP's entries, or everything under a folder). */
function modelsAt(target, isFolder) {
  const db = database.db;
  if (isFolder) return db.prepare("SELECT filePath FROM models WHERE filePath LIKE ? ESCAPE '\\'").all(`${escapeLike(target)}${path.sep}%`);
  return db.prepare("SELECT filePath FROM models WHERE filePath = ? OR filePath LIKE ? ESCAPE '\\'").all(target, `${escapeLike(target)}::%`);
}

/** The paths of the parts of these models. */
function partsOf(filePaths) {
  const db = database.db;
  if (!require('../core/model-parts').hasPartOf(db)) return [];
  const query = db.prepare('SELECT p.filePath FROM models p JOIN models m ON p.partOf = m.id WHERE m.filePath = ?');
  return filePaths.flatMap((filePath) => query.all(filePath).map((row) => row.filePath));
}

/**
 * What to move or delete for these models: [{ target, isFolder }] and the link-only models (no file).
 * @param {string[]} chosenPaths
 */
function plan(chosenPaths) {
  const modelFolders = require('./model-folders');
  // A model's parts (files uploaded on its page, model-parts.js) go with it.
  const filePaths = [...new Set([...chosenPaths, ...partsOf(chosenPaths)])];
  const chosen = new Set(filePaths);
  const files = new Set();
  const links = [];
  for (const filePath of filePaths) {
    if (filePath.startsWith('url::')) links.push(filePath);
    else files.add(filePath.split('::')[0]);
  }
  // A model folder whose every model is chosen goes as a whole.
  const folders = new Set();
  for (const file of files) {
    const folder = modelFolders.folderOfFile(file);
    if (!folder || folders.has(folder)) continue;
    const inside = modelsAt(folder, true).map((row) => row.filePath);
    if (inside.length && inside.every((p) => chosen.has(p) || chosen.has(p.split('::')[0]))) folders.add(folder);
  }
  const targets = [...folders].map((target) => ({ target, isFolder: true }));
  for (const file of files) {
    if (![...folders].some((folder) => file.startsWith(folder + path.sep))) targets.push({ target: file, isFolder: false });
  }
  return { targets, links };
}

/** The library folder `target` is in (the deepest STL Home or scanned folder), else its own folder. */
function rootOf(target) {
  const { rootFor } = require('./uploads');
  const { networkPathContext } = require('./path-context');
  const root = rootFor(target, networkPathContext().roots);
  return root && root !== target ? root : path.dirname(target);
}

/** "x", else "x (2)", … : a path not taken yet. */
function freePath(wanted) {
  const ext = path.extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? wanted : `${stem} (${n})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No free name for ${wanted}`);
}

/** Move `from` into its library folder's trash, keeping its path inside it. Answers where it went. */
function moveToTrash(from) {
  const root = rootOf(from);
  const relative = path.relative(root, from);
  const to = freePath(path.join(root, TRASH_DIR, relative.startsWith('..') ? path.basename(from) : relative));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
  return to;
}

/**
 * Delete these models: mode 'library' (files to the trash folder) or 'disk' (deleted for good).
 * Answers { removed: models out of the library, items: [{ target, to? }], failed: [{ name, error }] }.
 * @param {string[]} filePaths
 * @param {'library' | 'disk'} mode
 */
async function deleteModels(filePaths, mode) {
  if (mode !== 'library' && mode !== 'disk') throw new Error("mode must be 'library' or 'disk'");
  const paths = [...new Set((Array.isArray(filePaths) ? filePaths : []).filter((p) => typeof p === 'string' && p))];
  if (!paths.length) throw new Error('Choose the models to delete');
  const { deleteModelsByFilePaths } = require('../core/models');
  const { targets, links } = plan(paths);
  const out = { removed: 0, items: /** @type {{ target: string, to?: string }[]} */ ([]), failed: /** @type {{ name: string, error: string }[]} */ ([]) };
  // No scan in the middle (it could add a file back while it moves).
  await require('./stl-home').withoutScans(async () => {
    for (const { target, isFolder } of targets) {
      const records = modelsAt(target, isFolder).map((row) => row.filePath);
      try {
        if (fs.existsSync(target)) {
          if (mode === 'library') out.items.push({ target, to: moveToTrash(target) });
          else {
            fs.rmSync(target, { recursive: isFolder, force: true });
            out.items.push({ target });
          }
        }
        out.removed += deleteModelsByFilePaths(records).removed.length;
      } catch (error) {
        out.failed.push({ name: path.basename(target), error: error.message });
      }
    }
    out.removed += deleteModelsByFilePaths(links).removed.length;
  });
  require('./events').broadcast('refresh-grid');
  console.log(`[Delete] ${mode === 'disk' ? 'Deleted' : 'Moved to the trash folder'} ${out.items.length} item(s); ${out.removed} model(s) out of the library`);
  return out;
}

module.exports = { TRASH_DIR, deleteModels, plan };
