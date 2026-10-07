#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChangeQueue, TreeWatcher, collapseFolders } = require('../src/server/folder-watch');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-watch-')));

test('collapsing keeps outer folders only', () => {
  assert.deepStrictEqual(collapseFolders(['/m/a/b', '/m/a', '/m/ab', '/m/c/d', '/m/a/b/c']), ['/m/a', '/m/ab', '/m/c/d']);
  assert.deepStrictEqual(collapseFolders(['/m', '/m/x']), ['/m']);
});

test('a watched tree reports changes, follows new folders and skips hidden and excluded ones', async () => {
  const root = path.join(tmp, 'library');
  for (const dir of ['Designer A/Benchy', '.cache/thumbs', 'renders/out']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const changes = [];
  const watcher = new TreeWatcher({
    root,
    isIgnoredDir: (dir) => path.basename(dir) === 'renders',
    onChange: (folder, changed) => changes.push([folder, changed])
  });
  await watcher.start();
  assert.strictEqual(watcher.error, '');
  assert.deepStrictEqual([...watcher.watchers.keys()].sort(), [root, path.join(root, 'Designer A'), path.join(root, 'Designer A', 'Benchy')].sort());

  // On macOS fs.watch uses FSEvents, which starts reporting a moment after the watch begins:
  // write until the watcher reports, then test. (Linux inotify reports from the start.)
  const warmUp = path.join(root, 'Designer A', 'Benchy', 'warm-up.stl');
  for (let n = 0; n < 40 && !changes.length; n++) {
    fs.writeFileSync(warmUp, String(n));
    await sleep(100);
  }
  assert.ok(changes.length, 'the watcher reports changes');
  fs.rmSync(warmUp);
  await sleep(200);
  changes.length = 0;
  fs.writeFileSync(path.join(root, 'Designer A', 'Benchy', 'benchy.stl'), 'solid');
  assert.ok(await until(() => changes.some(([folder]) => folder === path.join(root, 'Designer A', 'Benchy'))), JSON.stringify(changes));

  // A folder created with a file in it: the folder itself is reported and watched.
  fs.mkdirSync(path.join(root, 'Designer B', 'Cube'), { recursive: true });
  assert.ok(await until(() => watcher.watchers.has(path.join(root, 'Designer B', 'Cube'))), 'new folders are watched');
  assert.ok(changes.some(([folder]) => folder === path.join(root, 'Designer B')), 'a new folder is reported');
  changes.length = 0;
  fs.writeFileSync(path.join(root, 'Designer B', 'Cube', 'cube.stl'), 'solid');
  assert.ok(await until(() => changes.some(([folder]) => folder === path.join(root, 'Designer B', 'Cube'))), 'files in a new folder are seen');

  changes.length = 0;
  fs.writeFileSync(path.join(root, '.cache', 'thumbs', 'x.png'), 'x');
  fs.writeFileSync(path.join(root, 'renders', 'out', 'x.stl'), 'x');
  fs.writeFileSync(path.join(root, '.hidden.stl'), 'x');
  await sleep(500);
  assert.deepStrictEqual(changes, [], 'hidden and excluded folders and hidden files are ignored');

  fs.rmSync(path.join(root, 'Designer B'), { recursive: true });
  assert.ok(await until(() => !watcher.watchers.has(path.join(root, 'Designer B', 'Cube'))), 'removed folders are no longer watched');
  assert.ok(changes.some(([folder]) => folder === root), 'the parent of a removed folder is reported');
  watcher.close();
  assert.strictEqual(watcher.folderCount, 0);
});

test('a missing root reports an error', async () => {
  const watcher = new TreeWatcher({ root: path.join(tmp, 'missing'), onChange: () => {} });
  await watcher.start();
  assert.match(watcher.error, /Cannot watch/);
});

test('changes are batched, collapsed and wait for files that are still being written', async () => {
  const scans = [];
  let busy = false;
  const queue = new ChangeQueue({
    scan: async (root, folders) => { if (busy) return false; scans.push([root, folders]); return true; },
    quietMs: 150, maxWaitMs: 2000, settleMs: 400
  });
  const file = path.join(tmp, 'copying.stl');
  fs.writeFileSync(file, 'part');
  queue.add('/lib', '/lib/a/b', file);
  queue.add('/lib', '/lib/a', null);
  queue.add('/lib', '/lib/c', null);
  await sleep(250);
  assert.deepStrictEqual(scans, [], 'a file written moments ago holds the scan back');
  assert.ok(await until(() => scans.length === 1, 2000), 'scans once the file has settled');
  assert.deepStrictEqual(scans[0], ['/lib', ['/lib/a', '/lib/c']]);

  busy = true;
  queue.add('/lib', '/lib/d', null);
  await sleep(300);
  busy = false;
  assert.ok(await until(() => scans.length === 2, 2000), 'a busy scan is tried again');
  assert.deepStrictEqual(scans[1], ['/lib', ['/lib/d']]);
  queue.stop();
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok ' + name);
    } catch (err) {
      console.error('FAIL ' + name + ':', err.message);
      process.exitCode = 1;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
})();
