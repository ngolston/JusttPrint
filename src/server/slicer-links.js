'use strict';

/**
 * Open in OrcaSlicer without the helper. OrcaSlicer handles `orcaslicer://open?file=<address>`
 * itself (on Windows it registers the link type at every start, on macOS its app bundle does):
 * it downloads the file from the address and opens it on the plate. It names the download after
 * the last part of the address, so each file gets an address of its own that ends in its name:
 *
 *   GET /api/slicer-file/<token>/<file name>
 *
 * A token is for one file and works for 30 minutes (OrcaSlicer may ask again to resume). It
 * needs no login, because OrcaSlicer has no session; it is 128 random bits and only made for a
 * logged-in user who may download the file. Mounted before requireAuth.
 */

const crypto = require('crypto');
const path = require('path');
const { parseZipPath } = require('../core/library-paths');
const { sendModelFile } = require('./model-file');

const TOKEN_TTL_MS = 30 * 60 * 1000;
/** OrcaSlicer opens one file per link; more than this is better sent with the helper. */
const MAX_FILES = 10;
/** The scheme a slicer entry's path holds to open with OrcaSlicer's own links. */
const ORCA_LINK_PATH = 'orcaslicer://';

const links = new Map(); // token -> { filePath, expires }

function isOrcaLinkSlicer(slicer) {
  return !!slicer && /^orcaslicer:\/\//i.test(String(slicer.path || '').trim());
}

/**
 * The file name in the address: the model's own name with only letters, digits, dots, dashes and
 * underscores (OrcaSlicer saves the download under it), keeping the extension it opens by.
 */
function linkFileName(filePath) {
  const info = parseZipPath(filePath);
  const base = path.basename(info.isZipEntry ? info.entryPath : filePath);
  const ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const stem = base.slice(0, base.length - path.extname(base).length)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return `${(stem || 'model').slice(0, 120)}${ext}`;
}

function sweep(now) {
  for (const [token, entry] of links) if (entry.expires <= now) links.delete(token);
}

/** One address per file, for the logged-in user's browser to hand to OrcaSlicer. */
function issueSlicerFileLinks(filePaths, now = Date.now()) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter((p) => typeof p === 'string' && p);
  if (!paths.length) throw new Error('No model files to open in the slicer');
  if (paths.length > MAX_FILES) {
    throw new Error(`OrcaSlicer opens up to ${MAX_FILES} files at a time from JusttPrint. Select fewer, or add OrcaSlicer with its path to use the helper.`);
  }
  sweep(now);
  return paths.map((filePath) => {
    const token = crypto.randomBytes(16).toString('base64url');
    links.set(token, { filePath, expires: now + TOKEN_TTL_MS });
    return { token, name: linkFileName(filePath) };
  });
}

function registerSlicerFileRoutes(expressApp) {
  expressApp.get('/api/slicer-file/:token/:name', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const entry = links.get(String(req.params.token || ''));
    if (!entry || entry.expires <= Date.now()) {
      res.status(404).type('text/plain').send('This slicer link has expired. Open the model in the slicer from JusttPrint again.');
      return;
    }
    console.log(`[Slicer] OrcaSlicer is downloading ${linkFileName(entry.filePath)}`);
    sendModelFile(res, entry.filePath).catch((error) => {
      console.error('[Slicer] Download failed:', error.message);
      if (!res.headersSent) res.status(500).type('text/plain').send('Could not read the file');
    });
  });
}

module.exports = { ORCA_LINK_PATH, MAX_FILES, isOrcaLinkSlicer, linkFileName, issueSlicerFileLinks, registerSlicerFileRoutes, _links: links };
