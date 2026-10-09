'use strict';

/**
 * MakerWorld model details for the details panel: the model, its print profiles, files and
 * video, read from MakerWorld's design answer (GET /api/v1/design-service/design/<id>).
 * No network access here; src/server/site-details.js does the fetching.
 */

const { licenseName } = require('./link-import');

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

const decodeEntities = (text) =>
  String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** A description's HTML → plain text with paragraphs (links keep their address). No HTML is kept. */
function htmlToText(html) {
  const text = String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return label && label !== href && !href.includes(label) ? `${label} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|figure|blockquote|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20000);
}

/** YouTube video ids in a description (links and embedded players), without repeats. */
function youtubeIds(html) {
  const ids = [];
  const pattern = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s<>]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;
  for (const match of String(html || '').matchAll(pattern)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids.slice(0, 10);
}

const hexColor = (value) => (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(String(value || '')) ? String(value).slice(0, 7).toUpperCase() : null);

/** One print profile ("instance"): name, printer, plates, filament. */
function profileOf(instance) {
  const info = (instance.extention && instance.extention.modelInfo) || {};
  const compat = info.compatibility || {};
  const plates = (Array.isArray(info.plates) ? info.plates : []).map((plate, i) => ({
    index: number(plate.index) ?? i + 1,
    name: clean(plate.name, 120),
    seconds: number(plate.prediction),
    grams: number(plate.weight)
  }));
  const ratingCount = number(instance.ratingCount) || 0;
  return {
    id: String(instance.id),
    name: clean(instance.title, 300),
    nameEnglish: clean(instance.titleTranslated, 300),
    description: htmlToText(instance.summary) || null,
    printer: clean(compat.devProductName, 80),
    nozzle: number(compat.nozzleDiameter),
    otherPrinters: (Array.isArray(info.otherCompatibility) ? info.otherCompatibility : []).map((c) => clean(c.devProductName, 80)).filter(Boolean),
    seconds: number(instance.prediction),
    grams: number(instance.weight),
    plates,
    needAms: !!instance.needAms,
    filaments: (Array.isArray(instance.instanceFilaments) ? instance.instanceFilaments : []).map((f) => ({
      type: clean(f.type, 40),
      color: hexColor(f.color),
      grams: number(f.usedG),
      meters: number(f.usedM)
    })),
    downloads: number(instance.downloadCount),
    prints: number(instance.printCount),
    rating: ratingCount ? Math.round((number(instance.ratingScoreTotal) / ratingCount) * 10) / 10 : null,
    ratingCount
  };
}

/** The model's files ("model_files"), folders flattened, with their sizes. */
function filesOf(list, folder = '') {
  const files = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item.isDir) {
      files.push(...filesOf(item.children, `${folder}${clean(item.dirName, 200) || ''}/`));
      continue;
    }
    const name = clean(item.modelName, 255);
    if (!name) continue;
    files.push({ name, folder: folder || null, size: number(item.modelSize), type: clean(item.modelType, 20) });
  }
  return files;
}

/**
 * MakerWorld's design answer → what the details panel shows, or null when there is no such
 * model (MakerWorld answers id 0). `url` is the model link JusttPrint keeps.
 */
function makerWorldDetails(body, url) {
  if (!body || !body.id || !body.title) return null;
  const creator = body.designCreator || {};
  const handle = clean(creator.handle, 100);
  const extension = body.designExtension || {};
  const instances = Array.isArray(body.instances) ? body.instances : [];
  const defaultId = String(body.defaultInstanceId || '');
  const profiles = instances
    .map(profileOf)
    // The default profile first.
    .sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
  const tags = (Array.isArray(body.tags) ? body.tags : []).map((t) => clean(t, 80)).filter(Boolean);
  const tagsEnglish = (Array.isArray(body.tagsTranslated) ? body.tagsTranslated : []).map((t) => clean(t, 80));
  const pictures = (Array.isArray(extension.design_pictures) ? extension.design_pictures : [])
    .map((p) => clean(p && p.url, 2000))
    .filter((u) => u && /^https:\/\//i.test(u));
  return {
    site: 'makerworld',
    url,
    id: String(body.id),
    title: clean(body.title, 500),
    titleEnglish: clean(body.titleTranslated, 500),
    designer: { name: clean(creator.name, 200), handle, url: handle ? `https://makerworld.com/en/@${encodeURIComponent(handle)}` : null },
    license: licenseName(body.license),
    categories: (Array.isArray(body.categories) ? body.categories : []).map((c) => clean(c && c.name, 100)).filter(Boolean),
    tags: tags.map((name, i) => ({ name, english: tagsEnglish[i] && tagsEnglish[i] !== name ? tagsEnglish[i] : null })),
    created: clean(body.createTime, 40),
    updated: clean(body.updateTime, 40),
    description: htmlToText(body.summary) || null,
    descriptionEnglish: htmlToText(body.summaryTranslated) || null,
    videos: youtubeIds(`${body.summary || ''} ${JSON.stringify(extension.design_video || '')}`),
    profiles,
    files: filesOf(extension.model_files),
    pictures,
    cover: clean(body.coverUrl, 2000),
    stats: {
      likes: number(body.likeCount),
      collections: number(body.collectionCount),
      downloads: number(body.downloadCount),
      prints: number(body.printCount),
      comments: number(body.commentCount)
    }
  };
}

/** True for a name with letters outside Latin script (Chinese, Japanese, Cyrillic…): worth translating. */
function needsTranslation(name) {
  return /[^\u0000-ɏḀ-ỿ\s\d\p{P}\p{S}]/u.test(String(name || ''));
}

/** "腿部.stl" → { stem: "腿部", extension: ".stl" }. */
function splitName(name) {
  const match = /^(.*?)(\.[a-z0-9]{1,6})?$/i.exec(String(name || ''));
  return { stem: match[1], extension: match[2] || '' };
}

/**
 * A file or folder name from a model title: no path characters, at most `maxChars` characters and
 * `maxBytes` bytes (Chinese characters take 3), cut at a word.
 */
function safeStem(title, maxChars = 80, maxBytes = 200) {
  let text = String(title || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  // Long titles are cut at a word, not in the middle of one.
  while (text.length > maxChars || Buffer.byteLength(text, 'utf8') > maxBytes) {
    const limit = Math.min(text.length - 1, maxChars);
    const atWord = text.slice(0, limit + 1).replace(/\s+\S*$/, '');
    text = atWord && atWord.length < text.length ? atWord : text.slice(0, limit);
  }
  return text.replace(/[\s.,;:!?+-]+$/, '').trim() || 'MakerWorld model';
}

/** A folder name from a model title. */
const folderName = (title) => safeStem(title, 80);

/** The model's name in the library: MakerWorld's English title, else its title. */
const modelTitle = (details) => (details && (details.titleEnglish || details.title)) || '';

/**
 * The main file's name for a model: "<English title, else title><extension>", or with several
 * print profiles "<profile> - <title><extension>": the profile first, so the cards of a model's
 * profiles (cut short in the grid) can be told apart.
 */
function modelFileName(details, extension, profile = null) {
  if (!profile) return `${safeStem(modelTitle(details), 150)}${extension}`;
  const profileName = safeStem(profile.nameEnglish || profile.name || `Profile ${profile.id}`, 60, 120);
  return `${profileName} - ${safeStem(modelTitle(details), 90, 120)}${extension}`;
}

module.exports = { folderName, htmlToText, makerWorldDetails, modelFileName, modelTitle, needsTranslation, safeStem, splitName, youtubeIds };
