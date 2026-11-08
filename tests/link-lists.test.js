'use strict';

// A designer's or a collection's models as model links (src/server/link-lists.js), and finding such links (src/core/link-import.js).

const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { parseListLink, findModelLinks } = require('../src/core/link-import');
const { listModelLinks } = require('../src/server/link-lists');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function main() {
  // --- Links ---
  assert.deepStrictEqual(parseListLink('makerworld.com/de/@3dwb/upload'), {
    site: 'makerworld',
    kind: 'designer',
    handle: '3dwb',
    url: 'https://makerworld.com/en/@3dwb'
  });
  assert.strictEqual(parseListLink('https://makerworld.com/en/collections/123-cool-stuff').id, '123');
  assert.strictEqual(parseListLink('https://www.printables.com/@JanOlejnik_20/models').userId, '20');
  assert.strictEqual(parseListLink('https://www.printables.com/@a_1/collections/1000').kind, 'collection');
  assert.strictEqual(parseListLink('https://www.thingiverse.com/MakerBot').user, 'MakerBot');
  assert.strictEqual(parseListLink('https://www.thingiverse.com/MakerBot/collections/accessories').id, 'accessories');
  for (const not of [
    'https://www.thingiverse.com/search',
    'https://www.thingiverse.com/thing:1',
    'https://makerworld.com/en/models/1',
    'https://example.com/@x',
    'javascript:alert(1)'
  ]) {
    assert.strictEqual(parseListLink(not), null, not);
  }
  const found = findModelLinks('https://makerworld.com/en/@3dwb\nhttps://makerworld.com/en/models/5\nhttps://example.com/x');
  assert.deepStrictEqual(
    found.lists.map((l) => [l.kind, l.raw]),
    [['designer', 'https://makerworld.com/en/@3dwb']]
  );
  assert.strictEqual(found.links.length, 1);
  assert.deepStrictEqual(found.unsupported, ['https://example.com/x']);

  database.db = new Database(':memory:');
  database.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE site_details (key TEXT PRIMARY KEY, data TEXT, fetched_at TEXT)');

  // --- MakerWorld: the designer's id from a model of theirs JusttPrint has looked at ---
  const asked = [];
  const world = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    if (u.pathname === '/v1/design-service/design/77') return json({ id: 77, designCreator: { uid: 555, name: 'Three D', handle: '3dwb' } });
    if (u.pathname === '/v1/design-service/published/555/design') {
      const offset = Number(u.searchParams.get('offset'));
      const ids = Array.from({ length: 60 }, (_, i) => 1000 + i).slice(offset, offset + 50);
      return json({ total: 60, hits: ids.map((id) => ({ id })) });
    }
    // A collection: its details, then its models (favorites/<id>/designs, as MakerWorld answers it).
    if (u.pathname === '/v1/design-service/favorites/9') return json({ id: 9, title: 'Parametric', creator: { name: 'SemiAmateur' } });
    if (u.pathname === '/v1/design-service/favorites/9/designs') return json({ total: 2, hits: [{ id: 1 }, { id: 2 }] });
    // A big collection (346 models, page by page).
    if (u.pathname === '/v1/design-service/favorites/12') return json({ id: 12, title: 'Big' });
    if (u.pathname === '/v1/design-service/favorites/12/designs') {
      const offset = Number(u.searchParams.get('offset'));
      const ids = Array.from({ length: 346 }, (_, i) => 5000 + i).slice(offset, offset + 50);
      return json({ total: 346, hits: ids.map((id) => ({ id })) });
    }
    if (u.pathname === '/v1/design-service/favorites/10') return json({ id: 10, title: 'Empty' });
    if (u.pathname === '/v1/design-service/favorites/10/designs') return json({ total: 0, hits: [] });
    if (u.pathname === '/v1/design-service/favorites/11') return json({ code: 404 }, 404);
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(listModelLinks('https://makerworld.com/en/@3dwb', { fetchImpl: world }), /does not know MakerWorld's id for @3dwb/);
  database.db.prepare("INSERT INTO site_details VALUES ('makerworld:77', ?, 'x')").run(JSON.stringify({ designer: { handle: '3DWB' } }));
  const designer = await listModelLinks('https://makerworld.com/en/@3dwb', { fetchImpl: world });
  assert.strictEqual(designer.title, 'Models by Three D');
  assert.strictEqual(designer.links.length, 60);
  assert.strictEqual(designer.total, 60);
  assert.strictEqual(designer.links[0], 'https://makerworld.com/en/models/1000');
  assert.strictEqual(
    (await listModelLinks('https://makerworld.com/en/@other', { fetchImpl: world, uid: '555' })).links.length,
    60,
    'a known id needs no lookup'
  );
  const collection = await listModelLinks('https://makerworld.com/en/collections/9-x', { fetchImpl: world });
  assert.deepStrictEqual(collection.links, ['https://makerworld.com/en/models/1', 'https://makerworld.com/en/models/2']);
  assert.strictEqual(collection.title, 'Collection "Parametric" by SemiAmateur');
  const big = await listModelLinks('https://makerworld.com/en/collections/12-big', { fetchImpl: world });
  assert.strictEqual(big.links.length, 346, 'a collection of 346 models comes whole (up to 600 links)');
  assert.strictEqual(new Set(big.links).size, 346);
  await assert.rejects(listModelLinks('https://makerworld.com/en/collections/10', { fetchImpl: world }), /no models in this collection/);
  await assert.rejects(listModelLinks('https://makerworld.com/en/collections/11', { fetchImpl: world }), /has no collection 11/);

  // --- Printables: the designer's models, page by page; collections cannot be listed ---
  const printables = async (url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (/user\(id/.test(query)) return json({ data: { user: { publicUsername: 'Jan', handle: 'Jan_20' } } });
    const page = variables.cursor ? 2 : 1;
    return json({ data: { userModels: { cursor: page === 1 ? 'next' : '', items: page === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '3' }] } } });
  };
  const jan = await listModelLinks('https://www.printables.com/@Jan_20', { fetchImpl: printables });
  assert.deepStrictEqual(jan.links, ['https://www.printables.com/model/1', 'https://www.printables.com/model/2', 'https://www.printables.com/model/3']);
  assert.strictEqual(jan.title, 'Models by Jan');
  await assert.rejects(listModelLinks('https://www.printables.com/@Jan_20/collections/5', { fetchImpl: printables }), /does not let other programs/);

  // --- Thingiverse: needs a token; a collection by its name ---
  await assert.rejects(listModelLinks('https://www.thingiverse.com/MakerBot', { fetchImpl: async () => json([]) }), /token/i);
  database.db.prepare("INSERT INTO settings VALUES ('thingiverseToken', 'abcdefabcdefabcdefabcdefabcdef12')").run();
  const thingiverse = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/users/MakerBot/collections')
      return json(u.searchParams.get('page') === '1' ? [{ id: 163, name: 'Accessories from the BotCave' }] : []);
    if (u.pathname === '/collections/163/things') return json(u.searchParams.get('page') === '1' ? [{ id: 11 }, { id: 12 }] : []);
    if (u.pathname === '/users/MakerBot/things') return json(u.searchParams.get('page') === '1' ? [{ id: 21 }] : []);
    throw new Error(`unexpected ${url}`);
  };
  const named = await listModelLinks('https://www.thingiverse.com/MakerBot/collections/accessories-from-the-botcave', { fetchImpl: thingiverse });
  assert.deepStrictEqual(named.links, ['https://www.thingiverse.com/thing:11', 'https://www.thingiverse.com/thing:12']);
  assert.strictEqual(named.title, 'Collection Accessories from the BotCave');
  assert.deepStrictEqual((await listModelLinks('https://www.thingiverse.com/MakerBot/designs', { fetchImpl: thingiverse })).links, [
    'https://www.thingiverse.com/thing:21'
  ]);
  await assert.rejects(listModelLinks('https://www.thingiverse.com/MakerBot/collections/nope', { fetchImpl: thingiverse }), /no collection "nope"/);
  await assert.rejects(listModelLinks('https://example.com/x'), /Not a designer's or collection's link/);

  console.log('link-lists tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
