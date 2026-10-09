'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');
const database = require('../src/core/database');
const job = require('../src/server/geometry-job');

const SHAPE = [[[0, 0, 0], [30, 0, 0], [0, 20, 0], [5, 7, 13]], [[40, 2, 1], [52, 4, 0], [45, 15, 3], [47, 6, 9]]];
const faces = (t) => [[t[0], t[2], t[1]], [t[0], t[1], t[3]], [t[1], t[2], t[3]], [t[0], t[3], t[2]]];
const tris = (f, shape = SHAPE) => shape.flatMap((t) => faces(t.map(f)));
function stl(list) {
  const buf = Buffer.alloc(84 + list.length * 50);
  buf.writeUInt32LE(list.length, 80);
  list.forEach((tri, i) => tri.forEach((p, j) => p.forEach((x, k) => buf.writeFloatLE(x, 84 + i * 50 + 12 + j * 12 + k * 4))));
  return buf;
}
function threeMf(list) {
  const verts = [];
  const idx = list.map((tri) => tri.map((p) => verts.push(p) - 1));
  const xml = `<model><resources><object id="1"><mesh><vertices>${verts.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${
    idx.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object></resources></model>`;
  return Buffer.from(zipSync({ '3D/3dmodel.model': strToU8(xml) }));
}
const moved = ([x, y, z]) => [y + 50, -x, z + 3];

async function waitDone() {
  for (let i = 0; i < 200; i++) {
    if (!job.status().running) return job.status();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('fingerprinting did not finish');
}

async function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-geometry-')));
  database.db = new Database(path.join(tmp, 'test.db'));
  database.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, size INTEGER, hash TEXT, designer TEXT, license TEXT, source TEXT, notes TEXT, isNew INTEGER, favorite INTEGER, rating INTEGER)');
  const files = {
    'part.stl': [stl(tris((p) => p)), 'h1'],
    'part copy.stl': [stl(tris((p) => p)), 'h1'],
    'part moved.stl': [stl(tris(moved)), 'h2'],
    'part.3mf': [threeMf(tris(moved)), 'h3'],
    'other.stl': [stl(tris(([x, y, z]) => [x * 2, y, z])), 'h4'],
    'notes.txt': [Buffer.from('x'), 'h5']
  };
  for (const [name, [bytes, hash]] of Object.entries(files)) {
    fs.writeFileSync(path.join(tmp, name), bytes);
    database.db.prepare('INSERT INTO models (filePath, fileName, size, hash) VALUES (?, ?, ?, ?)').run(path.join(tmp, name), name, bytes.length, hash);
  }
  database.db.prepare("INSERT INTO models (filePath, fileName) VALUES ('url::https://www.printables.com/model/1', 'online')").run();
  // The same part inside a ZIP file.
  fs.writeFileSync(path.join(tmp, 'parts.zip'), Buffer.from(zipSync({ 'inner/part.stl': new Uint8Array(stl(tris(moved))) })));
  database.db.prepare("INSERT INTO models (filePath, fileName, hash) VALUES (?, 'part.stl', 'h6')").run(`${path.join(tmp, 'parts.zip')}::inner/part.stl`);

  assert.strictEqual(job.missing().length, 6, 'STL and 3MF files, also inside a ZIP; not online models');
  assert.ok(job.start().started);
  assert.ok(job.start().alreadyRunning, 'one run at a time');
  const done = await waitDone();
  assert.deepStrictEqual([done.processed, done.total, done.failed], [6, 6, 0]);
  assert.strictEqual(job.missing().length, 0, 'kept until the file changes');

  const { groups, missing } = job.duplicates();
  assert.strictEqual(missing, 0);
  assert.strictEqual(groups.length, 1, JSON.stringify(groups));
  assert.deepStrictEqual(groups[0].files.map((f) => f.filePath.replace(`${tmp}/`, '')).sort(),
    ['part copy.stl', 'part moved.stl', 'part.3mf', 'part.stl', 'parts.zip::inner/part.stl'].sort(),
    'moved, re-saved, as 3MF and inside a ZIP: the same model; the other one is not');
  assert.ok(!job.duplicates(null, { includeZip: false }).groups[0].files.some((f) => f.filePath.includes('::')), 'without ZIP files, the entry is left out');
  assert.ok(groups[0].hash.startsWith('geometry:'));

  // Two identical files only: already on the identical-files list.
  database.db.prepare("DELETE FROM models WHERE fileName IN ('part moved.stl', 'part.3mf') OR filePath LIKE '%::%'").run();
  assert.strictEqual(job.duplicates().groups.length, 0);

  // A changed file is fingerprinted again.
  fs.writeFileSync(path.join(tmp, 'other.stl'), stl(tris((p) => p)));
  fs.utimesSync(path.join(tmp, 'other.stl'), new Date(), new Date(Date.now() + 5000));
  assert.deepStrictEqual(job.missing().map((row) => path.basename(row.filePath)), ['other.stl']);
  job.start();
  await waitDone();
  database.db.prepare("UPDATE models SET hash = 'h9' WHERE fileName = 'other.stl'").run();
  assert.deepStrictEqual(job.duplicates().groups[0].files.map((f) => f.fileName).sort(), ['other.stl', 'part copy.stl', 'part.stl'].sort());

  // A broken file fails without stopping the rest.
  fs.writeFileSync(path.join(tmp, 'broken.stl'), Buffer.from('solid nothing here'));
  database.db.prepare("INSERT INTO models (filePath, fileName, hash) VALUES (?, 'broken.stl', 'h8')").run(path.join(tmp, 'broken.stl'));
  job.start();
  const afterBroken = await waitDone();
  assert.deepStrictEqual([afterBroken.processed, afterBroken.failed], [1, 1]);

  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('geometry-job tests passed');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
