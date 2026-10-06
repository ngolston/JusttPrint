/**
 * The models the grid shows (kept on .file-grid as currentModels, which other code reads), the
 * groups the user expanded, and keeping both in step after searches and edits.
 */
import { callAction } from '../api';
import { setViewCount } from '../filters/counts';
import { getFilterState } from '../filters/store';
import { bundleKey, dedupeModels, normalizePath, parentModelKey, parentModelLabel, type GridModel } from '../grid/layout';
import { getGridView } from '../grid/view';
import { selection } from '../selection';
import { modelMatchesFilters, type MatchModel } from './match';

type GridElement = HTMLElement & { currentModels?: GridModel[] | null; _virtualGridView?: string };

const gridElement = () => document.querySelector<GridElement>('.file-grid');

/** The models in the grid, in order. */
export const shownModels = (): GridModel[] => gridElement()?.currentModels || [];

/** Expanded bundle and parent-model groups, by group key ("bundle:…", "parent:…"). */
export const expandedGroups = { bundles: new Set<string>(), parentModels: new Set<string>() };

/** Forget expanded groups that no longer have two or more files. */
function pruneExpanded(models: GridModel[]) {
  const prune = (expanded: Set<string>, keyOf: (m: GridModel) => string) => {
    if (!expanded.size) return;
    const files = new Map<string, Set<string>>();
    for (const model of models) {
      const key = keyOf(model);
      const path = normalizePath(model.filePath);
      if (!key || !path) continue;
      if (!files.has(key)) files.set(key, new Set());
      files.get(key)!.add(path);
    }
    for (const key of [...expanded]) if ((files.get(key)?.size || 0) < 2) expanded.delete(key);
  };
  prune(expandedGroups.bundles, (m) => (bundleKey(m) ? `bundle:${bundleKey(m)}` : ''));
  prune(expandedGroups.parentModels, (m) => (parentModelLabel(m) ? `parent:${parentModelKey(parentModelLabel(m))}` : ''));
}

const idOf = (m: GridModel) => (m.id != null && m.id !== '' ? m.id : m.filePath);

/** `next` is `prev` with more rows appended (a progressive library load). */
export function isAppendOf(prev: GridModel[], next: GridModel[]): boolean {
  if (!prev.length || next.length <= prev.length) return false;
  return prev.every((model, i) => idOf(model) === idOf(next[i]));
}

/** Same models as shown, maybe in another order. */
function sameModels(prev: GridModel[], next: GridModel[]): boolean {
  const a = prev.map(idOf);
  const b = next.map(idOf);
  return JSON.stringify(a) === JSON.stringify(b) && a.length === b.length;
}

/** Selection and details hooks (details.ts), so a new model list drops what is no longer shown. */
export const listHooks: { syncSelection?: (models: GridModel[]) => void; isMultiEdit?: () => boolean } = {};

/** Show a model list in the grid (a search result, or the whole library). */
export function showModels(models: GridModel[]) {
  const grid = gridElement();
  if (!grid) return;
  const filterActive = !!window.libraryFiltersAreActive?.(null) && !window._progressiveLibraryLoadActive;
  // A filtered result drops the selection and details of models it no longer has.
  if (filterActive) listHooks.syncSelection?.(models);

  const list = dedupeModels(models || []);
  pruneExpanded(list);
  const previousView = grid._virtualGridView;
  const view = getGridView().view;
  const current = grid.currentModels || [];
  const rebuild = !previousView || previousView !== view || !(isAppendOf(current, list) || sameModels(current, list));
  if (!rebuild) {
    // Same cards: keep the images they loaded (list queries leave the images out).
    const loaded = new Map(current.map((m) => [idOf(m), m]));
    for (const model of list) {
      const before = loaded.get(idOf(model)) as (GridModel & { thumbnail?: string; hasMultipleThumbnails?: boolean }) | undefined;
      const next = model as GridModel & { thumbnail?: string; hasMultipleThumbnails?: boolean };
      if (!before || before === model || next.thumbnail || !before.thumbnail) continue;
      next.thumbnail = before.thumbnail;
      if (before.hasMultipleThumbnails) next.hasMultipleThumbnails = true;
    }
  }
  const focusSelection = selection.size > 0 && !!previousView && (
    (previousView === 'detailed' && view === 'preview') || (previousView === 'preview' && view === 'detailed'));
  grid.currentModels = list;
  grid._virtualGridView = view;
  if (window.libraryGrid) window.libraryGrid.show({ rebuild, focusSelection });
  else (window as unknown as { _pendingGridShow?: object })._pendingGridShow = { rebuild: true, focusSelection };
  if (filterActive) listHooks.syncSelection?.(models);
  setViewCount(list.length);
}

/** Lay the shown models out again (the view or tile size changed). */
export function rebuildGrid() {
  const grid = gridElement();
  const models = grid?.currentModels ? [...grid.currentModels] : null;
  if (grid) grid.currentModels = null;
  if (models?.length) showModels(models);
  else window.performCombinedSearch?.();
}

/** Repaint the cards (after edits to the shown models in place). */
export const refreshGrid = () => window.libraryGrid?.refresh();

/** Replace a shown model with a fresher copy (matched by path). */
export function mergeModel(model: GridModel): boolean {
  const models = gridElement()?.currentModels;
  const key = normalizePath(model?.filePath);
  if (!models || !key) return false;
  const index = models.findIndex((m) => normalizePath(m.filePath) === key);
  if (index < 0) return false;
  models[index] = model;
  return true;
}

/**
 * After a model was saved: show its new values, or take it out of the grid when it no longer
 * fits the sidebar filters.
 */
export async function updateModel(filePath: string) {
  try {
    const model = await callAction<(GridModel & MatchModel) | null>('get-model', filePath);
    if (!model) return;
    const grid = gridElement();
    if (!modelMatchesFilters(model, getFilterState())) {
      if (listHooks.isMultiEdit?.()) selection.delete(filePath);
      const models = grid?.currentModels;
      const index = models ? models.findIndex((m) => idOf(m) === idOf(model)) : -1;
      if (models && index >= 0) models.splice(index, 1);
      setViewCount(models?.length || 0);
    } else {
      mergeModel(model);
    }
    refreshGrid();
  } catch (error) {
    console.error('Error updating model element:', error);
  }
}

