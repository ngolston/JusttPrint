'use strict';

/**
 * Bulk import from links: finding Printables, Thingiverse and MakerWorld model links in pasted
 * text, and reading a model's name, designer, license and picture from what each site answers.
 * No network access here; src/server/link-import.js does the fetching.
 */

/** Most links one paste may hold. */
const MAX_LINKS = 200;

const SITES = {
  printables: {
    label: 'Printables',
    // printables.com/model/3161-3d-benchy, /de/model/3161, /model/3161-x/files
    pattern: /^(?:www\.)?printables\.com$/,
    path: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?model\/(\d+)(?:-([^/?#]+))?/i,
    canonical: (id) => `https://www.printables.com/model/${id}`
  },
  thingiverse: {
    label: 'Thingiverse',
    // thingiverse.com/thing:763622, /thing:763622/files
    pattern: /^(?:www\.)?thingiverse\.com$/,
    path: /^\/thing:(\d+)/i,
    canonical: (id) => `https://www.thingiverse.com/thing:${id}`
  },
  makerworld: {
    label: 'MakerWorld',
    // makerworld.com/en/models/1000000-lens-cap#profileId-1, /models/19535
    pattern: /^(?:www\.)?makerworld\.com$/,
    path: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?models\/(\d+)(?:-([^/?#]+))?/i,
    canonical: (id) => `https://makerworld.com/en/models/${id}`
  }
};

/**
 * The model a link points to, or null for anything else: { site, id, url, slug }. `url` is the
 * link JusttPrint keeps (one form per model, so the same model is recognized however it was copied).
 */
function parseModelLink(raw) {
  let text = String(raw || '')
    .trim()
    .replace(/[)\]>.,;'"]+$/, '');
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  for (const [site, info] of Object.entries(SITES)) {
    if (!info.pattern.test(host)) continue;
    const match = info.path.exec(url.pathname);
    if (!match) return null;
    const id = String(Number(match[1]));
    if (id === '0') return null;
    let slug;
    try {
      slug = match[2] ? decodeURIComponent(match[2]) : '';
    } catch (_) {
      slug = match[2] || '';
    }
    return { site, id, url: info.canonical(id), slug };
  }
  return null;
}

/** Same model, same key: "printables:3161". */
const linkKey = (link) => (link ? `${link.site}:${link.id}` : '');

/**
 * Every model link in pasted text (one per line, or mixed with other words), without repeats.
 * Lines with a web address that is not a model page come back in `unsupported`.
 */
function findModelLinks(text) {
  const links = [];
  const unsupported = [];
  const seen = new Set();
  let skipped = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const candidates = line.match(/(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:printables|thingiverse|makerworld)\.com\/[^\s<>"']+/gi) || [];
    for (const candidate of candidates) {
      const link = parseModelLink(candidate);
      if (!link) {
        unsupported.push(candidate);
        continue;
      }
      const key = linkKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
      if (links.length >= MAX_LINKS) skipped++;
      // A MakerWorld link may name a print profile (#profileId-3376302).
      else links.push({ ...link, profileId: (/#profileId-(\d+)/.exec(candidate) || [])[1] || null });
    }
  }
  return { links, unsupported: [...new Set(unsupported)], skipped };
}

/** "3d-benchy" → "3d Benchy": a name from the link when the site tells us nothing. */
function nameFromSlug(slug) {
  const words = String(slug || '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The name a link gets when the site's details cannot be read. */
function fallbackName(link) {
  return nameFromSlug(link.slug) || `${SITES[link.site].label} model ${link.id}`;
}

const clean = (value, max = 300) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
};

/** Printables' GraphQL request for one model. */
function printablesQuery(id) {
  return {
    query: 'query JusttPrintModel($id: ID!) { print(id: $id) { id name user { publicUsername handle } image { filePath } license { name } } }',
    variables: { id: String(id) }
  };
}

/** Image path on media.printables.com → a 640×480 JPEG of it. */
function printablesImageUrl(filePath) {
  const text = String(filePath || '').replace(/^\/+/, '');
  const match = /^(.*\/images\/[^/]+)\/([^/]+?)(?:\.[a-z0-9]+)?$/i.exec(text);
  if (!match) return text ? `https://media.printables.com/${text}` : null;
  return `https://media.printables.com/${match[1]}/thumbs/inside/640x480/jpg/${match[2]}.jpg`;
}

/** Printables' answer → { name, designer, license, image }, or null when the model is not there. */
function fromPrintables(body) {
  const print = body && body.data && body.data.print;
  if (!print || !print.name) return null;
  return {
    name: clean(print.name),
    designer: clean(print.user && (print.user.publicUsername || print.user.handle)),
    license: clean(print.license && print.license.name),
    image: print.image && print.image.filePath ? printablesImageUrl(print.image.filePath) : null,
    // Newer Printables pictures have no resized versions: the original, when the resized one fails.
    imageFallback: print.image && print.image.filePath ? `https://media.printables.com/${String(print.image.filePath).replace(/^\/+/, '')}` : null
  };
}

/** MakerWorld's design answer → { name, designer, license, image }; a missing model has id 0. */
function fromMakerWorld(body) {
  if (!body || !body.id || !body.title) return null;
  const creator = body.designCreator || {};
  const cover = clean(body.coverUrl, 2000);
  return {
    // The English title when MakerWorld has one.
    name: clean(body.titleTranslated) || clean(body.title),
    designer: clean(creator.name || creator.handle),
    license: licenseName(body.license),
    image: cover ? `${cover.split('?')[0]}?x-oss-process=image/resize,w_640` : null
  };
}

const decodeEntities = (text) =>
  String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** "https://creativecommons.org/licenses/by-sa/4.0/" → "CC BY-SA 4.0"; other values as they are. */
function licenseName(value) {
  const text = clean(value);
  if (!text) return null;
  if (/^(?:CC[ -]?)?BY(?:-(?:SA|NC|ND))*$/i.test(text)) return `CC ${text.replace(/^CC[ -]?/i, '').toUpperCase()}`; // MakerWorld's "BY-NC"
  const cc = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/(\d+(?:\.\d+)?)/i.exec(text);
  if (!cc) return /^https?:\/\//i.test(text) ? null : text;
  if (cc[1].toLowerCase() === 'publicdomain') return cc[2].toLowerCase() === 'zero' ? `CC0 ${cc[3]}` : 'Public Domain';
  return `CC ${cc[2].toUpperCase()} ${cc[3]}`;
}

/** The schema.org records in a page's ld+json scripts. */
function structuredData(html) {
  const records = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1]);
      for (const item of Array.isArray(data) ? data : [data]) if (item && typeof item === 'object') records.push(item);
    } catch (_) {
      /* not JSON: skip */
    }
  }
  return records;
}

/**
 * Thing `id`'s page on Thingiverse → { name, designer, license, image }: its schema.org Product
 * record, else its link-preview tags ("Name by Designer"). Null for Cloudflare's check page, and
 * for the home page Thingiverse shows for a thing that does not exist.
 */
function fromThingiversePage(html, id) {
  const text = String(html || '');
  if (/<title>\s*Just a moment/i.test(text)) return null;
  const meta = {};
  for (const tag of text.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const value = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (key && value && !(key[1].toLowerCase() in meta)) meta[key[1].toLowerCase()] = decodeEntities(value[1]);
  }
  if (id && !new RegExp(`thing:${id}(?:\\D|$)`).test(meta['og:url'] || '')) return null;
  const product = structuredData(text).find((item) => item['@type'] === 'Product' && item.name) || {};
  const author = Array.isArray(product.author) ? product.author[0] : product.author;
  const title = clean(meta['og:title'] || meta['twitter:title']);
  const byline = title ? /^(.*\S)\s+by\s+(\S.*)$/.exec(title) : null;
  const name = clean(product.name) || (byline ? byline[1] : title);
  if (!name) return null;
  const image = clean(meta['og:image'] || meta['twitter:image'] || (Array.isArray(product.image) ? product.image[0] : product.image), 2000);
  // Like and comment counts: schema.org interaction counters on the model page.
  const counters = (product.mainEntityOfPage && product.mainEntityOfPage.interactionStatistic) || product.interactionStatistic || [];
  const count = (action) => {
    const counter = (Array.isArray(counters) ? counters : [counters]).find((c) => c && String(c.interactionType || '').endsWith(action));
    const n = counter ? Number(counter.userInteractionCount) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    name,
    designer: clean(author && (typeof author === 'string' ? author : author.name)) || (byline ? clean(byline[2]) : null),
    // The license is in the page's app data (escaped JSON), not in the Product record.
    license: licenseName(product.license || (/\\?"license\\?"\s*:\s*\\?"(https:\/\/creativecommons\.org\/[^"\\]+)/.exec(text) || [])[1]),
    image: image && /^https:\/\//i.test(image) ? image : null,
    stats: { likes: count('LikeAction'), comments: count('CommentAction') }
  };
}

/** Hosts a model picture may come from. */
const IMAGE_HOSTS = ['media.printables.com', 'makerworld.bblmw.com', 'cdn.thingiverse.com', 'resize.thingiverse.com'];

function isAllowedImageUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

/** The image type from its first bytes: jpeg, png, webp, or null for anything else. */
function imageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

module.exports = {
  MAX_LINKS,
  SITES,
  IMAGE_HOSTS,
  parseModelLink,
  linkKey,
  findModelLinks,
  fallbackName,
  nameFromSlug,
  printablesQuery,
  printablesImageUrl,
  fromPrintables,
  fromMakerWorld,
  fromThingiversePage,
  licenseName,
  isAllowedImageUrl,
  imageType
};
