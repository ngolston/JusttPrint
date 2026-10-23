#!/usr/bin/env node
'use strict';

// Groups become merged models, once (src/core/groups-to-merges.js).

const assert = require('assert');
const Database = require('better-sqlite3');
const { groupsToMerges } = require('../src/core/groups-to-merges');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, parentModel TEXT, title TEXT, description TEXT, partOf INTEGER);
  CREATE TABLE model_groups (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, description TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE model_group_members (model_id INTEGER PRIMARY KEY, group_id INTEGER);
`);
const add = (id, fileName, parentModel = null, title = null) =>
  db
    .prepare('INSERT INTO models (id, filePath, fileName, parentModel, title) VALUES (?, ?, ?, ?, ?)')
    .run(id, `/lib/${fileName}`, fileName, parentModel, title);

// Robot: a top group with a group inside it.
db.prepare("INSERT INTO model_groups (id, name, parent_id, description) VALUES (1, 'Robot', NULL, 'A robot kit')").run();
db.prepare("INSERT INTO model_groups (id, name, parent_id, description) VALUES (2, 'Arms', 1, '')").run();
add(10, 'leg.stl', 'Robot');
add(11, 'arm.stl', 'Robot');
add(12, 'body.3mf', 'Robot', 'Mine');
db.prepare('INSERT INTO model_group_members (model_id, group_id) VALUES (10, 1), (11, 2), (12, 1)').run();
// A model already merged into one outside the group stays there.
add(20, 'other.stl');
add(13, 'head.stl', 'Robot');
db.prepare('INSERT INTO model_group_members (model_id, group_id) VALUES (13, 1)').run();
db.prepare('UPDATE models SET partOf = 20 WHERE id = 13').run();
// A group name only in parentModel (no member row).
add(30, 'b.stl', 'Vase');
add(31, 'a.stl', 'Vase');
// One model alone in a group: it takes the name.
db.prepare("INSERT INTO model_groups (id, name, parent_id, description) VALUES (3, 'Solo', NULL, 'Just one')").run();
add(40, 'solo.stl', 'Solo');
db.prepare('INSERT INTO model_group_members (model_id, group_id) VALUES (40, 3)').run();
add(50, 'loose.stl');

const result = groupsToMerges(db);
const row = (id) => db.prepare('SELECT partOf, parentModel, title, description FROM models WHERE id = ?').get(id);

assert.deepStrictEqual(result, { merged: 3, groups: 3 });
// Robot: arm.stl is first by name, so the others (the inner group's too) are merged into it.
assert.strictEqual(row(11).partOf, null, 'the first by name is the main model');
assert.strictEqual(row(10).partOf, 11);
assert.strictEqual(row(12).partOf, 11);
assert.strictEqual(row(11).title, 'Robot', 'the main model takes the group name as its Title');
assert.strictEqual(row(11).description, 'A robot kit', "and the group's description");
assert.strictEqual(row(12).title, 'Mine', 'a merged model keeps its own Title');
assert.strictEqual(row(13).partOf, 20, 'a model merged elsewhere stays there');
assert.strictEqual(row(30).partOf, 31, 'a group known only by name is merged too');
assert.strictEqual(row(40).partOf, null);
assert.strictEqual(row(40).title, 'Solo');
assert.strictEqual(row(50).partOf, null, 'models in no group are left alone');
assert.ok(
  [10, 11, 12, 13, 30, 31, 40].every((id) => row(id).parentModel === null),
  'parentModel is cleared'
);
assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('model_groups', 'model_group_members')").get(), 'the group tables are gone');
assert.deepStrictEqual(groupsToMerges(db), { merged: 0, groups: 0 }, 'once only');
console.log('ok groups become merged models, once');
