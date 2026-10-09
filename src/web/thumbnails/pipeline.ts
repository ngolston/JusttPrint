/**
 * One model's thumbnail, made in this browser: images stored inside the file (3MF, LYS, F3D,
 * ChiTuBox, VOXL), the SVG itself, a 3D render (render.ts), or a placeholder naming the format.
 */
import { callAction } from '../api';
import { loadLibraryFileBuffer } from '../preview/files';
import { markImageOnlyMiss, syncThumbnailFromField } from './cache';
import { corruptedPlaceholder, extensionOf, hasEmbeddedPreviews, isImageOnly, isRenderable3d, typedPlaceholder } from './formats';

/** How hard the 3D renderer may work (set from the server's GPU in queue.ts). */
export const renderSettings = { contextReuse: 100 };

const IMAGE_ACTIONS: Record<string, string> = {
  '3mf': 'get3MFImages',
  lys: 'getLYSImages',
  f3d: 'getF3DImages',
  chitubox: 'getChituboxImages',
  voxl: 'getVoxlImages'
};

/** The preview images stored inside a file (data URLs), best first. */
export async function embeddedImages(filePath: string, options?: { maxImages?: number; quiet?: boolean }): Promise<string[]> {
  const action = IMAGE_ACTIONS[extensionOf(filePath)];
  if (!action) return [];
  const images = await callAction<string[] | null>(action, filePath, options);
  return (images || []).filter((image) => typeof image === 'string' && image.startsWith('data:image'));
}

interface GridModel {
  filePath: string;
  thumbnail?: string;
  hasThumbnail?: boolean;
  hasMultipleThumbnails?: boolean;
}

/** Update the grid's copy of a model and redraw (the grid keeps its models on .file-grid). */
export function updateGridModel(filePath: string, patch: Partial<GridModel>) {
  const grid = document.querySelector<HTMLElement & { currentModels?: GridModel[] }>('.file-grid');
  const key = filePath.replace(/\\/g, '/');
  const model = grid?.currentModels?.find((m) => m && m.filePath.replace(/\\/g, '/') === key);
  if (!model) return;
  Object.assign(model, patch);
  if (patch.thumbnail !== undefined) syncThumbnailFromField(filePath, patch.thumbnail);
  window.libraryGrid?.refresh();
}

/** Store a file's embedded images as its thumbnails and show them in the grid. */
export async function saveEmbeddedImages(filePath: string, images: string[]) {
  const result = await callAction<{ success?: boolean; thumbnailString?: string } | null>('add-multiple-thumbnails', filePath, images);
  if (result?.success) {
    updateGridModel(filePath, {
      thumbnail: result.thumbnailString || images.join('::'),
      hasThumbnail: true,
      hasMultipleThumbnails: images.length > 1
    });
  }
  return result;
}

export interface MakeOptions {
  /** False when the image is no longer needed (its card scrolled away): stop early. */
  stillWanted?: () => boolean;
  /** Read only a few embedded images (grid cards; full scans can be large). */
  fewImages?: boolean;
  lighting?: boolean;
  /** Larger files get no 3D render (the max file size setting, in bytes). */
  maxRenderBytes?: number;
}

/** A thumbnail made in this browser. */
export interface Made {
  /**
   * A data URL, '3d.png' for nothing to show, failure art (shown, never saved: see
   * isFailurePlaceholder), or null when it was no longer wanted.
   */
  image: string | null;
  /** Images stored inside the file, already saved as the model's thumbnails. Save a render yourself. */
  stored: boolean;
}

const made = (image: string | null, stored = false): Made => ({ image, stored });

/** The thumbnail for a model. */
export async function makeThumbnail(filePath: string, options: MakeOptions = {}): Promise<Made> {
  const wanted = () => options.stillWanted?.() !== false;
  if (filePath.startsWith('url::')) return made('3d.png');
  const ext = extensionOf(filePath);

  if (hasEmbeddedPreviews(ext)) {
    try {
      const images = await embeddedImages(filePath, ext === '3mf' && options.fewImages ? { maxImages: 3, quiet: true } : { quiet: true });
      if (!wanted()) return made(null);
      if (images.length) {
        const result = await saveEmbeddedImages(filePath, images).catch((error) => {
          console.error('Error adding embedded thumbnails:', error);
          return null;
        });
        return made(images[0], !!result?.success);
      }
    } catch (error) {
      console.error('Error reading embedded preview images:', error);
    }
  }
  if (isImageOnly(ext)) {
    markImageOnlyMiss(filePath);
    return made(typedPlaceholder(ext));
  }
  if (ext === 'svg') {
    try {
      const text = new TextDecoder().decode(await loadLibraryFileBuffer(filePath));
      return made(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`);
    } catch {
      return made(typedPlaceholder('svg'));
    }
  }
  if (!isRenderable3d(ext)) return made(typedPlaceholder(ext));
  if (options.maxRenderBytes) {
    const stats = await callAction<{ size?: number } | null>('get-file-stats', filePath).catch(() => null);
    if (stats?.size && stats.size > options.maxRenderBytes) {
      console.warn(`No thumbnail render for ${filePath}: larger than the max file size`);
      return made('3d.png');
    }
  }

  try {
    const image = await window.thumbnailRenderer!.render(filePath, {
      // Split 3MF (Bambu production files) can be 100 MB+ of XML.
      timeoutMs: ext === '3mf' ? 120000 : 30000,
      contextReuse: renderSettings.contextReuse,
      lighting: options.lighting ?? window.currentRenderLighting ?? true,
      stillWanted: wanted
    });
    if (!wanted()) return made(null);
    return made(image || '3d.png');
  } catch (error) {
    const noWebGL = window.thumbnailRenderer?.isWebGLUnavailable(error);
    console.error(noWebGL ? 'WebGL unavailable, using placeholder:' : 'Error rendering model:', error instanceof Error ? error.message : error);
    return made(corruptedPlaceholder());
  }
}
