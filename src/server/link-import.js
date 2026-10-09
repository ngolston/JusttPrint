'use strict';

/**
 * Bulk import from links (Library → Add Links): reads each model's details from the site and
 * saves it as a link-only model (filePath "url::<link>"), with its picture as the thumbnail.
 *
 * The server only contacts fixed addresses: Printables' GraphQL API, MakerWorld's design API,
 * the Thingiverse model page, and pictures on those sites' image hosts. A link only supplies
 * the model number, so pasted text cannot make the server load anything else.
 */

const https = require('https');
const { Readable } = require('stream');

const {
  SITES,
  fallbackName,
  findModelLinks,
  fromMakerWorld,
  fromPrintables,
  fromThingiversePage,
  imageType,
  isAllowedImageUrl,
  linkKey,
  parseModelLink,
  printablesQuery
} = require('../core/link-import');

const TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; JusttPrint; +https://github.com/ngolston/JusttPrint)';
const MAX_REDIRECTS = 3;

/**
 * fetch() over Node's https module. MakerWorld and Thingiverse turn away Node's built-in fetch
 * with a browser check but answer this. Redirects are followed only with `redirect: 'follow'`,
 * and only to the same host; `redirect: 'manual'` answers the redirect itself.
 */
function httpsFetch(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      reject(new Error('Only https addresses are fetched'));
      return;
    }
    const req = https.request(target, { method: options.method || 'GET', headers: options.headers || {}, signal: options.signal }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && options.redirect === 'manual') {
        // The caller checks where it leads (another host, for one).
        res.resume();
        resolve(new Response(null, { status, headers: { location: new URL(res.headers.location, target).href } }));
        return;
      }
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, target);
        if (options.redirect !== 'follow' || next.hostname !== target.hostname || redirects >= MAX_REDIRECTS) {
          reject(new Error(`The site sent JusttPrint elsewhere (${status})`));
          return;
        }
        resolve(httpsFetch(next.href, options, redirects + 1));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      }
      resolve(
        new Response(status === 204 || status === 304 ? null : /** @type {ReadableStream} */ (/** @type {unknown} */ (Readable.toWeb(res))), {
          status: status < 200 ? 502 : status,
          headers
        })
      );
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/** The body of a response, refused once it passes `limit` bytes. */
async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('The answer is too large');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error('The answer is too large');
    return buffer;
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('The answer is too large');
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

async function request(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: options.redirect || 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, ...(options.headers || {}) }
  });
  return response;
}

/** Cloudflare's "Just a moment" check: the site will not answer a server. */
function isBlocked(response, text) {
  return (response.status === 403 || response.status === 503) && /Just a moment|challenge-platform|cf-chl/i.test(text || '');
}

/** The site answered, and has no such model: nothing is added. */
function notFound(message) {
  const error = Object.assign(new Error(message), { notFound: true });
  return error;
}

async function fetchJson(fetchImpl, url, options) {
  const response = await request(fetchImpl, url, options);
  const text = (await readLimited(response, MAX_PAGE_BYTES)).toString('utf8');
  if (isBlocked(response, text)) throw new Error('The site asked for a browser check and did not answer');
  if (response.status === 404) throw notFound('The site has no model with this number');
  if (!response.ok) throw new Error(`The site answered ${response.status}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('The site did not answer with model details', { cause: error });
  }
}

/** The model's details from its site: { name, designer, license, image }, or throws. */
async function fetchModelInfo(link, fetchImpl = httpsFetch) {
  if (link.site === 'printables') {
    const body = await fetchJson(fetchImpl, 'https://api.printables.com/graphql/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'https://www.printables.com' },
      body: JSON.stringify(printablesQuery(link.id))
    });
    const info = fromPrintables(body);
    if (!info) throw notFound('Printables has no model with this number');
    return info;
  }
  if (link.site === 'makerworld') {
    const body = await fetchJson(fetchImpl, `https://makerworld.com/api/v1/design-service/design/${link.id}`, {
      headers: { accept: 'application/json' }
    });
    const info = fromMakerWorld(body);
    if (!info) throw notFound('MakerWorld has no model with this number');
    return info;
  }
  // Thingiverse's API needs an app key; its model page carries the details.
  const response = await request(fetchImpl, SITES.thingiverse.canonical(link.id), { headers: { accept: 'text/html' }, redirect: 'follow' });
  const html = (await readLimited(response, MAX_PAGE_BYTES)).toString('utf8');
  if (isBlocked(response, html)) throw new Error('Thingiverse asked for a browser check and did not answer');
  if (response.status === 404) throw notFound('Thingiverse has no model with this number');
  if (!response.ok) throw new Error(`Thingiverse answered ${response.status}`);
  const info = fromThingiversePage(html, link.id);
  if (!info) throw notFound('Thingiverse has no model with this number');
  return info;
}

/** A picture as a data URL (JPEG, PNG or WebP from an allowed host), or throws. */
async function fetchImage(url, fetchImpl = httpsFetch) {
  if (!isAllowedImageUrl(url)) throw new Error("The picture is not on the site's image server");
  const response = await request(fetchImpl, url, { headers: { accept: 'image/jpeg,image/png,image/webp' } });
  if (!response.ok) throw new Error(`The picture could not be loaded (${response.status})`);
  const buffer = await readLimited(response, MAX_IMAGE_BYTES);
  const type = imageType(buffer);
  if (!type) throw new Error('The picture is not a JPEG, PNG or WebP image');
  return `data:image/${type};base64,${buffer.toString('base64')}`;
}

/**
 * Library models that are the same model as a link: link-only models, and model files whose
 * source is that link. Map of key ("printables:3161") → { filePath, fileName }.
 */
function knownModels(db) {
  const rows = db
    .prepare(
      `SELECT filePath, fileName, source FROM models
    WHERE filePath LIKE 'url::%' OR source LIKE '%printables.com%' OR source LIKE '%thingiverse.com%' OR source LIKE '%makerworld.com%'`
    )
    .all();
  const known = new Map();
  for (const row of rows) {
    const fromPath = String(row.filePath || '').startsWith('url::') ? parseModelLink(row.filePath.slice(5)) : null;
    for (const link of [fromPath, parseModelLink(row.source)]) {
      const key = linkKey(link);
      // A link-only model wins over a file that names it as its source.
      if (key && (!known.has(key) || fromPath)) known.set(key, { filePath: row.filePath, fileName: row.fileName });
    }
  }
  return known;
}

/** Pasted text → the links in it, each marked new or already in the library. */
function checkLinks(db, text) {
  const { links, unsupported, skipped } = findModelLinks(text);
  const known = knownModels(db);
  return {
    links: links.map((link) => {
      const existing = known.get(linkKey(link));
      return {
        site: link.site,
        siteLabel: SITES[link.site].label,
        id: link.id,
        url: link.url,
        profileId: link.profileId || null,
        name: link.slug ? fallbackName(link) : null,
        existing: existing ? { filePath: existing.filePath, fileName: existing.fileName } : null
      };
    }),
    unsupported,
    skipped
  };
}

/**
 * Add one link to the library. Answers { status: 'added' | 'exists' | 'missing', filePath, name,
 * designer, picture, warning }. When the site cannot be reached the model is still added, named
 * from the link, and `warning` says why; when the site has no such model nothing is added.
 */
async function importLink(raw, deps, options = {}) {
  const { db, saveModel, saveThumbnail, fetchImpl = httpsFetch, download, downloadFiles } = deps;
  const link = parseModelLink(raw);
  if (!link) throw new Error('Not a Printables, Thingiverse or MakerWorld model link');
  // With a download folder, files are downloaded; none chosen (empty `profileIds`/`fileIds`): no download.
  const chosenNone = (Array.isArray(options.profileIds) && !options.profileIds.length) || (Array.isArray(options.fileIds) && !options.fileIds.length);
  const downloading = !!options.downloadFolder && !chosenNone && (link.site === 'makerworld' ? !!download : !!downloadFiles);
  const existing = knownModels(db).get(linkKey(link));
  const exists = (/** @type {string | null} */ warning = null) => ({
    status: 'exists',
    filePath: existing.filePath,
    name: existing.fileName,
    designer: null,
    picture: false,
    warning
  });
  // An online model already in the library can still get its files.
  if (existing && !(downloading && String(existing.filePath).startsWith('url::'))) return exists();

  /** @type {{ name: string | null, designer: string | null, license: string | null, image: string | null, imageFallback?: string | null } | null} */
  let info = null;
  /** @type {string | null} */
  let warning = null;

  // Printables and Thingiverse with a download folder: the chosen files (every model file when not
  // chosen), so the model arrives as its files. If that fails, the online model is added instead.
  if (downloading && link.site !== 'makerworld') {
    try {
      info = await fetchModelInfo(link, fetchImpl).catch(() => null);
      const result = await downloadFiles(
        { url: link.url, folder: options.downloadFolder, fileIds: Array.isArray(options.fileIds) ? options.fileIds : null },
        { ...(options.downloadOptions || {}), info }
      );
      const main = result.mainFile ? db.prepare('SELECT fileName, designer FROM models WHERE filePath = ?').get(result.mainFile) : null;
      return {
        status: 'downloaded',
        filePath: result.mainFile,
        name: (main && main.fileName) || (info && info.name) || null,
        designer: (main && main.designer) || null,
        picture: true,
        warning: result.warning || null,
        folder: result.folder,
        saved: result.saved,
        notScanned: result.notScanned || []
      };
    } catch (error) {
      warning = `Not downloaded: ${error.message.replace(/\.$/, '')}. ${existing ? 'The online model stays.' : 'Added as an online model.'}`;
      if (existing) return exists(warning);
    }
  }

  // MakerWorld with a download folder: download every print profile as a 3MF, so the model
  // arrives as files. If that fails, the online model is added instead and `warning` says why.
  // `profileIds`: the profiles chosen in Add Links (none: the online model only).
  if (downloading && link.site === 'makerworld') {
    // The chosen print profiles, else every one; the one the link named is the main file.
    const linkProfile = (/#profileId-(\d+)/.exec(String(raw)) || [])[1] || null;
    try {
      const chosen = Array.isArray(options.profileIds) ? { profileIds: options.profileIds } : { profileId: 'all' };
      const result = await download({ url: link.url, folder: options.downloadFolder, ...chosen, mainProfileId: linkProfile }, options.downloadOptions || {});
      const main = result.mainFile ? db.prepare('SELECT fileName, designer FROM models WHERE filePath = ?').get(result.mainFile) : null;
      return {
        status: 'downloaded',
        filePath: result.mainFile,
        name: (main && main.fileName) || null,
        designer: (main && main.designer) || null,
        picture: true,
        warning: result.warning || null,
        folder: result.folder,
        saved: result.saved
      };
    } catch (error) {
      const what = existing ? 'The online model stays.' : 'Added as an online model.';
      warning =
        error.code === 'SIGN_IN'
          ? `Not downloaded: sign in to MakerWorld to download. ${what}`
          : `Not downloaded: ${error.message.replace(/\.$/, '')}. ${what}`;
      if (existing) return exists(warning);
    }
  }
  try {
    info = await fetchModelInfo(link, fetchImpl);
  } catch (error) {
    if (error.notFound) return { status: 'missing', filePath: null, name: null, designer: null, picture: false, warning: `${error.message}.` };
    warning = [warning, `${error.message}. Added with the name from the link; fill in the details yourself.`].filter(Boolean).join(' ');
  }
  const filePath = `url::${link.url}`;
  const name = (info && info.name) || fallbackName(link);
  await saveModel({
    filePath,
    fileName: name,
    designer: (info && info.designer) || undefined,
    license: (info && info.license) || undefined,
    source: link.url,
    markAsNew: true
  });

  let picture = false;
  const pictures = info ? [info.image, info.imageFallback].filter((url, i, all) => url && all.indexOf(url) === i) : [];
  /** @type {any} */
  let pictureError = null;
  for (const url of pictures) {
    try {
      await saveThumbnail(filePath, await fetchImage(url, fetchImpl));
      picture = true;
      break;
    } catch (error) {
      pictureError = error;
    }
  }
  if (!picture && pictureError) warning = [warning, `No picture: ${pictureError.message}.`].filter(Boolean).join(' ');
  return { status: 'added', filePath, name, designer: (info && info.designer) || null, picture, warning };
}

module.exports = { USER_AGENT, checkLinks, fetchImage, fetchModelInfo, httpsFetch, importLink, isBlocked, knownModels, readLimited };
