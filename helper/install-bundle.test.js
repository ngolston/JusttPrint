#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { openZip } = require('../src/core/zip-entries');
const bundle = require('./install-bundle');

async function test(name, fn) {
  try {
    await fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

async function main() {
  await test('origin keeps the host and drops a path', () => {
    assert.strictEqual(bundle.safePublicOrigin('https://nas.local:8443/library'), 'https://nas.local:8443');
  });

  await test('origin rejects anything that is not http(s)', () => {
  assert.throws(() => bundle.safePublicOrigin('file:///tmp/evil'), /http or https/);
});

  await test('request host is the server the bundle connects to', () => {
  const origin = bundle.originFromRequest({
    protocol: 'http',
    get(name) {
      if (name === 'host') return '192.168.1.20:5000';
      return '';
    }
  });
  assert.strictEqual(origin, 'http://192.168.1.20:5000');
});

  await test('forwarded https host is used when a proxy terminates TLS', () => {
  const origin = bundle.originFromRequest({
    protocol: 'http',
    get(name) {
      if (name === 'x-forwarded-proto') return 'https';
      if (name === 'x-forwarded-host') return 'justtprint.home:8443';
      if (name === 'host') return '127.0.0.1:5000';
      return '';
    }
  });
  assert.strictEqual(origin, 'https://justtprint.home:8443');
});

  await test('zip is stamped with this server and the installer files', async () => {
  const appDir = path.join(__dirname, '..');
  const bytes = await bundle.buildHelperBundle({
    appDir,
    origin: 'http://nas.local:5000',
    insecure: true
  });
  const { files } = openZip(bytes);
  const read = (name) => files[name].read('string');
  const config = JSON.parse(read('helper-config.json'));
  assert.deepStrictEqual(config.origins, ['http://nas.local:5000']);
  assert.strictEqual(config.tlsInsecure, true);
  assert.ok(files['justtprint-helper.js']);
  assert.ok(files['slicer-protocol.js']);
  assert.ok(files['slicer-launch.js']);
  assert.ok(files['install.cmd']);
  assert.ok(files['install.command']);
  const readme = read('INSTALL.txt');
  assert.ok(readme.includes('http://nas.local:5000'));
  const cmd = read('install.cmd');
  assert.ok(cmd.includes('install --from-bundle'));
  assert.ok(cmd.includes('https://nodejs.org/dist/latest-lts/'));
  assert.ok(!cmd.includes('nas.local'));
  const sh = read('install.sh');
  assert.ok(sh.includes('https://nodejs.org/dist/latest-lts/'));
  assert.ok(sh.includes('darwin-arm64'));
  assert.ok(sh.includes('linux-x64'));
  // Unix permissions from the central directory: the installers are executable.
  const modes = {};
  for (let at = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); at >= 0; at = bytes.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), at + 4)) {
    const nameLength = bytes.readUInt16LE(at + 28);
    modes[bytes.toString('utf8', at + 46, at + 46 + nameLength)] = (bytes.readUInt32LE(at + 38) >>> 16) & 0o777;
  }
  assert.strictEqual(modes['install.sh'], 0o755);
  assert.strictEqual(modes['install.command'], 0o755);
  assert.strictEqual(modes['INSTALL.txt'], 0o644);
  });
}

main();
