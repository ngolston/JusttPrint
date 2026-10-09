'use strict';

/**
 * Which files the HTTP server may hand out.
 *
 * - Static files: only web assets from the web folders (STATIC_FOLDERS), never server code,
 *   config, secrets or node_modules.
 * - Library files (/api/file, /api/download): only paths inside a library root,
 *   paths stored as models, or backup/export files the server just wrote.
 */

const fs = require('fs');
const path = require('path');

const STATIC_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webmanifest',
  '.wasm',
  '.woff',
  '.woff2',
  '.ttf'
]);

/**
 * The only folders the server hands files out from, by URL prefix ('' is the site root). Nothing
 * else in the app folder (server code, config, node_modules, tests) has a URL.
 */
const STATIC_FOLDERS = [
  { prefix: '', dir: 'src/web/public' }, // the page, service worker, manifest, Puter sign-in, guide images
  { prefix: '', dir: 'src/shared' }, // scripts the page and the server both use
  { prefix: 'assets', dir: 'assets' },
  { prefix: 'vendor', dir: 'vendor' },
  { prefix: 'web-build', dir: 'web-build' }
];

const APP_DIR = path.join(__dirname, '..', '..');

const SERVER_GENERATED_FILE = /^justtprint-(backup|library)-[\w.-]+\.(db|json|zip)$/i;
/** Automatic backups (src/server/auto-backup.js), in their own folder. */
const AUTO_BACKUP_FILE = /^justtprint-auto-\d{8}-\d{6}(-\d+)?\.db$/;

/** URL path segments when the path names a web asset (extension, no dot-segments), else null. */
function staticPathSegments(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || ''));
  } catch (_) {
    return null;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (!segments.length) return null; // "/" is handled by the index route.
  if (segments.some((segment) => segment.startsWith('.') || segment.includes('\\'))) return null;
  if (/\.test\.js$|\.spec\.js$/i.test(decoded)) return null;
  if (!STATIC_EXTENSIONS.has(path.extname(decoded).toLowerCase())) return null;
  return segments;
}

/** The file a URL path serves from STATIC_FOLDERS, or null. */
function staticFilePath(urlPath, appDir = APP_DIR) {
  const segments = staticPathSegments(urlPath);
  if (!segments) return null;
  for (const { prefix, dir } of STATIC_FOLDERS) {
    if (prefix && segments[0] !== prefix) continue;
    const rest = prefix ? segments.slice(1) : segments;
    if (!rest.length) continue;
    const root = path.join(appDir, dir);
    const file = path.join(root, ...rest);
    if (!file.startsWith(root + path.sep)) continue;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch (_) {
      // Not in this folder.
    }
  }
  return null;
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
 * Where library paths may point.
 * @typedef {object} LibraryPathContext
 * @property {string[]} [roots] Library folders (scanned directories, STL Home, last scan).
 * @property {(filePath: string) => boolean} [isKnownModel] Exact match against stored models.
 * @property {string} [generatedDir] Folder where backups and exports are written.
 * @property {string} [autoBackupDir] Folder of the automatic backups (justtprint-auto-*.db only).
 * @property {string} [downloadsDir] Folder of backups and exports made for a browser download.
 * @property {(filePath: string) => boolean} [isExtractTemp] The app's own zip-extract temp files.
 * @property {(filePath: string) => string} [realpath] Follows symlinks (fs.realpathSync). Without it, paths are compared as written.
 */

/**
 * @param {string} filePath Absolute path requested by the client (zip entries: the archive path).
 * @param {LibraryPathContext} [ctx]
 */
function isLibraryPathAllowed(
  filePath,
  { roots = [], isKnownModel = () => false, generatedDir = '', autoBackupDir = '', downloadsDir = '', isExtractTemp = () => false, realpath = null } = {}
) {
  const raw = String(filePath || '');
  if (!raw || raw.includes('\0')) return false;
  if (isInsideRoots(raw, roots, realpath)) return true;
  if (isExtractTemp(raw)) return true;
  if (generatedDir && compareKey(path.dirname(raw)) === compareKey(generatedDir) && SERVER_GENERATED_FILE.test(path.basename(raw))) {
    return true;
  }
  if (autoBackupDir && compareKey(path.dirname(raw)) === compareKey(autoBackupDir) && AUTO_BACKUP_FILE.test(path.basename(raw))) {
    return true;
  }
  if (downloadsDir && compareKey(path.dirname(raw)) === compareKey(downloadsDir) && SERVER_GENERATED_FILE.test(path.basename(raw))) {
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
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var',
  '/app',
  'C:\\',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData'
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
  'calculate-file-hash': [[0, 'file']],
  'get-all-thumbnails': [[0, 'file']],
  'add-thumbnail': [[0, 'file']],
  'add-multiple-thumbnails': [[0, 'file']],
  'set-default-thumbnail': [[0, 'file']],
  'delete-thumbnail': [[0, 'file']],
  'get-file-stats': [[0, 'file']],
  'move-files': [
    [0, 'files'],
    [1, 'dir']
  ],
  'add-uploaded-files': [[0, 'dir']],
  'add-to-collection': [[1, 'files']],
  'organize-library-preview': [[0, 'organize']],
  'organize-library-run': [[0, 'organize']],
  'show-item-in-folder': 'blocked',
  'open-path': 'blocked'
};

/** Same idea for MCP tools, keyed by argument name. `dest` is a file the tool writes. */
const MCP_TOOL_PATH_RULES = {
  check_files_exist: [['filePaths', 'files']],
  pull_3mf_metadata: [
    ['filePath', 'file'],
    ['filePaths', 'files']
  ],
  generate_tags: [['filePath', 'file']],
  set_thumbnail: [['filePath', 'file']],
  add_thumbnail: [['filePath', 'file']],
  set_default_thumbnail: [['filePath', 'file']],
  delete_thumbnail: [['filePath', 'file']],
  scan_directory: [['directory', 'scanDir']],
  import_model_links: [['downloadFolder', 'dir']],
  remove_model: [
    ['filePath', 'file'],
    ['filePaths', 'files']
  ],
  trash_file: [
    ['filePath', 'file'],
    ['filePaths', 'files']
  ],
  open_in_slicer: [
    ['filePath', 'file'],
    ['filePaths', 'files']
  ],
  move_files: [
    ['filePaths', 'files'],
    ['destinationFolder', 'dir']
  ],
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
 * @param {LibraryPathContext & { appDir?: string, dataDir?: string }} ctx Same as isLibraryPathAllowed, plus appDir and dataDir (never valid roots).
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
  const blockedRoot = (dir) =>
    [dir, realLocation(dir, ctx.realpath)].some(
      (candidate) =>
        isSystemDirectory(candidate) || (ctx.appDir && isInsideOrSame(candidate, ctx.appDir)) || (ctx.dataDir && isInsideOrSame(candidate, ctx.dataDir))
    );

  switch (kind) {
    case 'file':
      libraryFile(value);
      return;
    case 'files':
      (Array.isArray(value) ? value : [value]).forEach(libraryFile);
      return;
    case 'contextFiles': {
      const list = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.filePaths) ? value.filePaths : value;
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
  staticFilePath,
  isLibraryPathAllowed,
  isInsideOrSame,
  isSystemDirectory,
  assertNetworkPathAllowed,
  assertNetworkIpcArgs,
  assertMcpToolArgs,
  NETWORK_IPC_PATH_RULES,
  MCP_TOOL_PATH_RULES
};
