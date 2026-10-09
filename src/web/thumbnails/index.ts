/**
 * Thumbnails for the page: window.thumbnailRenderer (the 3D render; three.js loads on the first
 * render, in a chunk shared with the 3D preview), and window.thumbnails, the queue and helpers
 * for the rest of the page.
 */
import type { ThumbnailOptions } from './render';
import {
  cachedThumbnail,
  fetchPrimaryThumbnail,
  invalidateThumbnail,
  isImageOnlyMiss,
  saveThumbnailIfReal,
  setCachedThumbnail,
  syncThumbnailFromField
} from './cache';
import { renderInBackground, setBulkJobActive, thumbnailQueue, tuneForServerGpu } from './cards';
import { extensionOf, isFailurePlaceholder, isMostlyEmpty, typedPlaceholder } from './formats';
import { embeddedImages, makeThumbnail } from './pipeline';
import './jobs';
import './worker';

declare global {
  interface Window {
    thumbnailRenderer?: {
      render: (filePath: string, options: ThumbnailOptions) => Promise<string | null>;
      /** Replace the shared WebGL renderer before the next render. */
      reset: () => Promise<void>;
      /** True for the error thrown when this browser has no WebGL. */
      isWebGLUnavailable: (error: unknown) => boolean;
    };
  }
}

const load = () => import('./render');
let unavailableClass: (new (...args: never[]) => Error) | null = null;

window.thumbnailRenderer = {
  render: async (filePath, options) => {
    const module = await load();
    unavailableClass = module.WebGLUnavailableError;
    return module.renderThumbnail(filePath, options);
  },
  reset: async () => {
    (await load()).resetThumbnailRenderer();
  },
  isWebGLUnavailable: (error) => !!unavailableClass && error instanceof unavailableClass
};

declare global {
  interface Window {
    thumbnails?: {
      make: typeof makeThumbnail;
      renderInBackground: typeof renderInBackground;
      embeddedImages: typeof embeddedImages;
      cached: typeof cachedThumbnail;
      setCached: typeof setCachedThumbnail;
      fetchPrimary: typeof fetchPrimaryThumbnail;
      invalidate: typeof invalidateThumbnail;
      syncFromField: typeof syncThumbnailFromField;
      saveIfReal: typeof saveThumbnailIfReal;
      isFailure: typeof isFailurePlaceholder;
      isMostlyEmpty: typeof isMostlyEmpty;
      isImageOnlyMiss: typeof isImageOnlyMiss;
      typedPlaceholderFor: (filePath: string) => string;
    };
    /** The server's bulk thumbnail job is running (card renders wait). */
    _serverBulkThumbnailJobActive?: boolean;
  }
}

window.thumbnails = {
  make: makeThumbnail,
  renderInBackground,
  embeddedImages,
  cached: cachedThumbnail,
  setCached: setCachedThumbnail,
  fetchPrimary: fetchPrimaryThumbnail,
  invalidate: invalidateThumbnail,
  syncFromField: syncThumbnailFromField,
  saveIfReal: saveThumbnailIfReal,
  isFailure: isFailurePlaceholder,
  isMostlyEmpty,
  isImageOnlyMiss,
  typedPlaceholderFor: (filePath) => typedPlaceholder(extensionOf(filePath))
};
Object.defineProperty(window, '_serverBulkThumbnailJobActive', {
  configurable: true,
  get: () => thumbnailQueue.paused,
  set: (value) => setBulkJobActive(!!value)
});

// The server's thumbnail worker page renders only bulk jobs, never cards.
if (new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1') setBulkJobActive(true);
tuneForServerGpu();
