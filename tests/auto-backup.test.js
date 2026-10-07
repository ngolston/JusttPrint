#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-auto-backup-')));
process.env.JUSTTPRINT_USER_DATA = path.join(tmp, 'data');
for (const name of ['JUSTTPRINT_AUTO_BACKUP', 'JUSTTPRINT_BACKUP_INTERVAL_HOURS', 'JUSTTPRINT_BACKUP_KEEP', 'JUSTTPRINT_BACKUP_DIR']) delete process.env[name];

const Database = require('better-sqlite3');
const database = require('../src/core/database');
const autoBackup = require('../src/server/auto-backup');
const { backupFileName, listBackups, pruneBackups, nextRunAt, folderProblem } = autoBackup;

const results = [];
function test(name, fn) {
  results.push((async () => {
    try {
      await fn();
      console.log('ok ' + name);
    } catch (err) {
      console.error('FAIL ' + name + ':', err.message);
      process.exitCode = 1;
    }
  })());
}

const HOUR = 3600 * 1000;

test('backup names are UTC and sort by time', () => {
  assert.strictEqual(backupFileName('2026-10-07T03:04:05.678Z'), 'justtprint-auto-20261007-030405.db');
  assert.ok(autoBackup.AUTO_BACKUP_FILE.test('justtprint-auto-20261007-030405-2.db'));
  for (const other of ['justtprint.db', 'justtprint-backup-2026.db', 'justtprint-auto-20261007-030405.db.partial', 'notes-auto-20261007-030405.db']) {
    assert.ok(!autoBackup.AUTO_BACKUP_FILE.test(other), other);
  }
});

test('pruning keeps the newest and never touches other files', () => {
  const dir = path.join(tmp, 'prune');
  fs.mkdirSync(dir);
  const names = ['justtprint-auto-20261001-000000.db', 'justtprint-auto-20261003-000000.db', 'justtprint-auto-20261002-000000.db', 'justtprint-auto-20261003-000000-1.db'];
  for (const name of [...names, 'justtprint.db', 'holiday-photos.db', 'justtprint-backup-x.db']) fs.writeFileSync(path.join(dir, name), 'x');
  assert.deepStrictEqual(listBackups(dir).map((b) => b.name), [names[3], names[1], names[2], names[0]]);
  assert.deepStrictEqual(pruneBackups(dir, 2).sort(), [names[0], names[2]].sort());
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['holiday-photos.db', 'justtprint-auto-20261003-000000-1.db', 'justtprint-auto-20261003-000000.db', 'justtprint-backup-x.db', 'justtprint.db']);
  assert.deepStrictEqual(listBackups(path.join(tmp, 'missing')), []);
});

test('schedule: off, first right away, every interval, retry an hour after a failure', () => {
  assert.strictEqual(nextRunAt({ enabled: false, intervalHours: 24 }), null);
  assert.strictEqual(nextRunAt({ enabled: true, intervalHours: 24 }), 0);
  const last = Date.parse('2026-10-07T03:00:00Z');
  assert.strictEqual(nextRunAt({ enabled: true, intervalHours: 24, newestBackup: new Date(last).toISOString() }), last + 24 * HOUR);
  const failed = last + 30 * HOUR;
  assert.strictEqual(nextRunAt({ enabled: true, intervalHours: 24, newestBackup: new Date(last).toISOString(), lastAttempt: new Date(failed).toISOString(), lastError: 'disk full' }), failed + HOUR);
  assert.strictEqual(nextRunAt({ enabled: true, intervalHours: 24, lastAttempt: new Date(failed).toISOString(), lastError: 'disk full' }), failed + HOUR);
  // An old error from before the newest backup does not delay the next run.
  assert.strictEqual(nextRunAt({ enabled: true, intervalHours: 6, newestBackup: new Date(failed).toISOString(), lastAttempt: new Date(last).toISOString(), lastError: 'old' }), failed + 6 * HOUR);
  assert.strictEqual(autoBackup.backupTime('justtprint-auto-20261007-030405-1.db'), Date.parse('2026-10-07T03:04:05Z'));
  assert.ok(Number.isNaN(autoBackup.backupTime('justtprint.db')));
});

test('backup folders: absolute, not system or app folders', () => {
  assert.strictEqual(folderProblem('/mnt/backups', { appDir: '/app' }), '');
  assert.strictEqual(folderProblem('/root/.config/justtprint/backups', { appDir: '/opt/justtprint', dataDir: '/root/.config/justtprint' }), '', 'the data folder (under /root) is fine');
  assert.match(folderProblem('/root/elsewhere', { dataDir: '/root/.config/justtprint' }), /system folder/);
  assert.match(folderProblem('backups'), /absolute/);
  assert.match(folderProblem('/etc/backups'), /system folder/);
  assert.match(folderProblem('/opt/justtprint/backups', { appDir: '/opt/justtprint' }), /app folder/);
});

test('a backup run writes a checked copy, prunes, and records failures', async () => {
  database.db = new Database(path.join(tmp, 'live.db'));
  database.db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE models (filePath TEXT); INSERT INTO models VALUES ('/m/cube.stl');");
  const dir = path.join(tmp, 'backups');
  let status = autoBackup.saveSettings({ enabled: true, intervalHours: 12, keep: 2, directory: dir + '/' });
  assert.strictEqual(status.directory, dir);
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.intervalHours, 12);
  autoBackup.stop();

  const first = await autoBackup.runBackup('test');
  assert.ok(first.success, first.message);
  const copy = new Database(first.backup.path, { readonly: true });
  assert.strictEqual(copy.prepare('SELECT filePath FROM models').get().filePath, '/m/cube.stl');
  copy.close();

  // Two more runs in other seconds: only the newest two stay.
  for (const backup of listBackups(dir)) fs.utimesSync(backup.path, new Date(0), new Date(0));
  fs.renameSync(first.backup.path, path.join(dir, 'justtprint-auto-20200101-000000.db'));
  fs.writeFileSync(path.join(dir, 'justtprint-auto-20200102-000000.db.partial'), 'left over');
  await autoBackup.runBackup('test');
  autoBackup.stop();
  fs.renameSync(listBackups(dir)[0].path, path.join(dir, 'justtprint-auto-20200103-000000.db'));
  const third = await autoBackup.runBackup('test');
  autoBackup.stop();
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [third.backup.name, 'justtprint-auto-20200103-000000.db'].sort());

  status = autoBackup.status();
  assert.strictEqual(status.lastError, '');
  assert.ok(Date.parse(status.nextRun) > Date.now() + 11 * HOUR, status.nextRun);
  assert.strictEqual(autoBackup.findBackup(third.backup.name).path, third.backup.path);
  assert.throws(() => autoBackup.findBackup('../live.db'), /Not an automatic backup/);

  const emptyFolder = autoBackup.saveSettings({ directory: path.join(tmp, 'empty-folder') });
  autoBackup.stop();
  assert.ok(Date.parse(emptyFolder.nextRun) <= Date.now() + 1000, `a new, empty folder gets a backup right away (${emptyFolder.nextRun})`);
  assert.throws(() => autoBackup.saveSettings({ directory: '/etc' }), /system folder/);
  assert.throws(() => autoBackup.saveSettings({ keep: 0 }), /Keep 1 to 1000/);
  fs.writeFileSync(path.join(tmp, 'not-a-folder'), 'x');
  autoBackup.saveSettings({ directory: path.join(tmp, 'not-a-folder') });
  autoBackup.stop();
  const failed = await autoBackup.runBackup('test');
  autoBackup.stop();
  assert.strictEqual(failed.success, false);
  assert.ok(autoBackup.status().lastError, 'the failure is recorded');
  database.db.close();
});

Promise.all(results).then(() => fs.rmSync(tmp, { recursive: true, force: true }));
