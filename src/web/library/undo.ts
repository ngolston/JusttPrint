/**
 * Undo for metadata and tag edits: each save records how to put the old values back. The newest
 * edit shows in the Undo notice (UndoToast.tsx); Ctrl/Cmd+Z undoes edits one by one, newest first.
 */

export interface UndoEntry {
  id: number;
  /** What the edit did, e.g. "Changed the designer of benchy.stl". */
  label: string;
  /** What was edited: 'tag' and 'metadata' get an Undo line in the Tag Manager and Metadata Editor (the page's notice is behind them). */
  kind?: 'tag' | 'metadata';
  undo: () => Promise<unknown>;
}

/** How many edits Ctrl/Cmd+Z can go back. */
export const UNDO_LIMIT = 20;

let entries: UndoEntry[] = [];
let nextId = 1;
let running = false;
const listeners = new Set<(latest: UndoEntry | null) => void>();

const notify = () => listeners.forEach((fn) => fn(entries[entries.length - 1] ?? null));

/** Remember how to undo an edit that was just saved. */
export function recordUndo(label: string, undo: () => Promise<unknown>, kind?: UndoEntry['kind']): UndoEntry {
  const entry: UndoEntry = { id: nextId++, label, undo, ...(kind ? { kind } : {}) };
  entries = [...entries, entry].slice(-UNDO_LIMIT);
  notify();
  return entry;
}

/** Undo the newest edit (or the one with `id`, if it is still listed). Resolves its label, or null. */
export async function undoLast(id?: number): Promise<string | null> {
  if (running) return null;
  const entry = id === undefined ? entries[entries.length - 1] : entries.find((e) => e.id === id);
  if (!entry) return null;
  entries = entries.filter((e) => e !== entry);
  running = true;
  notify();
  try {
    await entry.undo();
    return entry.label;
  } catch (error) {
    console.error(`Undo failed (${entry.label}):`, error);
    return null;
  } finally {
    running = false;
  }
}

/** The id of the newest edit recorded so far (0 before any): later edits have larger ids. */
export const lastUndoId = () => nextId - 1;

/** Follow the newest undoable edit (null when there is none). Returns the unsubscribe function. */
export function onUndoChange(fn: (latest: UndoEntry | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Forget every edit (tests). */
export function clearUndo() {
  entries = [];
  notify();
}

/** Tag lists as plain names. */
export const tagNames = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).map((t) => String(typeof t === 'string' ? t : (t as { name?: string })?.name || '').trim()).filter(Boolean);

/** Undo one tag edit on a list someone may have changed since: drop what it added, add back what it removed. */
export function revertTags(current: unknown, before: unknown, after: unknown): string[] {
  const was = new Set(tagNames(before));
  const now = new Set(tagNames(after));
  const result = new Set(tagNames(current));
  for (const tag of now) if (!was.has(tag)) result.delete(tag);
  for (const tag of was) if (!now.has(tag)) result.add(tag);
  return [...result].sort((a, b) => a.localeCompare(b));
}

/** The same value for undo purposes: empty and missing match, tag order does not count. */
export function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (field === 'tags') return tagNames(a).sort().join('\n') === tagNames(b).sort().join('\n');
  return String(a ?? '').trim() === String(b ?? '').trim();
}
