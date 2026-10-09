import { describe, expect, it } from 'vitest';
import { canApply, emptyReview, finishBatch, hasEntry, mergeTags, pickedTags, rateLimitDetail, setTicked, tickKey, upsertEntry, withResult, type ReviewEntry } from './review';

const entry = (filePath: string, over: Partial<ReviewEntry> = {}): ReviewEntry => ({
  filePath, fileName: filePath.split('/').pop()!, thumbnail: null, existingTags: [], ...over
});

describe('tag review', () => {
  it('keeps one entry per model, matching paths loosely', () => {
    let review = emptyReview(true, 2, true);
    review = upsertEntry(review, entry('/lib/a.stl'));
    review = upsertEntry(review, entry('lib\\A.stl', { generatedTags: ['x'] }));
    expect(review.entries).toHaveLength(1);
    expect(review.entries[0].generatedTags).toEqual(['x']);
  });

  it('never replaces a result with "still generating"', () => {
    let review = upsertEntry(emptyReview(false, 1, false), entry('/a', { generatedTags: ['x'] }));
    review = upsertEntry(review, entry('/a'));
    expect(review.entries[0].generatedTags).toEqual(['x']);
  });

  it('waits for a running batch, and a finished batch notes the models it skipped', () => {
    let review = upsertEntry(upsertEntry(emptyReview(true, 2, true), entry('/a', { generatedTags: ['x'] })), entry('/b'));
    expect(canApply(review)).toBe(false);
    review = finishBatch(review);
    expect(canApply(review)).toBe(true);
    expect(review.entries[1].generatedTags).toEqual([]);
    expect(review.entries[1].error).toMatch(/stopped/);
  });

  it('applies only ticked suggestions (all ticked at first)', () => {
    let review = upsertEntry(emptyReview(true, 2, false), entry('/a', { generatedTags: ['x', 'y'] }));
    review = upsertEntry(review, entry('/b', { generatedTags: ['z'] }));
    review = setTicked(review, [tickKey('/a', 'y'), tickKey('/b', 'z')], false);
    expect(pickedTags(review).map((p) => [p.entry.filePath, p.tags])).toEqual([['/a', ['x']]]);
    review = setTicked(review, [tickKey('/b', 'z')], true);
    expect(pickedTags(review)).toHaveLength(2);
  });

  it('merges, appends or replaces, always adding "AI Tagged"', () => {
    expect(mergeTags(['Cars', 'old'], ['cars', 'new'], 'merge')).toEqual(['Cars', 'old', 'cars', 'new', 'AI Tagged']);
    expect(mergeTags(['Cars', 'old'], ['cars', 'new'], 'append')).toEqual(['Cars', 'old', 'new', 'AI Tagged']);
    expect(mergeTags(['Cars', 'AI Tagged'], ['new'], 'replace')).toEqual(['new', 'AI Tagged']);
    expect(mergeTags(['AI Tagged'], ['x'], 'merge')).toEqual(['AI Tagged', 'x']);
  });

  it('reads rate limit errors', () => {
    expect(rateLimitDetail('Rate limit exceeded: try in 1 minute')).toBe('try in 1 minute');
    expect(rateLimitDetail('Rate limit hit')).toMatch(/rate limit has been exceeded/);
    expect(rateLimitDetail('Network down')).toBeNull();
  });
});

describe('a result for a model the review lists', () => {
  const entry = (filePath: string): ReviewEntry => ({ filePath, fileName: filePath.split('/').pop() || '', thumbnail: null, existingTags: ['old'] });
  const listed = upsertEntry(upsertEntry(emptyReview(true, 2, true), entry('/l/cube.stl')), entry('/l/box.3mf'));

  it('is shown at once, keeping the entry as it was', () => {
    expect(hasEntry(listed, '/L/box.3mf')).toBe(true);
    expect(hasEntry(listed, '/l/other.stl')).toBe(false);
    expect(hasEntry(null, '/l/box.3mf')).toBe(false);
    const next = withResult(listed, '/l/box.3mf', ['e2e-real-a'], null);
    expect(next.entries[1]).toEqual({ ...entry('/l/box.3mf'), generatedTags: ['e2e-real-a'], error: null });
    expect(withResult(listed, '/l/other.stl', ['x'], null)).toBe(listed);
  });

  it('is kept when the end of the run comes right after', () => {
    const done = finishBatch(withResult(withResult(listed, '/l/cube.stl', ['a'], null), '/l/box.3mf', ['e2e-real-a'], null));
    expect(done.entries.map((e) => e.generatedTags)).toEqual([['a'], ['e2e-real-a']]);
    expect(done.entries.every((e) => !e.error)).toBe(true);
    expect(canApply(done)).toBe(true);
  });
});
