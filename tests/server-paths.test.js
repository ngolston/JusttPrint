#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { isServableStaticPath, isLibraryPathAllowed } = require('../src/server/server-paths');

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
  for (const p of ['/page-init.js', '/logo.png', '/web-build/parse-worker.js', '/vendor/occt-import-js.wasm', '/manifest.webmanifest', '/guide/step1.png', '/index.html']) {
    assert.ok(isServableStaticPath(p), p);
  }
});

test('secrets, server code and dependencies are not served', () => {
  for (const p of [
    '/secrets.json', '/package.json', '/package-lock.json', '/.env', '/.git/config',
    '/main.js', '/server-auth.js', '/mcp-server.js', '/justtprint.db',
    '/node_modules/express/index.js', '/scripts/docker-hub-push.js', '/tests/test-utils.js',
    '/helper/justtprint-helper.js', '/data/justtprint.db', '/server-auth.test.js',
    '/src/server/index.js', '/src/server/runtime.js',
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
  const ctx = { roots: [], isExtractTemp: (p) => p === '/tmp/justtprint-extracts/justtprint_abc.stl' };
  assert.ok(isLibraryPathAllowed('/tmp/justtprint-extracts/justtprint_abc.stl', ctx));
  assert.ok(!isLibraryPathAllowed('/tmp/other.stl', ctx));
});

test('only backup and export files are allowed from the data folder', () => {
  const ctx = { roots: [], generatedDir: '/config/data' };
  assert.ok(isLibraryPathAllowed('/config/data/justtprint-backup-2026-10-03T10-00-00-000Z.db', ctx));
  assert.ok(isLibraryPathAllowed('/config/data/justtprint-library-2026-10-03T10-00-00-000Z.json', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/justtprint.db', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/certs/privkey.pem', ctx));
  assert.ok(!isLibraryPathAllowed('/config/data/sub/justtprint-backup-x.db', ctx));
});

const { assertNetworkIpcArgs, assertMcpToolArgs } = require('../src/server/server-paths');

const guardCtx = {
  roots: ['/mnt/library'],
  generatedDir: '/root/.config/justtprint/data',
  appDir: '/app',
  dataDir: '/root/.config/justtprint',
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
  refused(() => assertNetworkIpcArgs('delete-file', ['/root/.config/justtprint/data/justtprint.db'], guardCtx));
  refused(() => assertNetworkIpcArgs('delete-file', ['/etc/shadow.zip::x.stl'], guardCtx));
  refused(() => assertNetworkIpcArgs('pull-3mf-metadata', [['/mnt/library/a.stl', '/etc/hosts']], guardCtx));
});

test('context menu file lists are checked in both shapes', () => {
  assertNetworkIpcArgs('show-context-menu', [{ filePaths: ['/mnt/library/a.stl'] }], guardCtx);
  refused(() => assertNetworkIpcArgs('show-context-menu', [{ filePaths: ['/etc/passwd'] }], guardCtx));
  refused(() => assertNetworkIpcArgs('show-context-menu', [['/mnt/library/a.stl', '/etc/passwd']], guardCtx));
});

test('moves stay inside the library', () => {
  assertNetworkIpcArgs('move-files', [['/mnt/library/a.stl'], '/mnt/library/sorted'], guardCtx);
  refused(() => assertNetworkIpcArgs('move-files', [['/mnt/library/a.stl'], '/etc'], guardCtx));
  refused(() => assertNetworkIpcArgs('move-files', [['/mnt/library/p.zip::a.stl'], '/tmp'], guardCtx));
});

test('scans may add new folders but not system, app or data folders', () => {
  assertNetworkIpcArgs('scan-directory', ['/media/nas/models'], guardCtx);
  assertNetworkIpcArgs('save-directory', ['/srv/prints'], guardCtx);
  for (const dir of ['/', '/etc', '/proc/self', '/app', '/app/node_modules', '/root/.config/justtprint/data', '/usr/share']) {
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
  assertMcpToolArgs('backup_database', { destPath: '/root/.config/justtprint/data/justtprint-backup-x.db' }, guardCtx);
  assertMcpToolArgs('export_library', { destPath: '/mnt/library/export.json' }, guardCtx);
  refused(() => assertMcpToolArgs('backup_database', { destPath: '/etc/cron.d/evil' }, guardCtx));
  refused(() => assertMcpToolArgs('export_library', { destPath: '/app/index.html' }, guardCtx));
  refused(() => assertMcpToolArgs('trash_file', { filePath: '/etc/passwd', confirm: true }, guardCtx));
  refused(() => assertMcpToolArgs('move_files', { filePaths: ['/mnt/library/a.stl'], destinationFolder: '/tmp' }, guardCtx));
  refused(() => assertMcpToolArgs('scan_directory', { directory: '/etc' }, guardCtx));
});

test('symlinks that leave the library are refused', () => {
  const fs = require('fs');
  const os = require('os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-links-'));
  try {
    const lib = path.join(base, 'library');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(lib, 'models'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(lib, 'models', 'a.stl'), 'solid');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(lib, 'escape'));
    fs.symlinkSync(path.join(lib, 'models'), path.join(lib, 'alias'));
    const ctx = { roots: [lib], realpath: (p) => fs.realpathSync.native(p) };
    assert.ok(isLibraryPathAllowed(path.join(lib, 'models', 'a.stl'), ctx));
    assert.ok(isLibraryPathAllowed(path.join(lib, 'alias', 'a.stl'), ctx), 'a link that stays inside is fine');
    assert.ok(!isLibraryPathAllowed(path.join(lib, 'escape', 'secret.txt'), ctx));
    assert.ok(!isLibraryPathAllowed(path.join(lib, 'escape', 'not-yet.txt'), ctx), 'missing files are resolved through their parent');
    const guard = { ...ctx, appDir: '/app', dataDir: '/data' };
    assert.throws(() => assertNetworkIpcArgs('move-files', [[path.join(lib, 'models', 'a.stl')], path.join(lib, 'escape')], guard), /outside the library/);
    assert.throws(() => assertMcpToolArgs('export_library', { destPath: path.join(lib, 'escape', 'x.json') }, guard), /Can only write/);
    fs.symlinkSync('/etc', path.join(lib, 'etc-link'));
    assert.throws(() => assertNetworkIpcArgs('scan-directory', [path.join(lib, 'etc-link')], guard), /cannot be scanned/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
