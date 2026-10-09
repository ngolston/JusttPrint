'use strict';

// Worker thread: geometry fingerprints (src/core/geometry-signature.js), so a large mesh does not
// hold up the JusttPrint backend. Messages: { id, filePath } → { id, ok, result | error }; filePath
// may be a model inside a ZIP ("archive.zip::part.stl").
const workerThreads = require('worker_threads');

// This file only runs as a worker thread, so it always has a parent.
const parentPort = /** @type {import('worker_threads').MessagePort} */ (workerThreads.parentPort);
require('../core/log').install();
const fs = require('fs');
const path = require('path');
const { geometrySignature } = require('../core/geometry-signature');

const { extractZipEntryBuffer } = require('../core/zip-extract');

parentPort.on('message', async ({ id, filePath }) => {
  try {
    // A model inside a ZIP: "archive.zip::folder/part.stl".
    const [zipPath, entryPath] = filePath.includes('::') ? filePath.split('::') : [filePath, null];
    const buffer = entryPath ? await extractZipEntryBuffer(zipPath, entryPath) : await fs.promises.readFile(filePath);
    const result = geometrySignature(buffer, path.extname(entryPath || filePath));
    parentPort.postMessage({ id, ok: true, result: result ? { signature: result.signature, triangles: result.triangles } : null });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
  }
});
