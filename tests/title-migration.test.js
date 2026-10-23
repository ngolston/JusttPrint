#!/usr/bin/env node
'use strict';

// 8.0: the Title replaces Parent Model (src/core/db-init.js migrateTitleColumn). A 7.x database
// gets a title column with every Parent Model copied into it; settings that named Parent Model
// name Title; the parentModel column stays, so 7.x can still open the file (emptied since groups
// went in 8.11: groups-to-merges.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-title-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
process.env.JUSTTPRINT_USER_DATA = tmp;
const database = require('../src/core/database');
const { initializeDatabase } = require('../src/core/db-init');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

try {
  // A 7.x database: no title column, Parent Model values, the old settings and history.
  initializeDatabase();
  const db = database.db;
  db.exec('DROP INDEX IF EXISTS idx_models_title; ALTER TABLE models DROP COLUMN title;');
  db.prepare("DELETE FROM settings WHERE key IN ('titleFromParentModel', 'enable3MFTitle', 'titleWithoutExtension')").run();
  const save = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  save.run('enable3MFParentModel', '0');
  save.run('organizeLibraryLayers', JSON.stringify(['designer', 'parentModel']));
  db.exec(
    'CREATE TABLE IF NOT EXISTS model_changes (id INTEGER PRIMARY KEY, model_id INTEGER, field TEXT, old_value TEXT, new_value TEXT, changed_at TEXT, changed_by TEXT)'
  );
  const add = db.prepare('INSERT INTO models (filePath, fileName, parentModel) VALUES (?, ?, ?)');
  const dragon = add.run('/lib/dragon.3mf', 'dragon.3mf', '  Articulated Dragon.3mf ').lastInsertRowid;
  const plain = add.run('/lib/cube.stl', 'cube.stl', null).lastInsertRowid;
  db.prepare("INSERT INTO model_changes (model_id, field, old_value, new_value, changed_at) VALUES (?, 'parentModel', NULL, 'Dragon', 'now')").run(dragon);
  db.close();

  initializeDatabase();
  const after = database.db;
  test('every Parent Model is copied to the Title; the old column stays, emptied', () => {
    const row = after.prepare('SELECT title, parentModel FROM models WHERE id = ?').get(dragon);
    assert.strictEqual(row.title, 'Articulated Dragon', 'copied, without the file extension');
    assert.strictEqual(row.parentModel, null, 'groups are gone (8.11): the group name is cleared');
    assert.strictEqual(after.prepare('SELECT title FROM models WHERE id = ?').get(plain).title, null);
  });
  test('the settings that named Parent Model name Title', () => {
    const value = (key) => (after.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value;
    assert.strictEqual(value('enable3MFTitle'), '0', 'the 3MF checkbox keeps its choice');
    assert.deepStrictEqual(JSON.parse(value('organizeLibraryLayers')), ['designer', 'title']);
  });
  test('History shows Parent Model changes as Title changes', () => {
    assert.strictEqual(after.prepare('SELECT field FROM model_changes WHERE model_id = ?').get(dragon).field, 'title');
  });
  test('once: a Title cleared later is not filled again', () => {
    after.prepare('UPDATE models SET title = NULL WHERE id = ?').run(dragon);
    after.close();
    initializeDatabase();
    assert.strictEqual(database.db.prepare('SELECT title FROM models WHERE id = ?').get(dragon).title, null);
  });
} finally {
  try {
    database.db.close();
  } catch (_) {
    /* closed */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
