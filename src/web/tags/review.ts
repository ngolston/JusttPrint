/**
 * The Review Generated Tags state: one entry per model (keyed by path, so repeated server
 * events update an entry instead of adding another), which suggested tags are ticked, and how
 * picked tags merge into a model's tags. Pure functions; TagPreviewDialog.tsx renders it.
 */

export type MergeStrategy = 'merge' | 'append' | 'replace';

export interface ReviewEntry {
  filePath: string;
  fileName: string;
  thumbnail: string | null;
  existingTags: string[];
  /** Undefined while the AI is still working on this model. */
  generatedTags?: string[];
  error?: string | null;
}

export interface Review {
  /** A batch (several models); a single model shows its name at the top. */
  batch: boolean;
  /** The batch is still running. */
  running: boolean;
  expected: number;
  entries: ReviewEntry[];
  /** `${filePath}::${tag}` → ticked (default ticked). */
  unticked: ReadonlySet<string>;
}

export const AI_TAG = 'AI Tagged';

export const pathKey = (filePath: string) => filePath.replace(/\\/g, '/').toLowerCase().trim().replace(/^\/+/, '');
export const tickKey = (filePath: string, tag: string) => `${filePath}::${tag}`;

export function emptyReview(batch: boolean, expected: number, running: boolean): Review {
  return { batch, running, expected, entries: [], unticked: new Set() };
}

/** Add or update a model's entry. A result is never replaced by "still generating". */
export function upsertEntry(review: Review, entry: ReviewEntry): Review {
  const key = pathKey(entry.filePath);
  const index = review.entries.findIndex((e) => pathKey(e.filePath) === key);
  if (index < 0) return { ...review, entries: [...review.entries, entry] };
  const current = review.entries[index];
  if (entry.generatedTags === undefined && current.generatedTags !== undefined) return review;
  const entries = review.entries.slice();
  entries[index] = { ...current, ...entry, thumbnail: entry.thumbnail ?? current.thumbnail };
  return { ...review, entries };
}

/** Whether the review lists this model already. */
export const hasEntry = (review: Review | null, filePath: string) => !!review && review.entries.some((e) => pathKey(e.filePath) === pathKey(filePath));

/** A model's result, on the entry the review already has (unchanged when it has none). */
export function withResult(review: Review, filePath: string, generatedTags: string[], error: string | null): Review {
  const key = pathKey(filePath);
  const index = review.entries.findIndex((e) => pathKey(e.filePath) === key);
  if (index < 0) return review;
  const entries = review.entries.slice();
  entries[index] = { ...entries[index], generatedTags, error };
  return { ...review, entries };
}

/** The batch ended (finished, stopped, or rate limited): models still waiting get a note. */
export function finishBatch(review: Review): Review {
  return {
    ...review,
    running: false,
    entries: review.entries.map((e) => (e.generatedTags !== undefined ? e : {
      ...e, generatedTags: [], error: e.error || 'Tag generation stopped before this model finished. Tags already generated can still be applied.'
    }))
  };
}

export function setTicked(review: Review, keys: string[], ticked: boolean): Review {
  const unticked = new Set(review.unticked);
  for (const key of keys) {
    if (ticked) unticked.delete(key);
    else unticked.add(key);
  }
  return { ...review, unticked };
}

/** Each model's ticked suggestions (models with none left out). */
export function pickedTags(review: Review): { entry: ReviewEntry; tags: string[] }[] {
  return review.entries
    .map((entry) => ({ entry, tags: (entry.generatedTags || []).filter((tag) => !review.unticked.has(tickKey(entry.filePath, tag))) }))
    .filter((pick) => pick.tags.length > 0);
}

/** Apply waits while a batch still has models to hear back from. */
export function canApply(review: Review): boolean {
  return !(review.running && review.entries.some((e) => e.generatedTags === undefined));
}

/** The model's tags after applying picked suggestions; every applied model also gets "AI Tagged". */
export function mergeTags(existing: string[], picked: string[], strategy: MergeStrategy): string[] {
  if (strategy === 'replace') return [...new Set([...picked, AI_TAG])];
  if (strategy === 'append') {
    const have = new Set(existing.map((t) => t.toLowerCase()));
    const added = picked.filter((t) => !have.has(t.toLowerCase()));
    return [...new Set([...existing, ...added, AI_TAG])];
  }
  return [...new Set([...existing, ...picked, AI_TAG])];
}

export const STRATEGY_HELP: Record<MergeStrategy, string> = {
  merge: 'Selected tags will be added to existing tags (duplicates removed)',
  append: 'Only new tags not already present will be added',
  replace: 'Existing tags will be replaced with selected tags'
};

/** "Rate limit exceeded: <detail>" → the detail; other errors as they are. */
export function rateLimitDetail(error: string | null | undefined): string | null {
  if (!error || !error.includes('Rate limit')) return null;
  return error.includes('Rate limit exceeded: ') ? error.split('Rate limit exceeded: ')[1] : 'API rate limit has been exceeded. Tags already generated can still be applied.';
}
