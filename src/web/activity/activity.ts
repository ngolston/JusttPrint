/** What runs in the background (src/server/activity.js), for the progress bars above Library Storage. */
import { useSyncExternalStore } from 'react';
import { callAction } from '../api';
import { onServerEvent } from '../page';

export type ActivityKind = 'scan' | 'ai-tagging' | 'categories' | 'thumbnails' | 'duplicates' | 'download' | 'upload' | 'backup' | 'move' | 'plates';

export interface Activity {
  id: string;
  kind: ActivityKind;
  label: string;
  detail: string | null;
  done: number;
  /** null while its size is not known. */
  total: number | null;
  unit: string;
  startedAt: string;
  /** How long it should still take (ms), when that can be told. */
  etaMs: number | null;
}

/** Scans shorter than this are not shown (folder watching picks up a file in a moment). */
export const SHOW_AFTER_MS = 1500;

let jobs: Activity[] = [];
const listeners = new Set<() => void>();
const set = (next: Activity[]) => {
  jobs = Array.isArray(next) ? next : [];
  listeners.forEach((listener) => listener());
};

let started = false;
function follow() {
  if (started || typeof window === 'undefined') return;
  started = true;
  onServerEvent('background-activity', (next: Activity[]) => set(next));
  callAction<Activity[]>('get-background-activity').then(set, () => {});
}

/** The running jobs (every browser sees them all). */
export function useActivity(): Activity[] {
  follow();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => jobs
  );
}

/** The jobs worth a bar: every job, a scan once it has run for a moment. */
export function shown(list: Activity[], now = Date.now()): Activity[] {
  return list.filter((job) => job.kind !== 'scan' || now - Date.parse(job.startedAt) >= SHOW_AFTER_MS);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** The share done (0–100), or null when its size is not known. */
export function percentOf(job: Pick<Activity, 'done' | 'total'>): number | null {
  if (!job.total) return null;
  return Math.max(0, Math.min(100, Math.floor((job.done / job.total) * 100)));
}

/** "12 of 140 models", "3.2 MB of 10 MB", "45%", "1,204 files so far". */
export function amountText(job: Pick<Activity, 'done' | 'total' | 'unit'>): string {
  const n = (value: number) => Math.round(value).toLocaleString('en-US');
  if (job.unit === 'bytes') return job.total ? `${formatBytes(job.done)} of ${formatBytes(job.total)}` : formatBytes(job.done);
  if (job.unit === 'pages') return job.total ? `${percentOf(job)}%` : '';
  if (!job.total) return job.done ? `${n(job.done)} ${job.unit} so far` : '';
  return `${n(job.done)} of ${n(job.total)} ${job.unit}`;
}

/** "about 3 min left", "less than a minute left", "about 1 h 20 min left"; '' when it cannot be told. */
export function etaText(etaMs: number | null): string {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs < 0) return '';
  const minutes = Math.round(etaMs / 60000);
  if (etaMs < 45000) return 'less than a minute left';
  if (minutes < 60) return `about ${Math.max(1, minutes)} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ''} left`;
}
