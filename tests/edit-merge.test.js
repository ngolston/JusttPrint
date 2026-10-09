#!/usr/bin/env node
'use strict';

// Edits from two browsers at once (src/core/edit-merge.js).

const assert = require('assert');
const { findConflicts, mergeTagLists } = require('../src/core/edit-merge');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('an edit applies when nobody else changed the field', () => {
  assert.deepStrictEqual(findConflicts({ designer: 'Ann' }, { designer: 'Bob' }, { designer: 'Ann' }), []);
});

test('the same change from both is not a conflict', () => {
  assert.deepStrictEqual(findConflicts({ designer: 'Bob' }, { designer: 'Bob' }, { designer: 'Ann' }), []);
});

test('a field someone else changed meanwhile is a conflict, with both values', () => {
  assert.deepStrictEqual(findConflicts({ designer: 'Cat', notes: 'x' }, { designer: 'Bob' }, { designer: 'Ann' }), [
    { field: 'designer', theirs: 'Cat', yours: 'Bob' }
  ]);
  assert.deepStrictEqual(findConflicts({ notes: 'line 1\nline 2' }, { notes: 'line 1\nmine' }, { notes: 'line 1' }), [
    { field: 'notes', theirs: 'line 1\nline 2', yours: 'line 1\nmine' }
  ]);
});

test('empty, null and missing count as the same; spaces around do not count', () => {
  assert.deepStrictEqual(findConflicts({ license: null }, { license: 'MIT' }, { license: '' }), []);
  assert.deepStrictEqual(findConflicts({ source: ' https://a ' }, { source: 'https://b' }, { source: 'https://a' }), []);
  assert.deepStrictEqual(findConflicts({ designer: 'Ann' }, { designer: '' }, { designer: undefined }), [{ field: 'designer', theirs: 'Ann', yours: '' }]);
});

test('only fields in the base and the save are checked', () => {
  assert.deepStrictEqual(findConflicts({ designer: 'Cat', notes: 'theirs' }, { designer: 'Bob' }, { notes: 'old' }), []);
  assert.deepStrictEqual(findConflicts({ rating: 5 }, { rating: 1 }, { rating: 3 }), [], 'ratings are not checked');
  assert.deepStrictEqual(findConflicts(null, { designer: 'Bob' }, { designer: 'Ann' }), []);
});

test("tags merge: both people's additions and removals are kept", () => {
  // Stored: someone else added "red" and removed "old". This edit added "boat" and removed "toy".
  assert.deepStrictEqual(mergeTagLists(['red', 'toy'], ['old', 'toy'], ['boat', 'old']), ['boat', 'red']);
  assert.deepStrictEqual(mergeTagLists([{ name: 'a' }], ['a'], ['a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(mergeTagLists([], [], []), []);
});
