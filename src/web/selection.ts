/**
 * The grid selection: which models are selected. Paths compare normalized (slashes, URL
 * encoding, drive-letter case) but keep the spelling they were first added with. The grid
 * cards and the multi-edit panel subscribe (also as window.selection).
 */
import { normalizePath } from './grid/layout';

export type SelectionListener = () => void;

export class Selection implements Iterable<string> {
  private paths = new Map<string, string>();
  private listeners = new Set<SelectionListener>();
  private pending = false;

  get size(): number {
    return this.paths.size;
  }

  has(filePath: string | null | undefined): boolean {
    return !!filePath && this.paths.has(normalizePath(filePath));
  }

  /** Select a path. Returns the spelling stored (the earlier one if it was already selected). */
  add(filePath: string): string {
    const key = normalizePath(filePath);
    const existing = this.paths.get(key);
    if (existing !== undefined) return existing;
    this.paths.set(key, filePath);
    this.changed();
    return filePath;
  }

  /** Unselect a path. Returns the stored spelling, or null if it was not selected. */
  delete(filePath: string): string | null {
    const key = normalizePath(filePath);
    const existing = this.paths.get(key);
    if (existing === undefined) return null;
    this.paths.delete(key);
    this.changed();
    return existing;
  }

  toggle(filePath: string): boolean {
    if (this.has(filePath)) {
      this.delete(filePath);
      return false;
    }
    this.add(filePath);
    return true;
  }

  clear() {
    if (!this.paths.size) return;
    this.paths.clear();
    this.changed();
  }

  /** Replace the selection. */
  set(filePaths: Iterable<string>) {
    this.paths.clear();
    for (const filePath of filePaths) if (filePath) this.paths.set(normalizePath(filePath), filePath);
    this.changed();
  }

  /** Keep only the paths `keep` accepts. */
  retain(keep: (filePath: string) => boolean) {
    let removed = false;
    for (const [key, filePath] of this.paths) {
      if (!keep(filePath)) {
        this.paths.delete(key);
        removed = true;
      }
    }
    if (removed) this.changed();
  }

  values(): string[] {
    return [...this.paths.values()];
  }

  [Symbol.iterator](): Iterator<string> {
    return this.values()[Symbol.iterator]();
  }

  /** Called once per batch of changes (after the current task). Returns the unsubscribe function. */
  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.listeners.forEach((listener) => {
        try {
          listener();
        } catch (error) {
          console.error('Selection listener failed:', error);
        }
      });
    });
  }
}

declare global {
  interface Window {
    selection?: Selection;
  }
}

/** The page's selection (one per page). */
export const selection = new Selection();
if (typeof window !== 'undefined') window.selection = selection;
