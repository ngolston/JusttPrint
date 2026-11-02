/** Bambu Lab printers' live status (src/server/bambu-live.js), kept up to date by 'printer-live' events. */
import { useSyncExternalStore } from 'react';
import { printers as printerApi, type PrinterLive } from '../api';
import type { StatusTone } from '../components/Badge';
import { onServerEvent } from '../page';

let list: PrinterLive[] = [];
const listeners = new Set<() => void>();
const set = (next: PrinterLive[]) => {
  list = Array.isArray(next) ? next : [];
  listeners.forEach((listener) => listener());
};

let started = false;
function follow() {
  if (started || typeof window === 'undefined' || new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1') return;
  started = true;
  // As in activity/activity.ts: the first answer must not undo a newer event.
  let heard = false;
  onServerEvent('printer-live', (next: PrinterLive[]) => {
    heard = true;
    set(next);
  });
  printerApi.live().then(
    (snapshot) => {
      if (!heard) set(snapshot);
    },
    () => {}
  );
}

/** Every followed printer's live status. */
export function usePrinterLive(): PrinterLive[] {
  follow();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => list,
    () => list
  );
}

/** "1 h 20 min", "45 min". */
export function minutesText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const STATE_LABELS: Record<string, string> = {
  printing: 'Printing',
  paused: 'Paused',
  finished: 'Finished',
  failed: 'Failed',
  idle: 'Idle',
  offline: 'Offline'
};

/** "Printing 37%", "Idle", "Offline". */
export function liveLabel(live: PrinterLive): string {
  const label = STATE_LABELS[live.state || ''] || 'Connecting…';
  return (live.state === 'printing' || live.state === 'paused') && live.progress !== null ? `${label} ${live.progress}%` : label;
}

/** Badge tones for each state. */
export function liveTone(live: PrinterLive): StatusTone {
  if (live.state === 'printing') return 'accent';
  if (live.state === 'paused') return 'warning';
  if (live.state === 'failed') return 'danger';
  if (live.state === 'finished') return 'success';
  return 'neutral';
}
