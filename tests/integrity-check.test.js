#!/usr/bin/env node
'use strict';

// The full integrity check reads the whole database (13 minutes on a 20 GB library, the server answers nothing
// meanwhile): it runs only on the start after a "database is damaged" error, not at every start.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justtprint-integrity-'));
const dbPath = path.join(dir, 'justtprint.db');
process.env.JUSTTPRINT_DB_PATH = dbPath;
const mark = `${dbPath}.check`;

const database = require('../src/core/database');
const { verifyDatabaseIntegrity, markForIntegrityCheck } = require('../src/core/db-init');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

/** Opens the test database and records every pragma it is asked for. */
function open() {
  database.db = new Database(dbPath);
  const pragmas = [];
  const pragma = database.db.pragma.bind(database.db);
  database.db.pragma = (source, options) => {
    pragmas.push(String(source).split(/\s|=/)[0]);
    return pragma(source, options);
  };
  return pragmas;
}

const corrupt = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });

test('a normal start does not read the whole database', () => {
  const pragmas = open();
  assert.strictEqual(verifyDatabaseIntegrity(), true);
  assert.ok(!pragmas.includes('integrity_check'), `pragmas run: ${pragmas.join(', ')}`);
  database.db.close();
});

test('a busy database is not marked for a check', () => {
  markForIntegrityCheck(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
  markForIntegrityCheck(new Error('no code'));
  assert.ok(!fs.existsSync(mark));
});

test('after a "damaged" error the next start checks the whole database, once', () => {
  markForIntegrityCheck(corrupt);
  assert.match(fs.readFileSync(mark, 'utf8'), /SQLITE_CORRUPT: database disk image is malformed/);
  const pragmas = open();
  assert.strictEqual(verifyDatabaseIntegrity(), true);
  assert.ok(pragmas.includes('integrity_check'));
  assert.ok(!fs.existsSync(mark), 'the mark is removed after the check');
  database.db.close();
  const again = open();
  verifyDatabaseIntegrity();
  assert.ok(!again.includes('integrity_check'), 'the start after that does not check again');
  database.db.close();
});

test('a database that is still damaged keeps the mark, and is checked again on the next start', () => {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX iv ON t(v)');
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < 5000; i++) insert.run(`${'x'.repeat(200)}${i}`);
  db.close();
  const fd = fs.openSync(dbPath, 'r+');
  fs.writeSync(fd, Buffer.alloc(4096, 0x41), 0, 4096, 4096 * 40); // a page in the middle becomes garbage
  fs.closeSync(fd);
  markForIntegrityCheck(corrupt);
  const pragmas = open();
  assert.strictEqual(verifyDatabaseIntegrity(), true);
  assert.ok(pragmas.includes('integrity_check'));
  assert.ok(fs.existsSync(mark), 'the mark stays until the check says ok');
  database.db.close();
  fs.rmSync(mark);
  fs.rmSync(dbPath);
});

test('a server that stops on a "damaged" error leaves the mark', () => {
  const child = `
    const { markForIntegrityCheck } = require(${JSON.stringify(path.join(__dirname, '../src/core/db-init'))});
    process.on('uncaughtExceptionMonitor', markForIntegrityCheck);
    setTimeout(() => { throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }); });
  `;
  const result = spawnSync(process.execPath, ['-e', child], { env: { ...process.env, JUSTTPRINT_DB_PATH: dbPath }, encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0, 'the server still stops on the error');
  assert.ok(fs.existsSync(mark), result.stderr);
  fs.rmSync(mark);
});

fs.rmSync(dir, { recursive: true, force: true });
