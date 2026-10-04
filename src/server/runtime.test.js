#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const shim = require('./runtime');

const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log('ok ' + name),
    (err) => { console.error('FAIL ' + name + ':', err.message); process.exitCode = 1; }
  ));
}

test('app paths follow JUSTTPRINT_USER_DATA and XDG_CONFIG_HOME', () => {
  const saved = { ...process.env };
  try {
    process.env.JUSTTPRINT_USER_DATA = '/data/pv';
    assert.strictEqual(shim.app.getPath('userData'), '/data/pv');
    assert.strictEqual(shim.app.getPath('logs'), '/data/pv/logs');
    delete process.env.JUSTTPRINT_USER_DATA;
    process.env.XDG_CONFIG_HOME = '/root/.config';
    assert.strictEqual(shim.app.getPath('userData'), '/root/.config/justtprint');
  } finally {
    process.env = saved;
  }
});

test('ipcMain keeps handlers for the WebSocket dispatcher', () => {
  shim.ipcMain.handle('ping', () => 'pong');
  assert.strictEqual(shim.ipcMain._handlers.get('ping')(), 'pong');
  shim.ipcMain.removeHandler('ping');
  assert.ok(!shim.ipcMain._handlers.has('ping'));
});

test('nativeImage never decodes, so compression is skipped', () => {
  assert.ok(shim.nativeImage.createFromBuffer(Buffer.from('x')).isEmpty());
});

test('trashItem moves files into a trash folder on the same drive, with restore info', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-trash-'));
  const savedDataHome = process.env.XDG_DATA_HOME;
  // When the file is not on its own mount (as here), the home trash is used; keep it in the temp folder.
  process.env.XDG_DATA_HOME = path.join(base, 'share');
  try {
    const file = path.join(base, 'models', 'part.stl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'solid a');
    fs.writeFileSync(file + '.copy', 'solid b');
    await shim.shell.trashItem(file);
    fs.renameSync(file + '.copy', file);
    await shim.shell.trashItem(file);
    assert.ok(!fs.existsSync(file));
    const trash = path.join(base, 'share', 'Trash');
    assert.deepStrictEqual(fs.readdirSync(path.join(trash, 'files')).sort(), ['part.2.stl', 'part.stl']);
    const info = fs.readFileSync(path.join(trash, 'info', 'part.stl.trashinfo'), 'utf8');
    assert.match(info, /^\[Trash Info\]\nPath=.*part\.stl\nDeletionDate=\d{4}-/);
  } finally {
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedDataHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('trashItem rejects a missing file', async () => {
  await assert.rejects(shim.shell.trashItem('/definitely/not/here.stl'));
});

Promise.all(pending).then(() => process.exit(process.exitCode || 0));
