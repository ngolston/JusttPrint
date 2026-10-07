#!/usr/bin/env node
'use strict';

// Uploads in pieces (src/server/upload-sessions.js): order, resume, restarts, owners, clean-up.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { createUploadSessions } = require('../src/server/upload-sessions');
const { placeWithoutReplacing } = require('../src/server/uploads');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MAKER = { id: 2, username: 'maker' };
const OTHER = { id: 3, username: 'other' };
const MAX = 1024 * 1024;

function setup({ freeBytes = () => 1e12, clock = { t: 1000 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-sessions-'));
  const folder = path.join(dir, 'library');
  fs.mkdirSync(folder);
  const stateFile = path.join(dir, 'data', 'uploads-pending.json');
  const make = () => createUploadSessions({ stateFile, place: placeWithoutReplacing, now: () => clock.t, freeBytes, logger: { warn() {} } });
  return { dir, folder, stateFile, clock, store: make(), make, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A request body stream that sends `text` (or fails after `failAfter` bytes). */
function body(text, { failAfter } = {}) {
  const stream = new PassThrough();
  setImmediate(() => {
    if (failAfter !== undefined) {
      stream.write(text.slice(0, failAfter));
      setImmediate(() => stream.emit('aborted'));
    } else {
      stream.end(text);
    }
  });
  return stream;
}

test('pieces in order make the file, under its name, without temp files', async () => {
  const { folder, store, cleanup } = setup();
  try {
    const session = store.start({ user: MAKER, folder, name: 'Big.stl', size: 10, maxBytes: MAX });
    assert.strictEqual(session.received, 0);
    assert.strictEqual((await store.writePiece(session.id, MAKER, 0, body('01234'), { maxPieceBytes: 5 })).received, 5);
    assert.strictEqual((await store.writePiece(session.id, MAKER, 5, body('56789'), { maxPieceBytes: 5 })).received, 10);
    const done = store.finish(session.id, MAKER);
    assert.strictEqual(done.fileName, 'Big.stl');
    assert.strictEqual(fs.readFileSync(path.join(folder, 'Big.stl'), 'utf8'), '0123456789');
    assert.deepStrictEqual(fs.readdirSync(folder), ['Big.stl']);
  } finally {
    cleanup();
  }
});

test('a wrong offset says where the upload stands', async () => {
  const { folder, store, cleanup } = setup();
  try {
    const { id } = store.start({ user: MAKER, folder, name: 'a.stl', size: 6, maxBytes: MAX });
    await store.writePiece(id, MAKER, 0, body('abc'), { maxPieceBytes: 3 });
    await assert.rejects(store.writePiece(id, MAKER, 0, body('abc'), { maxPieceBytes: 3 }), (error) => error.status === 409 && error.received === 3);
    await assert.rejects(store.writePiece(id, MAKER, 6, body('x'), { maxPieceBytes: 3 }), (error) => error.status === 409);
    assert.throws(() => store.finish(id, MAKER), (error) => error.status === 409 && error.received === 3, 'not complete');
  } finally {
    cleanup();
  }
});

test('a piece cut off midway is dropped, and the upload continues from the last whole piece', async () => {
  const { folder, store, cleanup } = setup();
  try {
    const { id } = store.start({ user: MAKER, folder, name: 'a.stl', size: 6, maxBytes: MAX });
    await store.writePiece(id, MAKER, 0, body('abc'), { maxPieceBytes: 3 });
    await assert.rejects(store.writePiece(id, MAKER, 3, body('def', { failAfter: 2 }), { maxPieceBytes: 3 }));
    assert.strictEqual(store.status(id, MAKER).received, 3);
    await store.writePiece(id, MAKER, 3, body('def'), { maxPieceBytes: 3 });
    assert.strictEqual(fs.readFileSync(path.join(folder, store.finish(id, MAKER).fileName), 'utf8'), 'abcdef');
  } finally {
    cleanup();
  }
});

test('pieces may not be too large or go past the end', async () => {
  const { folder, store, cleanup } = setup();
  try {
    const { id } = store.start({ user: MAKER, folder, name: 'a.stl', size: 10, maxBytes: MAX });
    await assert.rejects(store.writePiece(id, MAKER, 0, body('0123456'), { maxPieceBytes: 5 }), (error) => error.status === 413);
    await store.writePiece(id, MAKER, 0, body('01234567'), { maxPieceBytes: 8 });
    await assert.rejects(store.writePiece(id, MAKER, 8, body('89X'), { maxPieceBytes: 8 }), (error) => error.status === 400);
    assert.strictEqual(store.status(id, MAKER).received, 8);
  } finally {
    cleanup();
  }
});

test('an upload continues after a server restart', async () => {
  const { folder, store, make, cleanup } = setup();
  try {
    const { id } = store.start({ user: MAKER, folder, name: 'a.stl', size: 6, maxBytes: MAX });
    await store.writePiece(id, MAKER, 0, body('abc'), { maxPieceBytes: 3 });
    const restarted = make();
    assert.strictEqual(restarted.status(id, MAKER).received, 3);
    await restarted.writePiece(id, MAKER, 3, body('def'), { maxPieceBytes: 3 });
    assert.strictEqual(fs.readFileSync(path.join(folder, restarted.finish(id, MAKER).fileName), 'utf8'), 'abcdef');
  } finally {
    cleanup();
  }
});

test('only the user who started an upload may add to it', async () => {
  const { folder, store, cleanup } = setup();
  try {
    const { id } = store.start({ user: MAKER, folder, name: 'a.stl', size: 3, maxBytes: MAX });
    await assert.rejects(store.writePiece(id, OTHER, 0, body('abc'), { maxPieceBytes: 3 }), (error) => error.status === 403);
    assert.throws(() => store.abort(id, OTHER), (error) => error.status === 403);
    assert.throws(() => store.status('nope', MAKER), (error) => error.status === 404);
  } finally {
    cleanup();
  }
});

test('the size limit and free disk space are checked before anything is sent', () => {
  const { folder, store, cleanup } = setup({ freeBytes: () => 100 * 1024 * 1024 });
  try {
    assert.throws(() => store.start({ user: MAKER, folder, name: 'a.stl', size: MAX + 1, maxBytes: MAX }), (error) => error.status === 413);
    assert.throws(() => store.start({ user: MAKER, folder, name: 'a.stl', size: 50 * 1024 * 1024, maxBytes: 1e12 }), (error) => error.status === 507 && /Not enough free space/.test(error.message));
    assert.throws(() => store.start({ user: MAKER, folder, name: 'a.stl', size: -1, maxBytes: MAX }), (error) => error.status === 400);
    assert.deepStrictEqual(fs.readdirSync(folder), []);
  } finally {
    cleanup();
  }
});

test('cancelling deletes the temp file; uploads left for a day are cleaned up', async () => {
  const { folder, store, clock, cleanup } = setup();
  try {
    const first = store.start({ user: MAKER, folder, name: 'a.stl', size: 3, maxBytes: MAX });
    store.abort(first.id, MAKER);
    assert.deepStrictEqual(fs.readdirSync(folder), []);
    const second = store.start({ user: MAKER, folder, name: 'b.stl', size: 3, maxBytes: MAX });
    clock.t += 23 * 60 * 60 * 1000;
    assert.strictEqual(store.sweep(), 0);
    clock.t += 2 * 60 * 60 * 1000;
    assert.strictEqual(store.sweep(), 1);
    assert.deepStrictEqual(fs.readdirSync(folder), []);
    assert.throws(() => store.status(second.id, MAKER), (error) => error.status === 404);
  } finally {
    cleanup();
  }
});

test('an empty file finishes without pieces', () => {
  const { folder, store, cleanup } = setup();
  try {
    const { id } = store.start({ user: MAKER, folder, name: 'empty.stl', size: 0, maxBytes: MAX });
    assert.strictEqual(fs.statSync(store.finish(id, MAKER).filePath).size, 0);
  } finally {
    cleanup();
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.message);
      process.exitCode = 1;
    }
  }
})();
