'use strict';

/**
 * Printables and Thingiverse model details for the details panel, in the same shape as
 * MakerWorld's (makerworld.js makerWorldDetails), so one section shows all three sites. No
 * network access here; src/server/site-details.js does the fetching.
 */

const { licenseName } = require('./link-import');
const { htmlToText, youtubeIds } = require('./makerworld');

const clean = (value, max = 500) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
};

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const list = (value) => (Array.isArray(value) ? value : []);

/** The fields every site fills in, empty. */
function blank(site, url, id) {
  return {
    site,
    url,
    id: String(id),
    title: null,
    titleEnglish: null,
    designer: { name: null, handle: null, url: null },
    license: null,
    categories: [],
    tags: [],
    created: null,
    updated: null,
    description: null,
    descriptionEnglish: null,
    videos: [],
    profiles: [],
    printSettings: null,
    files: [],
    filesNeedToken: false,
    pictures: [],
    cover: null,
    stats: {}
  };
}

/** The files list-site-files gives (site-files.js listFiles) → the details' files. */
const filesOf = (files) =>
  list(files).map((file) => ({
    id: String(file.id),
    name: clean(file.name, 255),
    folder: null,
    size: number(file.size),
    type: clean(file.kind, 20),
    model: !!file.model
  }));

/**
 * Printables' print answer (api.printables.com GraphQL) and its files → the details panel's
 * details, or null when there is no such model.
 */
function printablesDetails(print, files, url) {
  if (!print || !print.name) return null;
  const details = blank('printables', url, print.id || '');
  const handle = clean(print.user && print.user.handle, 100);
  details.id = String(print.id || url.match(/model\/(\d+)/)?.[1] || '');
  details.title = clean(print.name);
  details.designer = {
    name: clean(print.user && (print.user.publicUsername || print.user.handle), 200),
    handle,
    url: handle ? `https://www.printables.com/@${encodeURIComponent(handle)}` : null
  };
  details.license = licenseName(print.license && print.license.name);
  details.categories = list(print.category && print.category.path)
    .map((c) => clean(c && c.name, 100))
    .filter(Boolean);
  details.tags = list(print.tags)
    .map((t) => clean(t && t.name, 80))
    .filter(Boolean)
    .map((name) => ({ name, english: null }));
  details.created = clean(print.firstPublish || print.datePublished, 40);
  details.updated = clean(print.modified, 40);
  details.description = htmlToText(print.description) || clean(print.summary, 2000);
  details.videos = youtubeIds(print.description);
  const settings = {
    // Printables gives the print time in hours.
    seconds: number(print.printDuration) ? Math.round(number(print.printDuration) * 3600) : null,
    pieces: number(print.numPieces) || null,
    grams: number(print.weight),
    nozzles: list(print.nozzleDiameters)
      .map(number)
      .filter((n) => n),
    layerHeights: list(print.layerHeights)
      .map(number)
      .filter((n) => n),
    materials: [...new Set([...list(print.materials).map((m) => clean(m && m.name, 60)), clean(print.usedMaterial, 60)].filter(Boolean))]
  };
  details.printSettings = Object.values(settings).some((v) => (Array.isArray(v) ? v.length : v)) ? settings : null;
  details.files = filesOf(files);
  details.pictures = list(print.images)
    .map((image) => (image && image.filePath ? `https://media.printables.com/${String(image.filePath).replace(/^\/+/, '')}` : null))
    .filter(Boolean);
  details.cover = details.pictures[0] || null;
  details.stats = {
    likes: number(print.likesCount),
    downloads: number(print.downloadCount),
    prints: number(print.makesCount),
    views: number(print.displayCount)
  };
  return details;
}

const unescapeData = (text) =>
  String(text || '')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

/** The first match of `pattern` in a page and its app data (escaped JSON), or null. */
function pageValue(html, pattern) {
  const match = pattern.exec(html) || pattern.exec(unescapeData(html));
  return match ? match[1] : null;
}

/**
 * A Thingiverse model page (no API token: what the page says) and, with a token, the API's thing,
 * tags and files → the details panel's details, or null for Cloudflare's check page or a missing
 * thing. `fromPage` is fromThingiversePage's answer for the same page.
 */
function thingiverseDetails({ id, url, fromPage = null, html = '', thing = null, tags = null, files = null }) {
  if (!thing && !fromPage) return null;
  const details = blank('thingiverse', url, id);
  if (thing && thing.name) {
    const creator = thing.creator || {};
    details.title = clean(thing.name);
    details.designer = { name: clean(creator.name, 200), handle: clean(creator.name, 100), url: clean(creator.public_url, 500) };
    details.license = licenseName(thing.license);
    details.categories = list(thing.categories)
      .map((c) => clean(c && c.name, 100))
      .filter(Boolean);
    details.tags = list(tags || thing.tags)
      .map((t) => clean(typeof t === 'string' ? t : t && t.name, 80))
      .filter(Boolean)
      .map((name) => ({ name, english: null }));
    details.created = clean(thing.added, 40);
    details.updated = clean(thing.modified, 40);
    details.description = htmlToText(thing.details || thing.description_html || thing.description) || null;
    details.videos = youtubeIds(`${thing.details || ''} ${thing.description || ''} ${thing.instructions || ''}`);
    details.cover = clean(thing.preview_image || thing.thumbnail, 2000);
    details.stats = {
      likes: number(thing.like_count),
      downloads: number(thing.download_count),
      prints: number(thing.make_count),
      collections: number(thing.collect_count)
    };
  } else {
    details.title = fromPage.name;
    details.designer = {
      name: fromPage.designer,
      handle: null,
      url: fromPage.designer ? `https://www.thingiverse.com/${encodeURIComponent(fromPage.designer)}` : null
    };
    details.license = fromPage.license;
    details.created = clean(pageValue(html, /"datePublished"\s*:\s*"([^"]+)"/), 40);
    details.updated = clean(pageValue(html, /"dateModified"\s*:\s*"([^"]+)"/), 40);
    const description = pageValue(html, /<meta\s+property="og:description"\s+content="([^"]*)"/i);
    // The page's summary runs paragraphs together ("supports.It's"): a space between sentences.
    details.description = description ? htmlToText(description).replace(/([a-z0-9)][.!?])(?=[A-Z])/g, '$1 ') : null;
    details.videos = youtubeIds(html);
    details.cover = fromPage.image;
  }
  details.files = filesOf(files);
  details.filesNeedToken = files === null;
  details.pictures = details.cover ? [details.cover] : [];
  return details;
}

module.exports = { printablesDetails, thingiverseDetails };
