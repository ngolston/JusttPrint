/**
 * The server's bulk thumbnail job (Regenerate Thumbnails, Generate Missing Thumbnails, and the
 * job after a scan): the server's headless worker renders, and every open page follows its
 * progress. A job this page started shows in a dialog until sent to the background; any other
 * job (another tab's, the server's own after an STL Home scan) shows in the sidebar.
 */
import { useSyncExternalStore } from 'react';
import { callAction } from '../api';
import { showMessage } from '../page';
import { invalidateThumbnail } from './cache';
import { setBulkJobActive } from './cards';

export type JobMode = 'all' | 'missing';

export interface Job {
  mode: JobMode;
  title: string;
  phase: string;
  processed: number;
  total: number;
  /** Shown in the sidebar instead of the dialog. */
  background: boolean;
  /** Started from this page (it reports the outcome). */
  ours: boolean;
  stopping: boolean;
  /** Finished or stopped: the dialog shows this briefly. */
  done?: string;
}

const TITLES: Record<JobMode, string> = { all: 'Regenerate Thumbnails', missing: 'Generate Missing Thumbnails' };

let job: Job | null = null;
const listeners = new Set<() => void>();
function set(next: Job | null) {
  job = next;
  listeners.forEach((listener) => listener());
}
const update = (patch: Partial<Job>) => { if (job) set({ ...job, ...patch }); };

export function useThumbnailJob(): Job | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => job);
}

/** Start a job on the server. Resolves false when it could not start (the reason is shown unless quiet). */
export async function startThumbnailJob(mode: JobMode, options: { background?: boolean; quiet?: boolean } = {}): Promise<boolean> {
  if (job && !job.done) {
    if (!options.quiet) await showMessage(TITLES[mode], 'A thumbnail job is already running.');
    return false;
  }
  set({ mode, title: TITLES[mode], phase: 'Starting on the JusttPrint backend...', processed: 0, total: 0, background: !!options.background, ours: true, stopping: false });
  setBulkJobActive(true);
  const start = await callAction<{ success?: boolean; error?: string }>('start-server-thumbnail-job', { mode })
    .catch((error) => ({ success: false, error: error instanceof Error ? error.message : String(error) }));
  if (start?.success) return true;
  set(null);
  setBulkJobActive(false);
  if (!options.quiet) await showMessage('Error', start?.error || 'Failed to start the thumbnail job.');
  return false;
}

export const jobActions = {
  stop() {
    if (!job || job.stopping) return;
    update({ stopping: true, phase: 'Stopping...' });
    callAction('cancel-server-thumbnail-job').catch((error) => console.warn('Failed to cancel thumbnail job:', error));
  },
  background() {
    update({ background: true });
  }
};

function onProgress(payload: { phase?: string; processed?: number; total?: number; mode?: JobMode } | null) {
  setBulkJobActive(true);
  const mode: JobMode = payload?.mode === 'all' ? 'all' : 'missing';
  // A job started elsewhere: follow it in the sidebar.
  const current: Job = job && !job.done ? job : { mode, title: TITLES[mode], phase: '', processed: 0, total: 0, background: true, ours: false, stopping: false };
  set({
    ...current,
    phase: current.stopping ? 'Stopping...' : payload?.phase || current.phase,
    processed: typeof payload?.processed === 'number' ? payload.processed : current.processed,
    total: typeof payload?.total === 'number' ? payload.total : current.total
  });
}

function finish(message: string) {
  setBulkJobActive(false);
  invalidateThumbnail();
  const finished = job;
  if (!finished) return;
  if (!finished.background) {
    // Leave the outcome on screen briefly.
    set({ ...finished, done: message, phase: message });
    setTimeout(() => { if (job?.done) set(null); }, 1200);
  } else {
    set(null);
    if (finished.ours) showMessage(finished.title, message === 'Stopped.' ? 'Thumbnail generation stopped.' : 'Thumbnail generation finished.');
  }
}

function onComplete(result: { cancelled?: boolean } | null) {
  finish(result?.cancelled ? 'Stopped.' : 'Finished.');
}

function onError(payload: { error?: string } | null) {
  const ours = job?.ours;
  setBulkJobActive(false);
  set(null);
  if (ours) showMessage('Error', payload?.error || 'The thumbnail job on the JusttPrint backend failed');
}

declare global {
  interface Window {
    /** Theme settings: re-render every thumbnail after the model color or lighting changed. */
    regenerateAllThumbnails?: () => Promise<void>;
  }
}

/** Handle a page or server event (the bridge holds events that came before this listener). */
export function handlePageEvent(channel: string, handler: (...args: any[]) => void) {
  window.electron?.on?.(channel, handler);
}

async function regenerate() {
  const total = await callAction<number>('getTotalModelCount').catch(() => 0);
  if (!total) return void showMessage('Information', 'No models found in the database.');
  const answer = await showMessage('Regenerate Thumbnails',
    `This will regenerate thumbnails for all ${total} models. This may take a while. Continue?`, ['Yes', 'No']);
  if (answer === 'Yes') await startThumbnailJob('all');
}

async function generateMissing() {
  const missing = await callAction<unknown[]>('get-models-without-thumbnails').catch(() => []);
  if (!missing.length) return void showMessage('Information', 'All models already have thumbnails. Nothing to generate.');
  const answer = await showMessage('Generate Missing Thumbnails',
    `${missing.length} models are missing thumbnails. Would you like to generate them now?`, ['Yes', 'No']);
  if (answer === 'Yes') await startThumbnailJob('missing');
}

const isWorkerPage = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1';

if (typeof window !== 'undefined' && !isWorkerPage) {
  handlePageEvent('thumbnail-job-progress', onProgress);
  handlePageEvent('thumbnail-job-complete', onComplete);
  handlePageEvent('thumbnail-job-error', onError);
  handlePageEvent('regenerate-thumbnails', () => { regenerate(); });
  handlePageEvent('generate-missing-thumbnails', () => { generateMissing(); });
  window.regenerateAllThumbnails = async () => { await startThumbnailJob('all'); };
  // A job already running (started before this page loaded): follow it.
  callAction<{ status?: string; mode?: JobMode }>('get-server-thumbnail-job-status').then((status) => {
    if (status?.status === 'running' && !job) onProgress({ mode: status.mode, phase: 'Generating thumbnails on the JusttPrint backend...' });
  }, () => {});
}
