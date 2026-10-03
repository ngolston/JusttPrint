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

test('zip-extract temp files made by the app are allowed', () => {
  const ctx = { roots: [], isExtractTemp: (p) => p === '/tmp/printventory-extracts/printventory_abc.stl' };
  assert.ok(isLibraryPathAllowed('/tmp/printventory-extracts/printventory_abc.stl', ctx));
  assert.ok(!isLibraryPathAllowed('/tmp/other.stl', ctx));
});

test('only backup and export files are allowed from the data folder', () => {
  const ctx = { roots: [], generatedDir: '/config/data' };
  assert.ok(isLibraryPathAllowed('/config/data/printventory-backup-2026-10-03T10-00-00-000Z.db', ctx));
  assert.ok(isLibraryPathAllowed('/config/data/printventory-library-2026-10-03T10-00-00-000Z.json', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/printventory.db', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/certs/privkey.pem', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/sub/printventory-backup-x.db', ctx));
});

const { assertNetworkIpcArgs, assertMcpToolArgs } = require('./server-paths');

const guardCtx = {
  roots: ['/mnt/library'],
  generatedDir: '/root/.config/printventory/data',
  appDir: '/app',
  dataDir: '/root/.config/printventory',
  isKnownModel: (p) => p === '/old/scan/known.stl'
};

function refused(fn) {
  assert.throws(fn, /outside the library|cannot be scanned|only available in the desktop|Can only write|Cannot organize/);
}

test('network file arguments must be library files', () => {
  assertNetworkIpcArgs('read-model-file', ['/mnt/library/a.stl'], guardCtx);
  assertNetworkIpcArgs('read-model-file', ['/old/scan/known.stl'], guardCtx);
  assertNetworkIpcArgs('delete-file', ['/mnt/library/pack.zip::inner/a.stl'], guardCtx);
  assertNetworkIpcArgs('trash-file', ['url::https://example.com/model'], guardCtx);
  refused(() => assertNetworkIpcArgs('read-model-file', ['/etc/passwd'], guardCtx));
  refused(() => assertNetworkIpcArgs('delete-file', ['/root/.config/printventory/data/printventory.db'], guardCtx));
  refused(() => assertNetworkIpcArgs('delete-file', ['/etc/shadow.zip::x.stl'], guardCtx));
  refused(() => assertNetworkIpcArgs('check-files-exist', [['/mnt/library/a.stl', '/etc/hosts']], guardCtx));
});

test('context menu file lists are checked in both shapes', () => {
  assertNetworkIpcArgs('show-context-menu', [{ filePaths: ['/mnt/library/a.stl'] }], guardCtx);
  refused(() => assertNetworkIpcArgs('show-context-menu', [{ filePaths: ['/etc/passwd'] }], guardCtx));
  refused(() => assertNetworkIpcArgs('show-context-menu', [['/mnt/library/a.stl', '/etc/passwd']], guardCtx));
});

test('moves stay inside the library', () => {
  assertNetworkIpcArgs('move-files', [['/mnt/library/a.stl'], '/mnt/library/sorted'], guardCtx);
  refused(() => assertNetworkIpcArgs('move-files', [['/mnt/library/a.stl'], '/etc'], guardCtx));
  refused(() => assertNetworkIpcArgs('extract-zip-archive', ['/mnt/library/p.zip::a.stl', '/tmp'], guardCtx));
});

test('scans may add new folders but not system, app or data folders', () => {
  assertNetworkIpcArgs('scan-directory', ['/media/nas/models'], guardCtx);
  assertNetworkIpcArgs('save-directory', ['/srv/prints'], guardCtx);
  for (const dir of ['/', '/etc', '/proc/self', '/app', '/app/node_modules', '/root/.config/printventory/data', '/usr/share']) {
    refused(() => assertNetworkIpcArgs('scan-directory', [dir], guardCtx));
  }
});

test('organize may target a new folder, but not a system folder', () => {
  assertNetworkIpcArgs('organize-library-run', [{ sourceDir: '/mnt/library', destDir: '/media/sorted' }], guardCtx);
  refused(() => assertNetworkIpcArgs('organize-library-run', [{ sourceDir: '/mnt/library', destDir: '/etc/cron.d' }], guardCtx));
});

test('server desktop actions are blocked over the network', () => {
  refused(() => assertNetworkIpcArgs('open-path', ['/mnt/library/a.stl'], guardCtx));
  refused(() => assertNetworkIpcArgs('show-item-in-folder', ['/mnt/library/a.stl'], guardCtx));
});

test('channels without path arguments pass through', () => {
  assertNetworkIpcArgs('get-setting', ['currentVersion'], guardCtx);
});

test('MCP tools that write files only write to the library or the data folder', () => {
  assertMcpToolArgs('backup_database', {}, guardCtx);
  assertMcpToolArgs('backup_database', { destPath: '/root/.config/printventory/data/printventory-backup-x.db' }, guardCtx);
  assertMcpToolArgs('export_library', { destPath: '/mnt/library/export.json' }, guardCtx);
  refused(() => assertMcpToolArgs('backup_database', { destPath: '/etc/cron.d/evil' }, guardCtx));
  refused(() => assertMcpToolArgs('export_library', { destPath: '/app/index.html' }, guardCtx));
  refused(() => assertMcpToolArgs('trash_file', { filePath: '/etc/passwd', confirm: true }, guardCtx));
  refused(() => assertMcpToolArgs('move_files', { filePaths: ['/mnt/library/a.stl'], destinationFolder: '/tmp' }, guardCtx));
  refused(() => assertMcpToolArgs('scan_directory', { directory: '/etc' }, guardCtx));
});
