#!/usr/bin/env node
'use strict';

// Archives (ZIP, RAR, 7Z) are scanned as one model each: never opened, and not held to the Max File
// Size (src/server/scan-worker.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { zipSync, strToU8 } = require('fflate');

function scan(dir, maxFileSize) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '..', 'src', 'server', 'scan-worker.js'));
    const files = [];
    worker.on('message', (message) => {
      if (message.type === 'batch') files.push(...message.files);
      if (message.type === 'done') {
        files.push(...(message.result.files || []));
        worker.terminate();
        resolve({ files, skipped: message.result.skippedDueToSize });
      }
      if (message.type === 'error') {
        worker.terminate();
        reject(new Error(message.error));
      }
    });
    worker.postMessage({
      directoryPath: dir,
      maxFileSize,
      scanExtensions: ['.stl', '.3mf'],
      excludeFolderNames: [],
      excludeDirectories: []
    });
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-zip-size-'));
  try {
    const small = 'solid part\nendsolid part\n';
    // Incompressible padding makes the archive larger than the limit.
    const padding = Uint8Array.from({ length: 6000 }, (_, i) => (i * 7919) % 251);
    fs.writeFileSync(
      path.join(dir, 'kit.zip'),
      Buffer.from(zipSync({ 'arm.stl': strToU8(small), 'leg.stl': strToU8(small), 'notes.bin': [padding, { level: 0 }] }))
    );
    fs.writeFileSync(path.join(dir, 'parts.rar'), Buffer.from(padding));
    fs.writeFileSync(path.join(dir, 'parts.7z'), 'x');
    fs.writeFileSync(path.join(dir, 'big.stl'), 'solid big\n' + 'x'.repeat(5000) + '\nendsolid big\n');
    fs.writeFileSync(path.join(dir, 'arm.stl'), small);
    assert.ok(fs.statSync(path.join(dir, 'kit.zip')).size > 4000);
    const { files, skipped } = await scan(dir, 4000);
    const names = files.map((f) => f.fileName).sort();
    assert.deepStrictEqual(names, ['arm.stl', 'kit.zip', 'parts.7z', 'parts.rar'], 'each archive is one model, whatever its size');
    assert.ok(
      files.every((f) => !f.filePath.includes('::')),
      'nothing is listed from inside an archive'
    );
    assert.strictEqual(skipped, 1, 'a model file over the limit is still skipped');
    console.log('ok archives are scanned as one model each, never opened');
  } catch (error) {
    console.error('FAIL scan-zip-size:', error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
