'use strict';

/**
 * MakerWorld details in the details panel (src/core/makerworld.js), and downloading a model's
 * files into a library folder.
 *
 * Details are kept per model link in the site_details table, so a model and the files downloaded
 * from it (same source link) share them; they are fetched again after a day or with Refresh.
 * Downloads (a print profile's 3MF) need a MakerWorld sign-in (makerworld-account.js); a request that needs one fails
 * with `code: 'SIGN_IN'`, and the browser asks for it first.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const database = require('../core/database');
const { SITES, fromThingiversePage, linkKey, parseModelLink } = require('../core/link-import');
const { printablesDetails, thingiverseDetails } = require('../core/site-model-details');
const { folderName, makerWorldDetails, modelFileName, splitName } = require('../core/makerworld');
const { httpsFetch, isBlocked, readLimited, USER_AGENT } = require('./link-import');
const translate = require('./translate');
const account = require('./makerworld-account');

const MAX_AGE_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 20000;
const MAX_DESIGN_BYTES = 8 * 1024 * 1024;

/** Hosts MakerWorld hands out download links on. */
const DOWNLOAD_HOSTS = ['bblmw.com', 'bambulab.com', 'amazonaws.com', 'aliyuncs.com', 'cloudfront.net'];

let tableReady = false;
function table() {
  if (!tableReady) {
    database.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS site_details (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )`
      )
      .run();
    // Which downloaded file holds which print profile of a model.
    database.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS site_files (
      file_path TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      profile_id TEXT NOT NULL
    )`
      )
      .run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_site_files_key ON site_files(key)').run();
    // A file renamed in the Edit dialog keeps its name (renameProfileFiles leaves it alone).
    const columns = database.db.prepare('PRAGMA table_info(site_files)').all();
    if (!columns.some((column) => column.name === 'named_by_user')) {
      database.db.prepare('ALTER TABLE site_files ADD COLUMN named_by_user INTEGER NOT NULL DEFAULT 0').run();
    }
    // What people changed in a model's site details (the Edit dialog), laid over what the site says.
    database.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS site_edits (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      edited_at TEXT NOT NULL
    )`
      )
      .run();
    tableReady = true;
  }
  return database.db;
}

const setting = (key) => {
  const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
};

// After MakerWorld asks for its robot check (a CAPTCHA only a browser can answer), downloads
// pause for a while instead of asking again: more requests make the check last longer.
const CAPTCHA_PAUSE_MS = 30 * 60 * 1000;
let captchaUntil = 0;

function captchaError() {
  const minutes = Math.max(1, Math.ceil((captchaUntil - Date.now()) / 60000));
  const error = Object.assign(
    new Error(
      `MakerWorld wants to check that you are not a robot, which only a browser can do. Download the model on MakerWorld in your browser (then drop the file on JusttPrint), or try again in ${minutes} min`
    ),
    { code: 'CAPTCHA' }
  );
  return error;
}

function signInError(message = 'Sign in to MakerWorld first') {
  const error = Object.assign(new Error(message), { code: 'SIGN_IN' });
  return error;
}

/** A MakerWorld model link, or throws. */
function makerWorldLink(url) {
  const link = parseModelLink(url);
  if (!link || link.site !== 'makerworld') throw new Error('Not a MakerWorld model link');
  return link;
}

async function fetchDesign(link, fetchImpl, headers = {}) {
  const response = await fetchImpl(`https://makerworld.com/api/v1/design-service/design/${link.id}`, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = (await readLimited(response, MAX_DESIGN_BYTES)).toString('utf8');
  if (isBlocked(response, text)) throw new Error('MakerWorld asked for a browser check and did not answer');
  if (!response.ok) throw new Error(`MakerWorld answered ${response.status}`);
  return JSON.parse(text);
}

/** English names for the files (Settings → MakerWorld → File name translation). */
async function addTranslations(details, deps) {
  const mode = translate.modeOf(setting(translate.SETTING_KEY));
  const stems = details.files.map((file) => splitName(file.name).stem);
  const { english, by, error } = await translate.translateNames(stems, mode, deps);
  details.files = details.files.map((file, i) => ({ ...file, english: english[i] ? `${english[i]}${splitName(file.name).extension}` : null }));
  details.translation = { mode, by, error };
  return details;
}

/**
 * The print profiles of a model downloaded so far: [{ profileId, filePath, fileName }], for files
 * still in the library (a moved or deleted file is forgotten).
 */
function downloadsFor(key) {
  const rows = table()
    .prepare(
      `SELECT f.file_path AS filePath, f.profile_id AS profileId, m.fileName AS fileName
    FROM site_files f LEFT JOIN models m ON m.filePath = f.file_path WHERE f.key = ? ORDER BY f.file_path`
    )
    .all(key);
  const gone = rows.filter((row) => !row.fileName && !fs.existsSync(row.filePath));
  for (const row of gone) table().prepare('DELETE FROM site_files WHERE file_path = ?').run(row.filePath);
  return rows
    .filter((row) => !gone.includes(row))
    .map((row) => ({ profileId: row.profileId, filePath: row.filePath, fileName: row.fileName || path.basename(row.filePath) }));
}

/**
 * The details for a model link: kept ones when fresh, else fetched (and translated). Answers
 * { details, fetchedAt, stale, error, downloads }; `stale` when MakerWorld could not be reached
 * and older details are shown; `downloads` the profiles downloaded so far. Null for other sites.
 */
async function getDetails(url, options = {}) {
  const result = await fetchDetails(url, options);
  if (result) {
    const key = linkKey(parseModelLink(url));
    if (result.details) result.details = applyEdits(result.details, editsFor(key));
    result.downloads = downloadsFor(key);
  }
  return result;
}

const EDIT_LIMITS = { title: 300, designer: 200, license: 200, description: 50000 };
const MAX_LIST = 100;
const MAX_LIST_ITEM = 100;

/** The site's values of what the Edit dialog changes. */
function siteValues(details) {
  return {
    title: details.title || '',
    designer: (details.designer && details.designer.name) || '',
    license: details.license || '',
    description: details.description || '',
    categories: details.categories || [],
    tags: (details.tags || []).map((tag) => tag.name),
    profiles: Object.fromEntries((details.profiles || []).map((p) => [p.id, p.name || '']))
  };
}

const cleanText = (value, limit) => String(value).replace(/\r\n?/g, '\n').trim().slice(0, limit);
const cleanList = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).replace(/\s+/g, ' ').trim().slice(0, MAX_LIST_ITEM)).filter(Boolean))].slice(
    0,
    MAX_LIST
  );
const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

/** The edits kept for a model link: { title?, designer?, license?, description?, categories?, tags?, profiles? }. */
function editsFor(key) {
  const row = table().prepare('SELECT data FROM site_edits WHERE key = ?').get(key);
  if (!row) return {};
  try {
    return JSON.parse(row.data) || {};
  } catch (_) {
    return {};
  }
}

/** The details with the edits laid over them; `edited` lists what was changed. Translations of changed text are dropped. */
function applyEdits(details, edits) {
  const fields = Object.keys(edits || {});
  if (!fields.length) return details;
  const next = { ...details, edited: fields };
  if (typeof edits.title === 'string') Object.assign(next, { title: edits.title, titleEnglish: null });
  if (typeof edits.designer === 'string') next.designer = { ...details.designer, name: edits.designer };
  if (typeof edits.license === 'string') next.license = edits.license;
  if (typeof edits.description === 'string') Object.assign(next, { description: edits.description, descriptionEnglish: null });
  if (Array.isArray(edits.categories)) next.categories = edits.categories;
  if (Array.isArray(edits.tags)) next.tags = edits.tags.map((name) => ({ name, english: null }));
  if (edits.profiles && typeof edits.profiles === 'object') {
    next.profiles = (details.profiles || []).map((p) =>
      typeof edits.profiles[p.id] === 'string' ? { ...p, name: edits.profiles[p.id], nameEnglish: null } : p
    );
  }
  return next;
}

/**
 * Keep changes to a model's site details (the Edit dialog): `changes` holds the fields changed,
 * and is added to the edits kept so far; a value the same as the site's drops that edit, so the
 * field follows the site again. Null forgets all the edits. Answers the details as getDetails does.
 */
async function saveSiteEdits(url, changes, options = {}) {
  const link = parseModelLink(url);
  if (!link) throw new Error('Not a model link from MakerWorld, Printables or Thingiverse');
  const key = linkKey(link);
  if (!changes) {
    table().prepare('DELETE FROM site_edits WHERE key = ?').run(key);
    return getDetails(url, options);
  }
  if (typeof changes !== 'object' || Array.isArray(changes)) throw new Error('The changes must be an object');
  const row = table().prepare('SELECT data FROM site_details WHERE key = ?').get(key);
  const site = row ? siteValues(JSON.parse(row.data)) : null;
  const edits = editsFor(key);
  for (const [field, limit] of Object.entries(EDIT_LIMITS)) {
    if (changes[field] === undefined) continue;
    const value = cleanText(changes[field] ?? '', limit);
    if (site && value === site[field]) delete edits[field];
    else edits[field] = value;
  }
  for (const field of ['categories', 'tags']) {
    if (changes[field] === undefined) continue;
    const value = cleanList(changes[field]);
    if (site && sameList(value, site[field])) delete edits[field];
    else edits[field] = value;
  }
  if (changes.profiles && typeof changes.profiles === 'object' && !Array.isArray(changes.profiles)) {
    const names = { ...(edits.profiles || {}) };
    for (const [id, name] of Object.entries(changes.profiles)) {
      if (site && !Object.prototype.hasOwnProperty.call(site.profiles, id)) continue;
      const value = cleanText(name ?? '', EDIT_LIMITS.title);
      if (site && value === site.profiles[id]) delete names[id];
      else names[id] = value;
    }
    if (Object.keys(names).length) edits.profiles = names;
    else delete edits.profiles;
  }
  if (Object.keys(edits).length) {
    table().prepare('INSERT OR REPLACE INTO site_edits (key, data, edited_at) VALUES (?, ?, ?)').run(key, JSON.stringify(edits), new Date().toISOString());
  } else {
    table().prepare('DELETE FROM site_edits WHERE key = ?').run(key);
  }
  return getDetails(url, options);
}

/** A downloaded file was renamed by hand (model-rename.js): it moves, and keeps the name it was given. */
function fileRenamed(from, to) {
  table().prepare('UPDATE site_files SET file_path = ?, named_by_user = 1 WHERE file_path = ?').run(to, from);
}

const PRINTABLES_FIELDS = `id name summary description datePublished firstPublish modified likesCount downloadCount makesCount displayCount
  tags { name } category { path { name } } printDuration numPieces weight nozzleDiameters usedMaterial layerHeights
  materials { name } images { filePath } license { name } user { publicUsername handle }
  ratingAvg ratingCount commentCount collectionsCount remixCount pdfFilePath printer { name }
  remixParents { url parentPrint { id name user { publicUsername handle } } }`;

/** A Printables model's details, from its GraphQL API (no account needed). */
async function printablesSiteDetails(link, fetchImpl) {
  const response = await fetchImpl('https://api.printables.com/graphql/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'https://www.printables.com', 'user-agent': USER_AGENT },
    body: JSON.stringify({ query: `query JusttPrintDetails($id: ID!) { print(id: $id) { ${PRINTABLES_FIELDS} } }`, variables: { id: link.id } }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = JSON.parse((await readLimited(response, MAX_DESIGN_BYTES)).toString('utf8'));
  if (body.errors && body.errors.length) throw new Error(`Printables: ${body.errors[0].message}`);
  const print = body.data && body.data.print;
  if (!print) return null;
  const files = await require('./site-files')
    .listFiles(link.url, fetchImpl)
    .catch(() => []);
  return printablesDetails(print, files, link.url);
}

/**
 * A Thingiverse model's details: its page, and with an API token its tags, categories and files too.
 * When Cloudflare blocks the page, the API (with a token) still gives the details.
 */
async function thingiverseSiteDetails(link, fetchImpl) {
  const response = await fetchImpl(SITES.thingiverse.canonical(link.id), {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const html = (await readLimited(response, MAX_DESIGN_BYTES)).toString('utf8');
  const blocked = isBlocked(response, html);
  const fromPage = !blocked && response.ok ? fromThingiversePage(html, link.id) : null;
  // The Thingiverse API's answers (with a token).
  /** @type {any} */
  let thing = null;
  /** @type {any} */
  let tags = null;
  /** @type {any[] | null} */
  let files = null;
  /** @type {any} */
  let ancestors = null;
  const siteFiles = require('./site-files');
  if (siteFiles.tokenStatus().hasToken) {
    try {
      thing = await siteFiles.thingiverseJson(`/things/${link.id}`, fetchImpl);
      tags = await siteFiles.thingiverseJson(`/things/${link.id}/tags`, fetchImpl).catch(() => null);
      ancestors = await siteFiles.thingiverseJson(`/things/${link.id}/ancestors`, fetchImpl).catch(() => null);
      files = await siteFiles.listFiles(link.url, fetchImpl);
    } catch (error) {
      if (blocked) throw error;
      console.warn(`[Thingiverse] API details of ${link.url}: ${error.message}`);
    }
  }
  if (blocked && !thing) throw siteFiles.blockedError();
  return thingiverseDetails({ id: link.id, url: link.url, fromPage, html: blocked ? '' : html, thing, tags, files, ancestors });
}

/** A model's details from its site: MakerWorld, Printables or Thingiverse; null when there is no such model. */
async function siteModelDetails(link, fetchImpl) {
  if (link.site === 'printables') return printablesSiteDetails(link, fetchImpl);
  if (link.site === 'thingiverse') return thingiverseSiteDetails(link, fetchImpl);
  return makerWorldDetails(await fetchDesign(link, fetchImpl), link.url);
}

async function fetchDetails(url, { refresh = false, event = null, fetchImpl = httpsFetch, translate: withTranslation = true } = {}) {
  const link = parseModelLink(url);
  if (!link) return null;
  const key = linkKey(link);
  const row = table().prepare('SELECT data, fetched_at FROM site_details WHERE key = ?').get(key);
  const kept = row ? JSON.parse(row.data) : null;
  const mode = translate.modeOf(setting(translate.SETTING_KEY));
  const fresh = row && Date.now() - Date.parse(row.fetched_at) < MAX_AGE_MS;
  if (kept && fresh && !refresh && (kept.translation && kept.translation.mode) === mode) {
    return { details: kept, fetchedAt: row.fetched_at, stale: false, error: null };
  }
  try {
    const details = await siteModelDetails(link, fetchImpl);
    if (!details) return { details: null, fetchedAt: null, stale: false, error: `${SITES[link.site].label} has no model with this number` };
    // Categorize Library only needs the categories: no file names are translated (kept details without them are fetched again when shown).
    if (withTranslation) {
      const deps = {
        fetchImpl,
        aiSettings: require('./ipc/ai').getAISettings(),
        puterHandler: event ? require('./ipc/ai').createPuterIPCHandler(event) : null
      };
      await addTranslations(details, deps);
    }
    const fetchedAt = new Date().toISOString();
    table().prepare('INSERT OR REPLACE INTO site_details (key, data, fetched_at) VALUES (?, ?, ?)').run(key, JSON.stringify(details), fetchedAt);
    return { details, fetchedAt, stale: false, error: null };
  } catch (error) {
    if (kept) return { details: kept, fetchedAt: row.fetched_at, stale: true, error: error.message };
    throw error;
  }
}

function isAllowedDownloadUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && DOWNLOAD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch (_) {
    return false;
  }
}

/**
 * A signed-in MakerWorld API call that answers { url, name }; refreshes the sign-in once. Asked of
 * Bambu Lab's API host (as Bambu Studio does): makerworld.com puts its download links behind a
 * Cloudflare browser check a server cannot pass.
 */
async function downloadLink(apiPath, fetchImpl) {
  if (Date.now() < captchaUntil) throw captchaError();
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = account.authHeaders();
    if (!headers) throw signInError();
    const response = await fetchImpl(`https://api.bambulab.com${apiPath}`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = (await readLimited(response, 1024 * 1024)).toString('utf8');
    if (isBlocked(response, text)) throw new Error('MakerWorld asked for a browser check and did not answer. Try again later');
    let json = {};
    try {
      json = JSON.parse(text);
    } catch (_) {
      /* handled below */
    }
    if (response.status === 418 || json.captchaId || /not a robot/i.test(json.error || '')) {
      captchaUntil = Date.now() + CAPTCHA_PAUSE_MS;
      throw captchaError();
    }
    if (response.status === 401 || /log ?in/i.test(json.error || '')) {
      if (attempt === 0 && (await account.refresh(fetchImpl))) continue;
      throw signInError('Your MakerWorld sign-in has expired. Sign in again');
    }
    if (!response.ok) throw new Error(json.error || `MakerWorld answered ${response.status}`);
    const data = json.data && typeof json.data === 'object' ? json.data : json;
    const url = data.url || data.downloadUrl || data.fileUrl;
    if (!url) throw new Error('MakerWorld did not give a download link');
    if (!isAllowedDownloadUrl(url)) throw new Error(`MakerWorld's download link is on a server JusttPrint does not download from (${new URL(url).hostname})`);
    return { url, name: String(data.name || data.fileName || '').trim() };
  }
  throw signInError();
}

/** Stream a download into `tempPath` (at most `maxBytes`), reporting progress. */
async function saveTo(url, tempPath, { fetchImpl, maxBytes, onProgress }) {
  const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`The download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || null;
  if (total && total > maxBytes) throw new Error('The download is larger than the upload limit (JUSTTPRINT_MAX_UPLOAD_MB)');
  let received = 0;
  let last = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > maxBytes) return done(new Error('The download is larger than the upload limit (JUSTTPRINT_MAX_UPLOAD_MB)'));
      if (onProgress && Date.now() - last > 250) {
        last = Date.now();
        onProgress(received, total);
      }
      return done(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(tempPath, { flags: 'wx' }));
  if (onProgress) onProgress(received, total);
  return received;
}

/** A new folder for the model inside `parent`: "Name", "Name (2)", … */
function makeModelFolder(parent, details) {
  const { isInsideOrSame } = require('./server-paths');
  const base = folderName(details.titleEnglish || details.title);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(parent, n === 1 ? base : `${base} (${n})`);
    try {
      fs.mkdirSync(candidate);
      if (!isInsideOrSame(candidate, parent)) throw new Error('Could not make a folder for the model');
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not make a folder for the model');
}

/**
 * Scan a model's folder, give its models the model's details (only empty fields; "Unknown" counts
 * as empty, and tags the scan gave are kept), and fold the online model into them. `mainName` is
 * the main file's name (the 3MF). Answers { inLibrary, mainFile }.
 */
async function finishFolder(target, details, link, mainName, ctx) {
  const { rootFor } = require('./uploads');
  const { isInsideOrSame } = require('./server-paths');
  const { scanUploadedFolder } = require('./stl-home');
  const { readStlHomeDirectories } = require('../core/library-paths');
  const isStlHomeScan = readStlHomeDirectories().some((home) => isInsideOrSame(target, home));
  await scanUploadedFolder(target, rootFor(target, ctx.roots), { isStlHomeScan });
  const prefix = `${target.replace(/[\\%_]/g, (c) => `\\${c}`)}${path.sep}%`;
  database.db
    .prepare(
      `UPDATE models SET
      designer = CASE WHEN designer IS NULL OR designer = '' OR designer = 'Unknown' THEN ? ELSE designer END,
      license = CASE WHEN license IS NULL OR license = '' OR license = 'Unknown' THEN ? ELSE license END,
      source = CASE WHEN source IS NULL OR source = '' THEN ? ELSE source END
    WHERE filePath LIKE ? ESCAPE '\\'`
    )
    .run(details.designer.name || null, details.license, link.url, prefix);
  const inLibrary = database.db
    .prepare("SELECT filePath FROM models WHERE filePath LIKE ? ESCAPE '\\' ORDER BY filePath")
    .all(prefix)
    .map((row) => row.filePath);

  // One model, not the link and the files side by side: the online model goes into the files.
  const named = mainName ? path.join(target, mainName) : null;
  const mainFile = (named && inLibrary.includes(named) && named) || inLibrary.find((p) => /\.3mf$/i.test(p)) || inLibrary[0] || null;
  const online = require('./link-import').knownModels(database.db).get(linkKey(link));
  if (online && String(online.filePath).startsWith('url::') && inLibrary.length) {
    require('../core/merge-online-model').mergeOnlineModel(database.db, online.filePath, inLibrary, mainFile);
  }
  require('./events').broadcast('refresh-grid');
  return { inLibrary: inLibrary.length, mainFile };
}

/**
 * Files downloaded on MakerWorld in a browser, for a model: `prepare` makes the model's folder
 * (the browser then uploads into it, POST /api/upload), `finish` scans it and folds the online
 * model into the files.
 */
async function prepareManualFolder({ url, folder }) {
  const link = makerWorldLink(url);
  const ctx = require('./path-context').networkPathContext();
  const parent = require('./uploads').checkWritableFolder(folder, ctx);
  const { details } = (await getDetails(link.url)) || {};
  if (!details) throw new Error('MakerWorld has no model with this number');
  // The model's folder from an earlier download, so its files stay together.
  return { folder: earlierFolder(linkKey(link), ctx) || makeModelFolder(parent, details) };
}

/** @param {{ url: string, folder: string, files?: string[] | null }} request */
async function finishManualFolder({ url, folder, files = null }) {
  const link = makerWorldLink(url);
  const ctx = require('./path-context').networkPathContext();
  const target = require('./uploads').checkWritableFolder(folder, ctx);
  const { details } = (await getDetails(link.url)) || {};
  if (!details) throw new Error('MakerWorld has no model with this number');
  const mainName = nameMainFile(target, details, Array.isArray(files) ? files.map(String) : null);
  return { folder: target, ...(await finishFolder(target, details, link, mainName, ctx)) };
}

/**
 * Name the main file of the files just added to a model's folder (`added`; every file in it when
 * not given) after the model (English title, else title): the only file, else the only 3MF. Other
 * files are parts and keep their names, as do the files of earlier downloads. A model the folder
 * watcher already added under the old name moves with it. Answers the main file's name, or null.
 * @param {string[] | null} [added]
 */
function nameMainFile(target, details, added = null) {
  const files = fs
    .readdirSync(target)
    .filter((name) => !name.startsWith('.') && fs.statSync(path.join(target, name)).isFile() && (!added || added.includes(name)));
  const threeMfs = files.filter((name) => /\.3mf$/i.test(name));
  const main = files.length === 1 ? files[0] : threeMfs.length === 1 ? threeMfs[0] : null;
  if (!main) return null;
  const wanted = modelFileName(details, path.extname(main).toLowerCase());
  if (wanted === main) return main;
  const { candidateName } = require('./uploads');
  let renamed = null;
  for (let n = 1; n < 1000 && !renamed; n++) {
    const name = candidateName(wanted, n);
    const to = path.join(target, name);
    if (name === main) return main;
    if (fs.existsSync(to)) continue;
    fs.renameSync(path.join(target, main), to);
    renamed = name;
  }
  if (!renamed) return main;
  database.db.prepare('UPDATE models SET filePath = ?, fileName = ? WHERE filePath = ?').run(path.join(target, renamed), renamed, path.join(target, main));
  return renamed;
}

const PROFILE_GAP_MS = 2500;
let profileGapMs = PROFILE_GAP_MS;

/**
 * The model's folder from an earlier download (the folder of its downloaded profiles), when it is
 * still a library folder JusttPrint can write to; else null.
 */
function earlierFolder(key, ctx) {
  for (const { filePath } of downloadsFor(key)) {
    try {
      return require('./uploads').checkWritableFolder(path.dirname(filePath), ctx);
    } catch (_) {
      /* moved, read-only, outside the library: a new folder then */
    }
  }
  return null;
}

/**
 * Download a MakerWorld model's print profiles as 3MF files (each holds its parts on their plates,
 * ready for the slicer): `profileIds` the chosen ones, else `profileId` one profile, `'default'`
 * the model's default, `'all'` every one. They go into a new folder named after the model inside `folder`, or the model's folder from
 * an earlier download, where profiles already there are skipped. MakerWorld only lets a browser
 * download the separate model files (a CAPTCHA), which JusttPrint does not try to get around.
 *
 * The folder is scanned, the new models get the designer, license and source link, and the
 * model's online model, if any, is folded into them (merge-online-model.js); the main file (the
 * profile `mainProfileId`, else the default one) gets its print history. When MakerWorld stops a
 * download partway (its robot check), what was saved is kept and `missing` lists the rest.
 * Answers { folder, saved, inLibrary, mainFile, missing, warning }.
 * @param {{ url: string, folder: string, profileId?: string, profileIds?: string[] | null, mainProfileId?: string | null }} request
 * @param {{ event?: any, fetchImpl?: typeof httpsFetch, onProgress?: ((progress: { label: string, received: number, total: number }) => void) | null }} [options]
 */
async function download(
  { url, folder, profileId = 'default', profileIds = null, mainProfileId = null },
  { event = null, fetchImpl = httpsFetch, onProgress = null } = {}
) {
  const link = makerWorldLink(url);
  const key = linkKey(link);
  if (!account.authHeaders()) throw signInError();
  if (Date.now() < captchaUntil) throw captchaError();

  const { checkWritableFolder, maxUploadBytes, placeWithoutReplacing } = require('./uploads');
  const ctx = require('./path-context').networkPathContext();
  const parent = checkWritableFolder(folder, ctx);

  const { details } = (await getDetails(link.url, { event, fetchImpl })) || {};
  if (!details) throw new Error('MakerWorld has no model with this number');
  if (!details.profiles.length)
    throw new Error('This model has no print profile to download. MakerWorld only lets a browser download its separate files: open it on MakerWorld');
  const wantedId = profileId && !['default', 'all'].includes(profileId) ? String(profileId) : null;
  // The profiles chosen by number (`profileIds`), else all, else one: a profile the link named
  // that is gone is the default one.
  const picked = Array.isArray(profileIds) ? new Set(profileIds.map(String)) : null;
  const chosen = picked
    ? details.profiles.filter((p) => picked.has(p.id))
    : profileId === 'all'
      ? details.profiles
      : [(wantedId && details.profiles.find((p) => p.id === wantedId)) || details.profiles[0]];
  if (!chosen.length) throw new Error('Choose the print profiles to download');

  // Profiles already downloaded into a folder that can be added to are skipped.
  renameProfileFiles(key);
  const reused = earlierFolder(key, ctx);
  const have = new Set(
    reused
      ? downloadsFor(key)
          .filter((d) => path.dirname(d.filePath) === reused)
          .map((d) => d.profileId)
      : []
  );
  const todo = chosen.filter((p) => !have.has(p.id));
  if (!todo.length && reused) {
    return {
      folder: reused,
      saved: [],
      ...(await finishFolder(reused, details, link, mainFileOf(key, details, mainProfileId || wantedId), ctx)),
      missing: [],
      warning: null
    };
  }
  const target = reused || makeModelFolder(parent, details);

  const saved = [];
  const missing = [];
  /** @type {string | null} */
  let warning = null;
  for (let i = 0; i < todo.length; i++) {
    const profile = todo[i];
    const label = todo.length > 1 ? `${profile.nameEnglish || profile.name || 'Print profile'} (${i + 1} of ${todo.length})` : 'Print profile';
    const tempPath = path.join(target, `.justtprint-${crypto.randomBytes(6).toString('hex')}.part`);
    try {
      // Spaced out: a burst of downloads makes MakerWorld ask for its robot check.
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, profileGapMs));
      const { url: fileUrl } = await downloadLink(`/v1/design-service/instance/${profile.id}/f3mf?type=download`, fetchImpl);
      await saveTo(fileUrl, tempPath, {
        fetchImpl,
        maxBytes: maxUploadBytes(),
        onProgress: onProgress ? (received, total) => onProgress({ label, received, total }) : null
      });
      // Named after the model (English title, else title), and the profile when there are several.
      const name = path.basename(placeWithoutReplacing(tempPath, target, modelFileName(details, '.3mf', details.profiles.length > 1 ? profile : null)));
      table().prepare('INSERT OR REPLACE INTO site_files (file_path, key, profile_id) VALUES (?, ?, ?)').run(path.join(target, name), key, profile.id);
      saved.push(name);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      // Nothing saved this time and the folder is new: leave no empty folder behind.
      if (!saved.length && !have.size && !reused) {
        fs.rmSync(target, { recursive: true, force: true });
        throw error;
      }
      missing.push(...todo.slice(i).map((p) => p.nameEnglish || p.name || p.id));
      warning = `${error.message}. Not downloaded yet: ${missing.join(', ')}; download again to add them`;
      break;
    }
  }

  const finished = await finishFolder(target, details, link, mainFileOf(key, details, mainProfileId || wantedId), ctx);
  return { folder: target, saved, ...finished, missing, warning };
}

/** The main file's name: the profile `mainProfileId` when downloaded, else the default profile, else any. */
function mainFileOf(key, details, mainProfileId) {
  const downloads = downloadsFor(key);
  const pick = (id) => downloads.find((d) => d.profileId === id);
  const main = (mainProfileId && pick(String(mainProfileId))) || (details.profiles[0] && pick(details.profiles[0].id)) || downloads[0];
  return main ? path.basename(main.filePath) : null;
}

/**
 * Give downloaded print profiles today's names (modelFileName) when an older version named them
 * differently; `key` limits it to one model. The library's model moves with its file (same row:
 * tags, notes and history stay). Uses the kept details only, no network. Answers how many moved.
 * @param {string | null} [key]
 */
function renameProfileFiles(key = null) {
  const { candidateName } = require('./uploads');
  const rows = table()
    .prepare(
      `SELECT f.file_path AS filePath, f.key, f.profile_id AS profileId, d.data
    FROM site_files f JOIN site_details d ON d.key = f.key WHERE f.named_by_user = 0 ${key ? 'AND f.key = ?' : ''}`
    )
    .all(...(key ? [key] : []));
  let moved = 0;
  for (const row of rows) {
    let details;
    try {
      details = JSON.parse(row.data);
    } catch (_) {
      continue;
    }
    const profile = (details.profiles || []).find((p) => p.id === row.profileId);
    if (!profile || !fs.existsSync(row.filePath)) continue;
    const wanted = modelFileName(details, path.extname(row.filePath).toLowerCase() || '.3mf', details.profiles.length > 1 ? profile : null);
    if (path.basename(row.filePath) === wanted) continue;
    const folder = path.dirname(row.filePath);
    /** @type {string | null} */
    let to = null;
    for (let n = 1; n < 1000 && !to; n++) {
      const candidate = path.join(folder, candidateName(wanted, n));
      if (candidate === row.filePath) break;
      if (!fs.existsSync(candidate)) to = candidate;
    }
    if (!to) continue;
    try {
      fs.renameSync(row.filePath, to);
    } catch (error) {
      console.warn(`[MakerWorld] Could not rename ${row.filePath}: ${error.message}`);
      continue;
    }
    // Right after the rename, so a folder rescan finds the model under its new name.
    database.db.transaction(() => {
      database.db.prepare('UPDATE models SET filePath = ?, fileName = ? WHERE filePath = ?').run(to, path.basename(to), row.filePath);
      table().prepare('UPDATE site_files SET file_path = ? WHERE file_path = ?').run(to, row.filePath);
    })();
    moved++;
  }
  if (moved) console.log(`[MakerWorld] Renamed ${moved} downloaded print profile(s) so their names start with the profile`);
  return moved;
}

const OLDER_RENAME_KEY = 'makerWorldOlderRenameDone';

/**
 * Downloads from before JusttPrint kept track of them (no site_files row): name the main file of
 * a MakerWorld model's folder after the model's English title (else its title). Only folders that
 * hold nothing but that one model's files are touched, and only their single main file (the only
 * file, or the only 3MF); part files keep their names. The library's model moves with its file.
 * Answers how many were renamed. Runs once (`force` runs it again).
 */
async function renameOlderDownloads({ fetchImpl = httpsFetch, force = false } = {}) {
  if (!force && setting(OLDER_RENAME_KEY) === '1') return 0;
  const { candidateName } = require('./uploads');
  const tracked = new Set(
    table()
      .prepare('SELECT file_path FROM site_files')
      .all()
      .map((row) => row.file_path)
  );
  const rows = database.db.prepare("SELECT filePath, source FROM models WHERE source LIKE '%makerworld.com%' AND filePath NOT LIKE 'url::%'").all();
  const folders = new Map();
  for (const row of rows) {
    const link = parseModelLink(row.source);
    if (!link || link.site !== 'makerworld' || row.filePath.includes('::') || tracked.has(row.filePath)) continue;
    const folder = path.dirname(row.filePath);
    if (!folders.has(folder)) folders.set(folder, link);
  }
  let renamed = 0;
  for (const [folder, link] of folders) {
    const key = linkKey(link);
    const prefix = `${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}${path.sep}%`;
    const inFolder = database.db
      .prepare("SELECT filePath, source FROM models WHERE filePath LIKE ? ESCAPE '\\'")
      .all(prefix)
      .filter((row) => path.dirname(row.filePath) === folder);
    // Only a folder of this one model's files.
    if (!inFolder.length || inFolder.some((row) => linkKey(parseModelLink(row.source)) !== key || tracked.has(row.filePath))) continue;
    const threeMfs = inFolder.filter((row) => /\.3mf$/i.test(row.filePath));
    const main = inFolder.length === 1 ? inFolder[0] : threeMfs.length === 1 ? threeMfs[0] : null;
    if (!main || !fs.existsSync(main.filePath)) continue;
    let details;
    try {
      ({ details } = (await getDetails(link.url, { fetchImpl })) || {});
    } catch (error) {
      console.warn(`[MakerWorld] Could not get the details of ${link.url} to rename ${main.filePath}: ${error.message}`);
      continue;
    }
    if (!details) continue;
    const wanted = modelFileName(details, path.extname(main.filePath).toLowerCase());
    if (path.basename(main.filePath) === wanted) continue;
    /** @type {string | null} */
    let to = null;
    for (let n = 1; n < 1000 && !to; n++) {
      const candidate = path.join(folder, candidateName(wanted, n));
      if (candidate === main.filePath) break;
      if (!fs.existsSync(candidate)) to = candidate;
    }
    if (!to) continue;
    try {
      fs.renameSync(main.filePath, to);
    } catch (error) {
      console.warn(`[MakerWorld] Could not rename ${main.filePath}: ${error.message}`);
      continue;
    }
    // Right after the rename, so a folder rescan finds the model under its new name.
    database.db.prepare('UPDATE models SET filePath = ?, fileName = ? WHERE filePath = ?').run(to, path.basename(to), main.filePath);
    renamed++;
    console.log(`[MakerWorld] Renamed ${path.basename(main.filePath)} to ${path.basename(to)}`);
  }
  database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(OLDER_RENAME_KEY, '1');
  if (renamed) require('./events').broadcast('refresh-grid');
  return renamed;
}

/** For tests: no pause between profile downloads. */
const setProfileGap = (ms) => {
  profileGapMs = ms;
};

/** Whether files can be saved in a library folder: { ok, error } (the download dialog checks before downloading). */
function checkFolder(folder) {
  try {
    const { checkWritableFolder } = require('./uploads');
    checkWritableFolder(folder, require('./path-context').networkPathContext());
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** For tests: forget a robot check. */
const resetCaptchaPause = () => {
  captchaUntil = 0;
};

module.exports = {
  DOWNLOAD_HOSTS,
  downloadsFor,
  renameOlderDownloads,
  earlierFolder,
  finishFolder,
  makeModelFolder,
  renameProfileFiles,
  saveTo,
  setProfileGap,
  siteFilesTable: table,
  checkFolder,
  finishManualFolder,
  nameMainFile,
  prepareManualFolder,
  resetCaptchaPause,
  download,
  fileRenamed,
  getDetails,
  saveSiteEdits,
  isAllowedDownloadUrl,
  makerWorldLink,
  signInError
};
