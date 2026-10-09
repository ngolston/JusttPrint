/**
 * The page's thumbnail queue, and how grid cards use it: a card without a stored image queues
 * a render, ranked by where the card is on screen; the result is saved and the card redrawn.
 */
import { callAction } from '../api';
import type { GridModel } from '../grid/layout';
import { isImageOnlyMiss, saveThumbnailIfReal, syncThumbnailFromField } from './cache';
import { extensionOf, imagesIn, isFailurePlaceholder, isMostlyEmpty, typedPlaceholder } from './formats';
import { makeThumbnail, renderSettings, type Made } from './pipeline';
import { BACKGROUND_PRIORITY, DroppedError, LOW_PRIORITY, RenderQueue } from './queue';

declare global {
  interface Window {
    /** library/groups.ts: forget the cached images of bundle and parent-model cards. */
    invalidateGroupThumbnailCache?: () => void;
  }
}

let hydrateTimer: ReturnType<typeof setTimeout> | null = null;
/** Redraw the grid soon, so visible cards whose job was dropped queue again. */
function redrawSoon() {
  if (hydrateTimer) return;
  hydrateTimer = setTimeout(() => {
    hydrateTimer = null;
    window.libraryGrid?.refresh();
  }, 50);
}

export const thumbnailQueue = new RenderQueue<Made>({
  render: (task) =>
    makeThumbnail(task.filePath, {
      stillWanted: () => !task.element || task.element.isConnected,
      fewImages: !!task.element
    }),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onDrop: redrawSoon
});

/** The server's bulk thumbnail job runs (or this page is its worker): no card renders meanwhile. */
export function setBulkJobActive(active: boolean) {
  thumbnailQueue.paused = active;
  if (!active) thumbnailQueue.pump();
}

/** Fewer parallel WebGL renders on the server's GPU (NVIDIA most of all). */
export async function tuneForServerGpu() {
  let backend = 'unknown';
  try {
    backend = (await callAction<{ glBackend?: string } | null>('get-gpu-info'))?.glBackend || 'unknown';
  } catch {
    /* defaults below */
  }
  const nvidia = backend === 'nvidia';
  thumbnailQueue.max = nvidia ? 1 : 3;
  thumbnailQueue.backgroundMax = 1;
  renderSettings.contextReuse = nvidia ? 25 : 40;
}

/** Render a model in the background (scan work). Resolves with the result, as makeThumbnail. */
export function renderInBackground(filePath: string): Promise<Made> {
  return new Promise((resolve, reject) => thumbnailQueue.add({ filePath, priority: BACKGROUND_PRIORITY, resolve, reject }));
}

type CardModel = GridModel & { thumbnail?: string; hasThumbnail?: boolean; hasMultipleThumbnails?: boolean; _failedThumbnail?: string };

/** After a render for a card: keep images saved meanwhile, else save ours; failure art only shows. */
async function cardRendered(model: CardModel, { image: thumbnail }: Made) {
  const filePath = model.filePath;
  if (!thumbnail || thumbnail === '3d.png' || isFailurePlaceholder(thumbnail) || (await isMostlyEmpty(thumbnail))) {
    if (!thumbnail) return redrawSoon(); // no longer wanted
    if (!isImageOnlyMiss(filePath)) {
      // Shown in this card only and never saved, so a reload tries again.
      model._failedThumbnail = isFailurePlaceholder(thumbnail) && thumbnail !== '3d.png' ? thumbnail : typedPlaceholder(extensionOf(filePath));
    }
    return window.libraryGrid?.refresh();
  }
  let existing = '';
  try {
    existing = (await callAction<{ thumbnail?: string } | null>('get-model', filePath))?.thumbnail || '';
  } catch {
    /* save ours */
  }
  const kept = imagesIn(existing);
  if (kept.length) {
    // 3MF embeds or images added meanwhile: never overwrite them.
    model.thumbnail = existing;
    model.hasMultipleThumbnails = kept.length > 1;
    syncThumbnailFromField(filePath, existing);
  } else {
    model.thumbnail = thumbnail;
    model.hasMultipleThumbnails = false;
    await saveThumbnailIfReal(filePath, thumbnail).catch(() => false);
  }
  model.hasThumbnail = true;
  delete model._failedThumbnail;
  window.invalidateGroupThumbnailCache?.();
  window.libraryGrid?.refresh();
}

/** Queue a render for a card. `slot` is an empty element in the card: the job follows it. */
export function queueCardThumbnail(model: CardModel, slot: HTMLElement, priority: number) {
  if (thumbnailQueue.paused || !model?.filePath || !slot || model.hasThumbnail || isImageOnlyMiss(model.filePath)) return;
  const queued = thumbnailQueue.find(model.filePath);
  if (queued) {
    queued.element = slot;
    queued.priority = priority;
    return;
  }
  if (thumbnailQueue.isRunning(model.filePath)) return;
  thumbnailQueue.add({
    filePath: model.filePath,
    element: slot,
    priority,
    resolve: (thumbnail) => {
      cardRendered(model, thumbnail).catch((error) => console.error('Error saving thumbnail:', error));
    },
    reject: (error) => {
      if (!(error instanceof DroppedError)) console.error(`Failed to generate thumbnail for ${model.filePath}`, error);
      redrawSoon();
    }
  });
}

/** After the grid painted: drop jobs of cards that left, rank the rest by position, and run. */
export function afterGridPaint() {
  const grid = document.querySelector('.file-grid');
  if (grid) {
    const top = grid.getBoundingClientRect().top;
    const height = grid.clientHeight;
    const NEAR = 80;
    thumbnailQueue.rerank((task) => {
      if (!task.element?.isConnected) return null;
      const rect = task.element.getBoundingClientRect();
      const relTop = rect.top - top;
      if (rect.bottom - top < -NEAR) return LOW_PRIORITY + 1e9 + relTop; // above the view
      if (relTop > height + NEAR) return LOW_PRIORITY + relTop; // below the view
      return relTop;
    });
  }
  thumbnailQueue.prune();
  thumbnailQueue.pump();
}

/** Load every image of a model that has several (the card's carousel). */
export async function loadAllThumbnails(model: CardModel) {
  try {
    const all = imagesIn(((await callAction<string[] | null>('get-all-thumbnails', model.filePath)) || []).join('::'));
    if (all.length < 2) return;
    model.thumbnail = all.join('::');
    model.hasMultipleThumbnails = true;
    model.hasThumbnail = true;
    syncThumbnailFromField(model.filePath, model.thumbnail);
    window.libraryGrid?.refresh();
  } catch {
    /* the primary image stays */
  }
}

/** Make image `index` the model's default (first) image. */
export async function setDefaultThumbnail(model: CardModel, index: number) {
  await callAction('set-default-thumbnail', model.filePath, index);
  const updated = await callAction<{ thumbnail?: string } | null>('get-model', model.filePath);
  if (!updated?.thumbnail) return;
  model.thumbnail = updated.thumbnail;
  syncThumbnailFromField(model.filePath, updated.thumbnail);
  window.libraryGrid?.refresh();
}
