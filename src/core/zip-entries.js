'use strict';

const fs = require('fs');
const path = require('path');
const fflate = require('fflate');
const { getScanExcludeNames } = require('./library-paths');
const { EXTRACT_TEMP_FILE_PREFIX, ensureExtractTempDir } = require('./extract-temp');
const { shouldSkipEntryPath } = require('./scan-skip');
const { extractZipEntryBuffer } = require('./zip-extract');

// Skip macOS resource-fork / AppleDouble entries (._*) and __MACOSX metadata — not valid models
function isMacOsResourceForkEntry(entryPath) {
  return shouldSkipEntryPath(entryPath, getScanExcludeNames());
}

// Minimum ZIP is 22 bytes (end-of-central-directory). 3MF is ZIP-based (starts with PK).
function isLikelyValidZipBuffer(data) {
  if (!Buffer.isBuffer(data) || data.length < 22) return false;
  return data[0] === 0x50 && data[1] === 0x4b; // PK
}

// Helper function to extract model from zip to temp file or specified destination
async function extractModelFromZip(zipPath, entryPath, destinationPath = null) {
  const entryData = await extractZipEntryBuffer(zipPath, entryPath);

  if (destinationPath) {
    // Extract to specified destination, preserving directory structure
    const destPath = path.join(destinationPath, entryPath);
    const destDir = path.dirname(destPath);
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.writeFile(destPath, entryData);
    return destPath;
  }

  // Always OS temp subdirectory — never adjacent to the zip / library
  const tempDir = ensureExtractTempDir();
  const fileName = path.basename(entryPath).replace(/[<>:"|?*]/g, '_');
  const tempPath = path.join(tempDir, `${EXTRACT_TEMP_FILE_PREFIX}${Date.now()}_${fileName}`);
  await fs.promises.writeFile(tempPath, entryData);
  return tempPath;
}

/**
 * Open a zip held in memory (3MF files are zips). Lists the entries without decompressing
 * them; an entry is decompressed when it is read. Throws when the data is not a zip.
 * @returns {{ files: Object<string, { name: string, dir: boolean, size: number, read: (type?: 'nodebuffer'|'string'|'base64') => Buffer|string }> }}
 */
function openZip(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const files = {};
  fflate.unzipSync(bytes, {
    filter(info) {
      files[info.name] = {
        name: info.name,
        dir: info.name.endsWith('/'),
        size: info.originalSize,
        read(type = 'nodebuffer') {
          const out = fflate.unzipSync(bytes, { filter: (entry) => entry.name === info.name })[info.name];
          const buffer = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
          if (type === 'string') return buffer.toString('utf8');
          if (type === 'base64') return buffer.toString('base64');
          return buffer;
        }
      };
      return false;
    }
  });
  return { files };
}

/** Locate main model part in a 3MF zip (openZip contents). Handles alternate paths/casing. */
function find3dModelZipEntry(contents) {
  if (!contents || !contents.files) return null;
  const preferred = ['3D/3dmodel.model', '/3D/3dmodel.model'];
  for (const p of preferred) {
    const f = contents.files[p];
    if (f && !f.dir) return f;
  }
  for (const key of Object.keys(contents.files)) {
    const f = contents.files[key];
    if (f.dir) continue;
    const norm = key.replace(/\\/g, '/');
    if (/(^|\/)3dmodel\.model$/i.test(norm)) return f;
  }
  return null;
}

module.exports = { extractModelFromZip, find3dModelZipEntry, isLikelyValidZipBuffer, isMacOsResourceForkEntry, openZip };
