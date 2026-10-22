'use strict';

/**
 * Renaming a model (the Edit dialog in the details panel): its file is renamed in its folder and
 * the library follows it. Online models (no file) only change their name. Files inside a zip file
 * (listed before 8.6) keep their names; an archive (ZIP, RAR, 7Z) is renamed like any model file.
 */

const fs = require('fs');
const path = require('path');
const database = require('../core/database');

const MAX_NAME = 200;

/** A name someone typed, or throws: no folders, nothing hidden, not too long. */
function cleanName(name) {
  const text = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('The name cannot be empty');
  if (/[/\\:*?"<>|\0]/.test(text)) throw new Error('A name cannot contain / \\ : * ? " < > |');
  if (text.startsWith('.')) throw new Error('A name cannot start with a dot');
  if (text.length > MAX_NAME) throw new Error(`A name can be at most ${MAX_NAME} characters`);
  return text;
}

/**
 * Rename a model to `name`, given without the file's extension (the file keeps its type; typing
 * it anyway is fine). Answers { filePath, fileName }: the model's new path and name.
 */
function renameModel(filePath, name) {
  const model = database.db.prepare('SELECT id, fileName FROM models WHERE filePath = ?').get(filePath);
  if (!model) throw new Error('This model is not in the library');
  let stem = cleanName(name);

  if (filePath.startsWith('url::')) {
    database.db.prepare('UPDATE models SET fileName = ? WHERE id = ?').run(stem, model.id);
    return { filePath, fileName: stem };
  }
  if (filePath.includes('::')) throw new Error('Files inside a zip file keep their names');
  const extension = path.extname(filePath);
  if (extension && stem.toLowerCase().endsWith(extension.toLowerCase())) stem = cleanName(stem.slice(0, -extension.length));

  const fileName = `${stem}${extension}`;
  const target = path.join(path.dirname(filePath), fileName);
  if (target === filePath) return { filePath, fileName };
  // A change of case only is the same file on macOS and Windows.
  const sameFile = target.toLowerCase() === filePath.toLowerCase();
  if (!sameFile && (fs.existsSync(target) || database.db.prepare('SELECT 1 FROM models WHERE filePath = ?').get(target))) {
    throw new Error(`There is already a file named ${fileName} in this folder`);
  }
  if (!fs.existsSync(filePath)) throw new Error('The file is not in its folder any more');
  fs.renameSync(filePath, target);
  // Right after the rename, so a folder rescan finds the model under its new name.
  database.db.transaction(() => {
    database.db.prepare('UPDATE models SET filePath = ?, fileName = ? WHERE id = ?').run(target, fileName, model.id);
    require('./site-details').fileRenamed(filePath, target);
  })();
  // The only model in its model folder: the folder takes the new name too (its pictures, videos and documents go with it).
  const modelFolders = require('./model-folders');
  const folder = path.dirname(target);
  if (modelFolders.isModelFolder(folder)) {
    const inFolder = database.db
      .prepare("SELECT filePath FROM models WHERE filePath LIKE ? ESCAPE '\\' AND filePath NOT LIKE '%::%'")
      .all(`${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}${path.sep}%`)
      .filter((row) => path.dirname(row.filePath) === folder);
    if (inFolder.length === 1) {
      try {
        const renamedFolder = modelFolders.renameFolder(folder, stem);
        return { filePath: path.join(renamedFolder, fileName), fileName };
      } catch (error) {
        console.warn(`[Rename] The model folder kept its name: ${error.message}`);
      }
    }
  }
  return { filePath: target, fileName };
}

module.exports = { cleanName, renameModel };
