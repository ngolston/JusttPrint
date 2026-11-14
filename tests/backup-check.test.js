#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3');
const { checkBackupFile, checkBackupFileAsync } = require('../src/core/backup-check');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-backup-check-')));

const results = [];
function test(name, fn) {
  results.push(
    (async () => {
      try {
        await fn();
        console.log('ok ' + name);
      } catch (err) {
        console.error('FAIL ' + name + ':', err.message);
        process.exitCode = 1;
      }
    })()
  );
}

/** A library-like database: a models table and some large rows (thumbnails live in the database). */
function makeLibrary(file, megabytes) {
  const db = new Database(file);
  db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT, thumbnail BLOB)');
  const insert = db.prepare('INSERT INTO models (filePath, thumbnail) VALUES (?, ?)');
  const blob = Buffer.alloc(256 * 1024, 7);
  db.transaction(() => {
    for (let i = 0; i < megabytes * 4; i++) insert.run(`/m/${i}.stl`, blob);
  })();
  db.close();
  return file;
}

/** The message a check fails with, sync or async. */
async function refusal(check, file) {
  try {
    await check(file);
  } catch (error) {
    return error.message;
  }
  return null;
}

const library = makeLibrary(path.join(tmp, 'library.db'), 4);

const damaged = path.join(tmp, 'damaged.db');
fs.copyFileSync(library, damaged);
{
  // Page 2 is the models table's root page; garbage there is what quick_check finds.
  const fd = fs.openSync(damaged, 'r+');
  fs.writeSync(fd, Buffer.alloc(64, 0xab), 0, 64, 4096 + 8);
  fs.closeSync(fd);
}

const notSqlite = path.join(tmp, 'notes.db');
fs.writeFileSync(notSqlite, 'these are not the tables you are looking for\n'.repeat(200));

const noModels = path.join(tmp, 'other-app.db');
{
  const db = new Database(noModels);
  db.exec('CREATE TABLE photos (id INTEGER PRIMARY KEY)');
  db.close();
}

test('checking a backup leaves the main thread free', async () => {
  // The main thread holds a write lock on the file and lets go only from a timer. A check that
  // runs on the main thread waits for the lock while the timer cannot fire: "database is locked".
  const busy = makeLibrary(path.join(tmp, 'busy.db'), 4);
  const writer = new Database(busy);
  writer.exec('BEGIN EXCLUSIVE');
  const release = setTimeout(() => writer.exec('COMMIT'), 300);
  try {
    await checkBackupFileAsync(busy);
  } finally {
    clearTimeout(release);
    if (writer.inTransaction) writer.exec('COMMIT');
    writer.close();
  }
});

test('a good backup passes both checks', async () => {
  checkBackupFile(library);
  await checkBackupFileAsync(library);
});

test('damaged, non-SQLite, foreign and missing files are refused with the same message', async () => {
  const missing = path.join(tmp, 'missing.db');
  for (const [file, expected] of [
    [damaged, /^Not a JusttPrint backup: /],
    [notSqlite, /^Not a JusttPrint backup: file is not a database$/],
    [noModels, /^Not a JusttPrint backup: it has no models table$/],
    [missing, /^Not a JusttPrint backup: /]
  ]) {
    const sync = await refusal(checkBackupFile, file);
    const async = await refusal(checkBackupFileAsync, file);
    assert.ok(sync && expected.test(sync), `${path.basename(file)}: ${sync}`);
    assert.ok(async === sync, `${path.basename(file)}: the async check said ${async}`);
  }
});

Promise.all(results).then(() => fs.rmSync(tmp, { recursive: true, force: true }));
