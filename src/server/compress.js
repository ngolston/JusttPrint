'use strict';

/**
 * Smaller and fewer downloads for the browser (9.6):
 * - The app's text files (JavaScript, CSS, HTML, SVG, JSON, WebAssembly) are sent compressed
 *   (Brotli, else gzip) when the browser accepts it. Each file is compressed once and kept in memory
 *   until it changes on disk.
 * - Files whose name carries the build's fingerprint (app-<hash>.js, chunks, app.css?v=<build>)
 *   never change under that name, so browsers and Cloudflare may keep them for a year; a new
 *   release asks for new names. Other files are checked again each time, as before.
 * - The API's JSON answers over 1 KB are sent compressed too (api.js).
 * Model files and pictures are left alone: they are compressed already, or large and streamed.
 */

const fs = require('fs');
const zlib = require('zlib');

const TEXT_FILE = /\.(js|mjs|css|html|svg|json|webmanifest|wasm|txt|map)$/i;
/** Built files named after their contents by vite (name-<8+ characters>.ext). */
const FINGERPRINTED = /-[A-Za-z0-9_-]{8,}\.(js|mjs|css|wasm|woff2?|png|svg)$/;
const MIN_BYTES = 1024;
const YEAR = 'public, max-age=31536000, immutable';

/** The encoding to use for this request: 'br', 'gzip' or null. */
function encodingFor(req) {
  const accepted = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

function compressBuffer(buffer, encoding) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length }
    });
  }
  return zlib.gzipSync(buffer, { level: 6 });
}

/** Compressed static files: path → { mtimeMs, size, br?, gzip? }. */
const fileCache = new Map();
const MAX_CACHED_FILES = 200;

/** The file compressed with `encoding`, made once per change of the file. */
function compressedFile(filePath, stat, encoding) {
  let entry = fileCache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    entry = { mtimeMs: stat.mtimeMs, size: stat.size };
    if (fileCache.size >= MAX_CACHED_FILES) fileCache.delete(fileCache.keys().next().value);
    fileCache.set(filePath, entry);
  }
  if (!entry[encoding]) entry[encoding] = compressBuffer(fs.readFileSync(filePath), encoding);
  return entry[encoding];
}

/** How long the browser may keep a static file (see the top). */
function cacheControlFor(urlPath, query) {
  if (FINGERPRINTED.test(urlPath)) return YEAR;
  if (/\/app\.css$/.test(urlPath) && query && query.v) return YEAR;
  return 'no-cache';
}

/**
 * Send a static file of the app: compressed when it is text and the browser accepts it, with
 * its cache time. Answers false when it was not handled here (the caller sends it as before).
 */
function sendStatic(req, res, filePath) {
  const cache = cacheControlFor(req.path, req.query);
  if (cache !== 'no-cache' || /\.(js|css|html|webmanifest)$/i.test(filePath)) res.setHeader('Cache-Control', cache);
  const encoding = TEXT_FILE.test(filePath) ? encodingFor(req) : null;
  if (!encoding) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return false;
  }
  if (!stat.isFile() || stat.size < MIN_BYTES) return false;
  const etag = `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}-${encoding}"`;
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  let body;
  try {
    body = compressedFile(filePath, stat, encoding);
  } catch (_) {
    return false;
  }
  res.type(filePath.replace(/^.*\./, '.'));
  if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
  res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', body.length);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
  return true;
}

/**
 * Send an answer's JSON text: over 1 KB, gzip-compressed when the browser accepts it (gzip is
 * quicker than Brotli for answers made each time, and nearly as small).
 */
function sendJsonText(req, res, text) {
  res.type('application/json');
  if (text.length < MIN_BYTES || !encodingFor(req)) return res.send(text);
  const body = zlib.gzipSync(Buffer.from(text), { level: 5 });
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Content-Length', body.length);
  return res.end(body);
}

module.exports = { sendJsonText, sendStatic, cacheControlFor, encodingFor, FINGERPRINTED };
