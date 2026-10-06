/**
 * Page actions and events that act on the library: what the dialogs call after changing tags,
 * filaments or metadata, Print Roulette, Clear New Flag, and the server's events for thumbnails,
 * Add Image, downloads and the like.
 */
import { callAction } from '../api';
import { runSearch } from '../filters/search';
import { filterActions } from '../filters/store';
import type { GridModel } from '../grid/layout';
import { onServerEvent, showMessage } from '../page';
import { selection } from '../selection';
import { invalidateThumbnail, syncThumbnailFromField } from '../thumbnails/cache';
import { currentModelPath, highlightModel, showModelDetails } from './details';
import { mergeModel, refreshGrid, showModels } from './models';

const gridElement = () => document.querySelector<HTMLElement & { currentModels?: GridModel[] | null }>('.file-grid');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- After changes in the managers ----

/** Reload every picker and filter that lists tags, filaments, designers, parent models or licenses. */
function reloadAllPickers() {
  window.libraryFilters?.reloadOptions();
  window.detailsFields?.reloadOptions();
  window.detailsFilaments?.reloadOptions();
  window.multiEdit?.reloadOptions();
  window.multiEdit?.selectionChanged();
  window.bundleDetails?.reloadOptions();
}

/** The details panel's tags and filaments, from the database. */
async function reloadShownModel() {
  const filePath = currentModelPath();
  if (!filePath) return;
  const model = await callAction<{ id?: number } | null>('get-model', filePath).catch(() => null);
  if (model?.id) {
    const tags = await callAction<unknown[]>('get-model-tags', model.id).catch(() => []);
    window.detailsFields?.setTags(tags.map((t) => (typeof t === 'string' ? t : (t as { name?: string })?.name || '')).filter(Boolean));
  }
  await window.detailsFilaments?.load(filePath);
}

/** Search again with every card rebuilt (their tags or values changed). */
async function reloadGrid() {
  const grid = gridElement();
  if (grid) grid.currentModels = null;
  await runSearch({ force: true });
}

async function refreshTagRelatedUi() {
  reloadAllPickers();
  await reloadShownModel();
  await runSearch();
}

async function refreshAfterTagManagerClose() {
  // Let the last writes land.
  await pause(150);
  reloadAllPickers();
  await reloadShownModel();
  await reloadGrid();
}

async function refreshAfterFilamentManagerClose() {
  reloadAllPickers();
  await reloadShownModel();
  await runSearch();
}

// ---- Tools ----

/** Clear the New flag on every model, after asking. */
export async function clearNewFlags() {
  if (await showMessage('Clear New Flag', 'This will clear the New flag from every model in your library. Continue?', ['Yes', 'No']) !== 'Yes') return;
  try {
    const result = await callAction<{ cleared?: number }>('clear-new-model-flags');
    for (const model of gridElement()?.currentModels || []) model.isNew = 0;
    refreshGrid();
    await runSearch().catch(() => {});
    const cleared = Number(result?.cleared) || 0;
    await showMessage('Clear New Flag', cleared ? `Cleared the New flag from ${cleared} model${cleared === 1 ? '' : 's'}.` : 'No models were marked as new.');
  } catch (error) {
    await showMessage('Error', `Failed to clear New flags: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Print Roulette: spin through the shown cards, slowing down, and open the one it lands on. */
export async function printRoulette() {
  const paths = [...document.querySelectorAll<HTMLElement>('.file-item')].map((card) => card.dataset.filepath).filter((p): p is string => !!p);
  if (!paths.length) return;
  selection.clear();
  document.getElementById('model-details')?.classList.add('hidden');
  const pick = () => {
    const filePath = paths[Math.floor(Math.random() * paths.length)];
    selection.set([filePath]);
    return filePath;
  };
  let delay = 100;
  for (let i = 0; i < 10; i++) {
    await pause(delay);
    pick();
    delay += 20;
  }
  const filePath = pick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const card = document.querySelector<HTMLElement>(`.file-item[data-filepath="${CSS.escape(filePath)}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('roulette-winner');
    setTimeout(() => card.classList.remove('roulette-winner'), 3000);
  }
  await showModelDetails(filePath);
  await showMessage('Print Roulette', 'Your next print has been chosen! 🎲\nTime to get printing!');
}

/** Log out of the server (also when the terms are declined). */
export async function logOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.href = '/login';
  }
}

// ---- Server events ----

/** A model's images changed on the server: update its card, or search again when it is not shown. */
async function modelImagesChanged(filePath: string, searchIfHidden: boolean) {
  await pause(300);
  try {
    const model = await callAction<GridModel & { thumbnail?: string } | null>('get-model', filePath);
    if (!model) return;
    syncThumbnailFromField(filePath, model.thumbnail);
    if (mergeModel({ ...model })) refreshGrid();
    else if (searchIfHidden) scheduleSearch();
  } catch (error) {
    console.error('Error refreshing the grid after a thumbnail change:', error);
    scheduleSearch();
  }
}

/** Many images arrive at once during a job: one search per few seconds is enough. */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSearch() {
  if (searchTimer) return;
  searchTimer = setTimeout(() => {
    searchTimer = null;
    runSearch({ preserveScroll: true }).catch((error) => console.error('Error refreshing the grid:', error));
  }, 3000);
}

/** Add Image (model menu): pick an image in this browser and add it to each model. */
function addImage(filePaths: string | string[]) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/jpg,image/gif,image/webp';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        // The server sends thumbnail-added for each, which updates the cards.
        for (const filePath of paths) await callAction('add-thumbnail', filePath, reader.result as string);
      } catch (error) {
        await showMessage('Error', `Error adding image: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    reader.onerror = () => showMessage('Error', 'Error reading image file');
    reader.readAsDataURL(file);
  }, { once: true });
  document.body.appendChild(input);
  input.click();
  setTimeout(() => { if (!input.files?.length) input.remove(); }, 60000);
}

/** Download (model menu): the server sends the file from /api/download (also ZIP entries). */
function download(filePath: string) {
  const link = document.createElement('a');
  link.href = `/api/download/${encodeURIComponent(filePath)}`;
  link.download = '';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 100);
}

declare global {
  interface Window {
    refreshTagRelatedUi?: () => Promise<void>;
    refreshAfterTagManagerClose?: () => Promise<void>;
    refreshFilamentPickers?: () => Promise<void>;
    refreshAfterFilamentManagerClose?: () => Promise<void>;
    refreshAfterMetadataChange?: () => Promise<void>;
    refreshAfterDedupDelete?: () => Promise<void>;
    afterModelsPurged?: () => Promise<void>;
    populateFileTypeFilter?: () => Promise<void>;
    forceGridRefresh?: () => Promise<void>;
    logOutOfServer?: () => Promise<void>;
  }
}

if (typeof window !== 'undefined') {
  window.refreshTagRelatedUi = refreshTagRelatedUi;
  window.refreshAfterTagManagerClose = refreshAfterTagManagerClose;
  window.refreshFilamentPickers = async () => reloadAllPickers();
  window.refreshAfterFilamentManagerClose = refreshAfterFilamentManagerClose;
  window.refreshAfterMetadataChange = async () => {
    reloadAllPickers();
    await reloadGrid();
  };
  window.refreshAfterDedupDelete = async () => {
    selection.clear();
    await runSearch({ force: true });
  };
  window.afterModelsPurged = async () => {
    showModels([]);
    filterActions.clearAll();
  };
  window.populateFileTypeFilter = async () => window.libraryFilters?.reloadOptions();
  window.forceGridRefresh = async () => {
    window.libraryFilters?.reloadOptions();
    await reloadGrid();
  };
  window.logOutOfServer = logOut;

  onServerEvent('thumbnail-added', (data: { filePath?: string }) => { if (data?.filePath) modelImagesChanged(data.filePath, true); });
  onServerEvent('thumbnail-deleted', (data: { filePath?: string }) => {
    if (!data?.filePath) return;
    invalidateThumbnail(data.filePath);
    modelImagesChanged(data.filePath, true);
  });
  onServerEvent('thumbnail-default-changed', (data: { filePath?: string }) => { if (data?.filePath) modelImagesChanged(data.filePath, false); });
  onServerEvent('select-model-by-filepath', (filePath: string) => highlightModel(filePath));
  onServerEvent('add-image-request', (filePaths: string | string[]) => addImage(filePaths));
  onServerEvent('download-model', (filePath: string) => { if (filePath) download(filePath); });
  onServerEvent('db-cleanup', (...args: unknown[]) => {
    // The message may come as the first or the second argument.
    const data = (args[1] ?? args[0]) as { message?: string } | undefined;
    if (data?.message) showMessage('Database Cleanup', data.message);
  });
}
