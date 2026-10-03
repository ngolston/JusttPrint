#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { isServableStaticPath, isLibraryPathAllowed } = require('./server-paths');

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

test('web assets are served', () => {
  for (const p of ['/renderer.js', '/styles.css', '/logo.png', '/vendor/three.min.js', '/vendor/occt-import-js.wasm', '/manifest.webmanifest', '/guide/step1.png', '/index.html']) {
    assert.ok(isServableStaticPath(p), p);
  }
});

test('secrets, server code and dependencies are not served', () => {
  for (const p of [
    '/support-webhook.json', '/package.json', '/package-lock.json', '/.env', '/.git/config',
    '/main.js', '/preload.js', '/server-auth.js', '/mcp-server.js', '/printventory.db',
    '/node_modules/express/index.js', '/scripts/publish-beta-release.js', '/tests/test-utils.js',
    '/helper/printventory-helper.js', '/data/printventory.db', '/server-auth.test.js',
    '/vendor/..%2Fmain.js', '/%2e%2e/etc/passwd', '/vendor/%5c..%5cmain.js'
  ]) {
    assert.ok(!isServableStaticPath(p), p);
  }
});

test('library files inside a root are allowed', () => {
  const ctx = { roots: ['/mnt/models', 'D:\\Prints'] };
  assert.ok(isLibraryPathAllowed('/mnt/models/a/b.stl', ctx));
  assert.ok(isLibraryPathAllowed('d:\\prints\\x.3mf', ctx));
});

test('paths outside the roots are refused, including traversal', () => {
  const ctx = { roots: ['/mnt/models'] };
  assert.ok(!isLibraryPathAllowed('/etc/passwd', ctx));
  assert.ok(!isLibraryPathAllowed('/mnt/models/../../etc/passwd', ctx));
  assert.ok(!isLibraryPathAllowed('/mnt/models-other/x.stl', ctx));
  assert.ok(!isLibraryPathAllowed('/mnt/models/x.stl\0.png', ctx));
  assert.ok(!isLibraryPathAllowed('', ctx));
});

test('stored model paths are allowed even outside the roots', () => {
  const ctx = { roots: [], isKnownModel: (p) => p === '/old/scan/thing.stl' };
  assert.ok(isLibraryPathAllowed('/old/scan/thing.stl', ctx));
  assert.ok(!isLibraryPathAllowed('/old/scan/other.stl', ctx));
});

test('only backup and export files are allowed from the data folder', () => {
  const ctx = { roots: [], generatedDir: '/config/data' };
  assert.ok(isLibraryPathAllowed('/config/data/printventory-backup-2026-10-03T10-00-00-000Z.db', ctx));
  assert.ok(isLibraryPathAllowed('/config/data/printventory-library-2026-10-03T10-00-00-000Z.json', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/printventory.db', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/certs/privkey.pem', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/sub/printventory-backup-x.db', ctx));
});
