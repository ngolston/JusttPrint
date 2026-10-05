/**
 * Scanning: Scan Directory (a folder the user types), Scan STL Home, and the scan after saving
 * the STL Home settings. The server indexes the files; this page shows the progress, then hands
 * models without thumbnails to the server's thumbnail job and offers to show the new models.
 * The server also scans STL Home by itself (at startup and on its interval); pages refresh when
 * it says so ('refresh-grid').
 */
import { useSyncExternalStore } from 'react';
import { callAction, settings } from '../api';
import { runSearch } from '../filters/search';
import { filterActions } from '../filters/store';
import { askText, onServerEvent, showMessage } from '../page';
import { invalidateThumbnail } from '../thumbnails/cache';
import { startThumbnailJob } from '../thumbnails/jobs';
import { stlHomeDirectories } from './stlHome';

export interface ScanProgress {
  /** "Checking files: 120", then "Saving models: 40 / 120". */
  text: string;
  /** 0–100, or null while the total is unknown. */
  percent: number | null;
}

let progress: ScanProgress | null = null;
const listeners = new Set<() => void>();
function setProgress(next: ScanProgress | null) {
  progress = next;
  listeners.forEach((listener) => listener());
}

/** The running scan's progress, or null when none runs. */
export function useScanProgress(): ScanProgress | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => progress);
}

/** Reload what depends on the library's contents: pickers, the folder tree, the grid. */
async function refreshLibraryViews() {
  window.libraryFilters?.reloadOptions();
  window.detailsFields?.reloadOptions();
  window.multiEdit?.reloadOptions();
  window.bundleDetails?.reloadOptions();
  window.folderTree?.refresh().catch(() => {});
  await runSearch({ force: true, preserveScroll: true });
}

const SKIPPED_NOTICE_SETTING = 'hideSkippedFileSizeNotice';

async function skippedNotice(count: number) {
  if (count <= 0 || await settings.get<string | null>(SKIPPED_NOTICE_SETTING).catch(() => null) === '1') return;
  const message = count === 1
    ? '1 file was skipped because it is larger than the max file size. You can set the max file size under Settings > Performance.'
    : `${count} files were skipped because they are larger than the max file size. You can set the max file size under Settings > Performance.`;
  if (await showMessage('Files Skipped', message, ['Okay', 'Never show again']) === 'Never show again') {
    await settings.save(SKIPPED_NOTICE_SETTING, '1');
  }
}

interface ScanResult {
  newFilesCount?: number;
  skippedDueToSize?: number;
}

/** Scan folders (one after another) with progress in the sidebar. */
export async function scanFolders(dirs: string[], options: { stlHome?: boolean } = {}) {
  if (progress || !dirs.length) return;
  const started = new Date().toISOString();
  let checked = 0;
  setProgress({ text: 'Gathering files...', percent: null });
  const offs = [
    // Scan events can arrive out of order: keep the count from going backwards.
    onServerEvent('scan-progress', (p: { processed?: number }) => {
      checked = Math.max(checked, Number(p?.processed) || 0);
      setProgress({ text: `Checking files: ${checked}`, percent: null });
    }),
    onServerEvent('db-progress', (p: { processed?: number; total?: number }) => {
      const total = Number(p?.total) || 0;
      setProgress({ text: `Saving models: ${p?.processed || 0} / ${total}`, percent: total ? ((Number(p?.processed) || 0) / total) * 100 : null });
    })
  ];
  let found = 0;
  let skipped = 0;
  const failures: string[] = [];
  try {
    for (const dir of dirs) {
      try {
        const result = await callAction<ScanResult | null>('scan-directory', dir, options.stlHome ? { isStlHomeScan: true } : {});
        found += Number(result?.newFilesCount) || 0;
        skipped += Number(result?.skippedDueToSize) || 0;
      } catch (error) {
        console.error('Error scanning', dir, error);
        failures.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    offs.forEach((off) => off());
    setProgress(null);
  }

  // The server renders thumbnails for whatever still lacks one (the grid renders visible cards
  // itself if the server's worker is not available).
  const missing = await callAction<unknown[]>('get-models-without-thumbnails').catch(() => []);
  if (missing.length) startThumbnailJob('missing', { background: true, quiet: true });

  if (failures.length) await showMessage('Scan Error', `Some folders could not be scanned:\n\n${failures.join('\n')}`);
  if (found > 0 && await showMessage('New Models Found', `${found} new model(s) found, would you like to see them?`, ['Yes', 'No']) === 'Yes') {
    filterActions.showAddedSince(started);
  }
  invalidateThumbnail();
  await refreshLibraryViews();
  await skippedNotice(skipped);
}

/** Scan Directory: ask for a folder inside the container (starting from the first STL Home). */
export async function scanDirectory() {
  if (progress) return;
  const homes = await stlHomeDirectories();
  const entered = await askText('Scan Directory', 'Folder to scan (a path inside the container, for example /models):', homes[0] || '');
  const dir = entered?.trim();
  if (!dir) return;
  await callAction('save-directory', dir).catch(() => {});
  filterActions.clearAll();
  await scanFolders([dir]);
}

/** Scan STL Home: every STL Home directory. */
export async function scanStlHome() {
  if (progress) return;
  const homes = await stlHomeDirectories();
  if (!homes.length) return void showMessage('STL Home', 'Set STL Home directories in Settings first (Settings → STL Home).');
  await callAction('save-directory', homes[0]).catch(() => {});
  filterActions.clearAll();
  await scanFolders(homes, { stlHome: true });
}

declare global {
  interface Window {
    scanDirectory?: () => Promise<void>;
    runScanSTLHome?: () => void;
    /** The STL Home dialog: scan the saved directories now. */
    performSTLHomeScan?: (dirs: string[]) => Promise<void>;
  }
}

if (typeof window !== 'undefined') {
  window.scanDirectory = scanDirectory;
  window.runScanSTLHome = () => { scanStlHome(); };
  window.performSTLHomeScan = (dirs) => scanFolders(dirs, { stlHome: true });
  // The server scanned STL Home or finished a thumbnail job.
  onServerEvent('refresh-grid', () => {
    if (progress) return;
    invalidateThumbnail();
    refreshLibraryViews().catch((error) => console.error('Error refreshing after a server update:', error));
  });
}
