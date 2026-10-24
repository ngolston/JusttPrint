import { useSyncExternalStore } from 'react';
import { currentToken } from '../ai/puterAuth';
import { callAction } from '../api';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { onServerEvent, showMessage } from '../page';
import { navigate } from '../shell/routes';

/**
 * The Upload folder and Organize Uploads (src/server/upload-inbox.js): where uploads wait, how
 * many models are waiting ("Not organized"), and the run that puts them where they belong.
 */

export interface UploadFolderInfo {
  uploadFolder: string;
  /** '' when the default is used: Uploads inside the first STL Home folder. */
  chosenUploadFolder?: string;
  /** Where Organize Uploads puts models (the folder chosen, else the first STL Home folder). */
  destination: string;
  /** The folder chosen in Settings ('' for the first STL Home folder). */
  chosenDestination: string;
  waiting: number;
  /** Settings → Scanning → Organize (src/server/upload-inbox.js). */
  options: OrganizeOptions;
  /** Folders set by Docker (JUSTTPRINT_UPLOAD_FOLDER, JUSTTPRINT_ORGANIZE_DESTINATION). */
  fromEnv?: { uploadFolder: boolean; destination: boolean };
  /** The folder levels Organize can use. */
  layerChoices: { id: string; label: string }[];
}

export interface OrganizeOptions {
  /** The folders above each model's own (named after its Title), e.g. ['category', 'subcategory']. */
  layers: string[];
  tidy: boolean;
  tags: boolean;
  autoApply: boolean;
}

/** "Destination/Category/Subcategory/Title/file", from the settings. */
export function organizeStructure(info: UploadFolderInfo | null): string {
  const labels = (info?.options.layers || []).map((id) => info?.layerChoices.find((choice) => choice.id === id)?.label || id);
  return [info?.destination || 'Destination', ...labels, 'Title', 'file'].join('/');
}

export interface OrganizeRun {
  id: number;
  by: string | null;
  running: boolean;
  stopping: boolean;
  phase: 'prepare' | 'categorize' | 'move' | 'tag' | 'done';
  total: number;
  done: number;
  useAi: boolean;
  destination: string;
  moved: { name: string; to: string; category: string; subcategory: string; models: number }[];
  movedCount: number;
  movedModels: number;
  tagged: number;
  /** Files renamed after their model's Title. */
  renamed: number;
  /** Auto-apply off: the tags went to a review in the browser that started it. */
  reviewing: boolean;
  failed: { name: string; error: string }[];
  warning: string | null;
}

interface State {
  info: UploadFolderInfo | null;
  run: OrganizeRun | null;
}

let state: State = { info: null, run: null };
const listeners = new Set<() => void>();
let started = false;
let reloadTimer = 0;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export async function reloadUploadFolder() {
  try {
    setInfo(await callAction<UploadFolderInfo>('get-upload-folder'));
  } catch {
    /* logged out, or an older server */
  }
}

/** New info; the cards are drawn again when the Upload folder changed (their Not organized flag). */
function setInfo(info: UploadFolderInfo) {
  const before = state.info?.uploadFolder;
  set({ info });
  if (before !== info.uploadFolder) (window as unknown as { gridHost?: { rebuild?: () => void } }).gridHost?.rebuild?.();
}

/** Load once, then follow the server: settings saved, scans and moves (the count), and the run. */
function startFollowing() {
  if (started) return;
  started = true;
  void reloadUploadFolder();
  void callAction<OrganizeRun | null>('get-organize-uploads')
    .then((run) => set({ run }))
    .catch(() => {});
  const soon = () => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void reloadUploadFolder(), 600);
  };
  onServerEvent('upload-folder-changed', (info: UploadFolderInfo) => setInfo(info));
  onServerEvent('refresh-grid', soon);
  onServerEvent('organize-uploads', (run: OrganizeRun | null) => {
    set({ run });
    if (run && !run.running) soon();
  });
}

const subscribe = (listener: () => void) => {
  startFollowing();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useUploadFolder = () => useSyncExternalStore(subscribe, () => state.info);
export const useOrganizeRun = () => useSyncExternalStore(subscribe, () => state.run);
export const uploadFolderInfo = () => state.info;

/** A folder or file path compared loosely (either slash, no trailing one). */
const key = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');

/** Whether a file waits in the Upload folder (its card says "Not organized"). */
export function isUnorganized(filePath: string, info: UploadFolderInfo | null = state.info): boolean {
  if (!info?.uploadFolder || !filePath || filePath.startsWith('url::')) return false;
  return key(filePath.split('::')[0]).startsWith(`${key(info.uploadFolder)}/`);
}

/** Whether the library shows the Upload folder (the Not organized filter). */
export function showsUnorganized(directory: string, info: UploadFolderInfo | null = state.info): boolean {
  return !!info?.uploadFolder && !!directory && key(directory) === key(info.uploadFolder);
}

/** The library with only the models waiting in the Upload folder. */
export function showUnorganized() {
  const folder = state.info?.uploadFolder;
  if (!folder) return;
  navigate('library');
  applyFilterChange(() => {
    filterActions.clearAll();
    filterActions.setDirectory(folder);
  });
}

/** Back to the whole library. */
export function hideUnorganized() {
  applyFilterChange(() => filterActions.setDirectory(''));
}

/** Start Organize Uploads (it runs on the server; useOrganizeRun follows it). */
export async function organizeUploads() {
  try {
    // Puter answers through this browser: without its sign-in here the server leaves the AI out.
    const result = await callAction<OrganizeRun | { busy: true }>('organize-uploads', { puterSignedIn: !!currentToken() });
    if ('busy' in result) await showMessage('Organize', 'Organize is already running.');
    else set({ run: result });
  } catch (error) {
    await showMessage('Organize', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Organize (the sidebar): runs at once with its settings; without the Upload folder and a
 * destination it opens Settings → Scanning → Organize instead.
 */
export async function runOrganize() {
  // Fresh: the Upload folder follows STL Home when none is chosen.
  await reloadUploadFolder();
  const info = state.info;
  if (!info?.uploadFolder || !info.destination) {
    navigate('settings', 'organize');
    await showMessage('Organize', 'Choose the scanned directory (the Upload folder) and the destination first.');
    return;
  }
  await organizeUploads();
}

export const stopOrganizing = () => callAction('stop-organize-uploads').catch(() => {});

/** Forget a finished run (its notice closes). */
export function dismissOrganizeRun() {
  if (state.run && !state.run.running) set({ run: null });
}

const plural = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

/** What a run is doing, or how it ended. */
export function organizeText(run: OrganizeRun): string {
  if (run.running) {
    if (run.stopping) return 'Stopping Organize…';
    switch (run.phase) {
      case 'prepare':
        return `Organizing: preparing ${run.done} of ${run.total}…`;
      case 'categorize':
        return run.useAi ? 'Organizing: the AI is choosing their categories…' : 'Organizing: choosing their categories…';
      case 'move':
        return `Organizing: moving ${run.done} of ${run.total}…`;
      case 'tag':
        return `Organizing: AI tagging ${run.done} of ${run.total}…`;
      default:
        return 'Organizing…';
    }
  }
  const parts = [`Organize finished: ${plural(run.movedCount, 'model folder')} moved (${plural(run.movedModels, 'model')})`];
  if (run.renamed) parts.push(`${plural(run.renamed, 'file')} named after their Title`);
  if (run.tagged) parts.push(`${plural(run.tagged, 'model')} tagged`);
  if (run.reviewing) parts.push('the suggested tags are waiting for your review');
  if (run.failed.length) parts.push(`${run.failed.length} not organized: ${run.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
  return `${parts.join(', ')}.${run.warning ? ` ${run.warning}` : ''}`;
}
