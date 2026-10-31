#!/usr/bin/env node
'use strict';

// A painted 3MF must not crash the server: isPainted() used to destroy the part's stream at the
// first sign of paint, which left a read of the file in flight; zip.close() then failed it with
// EBADF, an error nobody can catch. Reads are slowed down here so one is always in flight, as on
// a busy disk. Without the fix this process dies before printing "ok".

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const realRead = fs.read;
fs.read = function slowRead(...args) {
  setTimeout(() => realRead.apply(fs, args), 3);
};

const fflate = require('fflate');
const { readPlateFilaments } = require('../src/server/threemf-filaments');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-painted-'));
  try {
    // Deflated like a real project; the sign of paint first, then data that does not compress,
    // so the part takes many reads.
    const model = `<triangle paint_color="4"/>${crypto.randomBytes(2 * 1024 * 1024).toString('base64')}`;
    const settings = JSON.stringify({ filament_colour: ['#F8F8F8', '#0056B8'], filament_type: ['PLA', 'PETG'] });
    const file = path.join(dir, 'painted.3mf');
    fs.writeFileSync(
      file,
      Buffer.from(
        fflate.zipSync({
          'Metadata/project_settings.config': fflate.strToU8(settings),
          '3D/Objects/object_1.model': [fflate.strToU8(model), { level: 6 }]
        })
      )
    );
    for (let i = 0; i < 30; i++) {
      const { source, rows } = await readPlateFilaments(file);
      assert.strictEqual(source, '3mf-project');
      assert.deepStrictEqual(
        rows.map((row) => [row.plate, row.slot]),
        [
          [0, 1],
          [0, 2]
        ]
      );
    }
    // Let anything left in flight finish: that is when the crash happens.
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log('ok a painted 3MF is read 30 times without crashing the server');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('FAIL a painted 3MF:', err.stack || err.message);
  process.exitCode = 1;
});
