#!/usr/bin/env node
'use strict';

// The library database runs in WAL mode (src/core/db-open.js): readers are not blocked by a
// write, every path that opens or reopens the library keeps it, and the copies the app makes
// (Back Up, automatic backups, the copy kept before a restore, the one at shutdown) are still
// complete.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-db-wal-')));
const dbPath = path.join(tmp, 'data', 'justtprint.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
process.env.JUSTTPRINT_DB_PATH = dbPath;
process.env.JUSTTPRINT_USER_DATA = tmp;
for (const name of ['JUSTTPRINT_AUTO_BACKUP', 'JUSTTPRINT_BACKUP_INTERVAL_HOURS', 'JUSTTPRINT_BACKUP_KEEP', 'JUSTTPRINT_BACKUP_DIR']) delete process.env[name];

const Database = require('better-sqlite3');
const database = require('./database');
const { initializeDatabase } = require('./db-init');
const { checkBackupFile } = require('./backup-check');
const { ipcMain } = require('../server/runtime');
require('../server/ipc/files');
require('../server/ipc/models');
require('../server/ipc/backup');
const autoBackup = require('../server/auto-backup');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const handler = (channel) => ipcMain._handlers.get(channel);
const fromBrowser = { fromNetwork: true };

const journalMode = (db) => db.pragma('journal_mode', { simple: true });
const modeOfFile = (file) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return journalMode(db);
  } finally {
    db.close();
  }
};
const sidecars = (file) => ['-wal', '-shm'].map((suffix) => file + suffix).filter((name) => fs.existsSync(name));
const addModel = (name) => database.db.prepare('INSERT INTO models (filePath, fileName) VALUES (?, ?)').run(`/library/${name}`, name);
const modelNames = (file) => {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT fileName FROM models ORDER BY fileName')
      .all()
      .map((row) => row.fileName);
  } finally {
    db.close();
  }
};
/** Close the library and put the file back in the rollback journal, as a library from before WAL. */
const closeAsOldLibrary = () => {
  database.db.close();
  const old = new Database(dbPath);
  old.pragma('journal_mode = DELETE');
  old.close();
  assert.strictEqual(modeOfFile(dbPath), 'delete');
};

test('a new library opens in WAL mode', () => {
  assert.ok(initializeDatabase(), 'the database opens');
  assert.strictEqual(journalMode(database.db), 'wal');
});

test('a library from before WAL is switched to WAL when it opens', () => {
  closeAsOldLibrary();
  assert.ok(initializeDatabase(), 'the database opens');
  assert.strictEqual(journalMode(database.db), 'wal');
});

test('reading is not blocked while a write is under way', () => {
  addModel('before.stl');
  const reader = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
  try {
    // EXCLUSIVE: in the rollback journal this locks readers out until the commit.
    database.db.exec('BEGIN EXCLUSIVE');
    try {
      addModel('during.stl');
      const names = reader
        .prepare('SELECT fileName FROM models ORDER BY fileName')
        .all()
        .map((row) => row.fileName);
      assert.deepStrictEqual(names, ['before.stl'], 'the reader sees the last commit');
    } finally {
      database.db.exec('COMMIT');
    }
  } finally {
    reader.close();
  }
});

test('Purge Models reopens a closed library in WAL mode', async () => {
  closeAsOldLibrary();
  assert.strictEqual(await handler('purge-models')(fromBrowser), true);
  assert.strictEqual(journalMode(database.db), 'wal');
});

test('clearing the New flags reopens a closed library in WAL mode', async () => {
  closeAsOldLibrary();
  const result = await handler('clear-new-model-flags')(fromBrowser);
  assert.strictEqual(result.success, true);
  assert.strictEqual(journalMode(database.db), 'wal');
});

test('Back Up writes one complete file, with writes not yet checkpointed', async () => {
  addModel('backed-up.stl');
  assert.ok(fs.statSync(`${dbPath}-wal`).size > 0, 'the last write is still in the WAL');
  const result = await handler('backup-database')(fromBrowser);
  assert.strictEqual(result.success, true, result.message);
  assert.strictEqual(modeOfFile(result.filePath), 'delete', 'the copy needs no -wal / -shm to open');
  assert.ok(modelNames(result.filePath).includes('backed-up.stl'));
  checkBackupFile(result.filePath);
  assert.deepStrictEqual(sidecars(result.filePath), [], 'nothing is left next to the copy');
});

test('automatic backups leave only the backup in their folder', async () => {
  addModel('auto.stl');
  const result = await autoBackup.runBackup('manual');
  assert.strictEqual(result.success, true, result.message);
  assert.ok(modelNames(result.backup.path).includes('auto.stl'));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(result.backup.path)), [result.backup.name]);
});

test('a restore keeps the library in WAL mode and the copy before it complete', async () => {
  const backup = await handler('backup-database')(fromBrowser);
  addModel('after-backup.stl');
  const base64 = fs.readFileSync(backup.filePath).toString('base64');
  const result = await handler('restore-database')(fromBrowser, { base64 });
  assert.strictEqual(result.success, true, result.message);
  assert.strictEqual(journalMode(database.db), 'wal');
  assert.ok(!modelNames(dbPath).includes('after-backup.stl'), 'the backup is what is open now');
  assert.ok(modelNames(`${dbPath}.before-restore`).includes('after-backup.stl'), 'the copy before the restore has the last write');
  assert.deepStrictEqual(sidecars(`${dbPath}.restore-upload`), [], 'nothing is left of the checked upload');
});

test('restoring a file that is itself in WAL mode leaves nothing of the upload behind', async () => {
  // As the copy made at shutdown (src/server/app.js): checkpoint, then a plain copy of the file.
  addModel('wal-file.stl');
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  const walFile = path.join(tmp, 'wal-file.db');
  fs.copyFileSync(dbPath, walFile);
  assert.strictEqual(modeOfFile(walFile), 'wal');
  const base64 = fs.readFileSync(walFile).toString('base64');
  const result = await handler('restore-database')(fromBrowser, { base64 });
  assert.strictEqual(result.success, true, result.message);
  assert.ok(modelNames(dbPath).includes('wal-file.stl'));
  assert.strictEqual(journalMode(database.db), 'wal');
  assert.deepStrictEqual(sidecars(`${dbPath}.restore-upload`), [], 'nothing is left of the checked upload');
});

test('the copy kept before a restore has the recent writes while another connection is reading', async () => {
  const backup = await handler('backup-database')(fromBrowser);
  addModel('read-by-outside.stl');
  // Another program reading the library: it holds the WAL, so closing does not empty it.
  const outside = new Database(dbPath, { readonly: true, fileMustExist: true });
  const reading = outside.prepare('SELECT fileName FROM models').iterate();
  try {
    reading.next();
    addModel('recent.stl');
    const base64 = fs.readFileSync(backup.filePath).toString('base64');
    const result = await handler('restore-database')(fromBrowser, { base64 });
    assert.strictEqual(result.success, true, result.message);
    checkBackupFile(`${dbPath}.before-restore`);
    assert.ok(modelNames(`${dbPath}.before-restore`).includes('recent.stl'), 'the copy before the restore has the last write');
    assert.deepStrictEqual(sidecars(`${dbPath}.before-restore`), [], 'the copy is one file');
  } finally {
    reading.return();
    outside.close();
  }
});

test('a restore replaces an old copy kept before a restore that is not a database', async () => {
  const backup = await handler('backup-database')(fromBrowser);
  fs.writeFileSync(`${dbPath}.before-restore`, Buffer.alloc(50 * 1024, 7));
  addModel('over-junk.stl');
  const base64 = fs.readFileSync(backup.filePath).toString('base64');
  const result = await handler('restore-database')(fromBrowser, { base64 });
  assert.strictEqual(result.success, true, result.message);
  assert.ok(modelNames(`${dbPath}.before-restore`).includes('over-junk.stl'), 'the copy before the restore has the last write');
  assert.ok(!fs.existsSync(`${dbPath}.before-restore.partial`), 'no unfinished copy is left');
});

test('a restore that fails before the switch leaves one open library', async () => {
  const backup = await handler('backup-database')(fromBrowser);
  const before = database.db;
  const kept = `${dbPath}.before-restore`;
  fs.rmSync(kept, { force: true });
  fs.mkdirSync(kept); // the copy before the restore cannot be written
  try {
    const base64 = fs.readFileSync(backup.filePath).toString('base64');
    const result = await handler('restore-database')(fromBrowser, { base64 });
    assert.strictEqual(result.success, false);
    assert.ok(!(before.open && database.db !== before), 'no second connection is left open');
    assert.ok(database.db.open);
    assert.strictEqual(journalMode(database.db), 'wal');
  } finally {
    fs.rmSync(kept, { recursive: true, force: true });
  }
});

test('the shutdown copy is only made when the checkpoint has emptied the WAL', () => {
  const { checkpointAndClose } = require('./db-open');
  const file = path.join(tmp, 'shutdown.db');
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    let db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    const outside = new Database(file, { readonly: true });
    const reading = outside.prepare('SELECT x FROM t').iterate();
    reading.next();
    db.exec('INSERT INTO t VALUES (2)');
    assert.strictEqual(checkpointAndClose(db), false, 'a reader holds the WAL');
    assert.ok(!db.open);
    assert.ok(
      warnings.some((line) => /backup_justtprint\.db/.test(line)),
      warnings.join('\n')
    );
    reading.return();
    outside.close();

    db = new Database(file);
    db.exec('INSERT INTO t VALUES (3)');
    assert.strictEqual(checkpointAndClose(db), true);
    assert.ok(!db.open);
    assert.strictEqual(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0, 0, 'everything is in the file');
  } finally {
    console.warn = warn;
  }
});

test('a database that cannot use WAL says so', () => {
  const { openLibraryDatabase } = require('./db-open');
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const db = openLibraryDatabase(':memory:'); // in memory: never WAL
    db.close();
  } finally {
    console.warn = warn;
  }
  assert.ok(
    warnings.some((line) => /WAL/.test(line)),
    warnings.join('\n')
  );
});

test('a restore that fails after closing the library reopens it in WAL mode', async () => {
  const backup = await handler('backup-database')(fromBrowser);
  addModel('kept-after-failure.stl');
  const blocker = `${dbPath}.restore-upload-shm`;
  fs.mkdirSync(path.join(blocker, 'inside'), { recursive: true }); // removing it fails, after the close
  try {
    const base64 = fs.readFileSync(backup.filePath).toString('base64');
    const result = await handler('restore-database')(fromBrowser, { base64 });
    assert.strictEqual(result.success, false);
    assert.ok(database.db.open, 'the library is open again');
    assert.strictEqual(journalMode(database.db), 'wal');
    assert.ok(modelNames(dbPath).includes('kept-after-failure.stl'), 'it is the library from before');
  } finally {
    fs.rmSync(blocker, { recursive: true, force: true });
  }
});

(async () => {
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`ok ${name}`);
      } catch (err) {
        console.error(`FAIL ${name}:`, err.message);
        process.exitCode = 1;
      }
    }
  } finally {
    if (database.db && database.db.open) database.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
