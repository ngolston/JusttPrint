'use strict';

/**
 * Which files the HTTP server may hand out.
 *
 * - Static files: only web assets, never server code, config, secrets or node_modules.
 * - Library files (/api/file, /api/download): only paths inside a library root,
 *   paths stored as models, or backup/export files the server just wrote.
 */

const path = require('path');

const STATIC_EXTENSIONS = new Set([
  '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.webmanifest', '.wasm', '.woff', '.woff2', '.ttf'
]);

/** Top-level folders and files that are never served, even with an allowed extension. */
const STATIC_BLOCKED_TOP = new Set([
  'node_modules', 'scripts', 'tests', 'build', 'dist', 'helper', 'chrome-extension',
  'data', 'certs', 'test-results', 'playwright-report'
]);

const STATIC_BLOCKED_FILES = new Set([
  'main.js', 'preload.js', 'input-dialog-preload.js', 'db-repair.js', 'server-auth.js',
  'server-paths.js', 'server-tls.js', 'mcp-server.js', 'support-logs.js', 'scan-worker.js',
  'extension-inbox.js', 'playwright.config.js', 'vitest.config.js'
]);

const SERVER_GENERATED_FILE = /^printventory-(backup|library)-[\w.-]+\.(db|json|zip)$/i;

/** True when a URL path may be served from the app folder. */
function isServableStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || ''));
  } catch (_) {
    return false;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (!segments.length) return true; // "/" is handled by the index route.
  if (segments.some((segment) => segment.startsWith('.') || segment.includes('\\'))) return false;
  if (STATIC_BLOCKED_TOP.has(segments[0])) return false;
  if (segments.length === 1 && STATIC_BLOCKED_FILES.has(segments[0])) return false;
  if (/\.test\.js$|\.spec\.js$/i.test(decoded)) return false;
  return STATIC_EXTENSIONS.has(path.extname(decoded).toLowerCase());
}

function compareKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const isWindowsLike = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
  const resolved = isWindowsLike ? path.win32.resolve(raw) : path.posix.resolve(raw);
  const slashed = resolved.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsLike || process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

function isInsideOrSame(filePath, directory) {
  const file = compareKey(filePath);
  const dir = compareKey(directory);
  if (!file || !dir) return false;
  return file === dir || file.startsWith(dir + '/');
}

/**
 * @param {string} filePath Absolute path requested by the client (zip entries: the archive path).
 * @param {object} ctx
 * @param {string[]} ctx.roots Library folders (scanned directories, STL Home, last scan).
 * @param {(filePath: string) => boolean} [ctx.isKnownModel] Exact match against stored models.
 * @param {string} [ctx.generatedDir] Folder where backups and exports are written.
 */
function isLibraryPathAllowed(filePath, { roots = [], isKnownModel = () => false, generatedDir = '' } = {}) {
  const raw = String(filePath || '');
  if (!raw || raw.includes('\0')) return false;
  if (roots.some((root) => isInsideOrSame(raw, root))) return true;
  if (generatedDir && compareKey(path.dirname(raw)) === compareKey(generatedDir) && SERVER_GENERATED_FILE.test(path.basename(raw))) {
    return true;
  }
  try {
    return !!isKnownModel(raw);
  } catch (_) {
    return false;
  }
}

module.exports = {
  isServableStaticPath,
  isLibraryPathAllowed,
  isInsideOrSame
};
