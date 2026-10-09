'use strict';

/** Stream one library model to an HTTP response as a download (a ZIP entry is extracted first). */
const fs = require('fs');
const path = require('path');
const { parseZipPath } = require('../core/library-paths');
const { extractModelFromZip } = require('../core/zip-entries');
const { cleanupExtractTempFile } = require('../core/extract-temp');

async function sendModelFile(res, filePath) {
  const info = parseZipPath(filePath);
  let actual = filePath;
  let name = path.basename(filePath);
  if (info.isZipEntry) {
    actual = await extractModelFromZip(info.zipPath, info.entryPath);
    name = path.basename(info.entryPath);
  }
  if (!fs.existsSync(actual)) {
    res.status(404).type('text/plain').send('The file is no longer there');
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(fs.statSync(actual).size));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  const stream = fs.createReadStream(actual);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  if (info.isZipEntry)
    stream.on('close', () => {
      setTimeout(() => cleanupExtractTempFile(actual).catch(() => {}), 1000);
    });
  stream.pipe(res);
}

module.exports = { sendModelFile };
