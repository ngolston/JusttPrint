/**
 * The grid's primary thumbnails: the first stored image of each model, fetched one at a time
 * (getThumbnail, never every image) and kept in a bounded cache. Saving a render goes through
 * here so the cache stays in step.
 */
import { callAction } from '../api';
import { imagesIn, isMostlyEmpty, isRealImage } from './formats';

const MAX = 800;
const cache = new Map<string, string | null>();

export const thumbKey = (filePath: string) => {
  let p = filePath;
  try {
    p = decodeURIComponent(p);
  } catch { /* as is */ }
  p = p.replace(/\\/g, '/').trim();
  return /^[a-zA-Z]:\//.test(p) ? p.charAt(0).toUpperCase() + p.slice(1) : p;
};

/** The cached primary image: a data URL, null (known to have none), or undefined (not asked yet). */
export function cachedThumbnail(filePath: string): string | null | undefined {
  const key = thumbKey(filePath);
  return cache.has(key) ? cache.get(key) : undefined;
}

export function setCachedThumbnail(filePath: string, thumb: string | null) {
  const key = thumbKey(filePath);
  if (cache.size >= MAX && !cache.has(key)) cache.delete(cache.keys().next().value as string);
  cache.set(key, thumb || null);
}

/** Forget one model's image, or every image (after a bulk job). */
export function invalidateThumbnail(filePath?: string | null) {
  if (filePath) cache.delete(thumbKey(filePath));
  else cache.clear();
}

/** Follow a model's thumbnail field (images joined by `::`; the first is the primary). */
export function syncThumbnailFromField(filePath: string, thumbnailField: string | null | undefined) {
  setCachedThumbnail(filePath, imagesIn(thumbnailField)[0] || null);
}

/** The primary image for a grid card, from the cache or the server. */
export async function fetchPrimaryThumbnail(filePath: string): Promise<string | null> {
  const cached = cachedThumbnail(filePath);
  if (cached !== undefined) return cached;
  try {
    const thumb = await callAction<string | null>('getThumbnail', filePath);
    const valid = isRealImage(thumb) && !(await isMostlyEmpty(thumb)) ? thumb : null;
    setCachedThumbnail(filePath, valid);
    return valid;
  } catch {
    return null;
  }
}

/** Save a render as the model's thumbnail, unless it is failure art or blank. True when saved. */
export async function saveThumbnailIfReal(filePath: string, thumbnail: string | null): Promise<boolean> {
  if (!isRealImage(thumbnail) || await isMostlyEmpty(thumbnail)) return false;
  await callAction('save-thumbnail', filePath, thumbnail);
  setCachedThumbnail(filePath, thumbnail);
  return true;
}

/**
 * Image-only formats (F3D, ChiTuBox, VOXL) whose embedded preview could not be read. No render
 * can help, so the grid shows their typed placeholder instead of asking again forever.
 */
const imageOnlyMisses = new Set<string>();
export const markImageOnlyMiss = (filePath: string) => imageOnlyMisses.add(thumbKey(filePath));
export const isImageOnlyMiss = (filePath: string) => imageOnlyMisses.has(thumbKey(filePath));
