/**
 * The AI searches (src/server/ai-search.js): what someone means, or what a photo shows, becomes
 * search words, and the library shows models matching any of them (the words show as the query's
 * chips, so the search can be changed like any other).
 */
import { callAction } from '../api';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { navigate } from '../shell/routes';
import { fitInside } from './photo';

function showWords(words: string[]) {
  navigate('models');
  applyFilterChange(() => filterActions.searchAny(words));
}

/** Search by meaning: answers the words used. */
export async function searchByMeaning(text: string): Promise<string[]> {
  const { words } = await callAction<{ words: string[] }>('search-by-meaning', text);
  showWords(words);
  return words;
}

/** Search with a photo (a data URL): answers the words used. */
export async function searchByPhoto(dataUrl: string): Promise<string[]> {
  const { words } = await callAction<{ words: string[] }>('search-by-photo', dataUrl);
  showWords(words);
  return words;
}

/** A photo made small (JPEG, longest side 1024 px) as a data URL, ready to send. */
export async function shrinkPhoto(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture (PNG, JPEG, WebP or GIF)');
  const bitmap = await createImageBitmap(file);
  const size = fitInside(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot read the picture');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}
