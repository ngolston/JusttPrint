'use strict';

// Small grid copies of large thumbnails (src/server/grid-thumbnails.js): made once, the originals
// untouched, dropped when the thumbnails change or the model goes.
const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const grid = require('../src/server/grid-thumbnails');

const big = (tag) => `data:image/png;base64,${tag}${'A'.repeat(grid.SMALL_ENOUGH_CHARS + 1000)}`;
const small = 'data:image/png;base64,iVBORw0KGgo=';
const copyOf = (image) => `data:image/webp;base64,copy-of-${image.slice(22, 27)}`;

(async () => {
  database.db = new Database(':memory:');
  database.db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, filePath TEXT UNIQUE, thumbnail TEXT)');
  const add = database.db.prepare('INSERT INTO models (filePath, thumbnail) VALUES (?, ?)');
  const large = big('one');
  const second = big('two');
  add.run('/lib/large.stl', `${large}::${second}`);
  add.run('/lib/small.stl', small);
  add.run('/lib/none.stl', null);
  add.run('/lib/placeholder.stl', '3d.png');

  const resized = [];
  const resize = async (image, max) => {
    resized.push(image);
    assert.strictEqual(max, grid.MAX_DIMENSION);
    return { width: 2048, height: 1024, dataUrl: copyOf(image) };
  };
  const original = (filePath) => () => database.db.prepare('SELECT thumbnail FROM models WHERE filePath = ?').get(filePath).thumbnail;

  // Before a copy exists, the grid gets the original's first image.
  assert.strictEqual(grid.gridImage('/lib/large.stl', original('/lib/large.stl')), large);
  grid.stop();

  let result = await grid.run({ resize });
  assert.deepStrictEqual(result, { made: 1, failed: 0, skipped: 0 });
  assert.deepStrictEqual(resized, [large], 'only the large first image is resized');
  assert.strictEqual(grid.gridImage('/lib/large.stl', original('/lib/large.stl')), copyOf(large));
  assert.strictEqual(original('/lib/large.stl')(), `${large}::${second}`, 'the stored images are unchanged');
  assert.strictEqual(grid.gridImage('/lib/small.stl', original('/lib/small.stl')), small);
  assert.strictEqual(grid.gridImage('/lib/none.stl', original('/lib/none.stl')), null);

  // Nothing left to do.
  resized.length = 0;
  result = await grid.run({ resize });
  assert.deepStrictEqual(result, { made: 0, failed: 0, skipped: 0 });
  assert.strictEqual(resized.length, 0);

  // A new default image drops the copy; the next pass makes one of the new first image.
  database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(`${second}::${large}`, '/lib/large.stl');
  assert.strictEqual(grid.copyFor('/lib/large.stl').found, false);
  assert.strictEqual(grid.gridImage('/lib/large.stl', original('/lib/large.stl')), second);
  grid.stop();
  await grid.run({ resize });
  assert.strictEqual(grid.gridImage('/lib/large.stl', original('/lib/large.stl')), copyOf(second));

  // A copy that is not smaller is not kept: the grid gets the original, and it is not tried again.
  const id = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get('/lib/large.stl').id;
  database.db.prepare('UPDATE models SET thumbnail = ? WHERE id = ?').run(large, id);
  resized.length = 0;
  await grid.run({ resize: async (image) => ({ width: 300, height: 300, dataUrl: image + 'longer' }) });
  assert.deepStrictEqual(grid.copyFor('/lib/large.stl'), { found: true, dataUrl: null });
  assert.strictEqual(grid.gridImage('/lib/large.stl', original('/lib/large.stl')), large);
  grid.stop();

  // An image Chromium cannot decode counts as failed and keeps the original.
  database.db.prepare('UPDATE models SET thumbnail = ? WHERE id = ?').run(second, id);
  result = await grid.run({
    resize: async () => {
      throw new Error('EncodingError');
    }
  });
  assert.deepStrictEqual(result, { made: 0, failed: 1, skipped: 0 });
  assert.strictEqual(grid.gridImage('/lib/large.stl', original('/lib/large.stl')), second);

  // Without Chromium the pass stops and saves nothing.
  database.db.prepare('UPDATE models SET thumbnail = ? WHERE id = ?').run(large, id);
  result = await grid.run({ resize: async () => null });
  assert.deepStrictEqual(result, { made: 0, failed: 0, skipped: 1 });
  assert.strictEqual(grid.copyFor('/lib/large.stl').found, false);
  grid.stop();

  // Removing the model removes its copy.
  await grid.run({ resize });
  assert.strictEqual(database.db.prepare('SELECT COUNT(*) AS n FROM grid_thumbnails WHERE model_id = ?').get(id).n, 1);
  database.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  assert.strictEqual(database.db.prepare('SELECT COUNT(*) AS n FROM grid_thumbnails WHERE model_id = ?').get(id).n, 0);

  grid.stop();
  console.log('grid thumbnails tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
