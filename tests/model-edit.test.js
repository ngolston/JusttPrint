'use strict';

// The details panel's Edit dialog on the server: renaming a model's file, and edits to its site details.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { renameModel, cleanName } = require('../src/server/model-rename');
const siteDetails = require('../src/server/site-details');

const URL_ = 'https://makerworld.com/en/models/1246678-voltron';

const design = {
  id: 1246678,
  title: 'VOLTRON',
  summary: '<p>Defender of the Universe</p>',
  license: 'BY',
  tags: ['robot', 'lion'],
  categories: [{ id: 1, name: 'Toys' }],
  designCreator: { name: 'Maker', handle: 'maker' },
  defaultInstanceId: 2,
  instances: [
    { id: 1, title: 'A1 Mini', extention: { modelInfo: { plates: [] } } },
    { id: 2, title: '0.1mm layer', extention: { modelInfo: { plates: [] } } }
  ]
};

async function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-model-edit-')));
  database.db = new Database(path.join(tmp, 'test.db'));
  database.db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, designer TEXT, license TEXT, source TEXT, notes TEXT, rating INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0, print_status TEXT DEFAULT 'unprinted', printed INTEGER, print_count INTEGER DEFAULT 0, last_printed_at TEXT, thumbnail TEXT); INSERT INTO settings (key, value) VALUES ('makerWorldTranslation', 'off')"
  );
  const add = (filePath) => database.db.prepare('INSERT INTO models (filePath, fileName) VALUES (?, ?)').run(filePath, path.basename(filePath)).lastInsertRowid;

  // --- Names ---
  assert.strictEqual(cleanName('  Lion   Head '), 'Lion Head');
  for (const bad of ['', '   ', 'a/b', 'a\\b', '.hidden', 'x'.repeat(201), 'what?']) assert.throws(() => cleanName(bad));

  // --- Renaming a file: same folder, same type, the library follows ---
  const folder = path.join(tmp, 'Voltron');
  fs.mkdirSync(folder);
  const original = path.join(folder, 'VOLTRON.3mf');
  fs.writeFileSync(original, 'x');
  const id = add(original);
  siteDetails.siteFilesTable();
  database.db.prepare('INSERT INTO site_files (file_path, key, profile_id) VALUES (?, ?, ?)').run(original, 'makerworld:1246678', '2');

  const renamed = renameModel(original, 'Black Lion');
  assert.deepStrictEqual(renamed, { filePath: path.join(folder, 'Black Lion.3mf'), fileName: 'Black Lion.3mf' });
  assert.ok(fs.existsSync(renamed.filePath) && !fs.existsSync(original));
  assert.deepStrictEqual(database.db.prepare('SELECT id, fileName FROM models WHERE filePath = ?').get(renamed.filePath), { id, fileName: 'Black Lion.3mf' });
  assert.deepStrictEqual(database.db.prepare('SELECT file_path, named_by_user FROM site_files').get(), { file_path: renamed.filePath, named_by_user: 1 });
  assert.strictEqual(renameModel(renamed.filePath, 'Black Lion.3mf').filePath, renamed.filePath, 'typing the extension does not double it');

  // An existing file is never overwritten.
  fs.writeFileSync(path.join(folder, 'Taken.3mf'), 'y');
  assert.throws(() => renameModel(renamed.filePath, 'Taken'), /already a file named Taken\.3mf/);
  assert.strictEqual(fs.readFileSync(path.join(folder, 'Taken.3mf'), 'utf8'), 'y');

  // Online models only change their name; zip entries and zip files keep theirs.
  add('url::https://makerworld.com/models/1');
  assert.deepStrictEqual(renameModel('url::https://makerworld.com/models/1', 'Voltron'), {
    filePath: 'url::https://makerworld.com/models/1',
    fileName: 'Voltron'
  });
  add('/l/kit.zip::part.stl');
  assert.throws(() => renameModel('/l/kit.zip::part.stl', 'x'), /inside a zip/);
  assert.throws(() => renameModel('/l/missing.stl', 'x'), /not in the library/);

  // --- Site edits: laid over the site's details, kept through Refresh ---
  let fetches = 0;
  const world = async (url) => {
    if (new URL(url).pathname === '/api/v1/design-service/design/1246678') {
      fetches++;
      return new Response(JSON.stringify(design));
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const first = await siteDetails.getDetails(URL_, { fetchImpl: world });
  assert.strictEqual(first.details.title, 'VOLTRON');
  assert.strictEqual(first.details.edited, undefined);

  const edited = await siteDetails.saveSiteEdits(
    URL_,
    { title: '  Voltron, Defender  ', tags: ['robot', ' lion ', 'lion', ''], description: 'Mine', profiles: { 2: 'Fine layers', 999: 'nope' } },
    { fetchImpl: world }
  );
  assert.strictEqual(edited.details.title, 'Voltron, Defender');
  assert.strictEqual(edited.details.titleEnglish, null);
  assert.strictEqual(edited.details.description, 'Mine');
  assert.deepStrictEqual(
    edited.details.tags.map((tag) => tag.name),
    ['robot', 'lion'],
    'the same tags as the site are not an edit'
  );
  assert.deepStrictEqual(edited.details.profiles.find((p) => p.id === '2').name, 'Fine layers');
  assert.deepStrictEqual([...edited.details.edited].sort(), ['description', 'profiles', 'title']);

  const refreshed = await siteDetails.getDetails(URL_, { refresh: true, fetchImpl: world });
  assert.strictEqual(fetches, 2);
  assert.strictEqual(refreshed.details.title, 'Voltron, Defender', 'Refresh keeps the edits');
  const stored = JSON.parse(database.db.prepare('SELECT data FROM site_details').get().data);
  assert.strictEqual(stored.title, 'VOLTRON', "the site's details are kept as the site says");

  // Setting a field back to the site's value drops that edit; null forgets them all.
  const back = await siteDetails.saveSiteEdits(URL_, { title: 'VOLTRON' }, { fetchImpl: world });
  assert.deepStrictEqual([...back.details.edited].sort(), ['description', 'profiles']);
  const reset = await siteDetails.saveSiteEdits(URL_, null, { fetchImpl: world });
  assert.strictEqual(reset.details.edited, undefined);
  assert.strictEqual(reset.details.description, 'Defender of the Universe');
  await assert.rejects(siteDetails.saveSiteEdits('https://example.com/x', {}), /Not a model link/);

  // --- A file renamed by hand keeps its name when profiles are renamed after the site ---
  assert.strictEqual(siteDetails.renameProfileFiles(), 0);
  assert.ok(fs.existsSync(renamed.filePath));
  database.db.prepare('UPDATE site_files SET named_by_user = 0').run();
  assert.strictEqual(siteDetails.renameProfileFiles(), 1, 'without the mark it would have been renamed after the site');

  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('model-edit tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
