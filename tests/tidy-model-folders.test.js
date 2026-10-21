'use strict';

// Tidy Into Model Folders (src/server/tidy-model-folders.js): a folder of its own for each model already in the library.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const mf = require('../src/server/model-folders');
const tidy = require('../src/server/tidy-model-folders');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-tidy-')));
  database.db = new Database(path.join(tmp, 'test.db'));
  database.db.exec(`CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, parentModel TEXT, title TEXT, thumbnail TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  const lib = path.join(tmp, 'lib');
  const add = (rel, { parent = null, thumbnail = null, content = 'solid x' } = {}) => {
    const filePath = path.join(lib, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    database.db
      .prepare('INSERT INTO models (filePath, fileName, parentModel, thumbnail) VALUES (?, ?, ?, ?)')
      .run(filePath, path.basename(filePath), parent, thumbnail);
    return filePath;
  };
  add('Benchy.stl');
  fs.writeFileSync(path.join(lib, 'Benchy.png'), Buffer.from(PNG, 'base64'));
  fs.writeFileSync(path.join(lib, 'Benchy - notes.pdf'), '%PDF');
  fs.writeFileSync(path.join(lib, 'Unrelated.pdf'), '%PDF');
  add('Robot arm.stl', { parent: 'Robot', thumbnail: `data:image/png;base64,${PNG}` });
  add('Robot leg.stl', { parent: 'robot' });
  add('Solo/only.stl');
  add('Done/x.stl');
  mf.register(path.join(lib, 'Done'));
  database.db.prepare("INSERT INTO models (filePath, fileName) VALUES ('url::https://example.com/m', 'link')").run();
  database.db.prepare('INSERT INTO models (filePath, fileName) VALUES (?, ?)').run(`${path.join(lib, 'pack.zip')}::a.stl`, 'a.stl');

  const roots = [lib];
  const preview = tidy.preview({ roots });
  assert.strictEqual(preview.moveCount, 2, JSON.stringify(preview));
  assert.strictEqual(preview.registerCount, 1, 'a folder with one model becomes its folder');
  assert.strictEqual(preview.already, 1);
  assert.deepStrictEqual(preview.skipped, { zip: 1, link: 1, missing: 0 });
  const benchy = preview.sample.find((g) => g.files.includes('Benchy.stl'));
  assert.deepStrictEqual(benchy.media.sort(), ['Benchy - notes.pdf', 'Benchy.png'], 'pictures and documents with its name go along');
  const robot = preview.sample.find((g) => g.files.includes('Robot arm.stl'));
  assert.deepStrictEqual(robot.files.sort(), ['Robot arm.stl', 'Robot leg.stl'], 'one parent model, one folder');
  assert.strictEqual(robot.to, path.join(lib, 'Robot'));
  assert.ok(fs.existsSync(path.join(lib, 'Benchy.stl')), 'a preview moves nothing');

  // Only the chosen ones.
  const first = await tidy.apply({ roots, only: [benchy.id] });
  assert.deepStrictEqual([first.moved, first.registered, first.failed], [1, 0, []]);
  assert.ok(fs.existsSync(path.join(lib, 'Benchy', 'Benchy.stl')));
  assert.ok(fs.existsSync(path.join(lib, 'Benchy', 'image', 'Benchy.png')) && fs.existsSync(path.join(lib, 'Benchy', 'document', 'Benchy - notes.pdf')));
  assert.ok(database.db.prepare('SELECT 1 FROM models WHERE filePath = ?').get(path.join(lib, 'Benchy', 'Benchy.stl')), 'the model moved with its file');
  assert.strictEqual(mf.getMedia(path.join(lib, 'Benchy')).cover, 'Benchy.png', 'its picture is the cover');
  assert.ok(fs.existsSync(path.join(lib, 'Robot arm.stl')), 'the others stay');

  // The rest, with covers from the thumbnails.
  const rest = await tidy.apply({ roots, covers: true });
  assert.deepStrictEqual([rest.moved, rest.registered, rest.failed], [1, 1, []]);
  assert.deepStrictEqual(fs.readdirSync(path.join(lib, 'Robot')).sort(), ['Robot arm.stl', 'Robot leg.stl', 'image']);
  assert.deepStrictEqual(fs.readdirSync(path.join(lib, 'Robot', 'image')), ['cover.png'], 'the thumbnail as the cover picture');
  assert.ok(mf.isModelFolder(path.join(lib, 'Solo')) && fs.existsSync(path.join(lib, 'Solo', 'only.stl')), 'kept where it is');
  assert.ok(fs.existsSync(path.join(lib, 'Unrelated.pdf')), 'files of no model stay');
  assert.strictEqual(tidy.preview({ roots }).moveCount + tidy.preview({ roots }).registerCount, 0, 'nothing left to tidy');

  // A model page's Upload: the model's own folder, made first when it has none.
  const pileA = add('Pile/Gear.stl');
  add('Pile/Spring.stl');
  const own = await tidy.ownFolder(pileA, { roots });
  assert.deepStrictEqual(own, { folder: path.join(lib, 'Pile', 'Gear'), filePath: path.join(lib, 'Pile', 'Gear', 'Gear.stl'), moved: true });
  assert.ok(fs.existsSync(own.filePath) && fs.existsSync(path.join(lib, 'Pile', 'Spring.stl')), 'only this model moves');
  assert.deepStrictEqual(await tidy.ownFolder(own.filePath, { roots }), { ...own, moved: false }, 'a model folder already');
  await assert.rejects(() => tidy.ownFolder(`${path.join(lib, 'pack.zip')}::a.stl`, { roots }), /inside a ZIP/);

  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('tidy-model-folders tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
