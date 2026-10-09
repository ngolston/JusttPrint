'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const siteFiles = require('../src/server/site-files');
const { importLink } = require('../src/server/link-import');
const { SECRET_SETTING_KEYS } = require('../src/server/server-auth');

const PRINTABLES = 'https://www.printables.com/model/1839122-parametric-laptop-stand';
const THINGIVERSE = 'https://www.thingiverse.com/thing:7418273';

async function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-site-files-')));
  const library = path.join(tmp, 'library');
  fs.mkdirSync(library);
  database.db = new Database(path.join(tmp, 'test.db'));
  database.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, designer TEXT, license TEXT, source TEXT, notes TEXT,
      rating INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0, print_status TEXT DEFAULT 'unprinted', printed INTEGER, print_count INTEGER DEFAULT 0, last_printed_at TEXT, thumbnail TEXT);
    CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER, PRIMARY KEY (model_id, tag_id));`);
  database.db.prepare("INSERT INTO settings (key, value) VALUES ('stlHomeDirectories', ?)").run(JSON.stringify([library]));
  require('../src/server/stl-home').scanUploadedFolder = async (folder) => {
    for (const name of fs.readdirSync(folder)) {
      database.db.prepare("INSERT OR IGNORE INTO models (filePath, fileName, designer) VALUES (?, ?, 'Unknown')").run(path.join(folder, name), name);
    }
    return 0;
  };
  siteFiles.setFileGap(0);
  assert.ok(SECRET_SETTING_KEYS.has('thingiverseToken'), 'the token is never readable through the settings API');

  const calls = [];
  let fileHost = 'files.printables.com';
  const json = (value, init) => new Response(JSON.stringify(value), init);
  const web = async (url, options = {}) => {
    const u = new URL(url);
    calls.push(`${u.hostname}${u.pathname}`);
    if (u.hostname === 'api.printables.com') {
      const { query, variables } = JSON.parse(options.body);
      if (/print\(id/.test(query) && /stls/.test(query)) {
        return json({ data: { print: {
          stls: [{ id: '1', name: 'Main Parts.stl', fileSize: 300 }, { id: '2', name: 'Stand.shapr', fileSize: 100 }],
          gcodes: [{ id: '3', name: 'MK4 0.2mm.gcode', fileSize: 900 }], slas: [], otherFiles: [{ id: '4', name: 'Pins.step', fileSize: 50 }]
        } } });
      }
      if (/print\(id/.test(query)) {
        return json({ data: { print: { id: '1839122', name: 'Parametric Laptop Stand', user: { publicUsername: 'Shapr3D' }, image: null, license: { name: 'CC BY' } } } });
      }
      if (/getDownloadLink/.test(query)) {
        if (variables.id === '9') return json({ data: { getDownloadLink: { ok: false, errors: [{ messages: ['files_cannot_be_downloaded'] }] } } });
        return json({ data: { getDownloadLink: { ok: true, output: { link: `https://${fileHost}/media/${variables.id}?sig=x` } } } });
      }
    }
    if (u.hostname === 'files.printables.com') return new Response(`solid file ${u.pathname}\nendsolid`);
    if (u.hostname === 'www.thingiverse.com') return new Response('<meta property="og:url" content="https://www.thingiverse.com/thing:7418273"><meta property="og:title" content="Prowling Bear by LennyFace">');
    if (u.hostname === 'api.thingiverse.com') {
      if (options.headers.authorization !== 'Bearer good-token-1234567890') return new Response('{}', { status: 401 });
      if (u.pathname === '/users/me') return json({ name: 'me' });
      if (u.pathname === '/things/7418273/files') return json([{ id: 11, name: 'bear.stl', size: 1000 }, { id: 12, name: 'readme.txt', size: 10 }]);
      if (u.pathname === '/files/11/download') return new Response(null, { status: 302, headers: { location: 'https://cdn.thingiverse.com/assets/bear.stl' } });
    }
    if (u.hostname === 'cdn.thingiverse.com') return new Response('solid bear\nendsolid');
    throw new Error(`unexpected fetch ${url}`);
  };

  // --- Printables: listing, ticks, download ---
  const files = await siteFiles.listFiles(PRINTABLES, web);
  assert.deepStrictEqual(files.map((f) => [f.name, f.kind, f.model]), [
    ['Main Parts.stl', 'stl', true], ['Stand.shapr', 'stl', false], ['Pins.step', 'other', true], ['MK4 0.2mm.gcode', 'gcode', false]
  ], 'model files are ticked; project files and G-code are not');

  const online = database.db.prepare("INSERT INTO models (filePath, fileName, source, notes) VALUES ('url::https://www.printables.com/model/1839122', 'Parametric Laptop Stand', 'https://www.printables.com/model/1839122', 'my notes')").run().lastInsertRowid;
  const result = await siteFiles.downloadFiles({ url: PRINTABLES, folder: library }, { fetchImpl: web });
  const folder = path.join(library, 'Parametric Laptop Stand');
  assert.strictEqual(result.folder, folder);
  assert.deepStrictEqual(result.saved.sort(), ['Main Parts.stl', 'Pins.step'].sort(), 'the model files when none were chosen');
  assert.deepStrictEqual(fs.readdirSync(folder).sort(), ['Main Parts.stl', 'Pins.step'].sort());
  assert.ok(!database.db.prepare('SELECT 1 FROM models WHERE id = ?').get(online), 'the online model became the files');
  const part = database.db.prepare('SELECT designer, license, source, notes FROM models WHERE filePath = ?').get(path.join(folder, 'Main Parts.stl'));
  assert.deepStrictEqual({ ...part }, { designer: 'Shapr3D', license: 'CC BY', source: 'https://www.printables.com/model/1839122', notes: 'my notes' });

  const more = await siteFiles.downloadFiles({ url: PRINTABLES, folder: library, fileIds: ['1', '3'] }, { fetchImpl: web });
  assert.deepStrictEqual([more.folder, more.saved], [folder, ['MK4 0.2mm.gcode']], 'the same folder; files already there are skipped');
  await assert.rejects(siteFiles.downloadFiles({ url: PRINTABLES, folder: library, fileIds: [] }, { fetchImpl: web }), /Choose the files/);

  // One file: named after the model.
  database.db.prepare('DELETE FROM site_files').run();
  const single = await siteFiles.downloadFiles({ url: PRINTABLES, folder: library, fileIds: ['1'] }, { fetchImpl: web });
  assert.deepStrictEqual(single.saved, ['Parametric Laptop Stand.stl'], 'a single file is named after the model');
  assert.strictEqual(path.basename(single.mainFile), 'Parametric Laptop Stand.stl');

  database.db.prepare('DELETE FROM site_files').run();
  fileHost = 'evil.example';
  await assert.rejects(siteFiles.downloadFiles({ url: PRINTABLES, folder: library, fileIds: ['1'] }, { fetchImpl: web }), /does not download from \(evil\.example\)/);
  assert.ok(!fs.existsSync(path.join(library, 'Parametric Laptop Stand (3)')), 'a failed download leaves no empty folder');
  fileHost = 'files.printables.com';
  await assert.rejects(siteFiles.downloadFiles({ url: PRINTABLES, folder: '/etc' }, { fetchImpl: web }), /outside|cannot|library/i);

  // --- Thingiverse: needs a token ---
  await assert.rejects(siteFiles.listFiles(THINGIVERSE, web), (error) => error.code === 'THINGIVERSE_TOKEN');
  assert.deepStrictEqual(siteFiles.tokenStatus(), { hasToken: false });
  await assert.rejects(siteFiles.setToken('bad-token-1234567890', web), /did not accept/);
  await assert.rejects(siteFiles.setToken('x y', web), /does not look like/);
  assert.deepStrictEqual(await siteFiles.setToken('good-token-1234567890', web), { hasToken: true });
  assert.ok(!JSON.stringify(siteFiles.tokenStatus()).includes('good-token'), 'the status never carries the token');
  const tv = await siteFiles.listFiles(THINGIVERSE, web);
  assert.deepStrictEqual(tv.map((f) => [f.name, f.model]), [['bear.stl', true], ['readme.txt', false]]);
  const bear = await siteFiles.downloadFiles({ url: THINGIVERSE, folder: library }, { fetchImpl: web });
  assert.deepStrictEqual(bear.saved, ['Prowling Bear.stl'], 'downloaded through the redirect to its file server');
  assert.strictEqual(fs.readFileSync(path.join(bear.folder, 'Prowling Bear.stl'), 'utf8'), 'solid bear\nendsolid');

  // --- Add Links: online models get their files; failures keep the online model ---
  database.db.prepare('DELETE FROM models').run();
  database.db.prepare('DELETE FROM site_files').run();
  const deps = { db: database.db, fetchImpl: web, downloadFiles: (request, options) => siteFiles.downloadFiles(request, { ...options, fetchImpl: web }),
    saveModel: async (model) => database.db.prepare('INSERT INTO models (filePath, fileName, designer, source) VALUES (?, ?, ?, ?)').run(model.filePath, model.fileName, model.designer || null, model.source),
    saveThumbnail: async () => {} };
  assert.strictEqual((await importLink(PRINTABLES, deps)).status, 'added', 'without a folder: an online model');
  const again = await importLink(PRINTABLES, deps, { downloadFolder: library, fileIds: ['1'] });
  assert.strictEqual(again.status, 'downloaded', 'an online model in the library still gets its files');
  assert.strictEqual(database.db.prepare("SELECT COUNT(*) AS n FROM models WHERE filePath LIKE 'url::%'").get().n, 0);
  assert.strictEqual((await importLink(PRINTABLES, deps, { downloadFolder: library })).status, 'exists', 'files in the library: nothing to do');
  database.db.prepare('DELETE FROM models').run();
  database.db.prepare('DELETE FROM site_files').run();
  await siteFiles.setToken('', web);
  const noToken = await importLink(THINGIVERSE, deps, { downloadFolder: library });
  assert.strictEqual(noToken.status, 'added');
  assert.match(noToken.warning, /Not downloaded: Thingiverse needs an API token.*Added as an online model/);
  const stillNoToken = await importLink(THINGIVERSE, deps, { downloadFolder: library });
  assert.strictEqual(stillNoToken.status, 'exists');
  assert.match(stillNoToken.warning, /The online model stays/);
  assert.strictEqual((await importLink(THINGIVERSE, deps, { downloadFolder: library, fileIds: [] })).status, 'exists', 'none ticked: nothing downloaded');

  assert.ok(calls.every((c) => /^(api\.printables\.com|files\.printables\.com|www\.thingiverse\.com|api\.thingiverse\.com|cdn\.thingiverse\.com|evil\.example)\//.test(c)), calls.join('\n'));
  assert.strictEqual(siteFiles.plainName('../../etc/passwd', 'x'), 'passwd');

  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('site-files tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
