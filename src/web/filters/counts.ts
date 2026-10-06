/**
 * The model counts the sidebar and the phone app bar show: models in the grid (set as the grid
 * loads, library/models.ts) and in the library (fetched once the grid settles).
 */
import { useSyncExternalStore } from 'react';
import { callAction } from '../api';

let counts = { view: 0, total: 0 };
const listeners = new Set<() => void>();
let totalTimer: ReturnType<typeof setTimeout> | null = null;

function set(next: Partial<typeof counts>) {
  counts = { ...counts, ...next };
  listeners.forEach((listener) => listener());
}

/** The grid reports its count page by page while it loads; one total fetch afterwards is enough. */
export function refreshTotal() {
  if (totalTimer) clearTimeout(totalTimer);
  totalTimer = setTimeout(() => {
    totalTimer = null;
    callAction<number>('getTotalModelCount').then((n) => set({ total: Number(n) || 0 }), (error) => console.error('Error updating total model count:', error));
  }, 350);
}

export function setViewCount(view: number) {
  set({ view });
  refreshTotal();
}

export function useModelCounts() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => counts);
}

export const plural = (n: number) => `${n} model${n === 1 ? '' : 's'}`;
