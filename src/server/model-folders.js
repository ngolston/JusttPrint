'use strict';

/**
 * Model folders: a folder per model, made for every upload and site download. Its model files
 * (the main file and the print profiles, site names kept) sit in the folder; pictures, videos and
 * documents in its `image`, `video` and `document` subfolders:
 *
 *   <library folder>/<Model Name>/
 *       model.3mf, Profile A.3mf, part.stl
 *       image/      cover and gallery pictures
 *       video/      video files
 *       document/   instructions, manuals, parts lists
 *       other/      any other file kept with the model (a model page's Upload: .step, .xlsx, …)
 *
 * The folders are kept in `model_folders` (with the chosen cover). Scans skip the three
 * subfolders of a model folder, so a picture or a PDF never becomes a model. The cover becomes the
 * first thumbnail of the folder's model files. YouTube videos (sites link to them; they cannot be
 * downloaded) are kept as links in `model_folder_links`, and what was downloaded from a site in
 * `model_folder_sources` (so the next download skips it).
 */

const fs = require('fs');
const path = require('path');
const database = require('../core/database');

/** The kinds of media a model folder keeps, each in its own subfolder. */
const KINDS = {
  image: {
    dir: 'image',
    label: 'Images',
    extensions: ['.avif', '.bmp', '.gif', '.jpg', '.jpeg', '.jpe', '.pjpeg', '.png', '.svg', '.tiff', '.tif', '.webp']
  },
  video: { dir: 'video', label: 'Videos', extensions: ['.mp4', '.m4v', '.mpeg', '.mpg', '.mpe', '.webm'] },
  document: { dir: 'document', label: 'Documents', extensions: ['.html', '.md', '.doc', '.docx', '.pdf', '.txt', '.text'] },
  // Any type (no list): kindOf never answers it; a file is "other" by being in other/.
  other: { dir: 'other', label: 'Other Files', extensions: /** @type {string[]} */ ([]) }
};
const KIND_NAMES = /** @type {('image' | 'video' | 'document' | 'other')[]} */ (Object.keys(KINDS));

const MIME_TYPES = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mpe': 'video/mpeg',
  '.webm': 'video/webm',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.text': 'text/plain; charset=utf-8'
};

/** Pictures a cover can be made from (browsers decode them; TIFF they do not). */
const COVER_TYPES = new Set(['.avif', '.bmp', '.gif', '.jpg', '.jpeg', '.jpe', '.pjpeg', '.png', '.svg', '.webp']);
const COVER_MAX_DIMENSION = 1024;
const COVER_QUALITY = 0.85;
/** Pictures larger than this are not read for a cover. */
const COVER_MAX_BYTES = 40 * 1024 * 1024;
/** A cover kept as it is when it cannot be made smaller (no Chromium): at most this many characters. */
const COVER_MAX_RAW_CHARS = 4_000_000;
const MAX_LIST = 500;

let readyFor = null;
function table() {
  const db = database.db;
  if (readyFor !== db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_folders (
        path TEXT PRIMARY KEY,
        cover TEXT,
        cover_thumbnail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_folder_links (
        folder TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        title TEXT,
        added_at TEXT NOT NULL,
        PRIMARY KEY (folder, kind, value)
      );
      CREATE TABLE IF NOT EXISTS model_folder_sources (
        folder TEXT NOT NULL,
        url TEXT NOT NULL,
        file_name TEXT NOT NULL,
        PRIMARY KEY (folder, url)
      );
    `);
    readyFor = db;
  }
  return db;
}

/** A folder path as kept: resolved, no trailing separator. */
const folderKey = (dir) => {
  const resolved = path.resolve(String(dir || ''));
  return resolved.length > path.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
};

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The kind of media a file name is ('image', 'video', 'document'), or null ('other' takes any name). */
function kindOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return KIND_NAMES.find((kind) => KINDS[kind].extensions.includes(ext)) || null;
}

/** Every media extension, for the upload dialog. */
const mediaExtensions = () => Object.fromEntries(KIND_NAMES.map((kind) => [kind, [...KINDS[kind].extensions]]));

function isModelFolder(dir) {
  if (!dir || !database.db) return false;
  return !!table().prepare('SELECT 1 FROM model_folders WHERE path = ?').get(folderKey(dir));
}

/** Keep a folder as a model folder (nothing changes on disk). Answers its key. */
function register(dir) {
  const key = folderKey(dir);
  table().prepare('INSERT OR IGNORE INTO model_folders (path, created_at) VALUES (?, ?)').run(key, new Date().toISOString());
  return key;
}

/** The model folder a model file is in (directly), or null. */
function folderOfFile(filePath) {
  const text = String(filePath || '');
  if (!text || text.includes('::')) return null;
  const dir = path.dirname(text);
  return isModelFolder(dir) ? folderKey(dir) : null;
}

/**
 * The media subfolders of the model folders at or under `dir` (and of the one `dir` is in), which
 * scans leave out.
 */
function mediaFolders(dir) {
  if (!database.db) return [];
  const key = folderKey(dir);
  const sep = path.sep;
  const rows = table()
    .prepare("SELECT path FROM model_folders WHERE path = ? OR path LIKE ? ESCAPE '\\'")
    .all(key, `${escapeLike(key)}${sep}%`)
    .map((row) => row.path);
  // A scan of a media folder itself (folder watching scans the folder that changed).
  const parent = path.dirname(key);
  if (SKIPPED_DIRS().includes(path.basename(key)) && isModelFolder(parent)) rows.push(folderKey(parent));
  return [...new Set(rows)].flatMap((folder) => SKIPPED_DIRS().map((name) => path.join(folder, name)));
}

/**
 * The archives/ subfolder where 7.28–8.1 kept the archives they unpacked into a model folder (unpacking is
 * gone since 8.2; the folders stay, and scans still leave them out so their archives do not count twice).
 */
const ARCHIVES_DIR = 'archives';
/** A model folder's subfolders that scans leave out: its media, and archives/. */
const SKIPPED_DIRS = () => [...KIND_NAMES.map((kind) => KINDS[kind].dir), ARCHIVES_DIR];

/**
 * Organize's Tidy into model folders: the loose pictures and documents directly in a model folder
 * go into its image/ and document/ folders ("name (2).png" when taken). Answers { images, documents }.
 */
function tidyMedia(dir) {
  const folder = register(dir);
  const out = { images: 0, documents: 0 };
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const kind = kindOf(entry.name);
    if (kind !== 'image' && kind !== 'document') continue;
    const into = path.join(folder, KINDS[kind].dir);
    fs.mkdirSync(into, { recursive: true });
    const ext = path.extname(entry.name);
    const stem = ext ? entry.name.slice(0, -ext.length) : entry.name;
    let target = path.join(into, entry.name);
    for (let n = 2; fs.existsSync(target) && n < 1000; n++) target = path.join(into, `${stem} (${n})${ext}`);
    fs.renameSync(path.join(folder, entry.name), target);
    if (kind === 'image') out.images++;
    else out.documents++;
  }
  return out;
}

/** Whether `dir` is the image, video or document subfolder of a model folder. */
function isMediaFolder(dir) {
  const key = folderKey(dir);
  return KIND_NAMES.some((kind) => KINDS[kind].dir === path.basename(key)) && isModelFolder(path.dirname(key));
}

/**
 * Where an upload of a media file goes: when `dir` is a media subfolder of a model folder (made
 * when missing), { folder, kind, extensions } (extensions null: any type, other/); else null.
 */
function mediaTarget(dir) {
  if (!dir) return null;
  const key = folderKey(dir);
  const kind = KIND_NAMES.find((name) => KINDS[name].dir === path.basename(key));
  if (!kind || !isModelFolder(path.dirname(key))) return null;
  fs.mkdirSync(key, { recursive: true });
  return { folder: key, kind, extensions: kind === 'other' ? null : [...KINDS[kind].extensions] };
}

/** "Name", "Name (2)", … for a new folder inside `parent`; made and registered. */
function makeFolder(parent, name) {
  const { folderName } = require('../core/makerworld');
  const { isInsideOrSame } = require('./server-paths');
  // Nothing usable in the name ("???"): "Model", not the MakerWorld import's default.
  const usable = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f.\s]+/g, '');
  const base = (usable && folderName(String(name).trim())) || 'Model';
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(parent, n === 1 ? base : `${base} (${n})`);
    try {
      fs.mkdirSync(candidate);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    if (!isInsideOrSame(candidate, parent)) throw new Error('Could not make a folder for the model');
    register(candidate);
    return candidate;
  }
  throw new Error('Could not make a folder for the model');
}

/** The media files of one kind in a model folder: [{ name, path, size, modified }], by name. */
function filesOf(folder, kind) {
  const dir = path.join(folder, KINDS[kind].dir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && (kind === 'other' || kindOf(entry.name) === kind))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      /** @type {fs.Stats | null} */
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch (_) {
        /* gone meanwhile */
      }
      return { name: entry.name, path: filePath, size: stat ? stat.size : 0, modified: stat ? stat.mtime.toISOString() : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, MAX_LIST);
}

/**
 * A model folder's media: { folder, isModelFolder, cover, image, video, document, youtube }.
 * `dir` may be the folder or a model file in it.
 */
function getMedia(dir) {
  const folder = resolveFolder(dir);
  const row = folder ? table().prepare('SELECT cover FROM model_folders WHERE path = ?').get(folder) : null;
  if (!folder || !row) return { folder: folder || null, isModelFolder: false, cover: null, image: [], video: [], document: [], other: [], youtube: [] };
  const image = filesOf(folder, 'image');
  return {
    folder,
    isModelFolder: true,
    cover: row.cover && image.some((file) => file.name === row.cover) ? row.cover : null,
    image,
    video: filesOf(folder, 'video'),
    document: filesOf(folder, 'document'),
    other: filesOf(folder, 'other'),
    youtube: table().prepare("SELECT value AS id, title FROM model_folder_links WHERE folder = ? AND kind = 'youtube' ORDER BY added_at, value").all(folder)
  };
}

/** The model folder for a folder or a model file in it, or null. */
function resolveFolder(dir) {
  if (!dir) return null;
  if (isModelFolder(dir)) return folderKey(dir);
  return folderOfFile(dir);
}

function requireFolder(dir) {
  const folder = resolveFolder(dir);
  if (!folder) throw new Error('Not a model folder');
  return folder;
}

/** A media file's path, checked: a plain name of the right kind, in the folder's subfolder. */
function mediaPath(folder, kind, name) {
  if (!KINDS[kind]) throw new Error(`Unknown kind: ${kind}`);
  const text = String(name || '');
  if (!text || /[/\\\0]/.test(text) || text.startsWith('.') || (kind !== 'other' && kindOf(text) !== kind)) throw new Error(`Not a ${kind} file name: ${text}`);
  return path.join(folder, KINDS[kind].dir, text);
}

/** The model files directly in a model folder (paths). */
function modelFiles(folder) {
  return database.db
    .prepare("SELECT filePath FROM models WHERE filePath LIKE ? ESCAPE '\\' AND filePath NOT LIKE '%::%'")
    .all(`${escapeLike(folder)}${path.sep}%`)
    .map((row) => row.filePath)
    .filter((filePath) => path.dirname(filePath) === folder);
}

/**
 * A picture as a thumbnail (a data URL at most 1024 px), or null when it cannot be one.
 * @param {{ resize?: Function | null }} [deps]
 */
async function coverImage(filePath, deps = {}) {
  const resize = deps.resize || null;
  const ext = path.extname(filePath).toLowerCase();
  if (!COVER_TYPES.has(ext)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size > COVER_MAX_BYTES) return null;
  const original = `data:${MIME_TYPES[ext].split(';')[0]};base64,${fs.readFileSync(filePath).toString('base64')}`;
  const resizeImage = resize || require('./thumbnail-worker').resizeImage;
  const made = await Promise.resolve()
    .then(() => resizeImage(original, COVER_MAX_DIMENSION, COVER_QUALITY))
    .catch(() => null);
  if (made && made.dataUrl && made.dataUrl.length < original.length) return made.dataUrl;
  // No Chromium (or it is not smaller): the picture itself, when the grid can show it.
  return ext !== '.svg' && original.length <= COVER_MAX_RAW_CHARS ? original : null;
}

/** Put `image` first in a model's thumbnails, instead of the folder's earlier cover `previous`. */
function putFirst(filePath, image, previous) {
  const { parseThumbnails } = require('../core/thumbnails');
  const row = database.db.prepare('SELECT thumbnail FROM models WHERE filePath = ?').get(filePath);
  const list = parseThumbnails((row && row.thumbnail) || '').filter((thumb) => thumb !== image && (!previous || thumb !== previous));
  database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(image ? [image, ...list].join('::') : list.join('::'), filePath);
}

/**
 * Make a picture the folder's cover: it becomes the first thumbnail of each of the folder's model
 * files (the earlier cover's thumbnail goes). `name` null takes the cover away. Answers getMedia.
 * @param {{ resize?: Function | null }} [deps]
 */
async function setCover(dir, name, deps = {}) {
  const folder = requireFolder(dir);
  const db = table();
  const before = db.prepare('SELECT cover_thumbnail FROM model_folders WHERE path = ?').get(folder);
  /** @type {string | null} */
  let image = null;
  if (name) {
    const filePath = mediaPath(folder, 'image', name);
    if (!fs.existsSync(filePath)) throw new Error(`No picture named ${name}`);
    image = await coverImage(filePath, deps);
    if (!image) throw new Error(`${name} cannot be a cover: browsers do not show ${path.extname(name)} pictures in the library`);
  }
  const files = modelFiles(folder);
  for (const filePath of files) putFirst(filePath, image, before && before.cover_thumbnail);
  db.prepare('UPDATE model_folders SET cover = ?, cover_thumbnail = ? WHERE path = ?').run(name || null, image, folder);
  const events = require('./events');
  // The cards show the new picture (the browser keeps their pictures until told).
  for (const filePath of files) events.broadcast('thumbnail-deleted', { filePath });
  events.broadcast('refresh-grid');
  events.broadcast('folder-changed', { path: folder });
  return getMedia(folder);
}

/**
 * The cover again on the folder's model files (after a scan added new ones, or a thumbnail job
 * gave them pictures of their own). Nothing without a cover.
 */
function reapplyCover(dir) {
  const folder = resolveFolder(dir);
  if (!folder) return;
  const row = table().prepare('SELECT cover_thumbnail FROM model_folders WHERE path = ?').get(folder);
  if (!row || !row.cover_thumbnail) return;
  for (const filePath of modelFiles(folder)) putFirst(filePath, row.cover_thumbnail, null);
}

/**
 * The first picture becomes the cover when the folder has none (after uploads and downloads).
 * `preferred` is tried first (the site's cover).
 * @param {string} dir
 * @param {{ preferred?: string | null, resize?: Function | null }} [options]
 */
async function coverIfNone(dir, { preferred = null, ...deps } = {}) {
  const folder = resolveFolder(dir);
  if (!folder) return;
  const row = table().prepare('SELECT cover FROM model_folders WHERE path = ?').get(folder);
  const images = filesOf(folder, 'image');
  if (row && row.cover && images.some((file) => file.name === row.cover)) {
    reapplyCover(folder);
    return;
  }
  const order = [...images.filter((file) => file.name === preferred), ...images.filter((file) => file.name !== preferred)];
  for (const file of order) {
    try {
      await setCover(folder, file.name, deps);
      return;
    } catch (_) {
      /* a TIFF, or too large: the next one */
    }
  }
}

/** Move a media file to the Trash. Taking away the cover picture takes away the cover. Answers getMedia. */
async function removeMedia(dir, kind, name) {
  const folder = requireFolder(dir);
  const filePath = mediaPath(folder, kind, name);
  if (!fs.existsSync(filePath)) throw new Error(`No file named ${name}`);
  await require('./runtime').shell.trashItem(filePath);
  table().prepare('DELETE FROM model_folder_sources WHERE folder = ? AND file_name = ?').run(folder, `${KINDS[kind].dir}/${name}`);
  const row = table().prepare('SELECT cover FROM model_folders WHERE path = ?').get(folder);
  if (kind === 'image' && row && row.cover === name) await setCover(folder, null);
  require('./events').broadcast('folder-changed', { path: folder });
  return getMedia(folder);
}

/** The YouTube video id in a link or an id, or null. */
function youtubeId(value) {
  const text = String(value || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (['youtube.com', 'youtube-nocookie.com', 'music.youtube.com'].includes(host)) {
    id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/) || [])[1] || null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** Keep YouTube videos (ids or links) with a model folder. Answers getMedia. */
function addYoutube(dir, values) {
  const folder = requireFolder(dir);
  const ids = (Array.isArray(values) ? values : [values]).map(youtubeId);
  if (!ids.length || ids.some((id) => !id)) throw new Error('Not a YouTube video link');
  const insert = table().prepare("INSERT OR IGNORE INTO model_folder_links (folder, kind, value, added_at) VALUES (?, 'youtube', ?, ?)");
  const now = new Date().toISOString();
  for (const id of ids) insert.run(folder, id, now);
  require('./events').broadcast('folder-changed', { path: folder });
  return getMedia(folder);
}

function removeYoutube(dir, id) {
  const folder = requireFolder(dir);
  table()
    .prepare("DELETE FROM model_folder_links WHERE folder = ? AND kind = 'youtube' AND value = ?")
    .run(folder, String(id || ''));
  require('./events').broadcast('folder-changed', { path: folder });
  return getMedia(folder);
}

/**
 * Download a file a site lists for the model (a picture, a video, a document) into the folder's
 * subfolder for its kind, under its own name (a number added when taken). Skips URLs already
 * downloaded into this folder. `name` is the file name to use (from the URL when not given);
 * a name without a media extension gets one from the answer's content type.
 * Answers the saved name, or null when skipped.
 * @param {string} dir
 * @param {string} url
 * @param {string | null} [name]
 * @param {{ fetchImpl?: Function | null, maxBytes?: number, allowedHost?: ((url: string) => boolean) | null, kind?: string | null }} [options]
 */
async function saveFromSite(dir, url, name = null, options = {}) {
  const { fetchImpl = null, maxBytes = 200 * 1024 * 1024, allowedHost = null, kind = null } = options;
  const folder = requireFolder(dir);
  const db = table();
  if (db.prepare('SELECT 1 FROM model_folder_sources WHERE folder = ? AND url = ?').get(folder, url)) return null;
  const crypto = require('crypto');
  const { httpsFetch, readLimited, USER_AGENT } = require('./link-import');
  const { placeWithoutReplacing } = require('./uploads');
  if (allowedHost && !allowedHost(url)) throw new Error(`Not downloaded from ${new URL(url).hostname}`);
  const response = await (fetchImpl || httpsFetch)(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`The site answered ${response.status}`);
  if (allowedHost && response.url && !allowedHost(response.url)) throw new Error(`Redirected to ${new URL(response.url).hostname}`);
  const type = String((response.headers && response.headers.get && response.headers.get('content-type')) || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  let fileName = plainFileName(name || decodeURIComponent(new URL(url).pathname.split('/').pop() || ''));
  if (!kindOf(fileName)) {
    const ext = Object.keys(MIME_TYPES).find((e) => MIME_TYPES[e].split(';')[0] === type);
    if (!ext) throw new Error(`Not a picture, video or document (${type || 'no type'})`);
    fileName = `${fileName || 'file'}${ext}`;
  }
  const fileKind = kindOf(fileName);
  if (!fileKind || (kind && fileKind !== kind)) throw new Error(`Not a ${kind || 'media'} file: ${fileName}`);
  // The content must be what the name says (a page instead of a picture is an error page).
  const expected = MIME_TYPES[path.extname(fileName).toLowerCase()].split(';')[0];
  const family = expected.split('/')[0];
  if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream' && !type.startsWith(`${family}/`) && type !== expected) {
    throw new Error(`${fileName}: the site sent ${type}`);
  }
  const body = await readLimited(response, maxBytes);
  const target = path.join(folder, KINDS[fileKind].dir);
  fs.mkdirSync(target, { recursive: true });
  const tempPath = path.join(target, `.justtprint-${crypto.randomBytes(6).toString('hex')}.part`);
  fs.writeFileSync(tempPath, body);
  const saved = path.basename(placeWithoutReplacing(tempPath, target, fileName));
  db.prepare('INSERT OR REPLACE INTO model_folder_sources (folder, url, file_name) VALUES (?, ?, ?)').run(folder, url, `${KINDS[fileKind].dir}/${saved}`);
  return saved;
}

/**
 * Save a picture, video or document given as its contents (base64, or a data URL) into the folder's
 * subfolder for its kind, under `name` (a number added when taken). A first picture becomes the
 * cover. Answers { name, media } (MCP add_model_media).
 * @param {string} dir a model folder or a model file in it
 * @param {string} name
 * @param {string} data
 */
async function saveMediaData(dir, name, data, { maxBytes = 200 * 1024 * 1024 } = {}) {
  const folder = requireFolder(dir);
  const fileName = plainFileName(name);
  const kind = kindOf(fileName);
  if (!kind) throw new Error(`Not a picture, video or document name: ${name} (give it an extension, such as .jpg, .mp4 or .pdf)`);
  const text = String(data || '').trim();
  const base64 = text.startsWith('data:') ? text.slice(text.indexOf(',') + 1) : text;
  const body = Buffer.from(base64.replace(/\s/g, ''), 'base64');
  if (!body.length) throw new Error('No file contents (base64) given');
  if (body.length > maxBytes) throw new Error(`Larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const crypto = require('crypto');
  const { placeWithoutReplacing } = require('./uploads');
  const target = path.join(folder, KINDS[kind].dir);
  fs.mkdirSync(target, { recursive: true });
  const tempPath = path.join(target, `.justtprint-${crypto.randomBytes(6).toString('hex')}.part`);
  fs.writeFileSync(tempPath, body);
  const saved = path.basename(placeWithoutReplacing(tempPath, target, fileName));
  if (kind === 'image') await coverIfNone(folder).catch(() => {});
  require('./events').broadcast('folder-changed', { path: folder });
  return { name: saved, kind, media: getMedia(folder) };
}

/** A file name safe to save under: no folders, no control characters, not hidden, not too long. */
function plainFileName(name) {
  let text = String(name || '')
    .normalize('NFC')
    .replace(/[/\\\0]/g, '_')
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .trim()
    .replace(/^\.+/, '');
  if (text.length > 150) {
    const ext = path.extname(text).slice(0, 10);
    text = text.slice(0, 150 - ext.length) + ext;
  }
  return text;
}

/** A model folder was moved or renamed: its records follow. */
function moved(from, to) {
  const a = folderKey(from);
  const b = folderKey(to);
  const db = table();
  db.prepare('UPDATE model_folders SET path = ? WHERE path = ?').run(b, a);
  db.prepare('UPDATE model_folder_links SET folder = ? WHERE folder = ?').run(b, a);
  db.prepare('UPDATE model_folder_sources SET folder = ? WHERE folder = ?').run(b, a);
}

/**
 * Every record of the files under `from` follows them to `to` (a folder renamed or moved): the
 * models (and the ZIP entries in it), their site downloads, folder notes and assembly, and the
 * model folder's own records.
 */
function pathsMoved(from, to) {
  const a = folderKey(from);
  const b = folderKey(to);
  const db = table();
  const like = `${escapeLike(a)}${path.sep}%`;
  const swap = (column, tableName) => {
    try {
      db.prepare(`UPDATE ${tableName} SET ${column} = ? || substr(${column}, ?) WHERE ${column} LIKE ? ESCAPE '\\'`).run(b, a.length + 1, like);
    } catch (_) {
      /* the table is not there yet */
    }
  };
  db.transaction(() => {
    swap('filePath', 'models');
    swap('file_path', 'site_files');
    for (const tableName of ['folder_info', 'folder_assembly']) {
      try {
        db.prepare(`UPDATE ${tableName} SET path = ? WHERE path = ?`).run(b, a);
        swap('path', tableName);
      } catch (_) {
        /* the table is not there yet */
      }
    }
    // Model folders inside it (a kit's folders) move along.
    swap('path', 'model_folders');
    swap('folder', 'model_folder_links');
    swap('folder', 'model_folder_sources');
    moved(a, b);
  })();
}

/**
 * Rename a model folder to `name` (a number added when taken) and move every record with it.
 * Answers the new path.
 */
function renameFolder(dir, name) {
  const folder = requireFolder(dir);
  const { folderName } = require('../core/makerworld');
  const base = folderName(String(name || '').trim());
  if (!base) throw new Error('The folder needs a name');
  const parent = path.dirname(folder);
  if (path.basename(folder) === base) return folder;
  /** @type {string | null} */
  let target = null;
  for (let n = 1; n < 1000 && !target; n++) {
    const candidate = path.join(parent, n === 1 ? base : `${base} (${n})`);
    // A change of case only is the same folder on macOS and Windows.
    if (candidate.toLowerCase() === folder.toLowerCase() || !fs.existsSync(candidate)) target = candidate;
  }
  if (!target) throw new Error('Could not rename the folder');
  fs.renameSync(folder, target);
  pathsMoved(folder, target);
  require('./events').broadcast('refresh-grid');
  return target;
}

/** Media file names in a folder's image, video and document subfolders ("image/a.jpg"). */
function mediaNames(dir) {
  const names = [];
  for (const kind of KIND_NAMES) {
    try {
      for (const entry of fs.readdirSync(path.join(dir, KINDS[kind].dir), { withFileTypes: true })) {
        if (entry.isFile() && !entry.name.startsWith('.')) names.push(`${KINDS[kind].dir}/${entry.name}`);
      }
    } catch (_) {
      /* no such subfolder */
    }
  }
  return names;
}

const RELINK_MAX_DIRS = 20000;
const RELINK_MATCH = 0.6;

/**
 * Model folders moved or renamed outside JusttPrint: a model folder that is gone is found again
 * under `root` (where a scan looked) as a folder that is not a model folder and has the same
 * name, or mostly the same pictures, videos and documents; its records (cover, YouTube links,
 * what came from its site) move to it. Answers [{ from, to }].
 */
function relinkMoved(root) {
  if (!database.db || !root) return [];
  const gone = table()
    .prepare('SELECT path FROM model_folders')
    .all()
    .map((row) => row.path)
    .filter((dir) => !fs.existsSync(dir));
  if (!gone.length) return [];
  // Folders under the root with media subfolders that are not model folders yet.
  const candidates = [];
  const queue = [folderKey(root)];
  let seen = 0;
  while (queue.length && seen < RELINK_MAX_DIRS) {
    const dir = /** @type {string} */ (queue.shift());
    seen++;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    if (subdirs.some((e) => KIND_NAMES.some((kind) => KINDS[kind].dir === e.name)) && !isModelFolder(dir)) {
      candidates.push({ dir, media: new Set(mediaNames(dir)) });
    }
    for (const e of subdirs) if (!KIND_NAMES.some((kind) => KINDS[kind].dir === e.name)) queue.push(path.join(dir, e.name));
  }
  const relinked = [];
  for (const old of gone) {
    const known = new Set(
      table()
        .prepare('SELECT file_name FROM model_folder_sources WHERE folder = ?')
        .all(old)
        .map((row) => row.file_name)
    );
    const cover = table().prepare('SELECT cover FROM model_folders WHERE path = ?').get(old)?.cover;
    if (cover) known.add(`image/${cover}`);
    /** @type {{ dir: string, media: Set<string> } | null} */
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const sameName = path.basename(candidate.dir) === path.basename(old);
      const shared = [...candidate.media].filter((name) => known.has(name)).length;
      const overlap = known.size && candidate.media.size ? shared / Math.max(known.size, candidate.media.size) : 0;
      const score = (sameName ? 1 : 0) + overlap;
      if ((sameName || overlap >= RELINK_MATCH) && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) continue;
    moved(old, best.dir);
    candidates.splice(candidates.indexOf(best), 1);
    relinked.push({ from: old, to: best.dir });
    console.log(`[Model folders] ${old} moved to ${best.dir}: its cover and links follow`);
  }
  return relinked;
}

/**
 * A model file's own pictures (its 3D renders and pictures it carries), without its model folder's
 * cover: what shows it and not the whole model. `thumbnail` is its thumbnail column.
 */
function ownPictures(filePath, thumbnail) {
  const { parseThumbnails } = require('../core/thumbnails');
  const list = parseThumbnails(String(thumbnail || ''));
  const folder = folderOfFile(filePath);
  const row = folder ? table().prepare('SELECT cover_thumbnail FROM model_folders WHERE path = ?').get(folder) : null;
  return row && row.cover_thumbnail ? list.filter((image) => image !== row.cover_thumbnail) : list;
}

/**
 * SQL (with a leading OR) for models whose only picture is their model folder's cover: they still
 * need a 3D render of their own (Generate Missing Thumbnails).
 */
function onlyCoverSql() {
  table();
  return 'OR thumbnail IN (SELECT cover_thumbnail FROM model_folders WHERE cover_thumbnail IS NOT NULL)';
}

/** Put every model folder's cover first again on its files (after a thumbnail job). */
function reapplyAllCovers() {
  if (!database.db) return 0;
  let n = 0;
  for (const row of table().prepare('SELECT path FROM model_folders WHERE cover_thumbnail IS NOT NULL').all()) {
    reapplyCover(row.path);
    n++;
  }
  return n;
}

module.exports = {
  ARCHIVES_DIR,
  KINDS,
  KIND_NAMES,
  MIME_TYPES,
  addYoutube,
  coverIfNone,
  folderKey,
  folderOfFile,
  getMedia,
  isMediaFolder,
  isModelFolder,
  kindOf,
  makeFolder,
  mediaExtensions,
  mediaFolders,
  mediaPath,
  mediaTarget,
  moved,
  onlyCoverSql,
  ownPictures,
  pathsMoved,
  reapplyAllCovers,
  relinkMoved,
  renameFolder,
  plainFileName,
  reapplyCover,
  register,
  removeMedia,
  removeYoutube,
  saveMediaData,
  resolveFolder,
  saveFromSite,
  setCover,
  tidyMedia,
  youtubeId
};
