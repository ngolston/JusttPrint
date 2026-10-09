'use strict';

/**
 * Downloading Printables and Thingiverse files into the library (Add Links), like MakerWorld's
 * print profiles (site-details.js): a folder per model, the online model folded into the files,
 * a single main file named after the model.
 *
 * Printables gives download links without an account. Thingiverse needs an API token: each user
 * makes their own on Thingiverse's developer pages (Settings → Integrations → Thingiverse), kept
 * in the thingiverseToken setting, never readable through the settings API.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const database = require('../core/database');
const { SITES, linkKey, parseModelLink } = require('../core/link-import');
const { fetchModelInfo, httpsFetch, readLimited, USER_AGENT } = require('./link-import');

const TIMEOUT_MS = 20000;
const FILE_GAP_MS = 800;
let fileGapMs = FILE_GAP_MS;
const TOKEN_KEY = 'thingiverseToken';

/** Hosts the files themselves come from. */
const FILE_HOSTS = {
  printables: ['files.printables.com', 'media.printables.com'],
  thingiverse: ['cdn.thingiverse.com', 'thingiverse-production-new.s3.amazonaws.com', 'thingiverse-production.s3.amazonaws.com']
};

/** Model files are ticked to start; printer-specific ones (G-code, SLA) are not. */
const MODEL_KINDS = new Set(['stl', 'other']);
const MODEL_EXTENSIONS = /\.(stl|3mf|obj|step|stp|iges|igs|ply|amf|f3d|scad|zip|blend)$/i;

function token() {
  const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_KEY);
  return row && row.value ? row.value : null;
}

function needsTokenError() {
  const error = new Error('Thingiverse needs an API token to download files: add yours under Settings → Integrations → Thingiverse');
  error.code = 'THINGIVERSE_TOKEN';
  return error;
}

async function json(response, what) {
  const text = (await readLimited(response, 4 * 1024 * 1024)).toString('utf8');
  if (/<title>\s*Just a moment/i.test(text)) throw new Error(`${what} asked for a browser check and did not answer`);
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error(`${what} answered ${response.status}`);
  }
  return body;
}

async function printablesGraphql(query, variables, fetchImpl) {
  const response = await fetchImpl('https://api.printables.com/graphql/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'https://www.printables.com', 'user-agent': USER_AGENT },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = await json(response, 'Printables');
  if (body.errors && body.errors.length) throw new Error(`Printables: ${body.errors[0].message}`);
  return body.data;
}

async function thingiverseApi(apiPath, fetchImpl, options = {}) {
  const key = token();
  if (!key) throw needsTokenError();
  const response = await fetchImpl(`https://api.thingiverse.com${apiPath}`, {
    ...options,
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status === 401 || response.status === 403) {
    response.body?.cancel?.();
    const error = new Error('Thingiverse did not accept the API token: check it under Settings → Integrations → Thingiverse');
    error.code = 'THINGIVERSE_TOKEN';
    throw error;
  }
  return response;
}

/** A Thingiverse API answer as JSON (with the token), or throws. */
async function thingiverseJson(apiPath, fetchImpl = httpsFetch) {
  const response = await thingiverseApi(apiPath, fetchImpl);
  if (!response.ok) {
    response.body?.cancel?.();
    throw new Error(`Thingiverse answered ${response.status}`);
  }
  return json(response, 'Thingiverse');
}

/**
 * The files of a Printables or Thingiverse model: [{ id, name, size, kind, model }], `model`
 * true for model files (ticked to start). Throws `code: 'THINGIVERSE_TOKEN'` without a token.
 */
async function listFiles(url, fetchImpl = httpsFetch) {
  const link = parseModelLink(url);
  if (!link || !['printables', 'thingiverse'].includes(link.site)) throw new Error('Not a Printables or Thingiverse model link');
  if (link.site === 'printables') {
    const data = await printablesGraphql(
      'query JusttPrintFiles($id: ID!) { print(id: $id) { stls { id name fileSize } gcodes { id name fileSize } slas { id name fileSize } otherFiles { id name fileSize } } }',
      { id: link.id }, fetchImpl);
    const print = data && data.print;
    if (!print) throw new Error('Printables has no model with this number');
    const files = [];
    for (const [list, kind] of [[print.stls, 'stl'], [print.otherFiles, 'other'], [print.gcodes, 'gcode'], [print.slas, 'sla']]) {
      for (const file of list || []) {
        const name = String(file.name || `file ${file.id}`);
        // Printables lists project files (.shapr, .f3z…) with the STLs: only model files start ticked.
        files.push({ id: String(file.id), name, size: Number(file.fileSize) || null, kind, model: MODEL_KINDS.has(kind) && MODEL_EXTENSIONS.test(name) });
      }
    }
    return files;
  }
  const response = await thingiverseApi(`/things/${link.id}/files`, fetchImpl);
  if (response.status === 404) throw new Error('Thingiverse has no model with this number');
  const body = await json(response, 'Thingiverse');
  if (!Array.isArray(body)) throw new Error('Thingiverse did not list the files');
  return body.map((file) => ({
    id: String(file.id),
    name: String(file.name || `file ${file.id}`),
    size: Number(file.size) || null,
    kind: path.extname(String(file.name || '')).slice(1).toLowerCase() || 'file',
    model: MODEL_EXTENSIONS.test(String(file.name || ''))
  }));
}

const allowedHost = (site, raw) => {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && FILE_HOSTS[site].some((h) => host === h || host.endsWith(`.${h}`));
  } catch (_) {
    return false;
  }
};

/** Where one file downloads from. */
async function fileUrl(link, file, fetchImpl) {
  if (link.site === 'printables') {
    const data = await printablesGraphql(
      'mutation JusttPrintDownload($id: ID!, $printId: ID!, $fileType: DownloadFileTypeEnum!, $source: DownloadSourceEnum!) { getDownloadLink(id: $id, printId: $printId, fileType: $fileType, source: $source) { ok errors { field messages } output { link } } }',
      { id: file.id, printId: link.id, fileType: file.kind, source: 'model_detail' }, fetchImpl);
    const answer = data && data.getDownloadLink;
    if (!answer || !answer.ok || !answer.output || !answer.output.link) {
      const why = answer && answer.errors && answer.errors[0] && answer.errors[0].messages && answer.errors[0].messages[0];
      throw new Error(why === 'files_cannot_be_downloaded' ? `Printables does not let ${file.name} be downloaded` : `Printables gave no download link for ${file.name}`);
    }
    return answer.output.link;
  }
  // Thingiverse answers the download with a redirect to its file server.
  const response = await thingiverseApi(`/files/${file.id}/download`, fetchImpl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location) return location;
  if (response.ok) {
    const body = await json(response, 'Thingiverse');
    if (body && (body.public_url || body.download_url)) return body.public_url || body.download_url;
  }
  throw new Error(`Thingiverse gave no download link for ${file.name} (${response.status})`);
}

/** The file name to save: no folders, no characters a file name cannot have. */
function plainName(name, fallback) {
  // eslint-disable-next-line no-control-regex
  const text = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC').replace(/[\x00-\x1f\x7f:*?"<>|]/g, '_').trim();
  return text && !text.startsWith('.') ? text.slice(0, 200) : fallback;
}

/**
 * Download the chosen files (`fileIds`; every model file when not given) of a Printables or
 * Thingiverse model into a new folder named after it inside `folder`, or the model's folder from
 * an earlier download, skipping files already there. Then the folder is scanned, the new models
 * get the designer, license and source link, the online model is folded into them, and a single
 * main file is named after the model. A failure partway keeps what was saved: `missing` lists
 * the rest; `notScanned` the saved files of types the library does not scan.
 * Answers { folder, saved, inLibrary, mainFile, missing, warning, notScanned }.
 */
async function downloadFiles({ url, folder, fileIds = null }, { fetchImpl = httpsFetch, onProgress = null, info = null } = {}) {
  const link = parseModelLink(url);
  if (!link || !['printables', 'thingiverse'].includes(link.site)) throw new Error('Not a Printables or Thingiverse model link');
  if (link.site === 'thingiverse' && !token()) throw needsTokenError();
  const key = linkKey(link);
  const siteDetails = require('./site-details');
  const { checkWritableFolder, maxUploadBytes, placeWithoutReplacing } = require('./uploads');
  const ctx = require('./path-context').networkPathContext();
  const parent = checkWritableFolder(folder, ctx);

  const files = await listFiles(link.url, fetchImpl);
  const wanted = Array.isArray(fileIds) ? new Set(fileIds.map(String)) : null;
  const chosen = files.filter((file) => (wanted ? wanted.has(file.id) : file.model));
  if (!chosen.length) throw new Error(files.length ? 'Choose the files to download' : `${SITES[link.site].label} lists no files for this model`);

  const model = info || await fetchModelInfo(link, fetchImpl).catch(() => null);
  const details = { title: (model && model.name) || `${SITES[link.site].label} model ${link.id}`, titleEnglish: null, designer: { name: (model && model.designer) || null }, license: (model && model.license) || null };

  const reused = siteDetails.earlierFolder(key, ctx);
  const have = new Set(reused ? siteDetails.downloadsFor(key).filter((d) => path.dirname(d.filePath) === reused).map((d) => d.profileId) : []);
  const todo = chosen.filter((file) => !have.has(`file:${file.id}`));
  const target = reused || siteDetails.makeModelFolder(parent, details);

  const saved = [];
  const missing = [];
  let warning = null;
  for (let i = 0; i < todo.length; i++) {
    const file = todo[i];
    const tempPath = path.join(target, `.justtprint-${crypto.randomBytes(6).toString('hex')}.part`);
    try {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, fileGapMs));
      const from = await fileUrl(link, file, fetchImpl);
      if (!allowedHost(link.site, from)) throw new Error(`${SITES[link.site].label}'s download link is on a server JusttPrint does not download from (${new URL(from).hostname})`);
      await siteDetails.saveTo(from, tempPath, {
        fetchImpl,
        maxBytes: maxUploadBytes(),
        onProgress: onProgress ? (received, total) => onProgress({ label: todo.length > 1 ? `${file.name} (${i + 1} of ${todo.length})` : file.name, received, total }) : null
      });
      const name = path.basename(placeWithoutReplacing(tempPath, target, plainName(file.name, `file-${file.id}`)));
      siteDetails.siteFilesTable().prepare('INSERT OR REPLACE INTO site_files (file_path, key, profile_id) VALUES (?, ?, ?)').run(path.join(target, name), key, `file:${file.id}`);
      saved.push(name);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      if (!saved.length && !have.size && !reused) {
        fs.rmSync(target, { recursive: true, force: true });
        throw error;
      }
      missing.push(...todo.slice(i).map((f) => f.name));
      warning = `${error.message}. Not downloaded yet: ${missing.join(', ')}; add the link again to add them`;
      break;
    }
  }

  // A single main file (the only one, or the only 3MF) is named after the model.
  let mainName = null;
  if (saved.length && !reused) {
    mainName = siteDetails.nameMainFile(target, details, saved);
    if (mainName && !saved.includes(mainName)) {
      const before = saved.find((name) => !fs.existsSync(path.join(target, name)));
      if (before) siteDetails.siteFilesTable().prepare('UPDATE site_files SET file_path = ? WHERE file_path = ?').run(path.join(target, mainName), path.join(target, before));
    }
  }
  const finished = await siteDetails.finishFolder(target, details, link, mainName, ctx);
  const names = saved.map((name) => (fs.existsSync(path.join(target, name)) ? name : mainName));
  // Saved but not in the library: a type the library does not scan (Settings → Scanning → File Types).
  const known = database.db.prepare('SELECT 1 FROM models WHERE filePath = ?');
  const notScanned = names.filter((name) => !known.get(path.join(target, name)));
  return { folder: target, saved: names, ...finished, missing, warning, notScanned };
}

/** Whether a Thingiverse token is set (never the token itself). */
const tokenStatus = () => ({ hasToken: !!token() });

/** Check a Thingiverse token against the API, then keep it ('' removes it). */
async function setToken(value, fetchImpl = httpsFetch) {
  const text = String(value || '').trim();
  if (!text) {
    database.db.prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY);
    return tokenStatus();
  }
  if (!/^[A-Za-z0-9._-]{16,200}$/.test(text)) throw new Error('That does not look like a Thingiverse token');
  const response = await fetchImpl('https://api.thingiverse.com/users/me', {
    headers: { authorization: `Bearer ${text}`, accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  response.body?.cancel?.();
  if (response.status === 401 || response.status === 403) throw new Error('Thingiverse did not accept this token');
  if (!response.ok) throw new Error(`Thingiverse answered ${response.status}; try again later`);
  database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TOKEN_KEY, text);
  return tokenStatus();
}

/** For tests: no pause between files. */
const setFileGap = (ms) => { fileGapMs = ms; };

module.exports = { FILE_HOSTS, downloadFiles, listFiles, plainName, setFileGap, setToken, thingiverseJson, tokenStatus };
