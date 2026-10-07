#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { browseFolders, parseMountInfo } = require('../src/server/folder-browse');

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

test('mountinfo: volumes kept, kernel file systems dropped, escapes decoded', () => {
  const text = [
    '612 540 0:52 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/x',
    '613 612 0:55 / /proc rw,nosuid - proc proc rw',
    '614 612 0:56 / /dev rw,nosuid - tmpfs tmpfs rw',
    '615 614 0:57 / /dev/pts rw - devpts devpts rw',
    '616 612 0:58 / /sys ro - sysfs sysfs ro',
    '617 616 0:30 / /sys/fs/cgroup ro - cgroup2 cgroup rw',
    '620 612 8:1 /srv/models /models rw,relatime - ext4 /dev/sda1 rw',
    '621 612 0:60 /Prints /mnt/NAS\\040Share rw - cifs //nas/share rw',
    '622 612 8:1 /etc/hosts /etc/hosts rw - ext4 /dev/sda1 rw',
    ''
  ].join('\n');
  assert.deepStrictEqual(parseMountInfo(text), ['/', '/dev', '/models', '/mnt/NAS Share', '/etc/hosts']);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-browse-'));
const volume = path.join(tmp, 'models');
const other = path.join(tmp, 'outside');
const data = path.join(volume, 'appdata');
for (const dir of [
  path.join(volume, 'Benchy'), path.join(volume, 'cars', 'Supra'), path.join(volume, 'item 10'), path.join(volume, 'item 9'),
  path.join(volume, '.hidden'), data, path.join(other, 'secret')
]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(volume, 'part.stl'), 'solid');
fs.symlinkSync(path.join(volume, 'cars'), path.join(volume, 'cars-link'));
fs.symlinkSync(other, path.join(volume, 'elsewhere'));
fs.symlinkSync(data, path.join(volume, 'data-link'));
const realVolume = fs.realpathSync(volume);
const isBlocked = (dir) => [data, path.join(realVolume, 'appdata')].some((blocked) => dir === blocked || dir.startsWith(blocked + '/'));
const browse = (dir) => browseFolders({ dir, places: [volume, other + '/missing', 'relative/path', data], isBlocked });

test('places: existing, absolute, not blocked', () => {
  assert.deepStrictEqual(browse(null).places, [{ name: 'models', path: volume }]);
});

test('lists subfolders: sorted naturally, no files, hidden or blocked folders, links to blocked ones', () => {
  const listing = browse(volume);
  assert.strictEqual(listing.path, volume);
  assert.deepStrictEqual(listing.folders.map((f) => f.name), ['Benchy', 'cars', 'cars-link', 'elsewhere', 'item 9', 'item 10']);
  assert.strictEqual(listing.parent, path.dirname(volume));
  assert.strictEqual(browse(path.join(volume, 'cars')).parent, volume);
});

test('folders outside the places can be browsed; blocked folders, links into them and bad paths cannot', () => {
  assert.deepStrictEqual(browse(path.join(volume, 'cars', '..', '..', 'outside')).folders.map((f) => f.name), ['secret']);
  assert.match(browse(data).error, /cannot be browsed/);
  assert.match(browse(path.join(volume, 'data-link')).error, /cannot be browsed/);
  assert.match(browse('relative').error, /Not a folder path/);
  assert.match(browse(path.join(volume, 'part.stl')).error, /Folder not found/);
  assert.strictEqual(browse(data).path, null);
});

test('no parent above a blocked folder', () => {
  const blockedParent = (dir) => dir === path.dirname(volume) || isBlocked(dir);
  assert.strictEqual(browseFolders({ dir: volume, places: [volume], isBlocked: blockedParent }).parent, null);
});

fs.rmSync(tmp, { recursive: true, force: true });
