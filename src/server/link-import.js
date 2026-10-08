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
  SITES, fallbackName, findModelLinks, fromMakerWorld, fromPrintables, fromThingiversePage, imageType,
  isAllowedImageUrl, linkKey, parseModelLink, printablesQuery
} = require('../core/link-import');

const TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; JusttPrint; +https://github.com/ngolston/JusttPrint)';
const MAX_REDIRECTS = 3;

/**
 * fetch() over Node's https module. MakerWorld and Thingiverse turn away Node's built-in fetch
 * with a browser check but answer this. Redirects are followed only with `redirect: 'follow'`,
 * and only to the same host.
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
      resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(res), { status: status < 200 ? 502 : status, headers }));
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
  const error = new Error(message);
  error.notFound = true;
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
  } catch (_) {
    throw new Error('The site did not answer with model details');
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
  if (!isAllowedImageUrl(url)) throw new Error('The picture is not on the site\'s image server');
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
  const rows = db.prepare(`SELECT filePath, fileName, source FROM models
    WHERE filePath LIKE 'url::%' OR source LIKE '%printables.com%' OR source LIKE '%thingiverse.com%' OR source LIKE '%makerworld.com%'`).all();
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
      return { site: link.site, siteLabel: SITES[link.site].label, id: link.id, url: link.url, name: link.slug ? fallbackName(link) : null,
        existing: existing ? { filePath: existing.filePath, fileName: existing.fileName } : null };
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
async function importLink(raw, deps) {
  const { db, saveModel, saveThumbnail, fetchImpl = httpsFetch } = deps;
  const link = parseModelLink(raw);
  if (!link) throw new Error('Not a Printables, Thingiverse or MakerWorld model link');
  const existing = knownModels(db).get(linkKey(link));
  if (existing) return { status: 'exists', filePath: existing.filePath, name: existing.fileName, designer: null, picture: false, warning: null };

  let info = null;
  let warning = null;
  try {
    info = await fetchModelInfo(link, fetchImpl);
  } catch (error) {
    if (error.notFound) return { status: 'missing', filePath: null, name: null, designer: null, picture: false, warning: `${error.message}.` };
    warning = `${error.message}. Added with the name from the link; fill in the details yourself.`;
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
  if (info && info.image) {
    try {
      await saveThumbnail(filePath, await fetchImage(info.image, fetchImpl));
      picture = true;
    } catch (error) {
      warning = `No picture: ${error.message}.`;
    }
  }
  return { status: 'added', filePath, name, designer: (info && info.designer) || null, picture, warning };
}

module.exports = { checkLinks, fetchImage, fetchModelInfo, httpsFetch, importLink, knownModels };
