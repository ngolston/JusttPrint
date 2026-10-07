#!/usr/bin/env node
'use strict';

// Collections (src/core/collections.js), share links (src/core/share-links.js) and the public page (src/server/share-pages.js).

const assert = require('assert');
const Database = require('better-sqlite3');
const c = require('../src/core/collections');
const shares = require('../src/core/share-links');
const { sharePageHtml, safeLink, displayName } = require('../src/server/share-pages');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT UNIQUE, fileName TEXT, designer TEXT, license TEXT, source TEXT, size INTEGER,
      notes TEXT, print_status TEXT, print_count INTEGER, last_printed_at TEXT, printed INTEGER, rating INTEGER, favorite INTEGER, bundleKey TEXT, bundleLabel TEXT, bundleKind TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER);
    INSERT INTO models (filePath, fileName, designer, license, source, size, notes) VALUES
      ('/lib/a/benchy.stl', 'benchy.stl', 'CreativeTools', 'CC-BY', 'https://example.com/benchy', 1000, 'secret note'),
      ('/lib/b/gear.stl', 'gear.stl', '<script>alert(1)</script>', NULL, 'javascript:alert(1)', 2000, NULL),
      ('/lib/pack.zip::inner/part.stl', 'pack.zip::inner/part.stl', NULL, NULL, NULL, 10, NULL);
    INSERT INTO tags VALUES (1, 'boat'); INSERT INTO model_tags VALUES (1, 1);
  `);
  return db;
}

const T0 = new Date('2026-10-07T10:00:00Z');
const at = (minutes) => new Date(T0.getTime() + minutes * 60000);

test('collections hold models from any folders, newest added first', () => {
  const db = createDb();
  const made = c.createCollection(db, { name: '  Gift   ideas ', createdBy: 'maker' }, T0);
  assert.strictEqual(made.name, 'Gift ideas');
  assert.deepStrictEqual(c.addToCollection(db, made.id, ['/lib/a/benchy.stl', '/lib/b/gear.stl', '/not/there.stl'], at(1)), { added: 2, name: 'Gift ideas' });
  assert.strictEqual(c.addToCollection(db, made.id, ['/lib/a/benchy.stl'], at(2)).added, 0, 'a model is in a collection once');
  c.addToCollection(db, made.id, ['/lib/pack.zip::inner/part.stl'], at(3));
  const detail = c.getCollection(db, made.id);
  assert.deepStrictEqual(detail.models.map((m) => m.fileName), ['pack.zip::inner/part.stl', 'gear.stl', 'benchy.stl'], 'same time: newer id first');
  const [summary] = c.listCollections(db);
  assert.strictEqual(summary.modelCount, 3);
  assert.strictEqual(summary.coverPath, '/lib/pack.zip::inner/part.stl');
  assert.strictEqual(c.removeFromCollection(db, made.id, ['/lib/b/gear.stl']).removed, 1);
  assert.strictEqual(c.getCollection(db, made.id).models.length, 2);
});

test('names are unique ignoring case, and required', () => {
  const db = createDb();
  c.createCollection(db, { name: 'Voron parts' });
  assert.throws(() => c.createCollection(db, { name: 'VORON PARTS' }), (e) => e.status === 409);
  assert.throws(() => c.createCollection(db, { name: '   ' }), (e) => e.status === 400);
  const other = c.createCollection(db, { name: 'Other' });
  assert.throws(() => c.updateCollection(db, other.id, { name: 'voron parts' }), (e) => e.status === 409);
  assert.strictEqual(c.updateCollection(db, other.id, { name: 'OTHER', description: 'misc' }).name, 'OTHER', 'changing only the case is fine');
});

test('a model that leaves the library leaves its collections', () => {
  const db = createDb();
  const made = c.createCollection(db, { name: 'X' });
  c.addToCollection(db, made.id, ['/lib/a/benchy.stl', '/lib/b/gear.stl']);
  db.prepare("DELETE FROM models WHERE filePath = '/lib/b/gear.stl'").run();
  assert.strictEqual(c.listCollections(db)[0].modelCount, 1);
  assert.deepStrictEqual(c.getCollection(db, made.id).models.map((m) => m.fileName), ['benchy.stl']);
});

test('membership says how many of the chosen models each collection holds', () => {
  const db = createDb();
  const a = c.createCollection(db, { name: 'A' });
  const b = c.createCollection(db, { name: 'B' });
  c.addToCollection(db, a.id, ['/lib/a/benchy.stl', '/lib/b/gear.stl']);
  c.addToCollection(db, b.id, ['/lib/a/benchy.stl']);
  const result = c.membership(db, ['/lib/a/benchy.stl', '/lib/b/gear.stl']);
  assert.strictEqual(result.models, 2);
  assert.deepStrictEqual(result.collections.map((x) => [x.name, x.selectedInIt]), [['A', 2], ['B', 1]]);
});

test('share links: a model, a collection, expiry, revoke, and a deleted collection', () => {
  const db = createDb();
  const model = shares.createShareLink(db, { kind: 'model', filePath: '/lib/a/benchy.stl', allowDownload: true, createdBy: 'maker' }, T0);
  assert.match(model.token, /^[A-Za-z0-9_-]{24}$/);
  const shown = shares.resolveShareLink(db, model.token, at(1));
  assert.strictEqual(shown.title, 'benchy.stl');
  assert.deepStrictEqual(shown.models.map((m) => [m.fileName, m.tags]), [['benchy.stl', ['boat']]]);
  assert.ok(!('notes' in shown.models[0]), 'notes are never shared');

  const col = c.createCollection(db, { name: 'Shared', description: 'For friends' });
  c.addToCollection(db, col.id, ['/lib/a/benchy.stl']);
  const week = shares.createShareLink(db, { kind: 'collection', targetId: col.id, expiresInDays: 7 }, T0);
  c.addToCollection(db, col.id, ['/lib/b/gear.stl'], at(5));
  assert.strictEqual(shares.resolveShareLink(db, week.token, at(10)).models.length, 2, 'models added later are shared too');
  assert.strictEqual(shares.resolveShareLink(db, week.token, at(8 * 24 * 60)), null, 'expired after 7 days');
  assert.strictEqual(shares.listShareLinks(db, {}, at(8 * 24 * 60)).find((l) => l.token === week.token).expired, true);

  shares.revokeShareLink(db, model.token);
  assert.strictEqual(shares.resolveShareLink(db, model.token, at(1)), null);
  assert.throws(() => shares.revokeShareLink(db, model.token), (e) => e.status === 404);
  const forever = shares.createShareLink(db, { kind: 'collection', targetId: col.id }, T0);
  c.deleteCollection(db, col.id);
  shares.revokeLinksOf(db, 'collection', col.id);
  assert.strictEqual(shares.resolveShareLink(db, forever.token, at(1)), null);
  assert.strictEqual(shares.resolveShareLink(db, 'not-a-token!', at(1)), null);
  assert.throws(() => shares.createShareLink(db, { kind: 'model', filePath: '/nope.stl' }), (e) => e.status === 404);
  assert.throws(() => shares.createShareLink(db, { kind: 'folder', targetId: 1 }), (e) => e.status === 400);
});

test('the public page escapes library text, keeps unsafe links out and shows no paths or notes', () => {
  const db = createDb();
  const col = c.createCollection(db, { name: 'Mine <b>bold</b>', description: 'Line one\n<i>two</i>' });
  c.addToCollection(db, col.id, ['/lib/a/benchy.stl', '/lib/b/gear.stl']);
  const link = shares.createShareLink(db, { kind: 'collection', targetId: col.id, allowDownload: false });
  const share = shares.resolveShareLink(db, link.token);
  share.models.forEach((m) => { m.hasThumbnail = false; });
  const html = sharePageHtml(share);
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<b>bold</b>') && !html.includes('<i>two</i>'));
  assert.ok(!html.includes('javascript:'), 'only http and https source links');
  assert.ok(html.includes('https://example.com/benchy'));
  assert.ok(!html.includes('/lib/') && !html.includes('secret note'), 'no paths, no notes');
  assert.ok(!html.includes('/file/'), 'no downloads unless the link allows them');
  assert.ok(!/<script/i.test(html.replace('&lt;script&gt;', '')), 'the page has no scripts');
  assert.strictEqual(safeLink('javascript:alert(1)'), null);
  assert.strictEqual(displayName('pack.zip::inner/part.stl'), 'part');
});
