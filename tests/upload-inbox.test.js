#!/usr/bin/env node
'use strict';

// The Upload folder and Organize Uploads' parts (src/server/upload-inbox.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-inbox-')));
const database = require('../src/core/database');
database.db = new Database(path.join(tmp, 'test.db'));
database.db.exec(
  'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, thumbnail TEXT, size INTEGER, source TEXT, title TEXT, designer TEXT, license TEXT)'
);
const setSetting = (key, value) => database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
const inbox = require('../src/server/upload-inbox');
const modelFolders = require('../src/server/model-folders');
const categories = require('../src/core/categories');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const uploads = path.join(tmp, 'Uploads');
const home = path.join(tmp, 'Models');
fs.mkdirSync(uploads);
fs.mkdirSync(home);
setSetting('stlHomeDirectories', JSON.stringify([home]));
setSetting('uploadFolder', uploads);
const addModel = (filePath) =>
  database.db.prepare('INSERT INTO models (filePath, fileName) VALUES (?, ?)').run(filePath, path.basename(filePath)).lastInsertRowid;

try {
  test('models in the Upload folder are waiting; the destination is the first STL Home folder', () => {
    addModel(path.join(uploads, 'Robot', 'arm.stl'));
    addModel(`${path.join(uploads, 'kit.zip')}::part.stl`);
    addModel(path.join(home, 'Boat.stl'));
    assert.strictEqual(inbox.waitingCount(), 2);
    assert.ok(inbox.isWaiting(path.join(uploads, 'Robot', 'arm.stl')));
    assert.ok(inbox.isWaiting(`${path.join(uploads, 'kit.zip')}::part.stl`), 'a ZIP entry by its archive');
    assert.ok(!inbox.isWaiting(path.join(home, 'Boat.stl')));
    assert.ok(!inbox.isWaiting(`${uploads}-old/x.stl`), 'not a folder that only starts the same');
    assert.strictEqual(inbox.destination(), home);
    setSetting('organizeDestination', path.join(tmp, 'Sorted'));
    assert.strictEqual(inbox.destination(), path.join(tmp, 'Sorted'));
    setSetting('organizeDestination', '');
  });

  test('without a chosen Upload folder, Uploads inside the first STL Home folder is used', () => {
    setSetting('uploadFolder', '');
    try {
      assert.strictEqual(inbox.uploadFolder(), path.join(home, 'Uploads'));
      assert.strictEqual(inbox.info().chosenUploadFolder, '');
      assert.strictEqual(inbox.requireUploadFolder(), path.join(home, 'Uploads'));
      assert.ok(fs.statSync(path.join(home, 'Uploads')).isDirectory(), 'made when needed');
      addModel(path.join(home, 'Uploads', 'New', 'thing.stl'));
      assert.ok(inbox.isWaiting(path.join(home, 'Uploads', 'New', 'thing.stl')));
      assert.ok(!inbox.isWaiting(path.join(home, 'Boat.stl')));
      setSetting('stlHomeDirectories', '[]');
      assert.strictEqual(inbox.uploadFolder(), '', 'no STL Home: none');
      assert.throws(
        () => inbox.requireUploadFolder(),
        (error) => error.code === 'NO_UPLOAD_FOLDER'
      );
    } finally {
      database.db.prepare('DELETE FROM models WHERE filePath = ?').run(path.join(home, 'Uploads', 'New', 'thing.stl'));
      fs.rmSync(path.join(home, 'Uploads'), { recursive: true, force: true });
      setSetting('stlHomeDirectories', JSON.stringify([home]));
      setSetting('uploadFolder', uploads);
    }
  });

  test('every top-level folder, model file and archive is one model; pictures, hidden and media folders are not', () => {
    fs.mkdirSync(path.join(uploads, 'Robot'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'Robot', 'arm.stl'), 'solid a\nendsolid a\n');
    fs.writeFileSync(path.join(uploads, 'Benchy.stl'), 'solid b\nendsolid b\n');
    fs.writeFileSync(path.join(uploads, 'Kit.7z'), 'x');
    fs.writeFileSync(path.join(uploads, 'photo.png'), 'x');
    fs.mkdirSync(path.join(uploads, '.cache'));
    fs.mkdirSync(path.join(uploads, 'image'));
    assert.deepStrictEqual(
      inbox.itemsIn(uploads).map((item) => item.name),
      ['Benchy.stl', 'Kit.7z', 'Robot'],
      'a 7Z is a model too (moved as it is, never unpacked)'
    );
  });

  test('a model folder moves with its records, model folders inside it too', () => {
    const from = path.join(uploads, 'Robot');
    modelFolders.register(from);
    modelFolders.register(path.join(from, 'hands'));
    const to = path.join(home, 'Toys & Games', 'Robots', 'Robot');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    inbox.moveFolder(from, to);
    assert.ok(fs.existsSync(path.join(to, 'arm.stl')) && !fs.existsSync(from));
    assert.ok(database.db.prepare('SELECT 1 FROM models WHERE filePath = ?').get(path.join(to, 'arm.stl')), 'the model follows');
    assert.ok(modelFolders.isModelFolder(to) && modelFolders.isModelFolder(path.join(to, 'hands')), 'model folders inside follow');
    assert.strictEqual(inbox.waitingCount(), 1, 'it is not waiting any more');
  });

  test('across drives the folder is copied (hidden until complete), then the original removed', () => {
    const from = path.join(uploads, 'Ship');
    fs.mkdirSync(path.join(from, 'image'), { recursive: true });
    fs.writeFileSync(path.join(from, 'hull.stl'), 'solid h\nendsolid h\n');
    fs.writeFileSync(path.join(from, 'image', 'cover.png'), 'x');
    addModel(path.join(from, 'hull.stl'));
    const to = path.join(home, 'Ship');
    const exdev = () => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    };
    inbox.moveFolder(from, to, { rename: exdev });
    assert.ok(fs.existsSync(path.join(to, 'hull.stl')) && fs.existsSync(path.join(to, 'image', 'cover.png')));
    assert.ok(!fs.existsSync(from), 'the original is gone');
    assert.deepStrictEqual(
      fs.readdirSync(home).filter((name) => name.startsWith('.')),
      [],
      'no hidden copy is left'
    );
    assert.ok(database.db.prepare('SELECT 1 FROM models WHERE filePath = ?').get(path.join(to, 'hull.stl')));
  });

  test('a folder goes where most of its models are placed, else Uncategorized › Other', () => {
    const ids = [path.join(tmp, 'p', 'a.stl'), path.join(tmp, 'p', 'b.stl'), path.join(tmp, 'p', 'c.stl')].map((p) => ({ id: Number(addModel(p)) }));
    assert.deepStrictEqual(inbox.placeOf(ids), ['Uncategorized', 'Other']);
    const list = categories.listCategories();
    const subs = list.filter((c) => c.parent_id);
    categories.setModelPlace(ids[0].id, subs[0].name, 'ai');
    categories.setModelPlace(ids[1].id, subs[0].name, 'ai');
    categories.setModelPlace(ids[2].id, subs[5].name, 'ai');
    const main = list.find((c) => c.id === subs[0].parent_id);
    assert.deepStrictEqual(inbox.placeOf(ids), [main.name, subs[0].name]);
  });

  test('the destination may not be inside the Upload folder, nor the Upload folder hold STL Home', () => {
    assert.throws(() => inbox.saveFolders(uploads, path.join(uploads, 'Sorted')), /inside the Upload folder/);
    assert.throws(() => inbox.saveFolders(tmp, ''), /cannot hold an STL Home folder/);
    assert.throws(() => inbox.saveFolders('relative/folder', ''), /whole path/);
    const made = path.join(tmp, 'New Uploads');
    const saved = inbox.saveFolders(made, '');
    assert.ok(fs.statSync(made).isDirectory(), 'made when missing');
    assert.strictEqual(saved.uploadFolder, made);
    assert.strictEqual(saved.destination, home);
  });

  test('Organize is set up as asked by default: Category / Subcategory / Title, every step on', () => {
    const options = inbox.organizeOptions();
    assert.deepStrictEqual(options, { layers: ['category', 'subcategory'], tidy: true, tags: true, autoApply: true });
    inbox.saveFolders(uploads, '', { layers: ['designer', 'category', 'nonsense', 'designer'], autoApply: false });
    assert.deepStrictEqual(inbox.organizeOptions().layers, ['designer', 'category'], 'unknown and repeated levels are left out');
    assert.strictEqual(inbox.organizeOptions().autoApply, false);
    assert.strictEqual(inbox.organizeOptions().tags, true, 'what was not sent stays');
    inbox.saveFolders(uploads, '', { layers: ['category', 'subcategory'], autoApply: true });
  });

  test("a model's folders: its levels, then its Title without the file's extension", () => {
    const id = Number(addModel(path.join(tmp, 'q', 'dragon.3mf')));
    database.db.prepare('UPDATE models SET title = ?, designer = ? WHERE id = ?').run('Articulated Dragon.3mf', 'Alice', id);
    assert.strictEqual(inbox.titleOf([{ id }]), 'Articulated Dragon');
    assert.deepStrictEqual(inbox.layerFolders([{ id }], ['designer', 'license', 'category']), ['Alice', 'No License', 'Uncategorized']);
    assert.strictEqual(inbox.withoutExtension('Kit.STL'), 'Kit');
  });
} finally {
  // Below: renaming files (async), then the clean-up.
}

(async () => {
  try {
    // Files are named after the Title, keeping their extension; two files with it get "(2)".
    const kit = path.join(home, 'Kit Folder');
    fs.mkdirSync(kit, { recursive: true });
    const files = ['part_a_v3.stl', 'part_b_final.stl'].map((name) => path.join(kit, name));
    for (const file of files) fs.writeFileSync(file, 'solid x\nendsolid x\n');
    const ids = files.map((file) => Number(addModel(file)));
    const renamed = await inbox.renameToTitle(
      ids.map((id, i) => ({ id, filePath: files[i] })),
      'Robot Arm',
      'test'
    );
    const names = fs.readdirSync(kit).sort();
    assert.strictEqual(renamed, 2);
    assert.deepStrictEqual(names, ['Robot Arm (2).stl', 'Robot Arm.stl']);
    assert.ok(database.db.prepare('SELECT 1 FROM models WHERE filePath = ?').get(path.join(kit, 'Robot Arm.stl')), 'the record follows');
    assert.strictEqual(
      await inbox.renameToTitle([{ id: ids[0], filePath: path.join(kit, 'Robot Arm.stl') }], 'Robot Arm', 'test'),
      0,
      'a file already named after the Title stays'
    );
    console.log('ok files are named after the Title, keeping their extension');
  } catch (err) {
    console.error('FAIL files are named after the Title:', err.message);
    process.exitCode = 1;
  } finally {
    database.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    // Folder watching restarts a moment after a setting changed; nothing to wait for here.
    setTimeout(() => process.exit(), 50).unref();
  }
})();
