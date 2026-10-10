'use strict';

// Categories: the list, what a model's own information points to, searching, and Categorize Library.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const categories = require('../src/core/categories');
const { buildModelFilterConditions } = require('../src/core/model-filters');

async function main() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-categories-')));
  database.db = new Database(path.join(tmp, 'test.db'));
  database.db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, fileName TEXT, designer TEXT, license TEXT, parentModel TEXT, source TEXT, notes TEXT,
      rating INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0, print_status TEXT DEFAULT 'unprinted', printed INTEGER, print_count INTEGER DEFAULT 0, last_printed_at TEXT,
      thumbnail TEXT, isNew INTEGER, dateAdded TEXT, size INTEGER, hash TEXT, modifiedDate TEXT, bundleKey TEXT, bundleLabel TEXT, bundleKind TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER);
  `);
  const add = (filePath, extra = {}) =>
    Number(
      database.db
        .prepare('INSERT INTO models (filePath, fileName, source, thumbnail) VALUES (?, ?, ?, ?)')
        .run(filePath, extra.fileName || path.basename(filePath), extra.source || null, extra.thumbnail || null).lastInsertRowid
    );

  // --- The list starts as MakerWorld's main categories, once ---
  let list = categories.listCategories();
  assert.deepStrictEqual(
    list.map((c) => c.name),
    categories.DEFAULT_CATEGORIES.map((c) => c.name)
  );
  categories.deleteCategory(list.find((c) => c.name === 'Education').id);
  database.db.prepare('DELETE FROM settings').run();
  assert.strictEqual(categories.listCategories().length, list.length - 1, 'a deleted default does not come back (the list is not empty)');

  // --- Create, rename, refuse duplicates ---
  const lamps = categories.createCategory('  Lamps ', 'lithophane lamp, night light');
  assert.strictEqual(lamps.name, 'Lamps');
  assert.throws(() => categories.createCategory('lamps'), /already a category named lamps/);
  assert.throws(() => categories.createCategory('  '), /needs a name/);
  categories.updateCategory(lamps.id, { name: 'Lighting' });
  assert.throws(() => categories.updateCategory(lamps.id, { name: 'Art' }), /already a category named Art/);
  list = categories.listCategories();
  const id = (name) => list.find((c) => c.name === name).id;
  assert.deepStrictEqual(list.find((c) => c.name === 'Lighting').keywords, ['lithophane lamp', 'night light']);

  // --- What a model's own information points to ---
  const match = (model) =>
    categories
      .freeMatches(model, list)
      .map((m) => `${list.find((c) => c.id === m.id).name}:${m.source}`)
      .sort();
  assert.deepStrictEqual(match({ siteCategories: ['Construction Sets', 'Toys & Games'], filePath: '/l/Art/x.stl' }), ['Toys & Games:site'], 'the site wins');
  assert.deepStrictEqual(match({ siteCategories: ['Costumes & Accessories'] }), ['Props & Cosplays:site'], "Printables' names map to MakerWorld's");
  assert.deepStrictEqual(match({ filePath: '/library/Warhammer Minis/orc.stl' }), ['Miniatures:folder']);
  assert.deepStrictEqual(match({ filePath: '/library/misc/a.stl', tags: ['Gridfinity'] }), ['Tools:tag']);
  assert.deepStrictEqual(match({ filePath: '/library/misc/Flower Vases.3mf', fileName: 'Flower Vases.3mf' }), ['Household:name'], 'plurals count');
  assert.deepStrictEqual(match({ filePath: '/library/Bambu A1 Mini/part.stl', fileName: 'part.stl' }), [], '"A1 Mini" is not a miniature');
  assert.deepStrictEqual(match({ filePath: '/library/Starship/propeller.stl', fileName: 'propeller.stl' }), [], 'whole words only');
  assert.deepStrictEqual(match({ filePath: '/l/Night Lights/moon.stl' }), ['Lighting:folder'], 'a category of your own, by its words');
  assert.ok(categories.hasPhrase('Dungeons & Dragons', 'dungeons and dragons'));
  assert.deepStrictEqual(
    categories.matchAiAnswer(['toys games', 'Art', 'robot', 'art'], list),
    [id('Toys & Games'), id('Art')],
    "AI Tagging's spelling of names"
  );

  // --- A model's categories; they go with the model ---
  const vase = add('/l/Vase.stl');
  assert.deepStrictEqual(categories.setModelCategories(vase, ['household', 'Art', 'Nope']), ['Art', 'Household']);
  assert.deepStrictEqual(categories.setModelCategories(vase, ['Art']), ['Art']);
  assert.strictEqual(list.find((c) => c.name === 'Art').model_count, 0);
  assert.strictEqual(categories.listCategories().find((c) => c.name === 'Art').model_count, 1);

  // --- Searching ---
  const found = (filters) => {
    const { conditions, params } = buildModelFilterConditions(filters);
    return database.db
      .prepare(`SELECT fileName FROM models ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY fileName`)
      .all(...params)
      .map((r) => r.fileName);
  };
  const party = add('/l/Party.stl');
  categories.createCategory('Party Art');
  categories.setModelCategories(party, ['Party Art']);
  assert.deepStrictEqual(found({ searchTokens: [{ t: 'clause', field: 'category', value: 'Art' }] }), ['Vase.stl'], 'a full name matches only that category');
  assert.deepStrictEqual(found({ searchTokens: [{ t: 'clause', field: 'category', value: 'part' }] }), ['Party.stl'], 'else part of a name');
  assert.deepStrictEqual(found({ searchTokens: [{ t: 'clause', field: 'all', value: 'party art' }] }), ['Party.stl'], 'the search box looks at categories too');

  database.db.prepare('DELETE FROM models WHERE id = ?').run(party);
  assert.strictEqual(database.db.prepare('SELECT COUNT(*) AS n FROM model_categories WHERE model_id = ?').get(party).n, 0, 'removed with the model');

  // --- Categorize Library ---
  const scan = require('../src/server/category-scan');
  const picture = 'data:image/png;base64,iVBORw0KGgo=';
  const site = add('url::https://makerworld.com/en/models/1246678', { fileName: 'VOLTRON' });
  const folder = add('/l/Cosplay/helmet.stl');
  const tagged = add('/l/misc/thing.stl');
  database.db.prepare("INSERT INTO tags (id, name) VALUES (1, 'gridfinity')").run();
  database.db.prepare('INSERT INTO model_tags (model_id, tag_id) VALUES (?, 1)').run(tagged);
  const forAi = add('/l/misc/0042.stl', { thumbnail: picture });
  const noPicture = add('/l/misc/0043.stl');
  let fetched = 0;
  const fetchImpl = async (url) => {
    fetched++;
    assert.match(url, /design\/1246678/);
    return new Response(
      JSON.stringify({ id: 1246678, title: 'VOLTRON', categories: [{ name: 'Construction Sets' }, { name: 'Toys & Games' }], instances: [] })
    );
  };
  const asked = [];
  const ask = async (base64, options, filePath) => {
    asked.push(filePath);
    assert.match(options.customPrompt, /"Toys & Games"/);
    return ['toys games', 'not a category'];
  };
  scan.start({ useAi: true }, { fetchImpl, ask });
  assert.strictEqual(scan.start({}), null, 'one run at a time');
  await scan._job().promise;
  const done = scan.snapshot();
  assert.strictEqual(done.running, false);
  assert.deepStrictEqual(done.placed, { site: 1, folder: 1, tag: 1 });
  assert.strictEqual(done.left, 2);
  assert.strictEqual(done.noPicture, 1);
  assert.strictEqual(fetched, 1);
  assert.deepStrictEqual(asked, ['/l/misc/0042.stl'], 'only models the free step left, with a picture');
  assert.deepStrictEqual(done.suggestions, [{ filePath: '/l/misc/0042.stl', fileName: '0042.stl', categories: ['Toys & Games'] }]);
  assert.deepStrictEqual(categories.modelCategoryNames(site), ['Toys & Games']);
  assert.deepStrictEqual(categories.modelCategoryNames(folder), ['Props & Cosplays']);
  assert.deepStrictEqual(categories.modelCategoryNames(tagged), ['Tools']);
  assert.deepStrictEqual(categories.modelCategoryNames(forAi), [], 'the AI picks wait for the review');
  assert.ok(database.db.prepare('SELECT 1 FROM site_details').get(), "the site's details are kept");

  assert.strictEqual(scan.apply([{ filePath: '/l/misc/0042.stl', categories: ['Toys & Games', 'Art'] }]), 1);
  assert.deepStrictEqual(categories.modelCategoryNames(forAi), ['Art', 'Toys & Games']);
  assert.strictEqual(database.db.prepare('SELECT source FROM model_categories WHERE model_id = ? LIMIT 1').get(forAi).source, 'ai');
  assert.strictEqual(scan.snapshot().suggestions.length, 0, 'reviewed picks leave the list');
  assert.deepStrictEqual(categories.modelCategoryNames(noPicture), []);
  assert.strictEqual(categories.uncategorizedCount(), 1);
  assert.strictEqual(scan.dismiss(), true);
  assert.strictEqual(scan.snapshot(), null);

  // A second run only looks at models still in no category.
  scan.start({ useAi: false }, { fetchImpl, ask });
  await scan._job().promise;
  assert.strictEqual(scan.snapshot().total, 1);

  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('categories tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
