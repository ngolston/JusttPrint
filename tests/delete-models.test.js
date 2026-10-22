#!/usr/bin/env node
'use strict';

// Multi-edit's Delete (src/server/delete-models.js): from the library (files to a trash folder no
// scan looks in) or from disk (deleted for good).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-delete-')));
const home = path.join(tmp, 'Models');
const database = require('../src/core/database');
database.db = new Database(path.join(tmp, 'test.db'));
database.db.exec(
  'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, thumbnail TEXT, partOf INTEGER); CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER)'
);
database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('stlHomeDirectories', JSON.stringify([home]));
// The print history a model's removal clears too.
require('../src/core/print-events').ensurePrintLifecycleSchema(database.db);
const { deleteModels, TRASH_DIR } = require('../src/server/delete-models');
const modelFolders = require('../src/server/model-folders');

const write = (...parts) => {
  const file = path.join(home, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'solid x\nendsolid x\n');
  return file;
};
const add = (filePath) => database.db.prepare('INSERT INTO models (filePath, fileName) VALUES (?, ?)').run(filePath, path.basename(filePath));
const inLibrary = (filePath) => !!database.db.prepare('SELECT 1 FROM models WHERE filePath = ?').get(filePath);

(async () => {
  try {
    // From the library: the file moves to <STL Home>/.JusttPrint Trash/<its path>, its record goes.
    const loose = write('Designer A', 'cube.stl');
    const other = write('Designer A', 'sphere.stl');
    add(loose);
    add(other);
    let result = await deleteModels([loose], 'library');
    assert.strictEqual(result.removed, 1);
    assert.ok(fs.existsSync(path.join(home, TRASH_DIR, 'Designer A', 'cube.stl')), 'kept in the trash folder, with its path');
    assert.ok(!fs.existsSync(loose) && !inLibrary(loose) && inLibrary(other), 'only the chosen model goes');

    // A model folder whose models are all chosen moves as a whole, its pictures with it.
    const robotDir = path.join(home, 'Robot');
    const arm = write('Robot', 'arm.stl');
    const leg = write('Robot', 'leg.stl');
    fs.mkdirSync(path.join(robotDir, 'image'));
    fs.writeFileSync(path.join(robotDir, 'image', 'cover.png'), 'x');
    modelFolders.register(robotDir);
    add(arm);
    add(leg);
    result = await deleteModels([arm, leg], 'library');
    assert.strictEqual(result.removed, 2);
    assert.ok(fs.existsSync(path.join(home, TRASH_DIR, 'Robot', 'image', 'cover.png')), 'the whole model folder');
    assert.ok(!fs.existsSync(robotDir));

    // A model's parts (files uploaded on its page) go with it: its folder goes as a whole.
    const shipDir = path.join(home, 'Ship');
    const hull = write('Ship', 'hull.stl');
    const mast = write('Ship', 'mast.stl');
    modelFolders.register(shipDir);
    add(hull);
    add(mast);
    const { setModelParts } = require('../src/core/models');
    assert.strictEqual(setModelParts(hull, [mast, hull]), 1, 'a model is not a part of itself');
    result = await deleteModels([hull], 'library');
    assert.strictEqual(result.removed, 2);
    assert.ok(!fs.existsSync(shipDir) && !inLibrary(mast), 'the part went with its model');
    assert.ok(fs.existsSync(path.join(home, TRASH_DIR, 'Ship', 'mast.stl')));

    // A model inside a ZIP: the whole ZIP (all its entries leave the library).
    const zip = write('Kits', 'kit.zip');
    add(`${zip}::a.stl`);
    add(`${zip}::b.stl`);
    result = await deleteModels([`${zip}::a.stl`], 'library');
    assert.strictEqual(result.removed, 2, 'every entry of the ZIP');
    assert.ok(fs.existsSync(path.join(home, TRASH_DIR, 'Kits', 'kit.zip')));

    // The same name again in the trash: a number, nothing replaced.
    const again = write('Designer A', 'cube.stl');
    add(again);
    await deleteModels([again], 'library');
    assert.ok(fs.existsSync(path.join(home, TRASH_DIR, 'Designer A', 'cube (2).stl')));

    // From disk: deleted for good.
    result = await deleteModels([other], 'disk');
    assert.ok(!fs.existsSync(other) && !inLibrary(other) && result.removed === 1);
    assert.ok(!fs.existsSync(path.join(home, TRASH_DIR, 'Designer A', 'sphere.stl')), 'not in the trash folder');

    // A link-only model has no file: only its record goes.
    add('url::https://www.printables.com/model/1');
    assert.strictEqual((await deleteModels(['url::https://www.printables.com/model/1'], 'library')).removed, 1);
    await assert.rejects(() => deleteModels([loose], 'somewhere'), /mode must be/);
    console.log('ok models are deleted from the library (files to the trash folder) or from disk');
  } catch (err) {
    console.error(
      'FAIL delete-models:',
      err.message,
      err.stack.split('\n').find((l) => l.includes('delete-models.test'))
    );
    process.exitCode = 1;
  } finally {
    database.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    setTimeout(() => process.exit(), 50).unref();
  }
})();
