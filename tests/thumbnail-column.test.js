#!/usr/bin/env node
'use strict';

// Pictures last in the models table, with their flags (src/core/thumbnail-column.js).

const assert = require('assert');
const Database = require('better-sqlite3');
const { ensureThumbnailLast, columnDefinitions } = require('../src/core/thumbnail-column');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

/** A database laid out as before 9.7: thumbnail in the middle, its index, triggers, a tag table. */
function oldLibrary() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filePath TEXT UNIQUE,
      fileName TEXT,
      thumbnail TEXT,
      title TEXT,
      print_status TEXT DEFAULT 'unprinted'
    );
    ALTER TABLE models ADD COLUMN rating INTEGER DEFAULT 0;
    CREATE INDEX idx_models_title ON models(title);
    CREATE INDEX idx_models_thumbnail ON models(thumbnail);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER, FOREIGN KEY(model_id) REFERENCES models(id), PRIMARY KEY(model_id, tag_id));
    CREATE TABLE removed (model_id INTEGER);
    CREATE TRIGGER models_removed AFTER DELETE ON models BEGIN INSERT INTO removed (model_id) VALUES (OLD.id); END;
  `);
  const add = db.prepare('INSERT INTO models (filePath, fileName, thumbnail, title, rating) VALUES (?, ?, ?, ?, ?)');
  add.run('/a.stl', 'a.stl', 'data:image/png;base64,AAAA', 'Alpha', 5);
  add.run('/b.stl', 'b.stl', 'data:image/png;base64,BBBB::data:image/png;base64,CCCC', 'Beta', 0);
  add.run('/c.stl', 'c.stl', '3d.png', null, 1);
  add.run('/d.stl', 'd.stl', null, 'Delta', 2);
  db.prepare('DELETE FROM models WHERE filePath = ?').run('/d.stl'); // the counter stays at 4
  db.exec("INSERT INTO tags (id, name) VALUES (1, 'robot'); INSERT INTO model_tags VALUES (1, 1);");
  return db;
}

const columnNames = (db) =>
  db
    .prepare('PRAGMA table_info(models)')
    .all()
    .map((c) => c.name);

test('the column definitions split at top-level commas only', () => {
  assert.deepStrictEqual(columnDefinitions("CREATE TABLE t (a TEXT DEFAULT 'x,y', b NUMERIC(10, 2), UNIQUE(a, b))"), [
    "a TEXT DEFAULT 'x,y'",
    'b NUMERIC(10, 2)',
    'UNIQUE(a, b)'
  ]);
});

test('the table is rebuilt with the pictures last, the flags set, and everything else kept', () => {
  const db = oldLibrary();
  assert.strictEqual(ensureThumbnailLast(db, { log: () => {} }), 'rebuilt');
  const names = columnNames(db);
  assert.strictEqual(names[names.length - 1], 'thumbnail');
  assert.deepStrictEqual(names, ['id', 'filePath', 'fileName', 'title', 'print_status', 'rating', 'has_thumb', 'multi_thumb', 'thumbnail']);
  const rows = db.prepare('SELECT filePath, title, rating, has_thumb, multi_thumb, thumbnail FROM models ORDER BY id').all();
  assert.deepStrictEqual(
    rows.map((r) => [r.filePath, r.has_thumb, r.multi_thumb]),
    [
      ['/a.stl', 1, 0],
      ['/b.stl', 1, 1],
      ['/c.stl', 0, 0]
    ]
  );
  assert.strictEqual(rows[1].thumbnail, 'data:image/png;base64,BBBB::data:image/png;base64,CCCC');
  assert.strictEqual(rows[0].title, 'Alpha');
  const objects = db
    .prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'models' AND type IN ('index', 'trigger')")
    .all()
    .map((r) => r.name);
  assert.ok(objects.includes('idx_models_title') && objects.includes('models_removed'), objects.join(', '));
  assert.ok(!objects.includes('idx_models_thumbnail'), 'the index holding a copy of every picture is gone');
  assert.throws(() => db.prepare('INSERT INTO models (filePath) VALUES (?)').run('/a.stl'), /UNIQUE/, 'filePath stays unique');
  const next = db.prepare('INSERT INTO models (filePath) VALUES (?)').run('/e.stl').lastInsertRowid;
  assert.strictEqual(Number(next), 5, 'ids keep counting from before (a deleted id is not reused)');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM model_tags WHERE model_id = 1').get().n, 1, 'tags keep their models');
  db.prepare('DELETE FROM models WHERE filePath = ?').run('/e.stl');
  assert.ok(db.prepare('SELECT 1 FROM removed WHERE model_id = 5').get(), 'the triggers on models still run');
});

test('the flags follow every insert and picture change', () => {
  const db = oldLibrary();
  ensureThumbnailLast(db, { log: () => {} });
  const flags = (filePath) => db.prepare('SELECT has_thumb AS h, multi_thumb AS m FROM models WHERE filePath = ?').get(filePath);
  db.prepare('INSERT INTO models (filePath, thumbnail) VALUES (?, ?)').run('/new.stl', 'data:image/png;base64,X::data:image/png;base64,Y');
  assert.deepStrictEqual(flags('/new.stl'), { h: 1, m: 1 });
  db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run('data:image/png;base64,X', '/new.stl');
  assert.deepStrictEqual(flags('/new.stl'), { h: 1, m: 0 });
  db.prepare('UPDATE models SET thumbnail = NULL WHERE filePath = ?').run('/new.stl');
  assert.deepStrictEqual(flags('/new.stl'), { h: 0, m: 0 });
  db.prepare("UPDATE models SET thumbnail = '3d.png' WHERE filePath = ?").run('/new.stl');
  assert.deepStrictEqual(flags('/new.stl'), { h: 0, m: 0 });
});

test('a table already in shape is left alone; a column added later puts it back in shape', () => {
  const db = oldLibrary();
  ensureThumbnailLast(db, { log: () => {} });
  assert.strictEqual(ensureThumbnailLast(db, { log: () => {} }), 'ok');
  db.exec('ALTER TABLE models ADD COLUMN later TEXT');
  assert.strictEqual(ensureThumbnailLast(db, { log: () => {} }), 'rebuilt');
  const names = columnNames(db);
  assert.strictEqual(names[names.length - 1], 'thumbnail');
  assert.ok(names.includes('later'));
});

test('without free disk space it adds the flags (and their triggers) instead of rebuilding', () => {
  const db = oldLibrary();
  const messages = [];
  assert.strictEqual(ensureThumbnailLast(db, { log: (m) => messages.push(m), freeBytes: 0 }), 'skipped');
  assert.match(messages.join(' '), /Not enough free disk space/);
  assert.deepStrictEqual(db.prepare("SELECT has_thumb AS h, multi_thumb AS m FROM models WHERE filePath = '/b.stl'").get(), { h: 1, m: 1 });
  db.prepare('UPDATE models SET thumbnail = NULL WHERE filePath = ?').run('/b.stl');
  assert.strictEqual(db.prepare("SELECT has_thumb FROM models WHERE filePath = '/b.stl'").get().has_thumb, 0);
});
