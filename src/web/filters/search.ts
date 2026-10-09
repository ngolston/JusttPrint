/**
 * Running a library search: the first page from the server, then the rest in chunks while the
 * grid shows what has arrived (window.renderFiles, library/models.ts). A newer search makes older ones stop.
 * Also the window functions the rest of the page calls (performCombinedSearch and friends).
 */
import { callAction } from '../api';
import { describePayload, payloadIsFiltered, serverFilters, type FilterState, type Labels, type ServerFilters } from './query';
import { filterActions, getFilterState } from './store';

const FIRST_PAGE = 500;
const CHUNK = 1200;

type Model = Record<string, unknown>;

declare global {
  interface Window {
    renderFiles?: (models: Model[]) => Promise<void>;
    syncSelectionWithFilteredModels?: (models: Model[]) => void;
    _progressiveLibraryLoadActive?: boolean;
  }
}

export const labels: Labels = {
  printed: (value) => window.PrintHistory?.filterLabel(value) || value
};

type SearchListener = (status: { loading: boolean; count: number | null }) => void;
const statusListeners = new Set<SearchListener>();
let status = { loading: false, count: null as number | null };
function setStatus(next: Partial<typeof status>) {
  status = { ...status, ...next };
  statusListeners.forEach((listener) => listener(status));
}
export const getSearchStatus = () => status;
export function subscribeSearchStatus(listener: SearchListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** The current filters as the server payload. */
export function currentServerFilters(): ServerFilters {
  return serverFilters(getFilterState());
}

/** One page of models for the current filters and sort. */
export async function fetchFilteredModels(page: { limit?: number; offset?: number } = {}): Promise<Model[]> {
  const filters: ServerFilters = { ...currentServerFilters(), sortOption: getFilterState().sort };
  if (payloadIsFiltered(filters) && getFilterState().viewingEntireLibrary) filterActions.setViewingEntireLibrary(false);
  if (page.limit != null) filters.limit = page.limit;
  if (page.offset != null) filters.offset = page.offset;
  try {
    return (await callAction<Model[]>('get-models-filtered', filters)) || [];
  } catch (error) {
    console.error('Error fetching filtered models:', error);
    return [];
  }
}

function syncSelection(models: Model[]) {
  window.syncSelectionWithFilteredModels?.(models);
  requestAnimationFrame(() => window.syncSelectionWithFilteredModels?.(models));
}

const yieldToPage = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(() => resolve(), { timeout: 100 });
    else setTimeout(resolve, 48);
  });

let generation = 0;
let inProgress = false;

export interface SearchOptions {
  /** Run even while another search is loading (it replaces that one). */
  force?: boolean;
  /** Background refresh: keep the grid's scroll position and do not shrink it to the first page. */
  preserveScroll?: boolean;
}

/** A filter change from the page: apply it, clear the selection and search again. */
export function applyFilterChange(change: () => void) {
  change();
  window.sidebarHost?.resetSelection();
  void runSearch({ force: true });
}

export async function runSearch(options: SearchOptions = {}): Promise<void> {
  if (inProgress && !options.force) return;
  const grid = options.preserveScroll ? document.querySelector<HTMLElement & { currentModels?: Model[] }>('.file-grid') : null;
  const savedScrollTop = grid ? grid.scrollTop : 0;
  const shownCount = grid && Array.isArray(grid.currentModels) ? grid.currentModels.length : 0;
  let scrollRestored = !grid;
  let renderedCount = 0;
  const renderPage = async (models: Model[], complete: boolean) => {
    // Keeping the scroll position: a first page shorter than what is shown would collapse the
    // grid and reset the scroll, so wait until the reload catches up.
    if (options.preserveScroll && !complete && models.length < shownCount) return;
    await window.renderFiles?.(models);
    renderedCount = models.length;
    if (!scrollRestored && grid) {
      scrollRestored = true;
      if (grid.scrollTop !== savedScrollTop) grid.scrollTop = savedScrollTop;
    }
  };

  const mine = ++generation;
  inProgress = true;
  window._progressiveLibraryLoadActive = true;
  const filtered = payloadIsFiltered(currentServerFilters());
  // A full-library load shows no spinner, so the page feels responsive.
  if (filtered) setStatus({ loading: true });
  try {
    const first = await fetchFilteredModels({ limit: FIRST_PAGE });
    if (generation !== mine) return;
    setStatus({ count: first.length });
    await renderPage(first, first.length < FIRST_PAGE);
    if (generation !== mine) return;
    if (first.length < FIRST_PAGE) {
      window._progressiveLibraryLoadActive = false;
      if (filtered) syncSelection(first);
      return;
    }
    // The rest in the background; a newer search stops this loop.
    (async () => {
      try {
        let all = first.slice();
        for (;;) {
          const chunk = await fetchFilteredModels({ limit: CHUNK, offset: all.length });
          if (generation !== mine) return;
          if (!chunk.length) break;
          all = all.concat(chunk);
          setStatus({ count: all.length });
          await renderPage(all, chunk.length < CHUNK);
          if (chunk.length < CHUNK) break;
          await yieldToPage();
        }
        if (generation !== mine) return;
        if (renderedCount !== all.length) await renderPage(all, true);
        window._progressiveLibraryLoadActive = false;
        if (filtered) syncSelection(all);
      } catch (error) {
        console.error('Progressive library load failed:', error);
        if (generation === mine) window._progressiveLibraryLoadActive = false;
      }
    })();
  } catch (error) {
    console.error('Error performing combined search:', error);
    if (generation === mine) window._progressiveLibraryLoadActive = false;
  } finally {
    if (generation === mine) {
      setStatus({ loading: false });
      inProgress = false;
    }
  }
}

declare global {
  interface Window {
    clearAllLibraryFilters?: () => void;
    getCombinedFilteredModels?: (page?: { limit?: number; offset?: number }) => Promise<Model[]>;
    setTagMultiFilter?: (names: string[]) => void;
  }
}

// The page's search API (the React dialogs and the library call these).
if (typeof window !== 'undefined') installSearchGlobals();
function installSearchGlobals() {
  window.performCombinedSearch = runSearch;
  window.clearAllLibraryFilters = () => filterActions.clearAll();
  window.getCombinedFilteredModels = fetchFilteredModels;
  window.getCurrentLibraryFilters = currentServerFilters;
  window.libraryFiltersAreActive = (filters) => payloadIsFiltered(filters ?? currentServerFilters());
  window.describeLibraryFilters = (filters) => describePayload(filters ?? currentServerFilters(), labels);
  window.setTagMultiFilter = (names) => filterActions.setTags(names);
}

const optionReloaders = new Set<() => void>();
/** The sidebar registers how to reload its pickers' options. */
export function onReloadOptions(reload: () => void): () => void {
  optionReloaders.add(reload);
  return () => optionReloaders.delete(reload);
}

const SELECT_IDS: Record<string, (value: string) => void> = {
  'designer-select': (v) => filterActions.setValue('designer', v),
  'license-select': (v) => filterActions.setValue('license', v),
  'parent-select': (v) => filterActions.setValue('parentModel', v),
  'printed-select': (v) => filterActions.setSingle('printed', v),
  'new-select': (v) => filterActions.setSingle('isNew', v),
  'favorite-select': (v) => filterActions.setSingle('favorite', v),
  'rating-select': (v) => filterActions.setSingle('rating', v),
  'rating-min-select': (v) => filterActions.setSingle('ratingMin', v),
  'filetype-select': (v) => filterActions.setSingle('fileType', v)
};

declare global {
  interface Window {
    /** The sidebar filters for the rest of the page. */
    libraryFilters?: {
      state: () => FilterState;
      /** Reload the pickers' options (values were added, renamed or removed). */
      reloadOptions: () => void;
      /** A filter link on a card, by the old select id ("designer-select", value). */
      setFromSelect: (selectId: string, value: string) => void;
      /** After a scan: show only the models added since then (null: leave that view). */
      showAddedSince: (since: string | null) => void;
      /** Change the sort order (saved) and search again (the list view's column headers). */
      setSort: (sort: string) => void;
    };
  }
}

if (typeof window !== 'undefined')
  window.libraryFilters = {
    state: getFilterState,
    reloadOptions: () => optionReloaders.forEach((reload) => reload()),
    setFromSelect: (selectId, value) => SELECT_IDS[selectId]?.(value),
    showAddedSince: (since) => filterActions.showAddedSince(since),
    setSort: (sort) => {
      filterActions.setSort(sort);
      runSearch({ force: true });
    }
  };
