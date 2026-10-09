'use strict';

// Worker thread: geometry fingerprints (src/core/geometry-signature.js), so a large mesh does not
// hold up the JusttPrint backend. Messages: { id, filePath } → { id, ok, result | error }.
const { parentPort } = require('worker_threads');
require('../core/log').install();
const fs = require('fs');
const path = require('path');
const { geometrySignature } = require('../core/geometry-signature');

parentPort.on('message', async ({ id, filePath }) => {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const result = geometrySignature(buffer, path.extname(filePath));
    parentPort.postMessage({ id, ok: true, result: result ? { signature: result.signature, triangles: result.triangles } : null });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
  }
});
