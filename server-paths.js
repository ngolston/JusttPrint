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
  'node_modules', 'scripts', 'tests', 'build', 'dist', 'helper', 'chrome-extension', 'src',
  'data', 'certs', 'test-results', 'playwright-report'
]);

const STATIC_BLOCKED_FILES = new Set([
  'main.js', 'preload.js', 'input-dialog-preload.js', 'db-repair.js', 'server-auth.js',
  'server-paths.js', 'server-tls.js', 'mcp-server.js', 'scan-worker.js',
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
 * Where a path really points: follows symlinks. For a path that does not exist yet,
 * resolves the nearest existing parent and keeps the rest.
 */
function realLocation(filePath, realpath) {
  if (!realpath) return filePath;
  let current = String(filePath);
  const rest = [];
  for (let depth = 0; depth < 128; depth++) {
    try {
      const real = realpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (_) {
      const parent = path.dirname(current);
      if (parent === current) return filePath;
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return filePath;
}

/** Inside a root both as written and after following symlinks. */
function isInsideRoots(filePath, roots, realpath) {
  if (!roots.some((root) => isInsideOrSame(filePath, root))) return false;
  if (!realpath) return true;
  const real = realLocation(filePath, realpath);
  return roots.some((root) => isInsideOrSame(real, realLocation(root, realpath)));
}

/**
 * @param {string} filePath Absolute path requested by the client (zip entries: the archive path).
 * @param {object} ctx
 * @param {string[]} ctx.roots Library folders (scanned directories, STL Home, last scan).
 * @param {(filePath: string) => boolean} [ctx.isKnownModel] Exact match against stored models.
 * @param {string} [ctx.generatedDir] Folder where backups and exports are written.
 * @param {(filePath: string) => boolean} [ctx.isExtractTemp] The app's own zip-extract temp files.
 * @param {(filePath: string) => string} [ctx.realpath] Follows symlinks (fs.realpathSync). Without it, paths are compared as written.
 */
function isLibraryPathAllowed(filePath, { roots = [], isKnownModel = () => false, generatedDir = '', isExtractTemp = () => false, realpath = null } = {}) {
  const raw = String(filePath || '');
  if (!raw || raw.includes('\0')) return false;
  if (isInsideRoots(raw, roots, realpath)) return true;
  if (isExtractTemp(raw)) return true;
  if (generatedDir && compareKey(path.dirname(raw)) === compareKey(generatedDir) && SERVER_GENERATED_FILE.test(path.basename(raw))) {
    return true;
  }
  try {
    return !!isKnownModel(raw);
  } catch (_) {
    return false;
  }
}

/** Folders that may never become a library root or a move/extract destination. */
const SYSTEM_DIRECTORIES = [
  '/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root',
  '/run', '/sbin', '/sys', '/usr', '/var', '/app',
  'C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'
];

/**
 * Path arguments of IPC channels that browsers and MCP clients may call, by argument index.
 * - file / files: existing library files (zip entries are checked by their archive)
 * - dir: an existing library folder (move or extract destination)
 * - scanDir: a folder that becomes part of the library; anything but system and app folders
 * - blocked: acts on the server's own desktop; never allowed over the network
 */
const NETWORK_IPC_PATH_RULES = {
  'scan-directory': [[0, 'scanDir']],
  'save-directory': [[0, 'scanDir']],
  'save-thumbnail': [[0, 'file']],
  'check-files-exist': [[0, 'files']],
  'trash-file': [[0, 'file']],
  'delete-file': [[0, 'file']],
  'show-context-menu': [[0, 'contextFiles']],
  get3MFImages: [[0, 'file']],
  getLYSImages: [[0, 'file']],
  getF3DImages: [[0, 'file']],
  getChituboxImages: [[0, 'file']],
  getVoxlImages: [[0, 'file']],
  get3MFSTL: [[0, 'file']],
  'read-model-file': [[0, 'file']],
  'parse-3mf-preview': [[0, 'file']],
  'pull-3mf-metadata': [[0, 'files']],
  'extract-model-from-zip': [[0, 'file']],
  'extract-zip-archive': [[0, 'file'], [1, 'dir']],
  'calculate-file-hash': [[0, 'file']],
  'get-all-thumbnails': [[0, 'file']],
  'add-thumbnail': [[0, 'file']],
  'add-multiple-thumbnails': [[0, 'file']],
  'set-default-thumbnail': [[0, 'file']],
  'delete-thumbnail': [[0, 'file']],
  'generate-tags': [[0, 'file']],
  'get-file-stats': [[0, 'file']],
  'move-files': [[0, 'files'], [1, 'dir']],
  'organize-library-preview': [[0, 'organize']],
  'organize-library-run': [[0, 'organize']],
  'show-item-in-folder': 'blocked',
  'open-path': 'blocked',
  'open-model-viewer': 'blocked'
};

/** Same idea for MCP tools, keyed by argument name. `dest` is a file the tool writes. */
const MCP_TOOL_PATH_RULES = {
  check_files_exist: [['filePaths', 'files']],
  pull_3mf_metadata: [['filePath', 'file'], ['filePaths', 'files']],
  generate_tags: [['filePath', 'file']],
  set_thumbnail: [['filePath', 'file']],
  add_thumbnail: [['filePath', 'file']],
  set_default_thumbnail: [['filePath', 'file']],
  delete_thumbnail: [['filePath', 'file']],
  scan_directory: [['directory', 'scanDir']],
  remove_model: [['filePath', 'file'], ['filePaths', 'files']],
  trash_file: [['filePath', 'file'], ['filePaths', 'files']],
  open_in_slicer: [['filePath', 'file'], ['filePaths', 'files']],
  move_files: [['filePaths', 'files'], ['destinationFolder', 'dir']],
  export_library: [['destPath', 'dest']],
  backup_database: [['destPath', 'dest']]
};

function isSystemDirectory(dir) {
  const key = compareKey(dir);
  return SYSTEM_DIRECTORIES.some((systemDir) => {
    const systemKey = compareKey(systemDir);
    // "/" and drive roots only block themselves; the rest block everything inside.
    if (systemKey === '' || systemKey === '/' || /^[a-z]:$/.test(systemKey)) return key === systemKey || key === '';
    return key === systemKey || key.startsWith(systemKey + '/');
  });
}

/**
 * Throws when a network caller passes a path it may not touch.
 * @param {string} kind file | files | contextFiles | dir | scanDir | dest
 * @param {*} value The argument value.
 * @param {object} ctx Same as isLibraryPathAllowed, plus appDir and dataDir (never valid roots).
 */
function assertNetworkPathAllowed(kind, value, ctx) {
  if (value === undefined || value === null || value === '') return;
  const libraryFile = (filePath) => {
    const text = String(filePath || '');
    if (text.startsWith('url::')) return; // Link-only model, no file on disk.
    const archive = text.includes('::') ? text.split('::')[0] : text;
    if (!isLibraryPathAllowed(archive, ctx) && !isLibraryPathAllowed(text, ctx)) {
      throw new Error(`Path is outside the library folders: ${text}`);
    }
  };
  const blockedRoot = (dir) => [dir, realLocation(dir, ctx.realpath)].some((candidate) => isSystemDirectory(candidate)
    || (ctx.appDir && isInsideOrSame(candidate, ctx.appDir))
    || (ctx.dataDir && isInsideOrSame(candidate, ctx.dataDir)));

  switch (kind) {
    case 'file':
      libraryFile(value);
      return;
    case 'files':
      (Array.isArray(value) ? value : [value]).forEach(libraryFile);
      return;
    case 'contextFiles': {
      const list = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.filePaths)
        ? value.filePaths
        : value;
      (Array.isArray(list) ? list : [list]).forEach(libraryFile);
      return;
    }
    case 'dir':
      if (!isInsideRoots(value, ctx.roots || [], ctx.realpath) || blockedRoot(value)) {
        throw new Error(`Folder is outside the library folders: ${value}`);
      }
      return;
    case 'scanDir':
      if (typeof value !== 'string' || blockedRoot(value)) {
        throw new Error(`This folder cannot be scanned from the web: ${value}`);
      }
      return;
    case 'organize':
      // The organizer checks that the source is scanned; the destination may be a new folder.
      if (value && value.destDir && blockedRoot(value.destDir)) {
        throw new Error(`Cannot organize into this folder: ${value.destDir}`);
      }
      return;
    case 'dest': {
      const parent = path.dirname(String(value));
      const inLibrary = isInsideRoots(parent, ctx.roots || [], ctx.realpath);
      const inData = ctx.generatedDir && compareKey(parent) === compareKey(ctx.generatedDir);
      if ((!inLibrary && !inData) || (inLibrary && blockedRoot(parent))) {
        throw new Error(`Can only write inside the library folders or the data folder: ${value}`);
      }
      return;
    }
    default:
      throw new Error(`Unknown path rule: ${kind}`);
  }
}

/** Check an IPC call that arrived over the WebSocket. */
function assertNetworkIpcArgs(channel, args, ctx) {
  const rules = NETWORK_IPC_PATH_RULES[channel];
  if (!rules) return;
  if (rules === 'blocked') throw new Error(`${channel} is only available in the desktop app`);
  const list = Array.isArray(args) ? args : [];
  for (const [index, kind] of rules) assertNetworkPathAllowed(kind, list[index], ctx);
}

/** Check an MCP tool call. */
function assertMcpToolArgs(toolName, args, ctx) {
  const rules = MCP_TOOL_PATH_RULES[toolName];
  if (!rules) return;
  const values = args && typeof args === 'object' ? args : {};
  for (const [key, kind] of rules) assertNetworkPathAllowed(kind, values[key], ctx);
}

module.exports = {
  isServableStaticPath,
  isLibraryPathAllowed,
  isInsideOrSame,
  isSystemDirectory,
  assertNetworkPathAllowed,
  assertNetworkIpcArgs,
  assertMcpToolArgs,
  NETWORK_IPC_PATH_RULES,
  MCP_TOOL_PATH_RULES
};
