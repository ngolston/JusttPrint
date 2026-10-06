/**
 * Does an edited model still fit the sidebar's single-value filters? A quick check so the grid
 * can drop a model at once after an edit; the next search decides exactly.
 */
import type { FilterState } from '../filters/query';
import { modelMatchesPrintFilter, type PrintModel } from '../print/printStatus';

export interface MatchModel extends PrintModel {
  filePath: string;
  fileName?: string | null;
  designer?: string | null;
  license?: string | null;
  parentModel?: string | null;
  isNew?: number | boolean | string | null;
  favorite?: number | boolean | null;
  rating?: number | string | null;
}

export const isModelNew = (model: { isNew?: unknown } | null | undefined) => model?.isNew === 1 || model?.isNew === true || model?.isNew === '1';

/** A rating from 0 to 5 (bad values are 0). */
export function ratingOf(value: unknown): number {
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) || n < 0 ? 0 : Math.min(5, n);
}

const blank = (v: string | null | undefined) => !v || !v.trim();
const only = (list: string[]) => (list.length === 1 ? list[0] : '');

export function modelMatchesFilters(model: MatchModel, f: FilterState): boolean {
  const designer = only(f.designer);
  if (designer && (designer === '__none__' ? !blank(model.designer) : (model.designer || '').trim().toLowerCase() !== designer.trim().toLowerCase())) return false;
  const license = only(f.license);
  if (license && (license === '__none__' ? !blank(model.license) : model.license !== license)) return false;
  const parent = only(f.parentModel);
  if (parent && (parent === '__none__' ? !blank(model.parentModel) : model.parentModel !== parent)) return false;
  if (f.printed && f.printed !== 'all' && !modelMatchesPrintFilter(model, f.printed)) return false;
  if (f.isNew === 'new' && !isModelNew(model)) return false;
  if (f.isNew === 'not-new' && isModelNew(model)) return false;
  if (f.favorite === 'favorited' && !model.favorite) return false;
  if (f.favorite === 'not-favorited' && model.favorite) return false;
  const rating = ratingOf(model.rating);
  if (f.rating === 'unrated' && rating !== 0) return false;
  if (/^[1-5]$/.test(f.rating) && rating !== Number(f.rating)) return false;
  if (/^[1-5]$/.test(f.ratingMin) && rating < Number(f.ratingMin)) return false;
  if (f.fileType) {
    if (f.fileType.toLowerCase() === 'zip') return model.filePath.includes('::');
    return (model.fileName || '').toLowerCase().endsWith(`.${f.fileType.toLowerCase()}`);
  }
  return true;
}
