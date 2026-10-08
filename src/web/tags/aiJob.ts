/**
 * The AI tagging run on the JusttPrint backend (src/server/ai-tag-job.js): every page follows its
 * progress in the sidebar; the person who started it can stop it and reopen its review.
 */
import { useSyncExternalStore } from 'react';
import { callAction } from '../api';
import { onServerEvent } from '../page';

export interface AiTagJob {
  id: number;
  /** Who started it (username). */
  by: string | null;
  batch: boolean;
  total: number;
  processed: number;
  withTags: number;
  running: boolean;
  stopping: boolean;
}

/** A run with every result so far (get-ai-tag-job). */
export interface AiTagJobSnapshot extends AiTagJob {
  filePaths: string[];
  results: { filePath: string; tags: string[]; error: string | null }[];
}

let job: AiTagJob | null = null;
/** The review dialog shows this run (the sidebar then leaves out its Review button). */
let reviewing: number | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

function set(next: AiTagJob | null) {
  job = next;
  notify();
}

export function useAiTagJob(): { job: AiTagJob | null; reviewing: boolean } {
  const current = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => job);
  const shown = useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => reviewing);
  return { job: current, reviewing: !!current && shown === current.id };
}

export const currentAiTagJob = () => job;

export function setReviewing(id: number | null) {
  reviewing = id;
  notify();
}

export const getAiTagJob = () => callAction<AiTagJobSnapshot | null>('get-ai-tag-job').catch(() => null);

export const stopAiTagJob = () => callAction('stop-ai-tag-job').catch((error) => console.warn('Failed to stop AI tagging:', error));

/** The review was applied or closed after the run ended: the JusttPrint backend forgets it. */
export const dismissAiTagJob = (id: number) => callAction('dismiss-ai-tag-job', id).catch(() => {});

/** Text for a progress line. */
export function progressText(run: AiTagJob): string {
  if (run.stopping) return 'AI tagging: stopping...';
  if (!run.running) return `AI tags ready to review (${run.withTags} of ${run.total} with tags)`;
  return `AI tagging: ${run.processed}/${run.total}`;
}

export const percentOf = (run: AiTagJob) => (run.total > 0 ? Math.min(100, Math.floor((run.processed / run.total) * 100)) : 0);

if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pv-thumbnail-worker') !== '1') {
  onServerEvent('ai-tag-job', (summary: AiTagJob | null) => set(summary || null));
  getAiTagJob().then((snapshot) => {
    if (!snapshot || job) return;
    const { filePaths: _paths, results: _results, ...summary } = snapshot;
    set(summary);
  });
}
