#!/usr/bin/env node
'use strict';

// A list of pictures over the load limit is no longer cleared at each start: only the pictures
// needed are reduced, largest first and at the gentlest size first, until the list fits. Their
// number and order stay the same, and a list that fits is not touched.
const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const oversized = require('../src/server/oversized-thumbnails');
const { purgeOversizedThumbnails } = require('../src/server/thumbnail-cleanup');

const LIMIT = 1000; // a small limit in place of the 8 million
const pic = (tag, n) => `data:image/webp;base64,${tag}${'A'.repeat(n)}`;
// A pretend reduction: at 2048 px a picture drops to 60%, at 1600 px to 40%, and so on.
const factor = { 2048: 0.6, 1600: 0.4, 1280: 0.3, 1024: 0.2, 800: 0.15, 640: 0.1 };
const requests = [];
const resize = async (image, max) => {
  requests.push([image.slice(23, 26), max]);
  return { width: 4000, height: 3000, dataUrl: image.slice(0, 26) + 'B'.repeat(Math.round((image.length - 26) * factor[max])) };
};

(async () => {
  database.db = new Database(':memory:');
  database.db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, thumbnail TEXT)');
  oversized.ensureTable(database.db, { limit: LIMIT });
  const add = database.db.prepare('INSERT INTO models (filePath, thumbnail) VALUES (?, ?)');
  const read = (id) => database.db.prepare('SELECT thumbnail FROM models WHERE id = ?').get(id).thumbnail;
  const marked = () =>
    database.db
      .prepare('SELECT model_id FROM oversized_thumbnails ORDER BY model_id')
      .all()
      .map((r) => r.model_id);

  // 1) A gallery that fits is not marked or touched.
  const fits = `${pic('aaa', 300)}::${pic('bbb', 300)}`;
  const idFits = add.run('/lib/fits.3mf', fits).lastInsertRowid;
  // 2) A large gallery: a small cover, a huge picture, a medium one. 1,282 characters, limit 1,000.
  const cover = pic('cap', 100),
    huge = pic('eno', 800),
    medium = pic('med', 200);
  const large = `${cover}::${huge}::${medium}`;
  const idLarge = add.run('/lib/large.3mf', large).lastInsertRowid;
  assert.deepStrictEqual(marked(), [Number(idLarge)], 'the trigger marks only the gallery over the limit');

  // Chromium not ready: nothing changes, the mark stays for next time.
  let r = await oversized.run({ resize: async () => null, limit: LIMIT });
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(read(idLarge), large);
  assert.deepStrictEqual(marked(), [Number(idLarge)]);

  requests.length = 0;
  r = await oversized.run({ resize, limit: LIMIT });
  assert.deepStrictEqual(r, { shrunk: 1, failed: 0, skipped: 0 });
  const after = read(idLarge).split('::');
  assert.strictEqual(after.length, 3, 'the same number of pictures');
  assert.ok(read(idLarge).length <= LIMIT * oversized.TARGET_RATIO, 'fits, with room to spare');
  assert.strictEqual(after[0], cover, 'the small cover was not reduced');
  assert.strictEqual(after[2], medium, 'the medium one was not reduced: the huge one was enough');
  assert.ok(after[1].startsWith('data:image/webp;base64,eno'), 'the huge one is still second');
  assert.deepStrictEqual(requests, [['eno', 2048]], 'one reduction only, the gentlest, on the largest picture');
  assert.deepStrictEqual(marked(), [], 'done, it leaves the list');
  assert.strictEqual(read(idFits), fits, 'the gallery that fit is unchanged');

  // 3) When the gentlest is not enough, it goes down in size (always from the original).
  const two = `${pic('um1', 1000)}::${pic('do2', 1000)}`;
  const idTwo = add.run('/lib/two.3mf', two).lastInsertRowid;
  requests.length = 0;
  await oversized.run({ resize, limit: LIMIT });
  assert.ok(read(idTwo).length <= LIMIT * oversized.TARGET_RATIO);
  assert.strictEqual(read(idTwo).split('::').length, 2);
  assert.deepStrictEqual(
    requests.map((p) => p[1]),
    [2048, 2048, 1600, 1600],
    '2048 on both, only then 1600'
  );

  // 4) Changed during the reduction: the result is not written over it.
  const other = `${pic('ou1', 900)}::${pic('ou2', 300)}`;
  const idOther = add.run('/lib/other.3mf', other).lastInsertRowid;
  const replaced = `${pic('nov', 1200)}`;
  await oversized.run({
    resize: async (image, max) => {
      database.db.prepare('UPDATE models SET thumbnail = ? WHERE id = ?').run(replaced, idOther);
      return resize(image, max);
    },
    limit: LIMIT
  });
  assert.strictEqual(read(idOther), replaced, 'the new list, written meanwhile, stays');
  assert.deepStrictEqual(marked(), [Number(idOther)], 'and stays marked (the new one is over the limit too)');

  // 5) A picture Chromium cannot open stays as it is; if the list still does not fit, it is unchanged.
  database.db.prepare('UPDATE models SET thumbnail = ? WHERE id = ?').run(`${pic('ruim', 1500)}`, idOther);
  r = await oversized.run({
    resize: async () => {
      throw new Error('does not decode');
    },
    limit: LIMIT
  });
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(read(idOther), pic('ruim', 1500), 'nothing cleared');
  assert.deepStrictEqual(marked(), [], 'not tried again until the gallery changes');

  // 6) The startup safeguard: over the load limit it no longer clears (it marks for reducing);
  //    only a runaway value over the ceiling is cleared, as everything used to be.
  const idRunaway = add.run('/lib/runaway.3mf', pic('abs', 5000)).lastInsertRowid;
  const idLarge2 = add.run('/lib/large2.3mf', pic('gr2', 2000)).lastInsertRowid;
  database.db.exec('DELETE FROM oversized_thumbnails');
  const cleared = purgeOversizedThumbnails(LIMIT, { hardMax: 4000 });
  assert.strictEqual(cleared, 1);
  assert.strictEqual(read(idRunaway), null, 'the runaway value was cleared');
  assert.strictEqual(read(idLarge2), pic('gr2', 2000), 'the large one stayed');
  assert.ok(marked().includes(Number(idLarge2)), 'and was marked for reducing');
  assert.ok(marked().includes(Number(idOther)), 'the one that failed gets another try at each start');

  // 7) A deleted model leaves the list.
  database.db.prepare('DELETE FROM models WHERE id = ?').run(idLarge2);
  assert.ok(!marked().includes(Number(idLarge2)));

  // 8) An animation is never reduced (only its first frame would be kept): a 2-frame GIF and an
  //    animated WebP stay the same, and the still pictures shrink instead.
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  const gif = `data:image/gif;base64,${b64(Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x21, 0xf9, 0x04]), Buffer.alloc(100, 1), Buffer.from([0x21, 0xf9, 0x04]), Buffer.alloc(100, 2)]))}`;
  const animatedWebp = `data:image/webp;base64,${b64(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(14), Buffer.from('ANIM'), Buffer.alloc(200, 3)]))}`;
  const still = pic('par', 800);
  const withAnimation = `${gif}::${animatedWebp}::${still}`;
  const idAnimated = add.run('/lib/animation.3mf', withAnimation).lastInsertRowid;
  assert.ok(withAnimation.length > LIMIT);
  const asked = [];
  await oversized.run({
    resize: async (image, max) => {
      asked.push(image.slice(5, 15));
      return resize(image, max);
    },
    limit: LIMIT
  });
  const afterAll = read(idAnimated).split('::');
  assert.strictEqual(afterAll[0], gif, 'the animated GIF is identical');
  assert.strictEqual(afterAll[1], animatedWebp, 'the animated WebP is identical');
  assert.notStrictEqual(afterAll[2], still, 'the still picture was reduced');
  assert.ok(!asked.some((p) => p.startsWith('image/gif')) && asked.every((p) => p === 'image/webp') && asked.length >= 1, JSON.stringify(asked));
  assert.ok(read(idAnimated).length <= LIMIT * oversized.TARGET_RATIO);
  // Only animations, nothing else to reduce: it does not fit and stays as it is.
  const onlyAnimation = `${gif}::${gif}::${gif}::${gif}`;
  assert.ok(onlyAnimation.length > LIMIT, 'over the limit');
  const idOnly = add.run('/lib/only-animation.3mf', onlyAnimation).lastInsertRowid;
  await oversized.run({ resize, limit: LIMIT });
  assert.strictEqual(read(idOnly), onlyAnimation);

  console.log('ok galleries over the limit are reduced, not cleared');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
