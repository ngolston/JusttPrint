#!/usr/bin/env node
'use strict';

// Finding the models without a grid copy must not read every picture: it blocks the whole server.
const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const grid = require('../src/server/grid-thumbnails');

const big = (tag) => `data:image/png;base64,${tag}${'A'.repeat(grid.SMALL_ENOUGH_CHARS + 1000)}`;
const small = 'data:image/png;base64,iVBORw0KGgo=';

database.db = new Database(':memory:');
database.db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, thumbnail TEXT)');
const add = database.db.prepare('INSERT INTO models (filePath, thumbnail) VALUES (?, ?)');
add.run('/lib/large-no-copy.stl', `${big('a')}::${small}`);
add.run('/lib/small.stl', small);
add.run('/lib/no-picture.stl', null);
add.run('/lib/placeholder.stl', '3d.png');
add.run('/lib/long-path.stl', 'x'.repeat(grid.SMALL_ENOUGH_CHARS + 10)); // large, but not a data URL
const withCopy = add.run('/lib/large-with-copy.stl', big('b')).lastInsertRowid;
grid._internal.table().prepare('INSERT INTO grid_thumbnails (model_id, data_url, source_chars, made_at) VALUES (?, ?, ?, ?)').run(withCopy, small, 1, 'now');

// The same result as the query it replaces.
const before = database.db
  .prepare(
    `SELECT m.id, m.filePath FROM models m LEFT JOIN grid_thumbnails g ON g.model_id = m.id
     WHERE g.model_id IS NULL AND m.thumbnail LIKE 'data:image%' AND octet_length(m.thumbnail) > ?
     ORDER BY m.id`
  )
  .all(grid.SMALL_ENOUGH_CHARS);
assert.deepStrictEqual(grid._internal.missing(), before);
assert.deepStrictEqual(
  before.map((m) => m.filePath),
  ['/lib/large-no-copy.stl']
);

// The pass over every model does not touch the pictures' column.
assert.ok(!/\bthumbnail\b/i.test(grid._internal.MISSING_IDS_SQL), grid._internal.MISSING_IDS_SQL);

console.log('ok models without a grid copy are found without reading every picture');
