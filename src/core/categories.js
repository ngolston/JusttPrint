'use strict';

/**
 * Categories: a short list of shelves (MakerWorld's main categories to start), and which models
 * are in which (a model can be in several). Each placement remembers where it came from:
 * 'site' (the category MakerWorld, Printables or Thingiverse gives the model), 'folder', 'tag'
 * or 'name' (a word of the category found there), 'ai' (picked by the AI service and accepted
 * in the review), or 'manual' (the Edit dialog).
 */

const database = require('./database');
const { folderTagsFromPath } = require('./library-context');

/** MakerWorld's main categories, with words that point to them in folder names, tags and model names. */
const DEFAULT_CATEGORIES = [
  {
    name: '3D Printer',
    keywords: [
      '3d printer',
      'printer part',
      'printer upgrade',
      'calibration',
      'test print',
      'benchy',
      'spool holder',
      'filament',
      'nozzle',
      'extruder',
      'hotend',
      'voron',
      'ender'
    ]
  },
  { name: 'Art', keywords: ['art', 'sculpture', 'statue', 'bust', 'wall art', 'lithophane', 'hueforge', 'relief', 'sign', 'logo', 'painting'] },
  { name: 'Education', keywords: ['education', 'educational', 'learning', 'school', 'science', 'math', 'anatomy', 'engineering', 'teaching'] },
  {
    name: 'Fashion',
    keywords: ['fashion', 'jewelry', 'jewellery', 'earring', 'bracelet', 'necklace', 'pendant', 'wearable', 'clothing', 'shoe', 'belt buckle']
  },
  {
    name: 'Hobby & DIY',
    keywords: [
      'hobby',
      'diy',
      'rc',
      'drone',
      'robot',
      'robotics',
      'fpv',
      'model railway',
      'train',
      'fishing',
      'bike',
      'bicycle',
      'camping',
      'sport',
      'electronics'
    ]
  },
  {
    name: 'Household',
    keywords: [
      'household',
      'home',
      'decor',
      'decoration',
      'kitchen',
      'bathroom',
      'garden',
      'planter',
      'vase',
      'flower pot',
      'lamp',
      'lampshade',
      'coaster',
      'christmas',
      'halloween',
      'easter',
      'ornament',
      'furniture'
    ]
  },
  {
    name: 'Miniatures',
    keywords: ['miniature', 'figurine', 'warhammer', 'dnd', 'd and d', 'dungeons and dragons', 'tabletop', 'terrain', 'wargaming', 'wargame', 'diorama']
  },
  {
    name: 'Props & Cosplays',
    keywords: ['prop', 'cosplay', 'costume', 'helmet', 'mask', 'armor', 'armour', 'sword', 'blaster', 'lightsaber', 'replica']
  },
  {
    name: 'Tools',
    keywords: ['tool', 'gadget', 'organizer', 'organiser', 'gridfinity', 'storage', 'clamp', 'jig', 'wrench', 'bracket', 'cable management', 'workshop']
  },
  {
    name: 'Toys & Games',
    keywords: ['toy', 'game', 'puzzle', 'fidget', 'articulated', 'flexi', 'action figure', 'board game', 'dice', 'construction set']
  }
];

/** Category names from other sites that mean one of MakerWorld's (Printables, Thingiverse). */
const SITE_SYNONYMS = {
  '3d printers': '3D Printer',
  '3d printing': '3D Printer',
  '3d printer accessories': '3D Printer',
  '3d printer parts': '3D Printer',
  'art and design': 'Art',
  art: 'Art',
  learning: 'Education',
  'costumes and accessories': 'Props & Cosplays',
  props: 'Props & Cosplays',
  'hobby and makers': 'Hobby & DIY',
  hobby: 'Hobby & DIY',
  'sports and outdoors': 'Hobby & DIY',
  'outdoor and garden': 'Household',
  household: 'Household',
  gadgets: 'Tools',
  tools: 'Tools',
  'toys and games': 'Toys & Games',
  models: 'Miniatures',
  fashion: 'Fashion'
};

const SOURCES = ['site', 'folder', 'tag', 'name', 'ai', 'manual'];
const MAX_NAME = 60;

/** Lower case, "&" as "and", only letters and digits as words: "Toys & Games" → "toys and games". */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A word without a plural "s" (not for short words like "rc" or "dnd"). */
const singular = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
const words = (text) => normalize(text).split(' ').filter(Boolean).map(singular);

/** Whether `phrase` appears in `text` as whole words (plurals count). */
function hasPhrase(text, phrase) {
  const haystack = ` ${words(text).join(' ')} `;
  const needle = words(phrase).join(' ');
  return !!needle && haystack.includes(` ${needle} `);
}

const readyFor = new WeakSet();

/** The categories tables (and MakerWorld's list the first time). */
function ensureTables(db = database.db) {
  if (!db || readyFor.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      keywords TEXT,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS model_categories (
      model_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (model_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_categories_category ON model_categories(category_id);
  `);
  const hasModels = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'models'").get();
  if (hasModels)
    db.exec('CREATE TRIGGER IF NOT EXISTS model_categories_removed AFTER DELETE ON models BEGIN DELETE FROM model_categories WHERE model_id = OLD.id; END;');
  const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
  const seeded = hasSettings && db.prepare("SELECT value FROM settings WHERE key = 'categoriesSeeded'").get();
  if (!seeded) {
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
        const insert = db.prepare('INSERT OR IGNORE INTO categories (name, keywords, position) VALUES (?, ?, ?)');
        DEFAULT_CATEGORIES.forEach((category, index) => insert.run(category.name, category.keywords.join(', '), index));
      }
      if (hasSettings) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('categoriesSeeded', '1')").run();
    })();
  }
  readyFor.add(db);
  return db;
}

/** A category name someone typed, or throws. */
function cleanName(name) {
  const text = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('A category needs a name');
  if (text.length > MAX_NAME) throw new Error(`A category name can be at most ${MAX_NAME} characters`);
  return text;
}

const keywordList = (text) =>
  String(text ?? '')
    .split(',')
    .map((word) => word.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/** Every category with how many models it has: [{ id, name, keywords: string[], model_count }]. */
function listCategories() {
  const db = ensureTables();
  return db
    .prepare(
      `SELECT c.id, c.name, c.keywords, COUNT(mc.model_id) AS model_count
    FROM categories c LEFT JOIN model_categories mc ON mc.category_id = c.id
    GROUP BY c.id ORDER BY c.position, c.name COLLATE NOCASE`
    )
    .all()
    .map((row) => ({ ...row, keywords: keywordList(row.keywords) }));
}

/** How many models are in no category. */
function uncategorizedCount() {
  const db = ensureTables();
  return db.prepare('SELECT COUNT(*) AS n FROM models WHERE id NOT IN (SELECT model_id FROM model_categories)').get().n;
}

function createCategory(name, keywords = '') {
  const db = ensureTables();
  const clean = cleanName(name);
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(clean)) throw new Error(`There is already a category named ${clean}`);
  const position = (db.prepare('SELECT MAX(position) AS p FROM categories').get().p ?? -1) + 1;
  const id = db
    .prepare('INSERT INTO categories (name, keywords, position) VALUES (?, ?, ?)')
    .run(clean, keywordList(keywords).join(', '), position).lastInsertRowid;
  return { id: Number(id), name: clean };
}

/**
 * Rename a category and change its words; renaming onto another category's name is refused.
 * @param {number} id
 * @param {{ name?: string, keywords?: string }} [changes]
 */
function updateCategory(id, { name, keywords } = {}) {
  const db = ensureTables();
  const row = db.prepare('SELECT id, name, keywords FROM categories WHERE id = ?').get(id);
  if (!row) throw new Error('This category is gone');
  const clean = name === undefined ? row.name : cleanName(name);
  const other = db.prepare('SELECT id FROM categories WHERE name = ? AND id != ?').get(clean, id);
  if (other) throw new Error(`There is already a category named ${clean}`);
  db.prepare('UPDATE categories SET name = ?, keywords = ? WHERE id = ?').run(
    clean,
    keywords === undefined ? row.keywords : keywordList(keywords).join(', '),
    id
  );
  return { id, name: clean };
}

/** Delete a category; its models stay, in their other categories. */
function deleteCategory(id) {
  const db = ensureTables();
  db.transaction(() => {
    db.prepare('DELETE FROM model_categories WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  })();
}

/** The names of a model's categories, in list order. */
function modelCategoryNames(modelId) {
  const db = ensureTables();
  return db
    .prepare(
      `SELECT c.name FROM model_categories mc JOIN categories c ON c.id = mc.category_id
    WHERE mc.model_id = ? ORDER BY c.position, c.name COLLATE NOCASE`
    )
    .all(modelId)
    .map((row) => row.name);
}

/** Category ids by normalized name. */
function idsByName(db) {
  return new Map(
    db
      .prepare('SELECT id, name FROM categories')
      .all()
      .map((row) => [normalize(row.name), row.id])
  );
}

/**
 * Put a model in exactly these categories (by name; unknown names are left out). Placements
 * that stay keep where they came from; new ones get `source`.
 */
function setModelCategories(modelId, names, source = 'manual') {
  const db = ensureTables();
  const byName = idsByName(db);
  const wanted = new Set((Array.isArray(names) ? names : []).map((name) => byName.get(normalize(name))).filter(Boolean));
  db.transaction(() => {
    const current = db.prepare('SELECT category_id FROM model_categories WHERE model_id = ?').all(modelId);
    for (const { category_id: id } of current)
      if (!wanted.has(id)) db.prepare('DELETE FROM model_categories WHERE model_id = ? AND category_id = ?').run(modelId, id);
    const insert = db.prepare('INSERT OR IGNORE INTO model_categories (model_id, category_id, source) VALUES (?, ?, ?)');
    for (const id of wanted) insert.run(modelId, id, SOURCES.includes(source) ? source : 'manual');
  })();
  return modelCategoryNames(modelId);
}

/** Add categories (by id) to a model, keeping the ones it has. Answers how many were new. */
function addModelCategories(modelId, ids, source) {
  const db = ensureTables();
  const insert = db.prepare('INSERT OR IGNORE INTO model_categories (model_id, category_id, source) VALUES (?, ?, ?)');
  let added = 0;
  for (const id of ids) added += insert.run(modelId, id, source).changes;
  return added;
}

/**
 * The categories a model's own information points to, without asking anyone: the site's
 * categories first (when the model came from MakerWorld, Printables or Thingiverse they are the
 * best guide, and nothing else is used), else the words of each category found in the model's
 * folders, tags and name. Answers [{ id, source }].
 *
 * @param {{ siteCategories?: string[], filePath?: string, fileName?: string, tags?: string[] }} model
 * @param {{ id: number, name: string, keywords: string[] }[]} categories
 */
function freeMatches(model, categories) {
  const byName = new Map(categories.map((category) => [normalize(category.name), category.id]));
  const site = [];
  for (const raw of model.siteCategories || []) {
    const key = normalize(raw);
    const id = byName.get(key) ?? byName.get(normalize(SITE_SYNONYMS[key] || ''));
    if (id && !site.includes(id)) site.push(id);
  }
  if (site.length) return site.map((id) => ({ id, source: 'site' }));

  const phrases = (category) => [category.name, ...category.keywords];
  const found = new Map();
  const look = (texts, source) => {
    for (const category of categories) {
      if (found.has(category.id)) continue;
      if (texts.some((text) => phrases(category).some((phrase) => hasPhrase(text, phrase)))) found.set(category.id, source);
    }
  };
  look(folderTagsFromPath(model.filePath || '', 3), 'folder');
  look(model.tags || [], 'tag');
  const name = String(model.fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  if (name) look([name], 'name');
  return [...found].map(([id, source]) => ({ id, source }));
}

/** The prompt asking the AI to choose categories from the list for a model's picture. */
function aiPrompt(categories) {
  const list = categories.map((category) => `"${category.name}"`).join(', ');
  return (
    `You are sorting 3D printable models in a library into categories. Look at this picture of a model and choose the categories it belongs in, ` +
    `using ONLY names from this list, written exactly as they are: ${list}. ` +
    `Choose one category, or two or three when the model clearly fits each of them. If none fits, choose none. ` +
    `Put the chosen category names in the "tags" list of your answer. `
  );
}

/** The AI's answer as category ids from the list (AI Tagging drops "&": "Toys & Games" comes back as "toys games"). */
function matchAiAnswer(tags, categories) {
  const byName = new Map();
  for (const category of categories) {
    byName.set(normalize(category.name), category.id);
    byName.set(normalize(category.name.replace(/&/g, ' ')), category.id);
  }
  const ids = [];
  for (const tag of tags || []) {
    const id = byName.get(normalize(tag));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

module.exports = {
  DEFAULT_CATEGORIES,
  SITE_SYNONYMS,
  SOURCES,
  addModelCategories,
  aiPrompt,
  cleanName,
  createCategory,
  deleteCategory,
  ensureTables,
  freeMatches,
  hasPhrase,
  listCategories,
  matchAiAnswer,
  modelCategoryNames,
  normalize,
  setModelCategories,
  uncategorizedCount,
  updateCategory
};
