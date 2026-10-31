'use strict';

// Folders as models (src/core/folder-models.js), a 3MF's plates (src/server/threemf-plates.js) and kit progress (src/server/kits.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');
const database = require('../src/core/database');
const { platesFrom, readPlates } = require('../src/server/threemf-plates');
const folders = require('../src/core/folder-models');

const MODEL_SETTINGS = `<?xml version="1.0"?><config>
<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Legs &amp; arms"/></plate>
<plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value=""/></plate>
<plate><metadata key="plater_id" value="3"/><metadata key="plater_name" value="Head"/></plate>
</config>`;
const SLICE_INFO = `<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="3600"/><metadata key="weight" value="42.25"/></plate></config>`;

async function main() {
  // --- Plates ---
  assert.deepStrictEqual(platesFrom({ entryNames: ['Metadata/plate_1.png'] }), [], 'one plate is not a kit');
  assert.deepStrictEqual(
    platesFrom({ sliceInfo: '<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="5400"/></plate></config>' }, { single: true }),
    [{ index: 1, name: null, seconds: 5400, grams: null }],
    'with single: the one plate, for its print time (10.2)'
  );
  assert.deepStrictEqual(
    platesFrom({ entryNames: ['Metadata/plate_1.png', 'Metadata/plate_2.png', 'Metadata/plate_3.png'], modelSettings: MODEL_SETTINGS, sliceInfo: SLICE_INFO }),
    [
      { index: 1, name: 'Legs & arms', seconds: 3600, grams: 42.3 },
      { index: 2, name: null, seconds: null, grams: null },
      { index: 3, name: 'Head', seconds: null, grams: null }
    ]
  );

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-kits-')));
  const kitDir = path.join(tmp, 'Voltron');
  fs.mkdirSync(kitDir);
  fs.mkdirSync(path.join(kitDir, 'extras'));
  const threeMf = path.join(kitDir, 'Voltron.3mf');
  fs.writeFileSync(
    threeMf,
    Buffer.from(
      zipSync({
        '3D/3dmodel.model': strToU8('<model/>'),
        'Metadata/plate_1.png': strToU8('x'),
        'Metadata/plate_2.png': strToU8('x'),
        'Metadata/plate_3.png': strToU8('x'),
        'Metadata/model_settings.config': strToU8(MODEL_SETTINGS),
        'Metadata/slice_info.config': strToU8(SLICE_INFO)
      })
    )
  );
  assert.strictEqual((await readPlates(threeMf)).length, 3);
  assert.deepStrictEqual(await readPlates(path.join(kitDir, 'nope.stl')), []);

  database.db = new Database(path.join(tmp, 'test.db'));
  database.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, size INTEGER, designer TEXT, license TEXT, source TEXT, parentModel TEXT, title TEXT,
      rating INTEGER, favorite INTEGER, print_status TEXT, print_count INTEGER, printed INTEGER, dateAdded TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER);
  `);
  const add = (filePath, extra = {}) =>
    Number(
      database.db
        .prepare('INSERT INTO models (filePath, fileName, size, designer, dateAdded) VALUES (?, ?, ?, ?, ?)')
        .run(filePath, path.basename(filePath), extra.size || 10, extra.designer || null, extra.dateAdded || null).lastInsertRowid
    );
  const kitId = add(threeMf, { designer: '3dwb', dateAdded: '2026-10-01' });
  fs.writeFileSync(path.join(kitDir, 'Sword.stl'), 'solid x');
  const swordId = add(path.join(kitDir, 'Sword.stl'), { designer: '3dwb', dateAdded: '2026-09-01' });
  add(path.join(kitDir, 'extras', 'Stand.stl'));
  add(`${kitDir}${path.sep}pack.zip::inner.stl`);
  database.db.prepare("INSERT INTO tags VALUES (1, 'robot')").run();
  database.db.prepare('INSERT INTO model_tags VALUES (?, 1), (?, 1)').run(kitId, swordId);

  // --- A folder as a model ---
  const folder = folders.getFolder(database.db, `${kitDir}${path.sep}`);
  assert.deepStrictEqual(
    folder.files.map((f) => f.fileName),
    ['Sword.stl', 'Voltron.3mf'],
    'only the files directly in it, not subfolders or ZIP entries'
  );
  assert.deepStrictEqual(folder.designers, ['3dwb']);
  assert.deepStrictEqual(folder.tags, ['robot']);
  assert.strictEqual(folder.added, '2026-09-01');
  assert.strictEqual(folder.size, 20);
  folders.saveFolderNotes(database.db, kitDir, 'Glue the head last.');
  assert.strictEqual(folders.getFolder(database.db, kitDir).notes, 'Glue the head last.');
  assert.strictEqual(folders.getFolder(database.db, path.join(tmp, 'empty')), null);

  // --- Assembly view: a folder's layout, checked ---
  assert.strictEqual(folders.getAssembly(database.db, kitDir), null);
  const saved = folders.saveAssembly(database.db, `${kitDir}${path.sep}`, {
    layout: 'laid-out',
    poses: {
      [kitId]: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
      [swordId]: { position: [1, 'x', 3], quaternion: [0, 0, 0, 1] },
      evil: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }
    }
  });
  assert.deepStrictEqual(saved, { layout: 'laid-out', poses: { [kitId]: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] } } });
  assert.deepStrictEqual(folders.getAssembly(database.db, kitDir), saved);
  assert.strictEqual(folders.saveAssembly(database.db, kitDir, { layout: 'sideways', poses: null }).layout, 'designed');
  folders.saveAssembly(database.db, kitDir, null);
  assert.strictEqual(folders.getAssembly(database.db, kitDir), null);

  // --- Kit progress ---
  const kits = require('../src/server/kits');
  const kit = await kits.getKit(kitDir);
  assert.strictEqual(kit.kind, 'folder');
  assert.deepStrictEqual(
    kit.parts.map((p) => p.label),
    ['Sword', 'Voltron · Legs & arms', 'Voltron · Plate 2', 'Voltron · Head']
  );
  assert.strictEqual(kit.parts[1].seconds, 3600);
  assert.strictEqual(kit.done, 0);
  kits.setPart(threeMf, 2, true, 'ace');
  assert.strictEqual((await kits.getKit(kitDir)).done, 1);
  const one = await kits.getKit(threeMf);
  assert.strictEqual(one.kind, 'file');
  assert.deepStrictEqual(
    one.parts.map((p) => [p.label, p.done, p.doneBy]),
    [
      ['Legs & arms', false, null],
      ['Plate 2', true, 'ace'],
      ['Head', false, null]
    ]
  );
  kits.setPart(threeMf, 2, false);
  await kits.markPrinted([kitId], 'ace');
  assert.strictEqual((await kits.getKit(threeMf)).done, 3, 'a print logged as Printed ticks every plate');
  assert.deepStrictEqual(await kits.summaries([kitDir, path.join(kitDir, 'extras')]), { [kitDir]: { done: 3, total: 4 } }, 'a one-part folder has no kit');
  assert.throws(() => kits.setPart('/nope.stl', 0, true), /not in the library/);

  // Log Print with only some plates chosen: those are ticked, the others stay as they are.
  for (const plate of [1, 2, 3]) kits.setPart(threeMf, plate, false);
  assert.strictEqual(await kits.markPlates(threeMf, [1, 3, 9]), 2, 'a plate the file does not have is skipped');
  assert.deepStrictEqual(
    (await kits.getKit(threeMf)).parts.map((p) => p.done),
    [true, false, true]
  );
  await kits.markPrinted([kitId], 'ace');

  // Continue your kits: started and not finished, as a folder or as a file with plates.
  assert.deepStrictEqual(
    (await kits.inProgress({ folders: true })).map((k) => [k.kind, k.target, k.name, k.done, k.total]),
    [['folder', kitDir, 'Voltron', 3, 4]]
  );
  assert.deepStrictEqual(await kits.inProgress({ folders: false }), [], 'every plate of the 3MF is ticked');
  kits.setPart(threeMf, 3, false);
  assert.deepStrictEqual(
    (await kits.inProgress({ folders: false })).map((k) => [k.kind, k.target, k.name, k.done, k.total]),
    [['file', threeMf, 'Voltron', 2, 3]]
  );
  kits.setPart(path.join(kitDir, 'Sword.stl'), 0, true);
  kits.setPart(threeMf, 3, true);
  assert.deepStrictEqual(await kits.inProgress({ folders: true }), [], 'a finished kit is not shown');

  // The plates are read once per version of the file.
  assert.ok(database.db.prepare('SELECT 1 FROM model_plates WHERE model_id = ?').get(kitId));
  database.db.prepare('DELETE FROM models WHERE id = ?').run(kitId);
  assert.strictEqual(database.db.prepare('SELECT COUNT(*) AS n FROM kit_done WHERE model_id = ?').get(kitId).n, 0, 'removed with the model');

  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('kits tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
