'use strict';

/**
 * Uploads from the browser into a library folder (Library → Upload, or drop files on the page).
 *
 * `POST /api/upload?folder=<library folder>&name=<file name>` with the file as the request body
 * (any content type; it is streamed to disk, never held in memory). Editors and admins only.
 * The folder must be inside the library (server-paths.js, rule `dir`), the name a plain file
 * name of a type the library scans, and the size within JUSTTPRINT_MAX_UPLOAD_MB (default
 * 2048). The file is written to a hidden temp file next to its destination, then linked to
 * its name without replacing anything: "Benchy.stl" becomes "Benchy (2).stl" when taken.
 *
 * After a batch, the browser calls the `add-uploaded-files` action (ipc/uploads.js), which scans
 * that folder so the new models appear (and get thumbnails) straight away.
 *
 * Answers: 200 { fileName, filePath, size }, 400 bad name or type, 403 role or folder,
 * 413 too large, 500 write failed; all errors as { error }.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const database = require('../core/database');
const { assertNetworkPathAllowed, isInsideOrSame } = require('./server-paths');
const { networkPathContext } = require('./path-context');

const DEFAULT_MAX_UPLOAD_MB = 2048;
const MAX_NAME_LENGTH = 200;

function maxUploadBytes(env = process.env) {
  const mb = Number(env.JUSTTPRINT_MAX_UPLOAD_MB);
  return Math.round((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024);
}

/** File types an upload may have: the ones the library scans (Settings → File Types), and ZIP when on. */
function allowedUploadExtensions() {
  const { getSupportedExtensionsForLibrary } = require('./ipc/models');
  const extensions = new Set(getSupportedExtensionsForLibrary(database.db));
  const zip = database.db && database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
  if (zip && zip.value === '1') extensions.add('.zip');
  return [...extensions].sort();
}

/** The name to save under, or throws: a plain file name (no folders), not hidden, of an allowed type. */
function checkUploadName(name, extensions) {
  const text = String(name || '').normalize('NFC').trim();
  if (!text) throw new Error('The file has no name');
  if (/[/\\\0]/.test(text) || text === '.' || text === '..') throw new Error(`Not a plain file name: ${text}`);
  if (text.startsWith('.')) throw new Error(`Hidden files are not uploaded: ${text}`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`The file name has control characters: ${text}`);
  if (text.length > MAX_NAME_LENGTH) throw new Error('The file name is too long');
  const ext = path.extname(text).toLowerCase();
  if (!extensions.includes(ext)) {
    throw new Error(`${text}: the library does not scan ${ext ? `${ext} files` : 'files without an extension'}. Settings → File Types lists the types it can scan.`);
  }
  return text;
}

/** "Benchy.stl", then "Benchy (2).stl", "Benchy (3).stl", ... */
function candidateName(name, n) {
  if (n <= 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/**
 * Give the finished temp file its name without replacing an existing file. A hard link fails
 * when the name is taken; where links are not supported (some network shares), the name is
 * checked first and the file renamed.
 */
function placeWithoutReplacing(tempPath, folder, name) {
  for (let n = 1; n < 1000; n++) {
    const target = path.join(folder, candidateName(name, n));
    try {
      fs.linkSync(tempPath, target);
      fs.unlinkSync(tempPath);
      return target;
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(error.code)) throw error;
      if (fs.existsSync(target)) continue;
      fs.renameSync(tempPath, target);
      return target;
    }
  }
  throw new Error(`Too many files named like ${name}`);
}

/** Stream a request body to `tempPath`, failing once it passes `maxBytes`. Resolves with the size. */
function writeBody(req, tempPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const out = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o644 });
    const fail = (error) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error(`The file is larger than the upload limit (${Math.round(maxBytes / 1024 / 1024)} MB)`);
        error.status = 413;
        fail(error);
      }
    });
    req.on('aborted', () => fail(new Error('The upload was cancelled')));
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (!failed) resolve(size); });
    req.pipe(out);
  });
}

/** The library root a folder belongs to (the deepest one that contains it). */
function rootFor(folder, roots) {
  return roots.filter((root) => isInsideOrSame(folder, root)).sort((a, b) => b.length - a.length)[0] || folder;
}

function checkFolder(folder, ctx) {
  const dir = String(folder || '');
  if (!dir) throw new Error('Choose a library folder to upload into');
  assertNetworkPathAllowed('dir', dir, ctx);
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (_) {
    throw new Error(`The folder does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  return dir;
}

async function handleUpload(req, res) {
  const send = (status, body) => {
    if (!res.headersSent) res.status(status).json(body);
  };
  const maxBytes = maxUploadBytes();
  let folder;
  let name;
  try {
    folder = checkFolder(req.query.folder, networkPathContext());
    name = checkUploadName(req.query.name, allowedUploadExtensions());
  } catch (error) {
    req.resume();
    send(/outside the library/.test(error.message) ? 403 : 400, { error: error.message });
    return;
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    send(413, { error: `The file is larger than the upload limit (${Math.round(maxBytes / 1024 / 1024)} MB)` });
    return;
  }

  // Hidden (dot) and not a model type, so scans and folder watching ignore it until it is done.
  const tempPath = path.join(folder, `.${crypto.randomBytes(8).toString('hex')}.justtprint-upload`);
  try {
    const size = await writeBody(req, tempPath, maxBytes);
    const filePath = placeWithoutReplacing(tempPath, folder, name);
    console.log(`[Upload] ${req.user ? req.user.username : '?'} uploaded ${filePath} (${size} bytes)`);
    send(200, { success: true, fileName: path.basename(filePath), filePath, size });
  } catch (error) {
    fs.promises.unlink(tempPath).catch(() => {});
    console.warn(`[Upload] ${name} into ${folder} failed: ${error.message}`);
    send(error.status || 500, { error: error.message });
    if (error.status === 413) req.resume();
  }
}

/**
 * Mount the upload route. Call after requireAuth and before any body parser.
 * @param {object} deps
 * @param {(role: string) => Function} deps.requireRole
 */
function registerUploadRoutes(expressApp, { requireRole }) {
  expressApp.post('/api/upload', requireRole('editor'), (req, res) => {
    handleUpload(req, res).catch((error) => {
      console.error('[Upload] Unexpected error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
    });
  });
}

module.exports = {
  registerUploadRoutes,
  allowedUploadExtensions,
  checkFolder,
  checkUploadName,
  candidateName,
  placeWithoutReplacing,
  maxUploadBytes,
  rootFor,
  writeBody
};
