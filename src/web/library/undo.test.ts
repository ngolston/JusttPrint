import { beforeEach, describe, expect, it } from 'vitest';
import { UNDO_LIMIT, clearUndo, onUndoChange, recordUndo, revertTags, sameValue, undoLast } from './undo';

describe('undo list', () => {
  beforeEach(() => clearUndo());

  it('undoes the newest edit first, each once', async () => {
    const done: string[] = [];
    recordUndo('first', async () => { done.push('first'); });
    recordUndo('second', async () => { done.push('second'); });
    expect(await undoLast()).toBe('second');
    expect(await undoLast()).toBe('first');
    expect(await undoLast()).toBeNull();
    expect(done).toEqual(['second', 'first']);
  });

  it('undoes a chosen edit by id and tells listeners what is newest', async () => {
    const seen: (string | null)[] = [];
    const stop = onUndoChange((latest) => seen.push(latest?.label ?? null));
    const a = recordUndo('a', async () => {});
    recordUndo('b', async () => {});
    await undoLast(a.id);
    stop();
    expect(seen).toEqual(['a', 'b', 'b']);
    expect(await undoLast()).toBe('b');
  });

  it(`keeps the last ${UNDO_LIMIT} edits`, async () => {
    for (let i = 0; i < UNDO_LIMIT + 5; i++) recordUndo(String(i), async () => {});
    let count = 0;
    while (await undoLast()) count++;
    expect(count).toBe(UNDO_LIMIT);
  });

  it('a failed undo resolves null and is not retried', async () => {
    recordUndo('broken', async () => { throw new Error('offline'); });
    const original = console.error;
    console.error = () => {};
    try {
      expect(await undoLast()).toBeNull();
    } finally {
      console.error = original;
    }
    expect(await undoLast()).toBeNull();
  });
});

describe('revertTags', () => {
  it('takes back only what the edit added and removed', () => {
    // The edit turned [boat, red] into [boat, toy]; meanwhile someone else added "blue".
    expect(revertTags(['blue', 'boat', 'toy'], ['boat', 'red'], ['boat', 'toy'])).toEqual(['blue', 'boat', 'red']);
  });

  it('accepts tag objects', () => {
    expect(revertTags([{ name: 'a' }, { name: 'b' }], [{ name: 'a' }], ['a', 'b'])).toEqual(['a']);
  });
});

describe('sameValue', () => {
  it('treats empty and missing alike, and ignores tag order', () => {
    expect(sameValue('designer', null, '')).toBe(true);
    expect(sameValue('designer', ' Ann ', 'Ann')).toBe(true);
    expect(sameValue('designer', 'Ann', 'Bo')).toBe(false);
    expect(sameValue('tags', ['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameValue('tags', ['a'], ['a', 'b'])).toBe(false);
  });
});
