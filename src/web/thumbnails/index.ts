/**
 * window.thumbnailRenderer for renderer.js's thumbnail queue. three.js is loaded on the first
 * render (it shares a chunk with the 3D preview).
 */
import type { ThumbnailOptions } from './render';

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
  reset: async () => { (await load()).resetThumbnailRenderer(); },
  isWebGLUnavailable: (error) => !!unavailableClass && error instanceof unavailableClass
};
