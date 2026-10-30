/**
 * The library filters for the page: one FilterState, changed through the actions below, with
 * subscribers (the sidebar). Also defines the globals the older scripts read and write
 * (window.currentDirectoryFilter, dateAddedFilter, viewingEntireLibrary) as properties
 * backed by this store, so they stay in step.
 */
import { settings } from '../api';
import { looksTyped, parseTyped } from './typed';
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  appendClause,
  appendNot,
  appendOp,
  clearSidebarKinds,
  clearedState,
  consumeIntoQuery,
  emptyFilterState,
  invertNext,
  normalizeTokens,
  removeToken,
  restoredState,
  setCategoryClause,
  type AtomKind,
  type ChipRemove,
  type Combine,
  type FilterState,
  type MultiKind,
  type SearchToken
} from './query';

type Listener = (state: FilterState) => void;

let state: FilterState = emptyFilterState();
const listeners = new Set<Listener>();

export function getFilterState(): FilterState {
  return state;
}

export function subscribeFilters(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(next: FilterState) {
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error('Filter listener failed:', error);
    }
  });
}

/** A user change: leaves the "new models" view and Entire Library mode. */
function userChange(next: FilterState) {
  set({ ...next, dateAdded: null, viewingEntireLibrary: false });
}

const SINGLE_TO_ATOM: Record<'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin' | 'fileType', AtomKind> = {
  printed: 'printed',
  isNew: 'isNew',
  favorite: 'favorite',
  rating: 'rating',
  ratingMin: 'ratingMin',
  fileType: 'fileType'
};

export const filterActions = {
  /** A single-choice filter (print status, new, favorite, rating, min rating, file type). */
  /** Only models the spools on hand can print. */
  setFitsMyFilament(on: boolean) {
    userChange({ ...state, fitsMyFilament: on });
  },

  setSingle(key: 'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin' | 'fileType', value: string) {
    const isOff = !value || value === 'all';
    if (!isOff) {
      const consumed = consumeIntoQuery(state, { t: 'filter', kind: SINGLE_TO_ATOM[key], value });
      if (consumed) return userChange(consumed);
    }
    userChange({ ...state, [key]: value || (key === 'fileType' ? '' : 'all') });
  },

  /** A library tab (library/tabs.ts): print status and favorite together, in one search. */
  setTab(printed: string, favorite: string) {
    if (state.printed === printed && state.favorite === favorite) return;
    userChange({ ...state, printed, favorite });
  },

  /** Designer, license or title select (one value, or '' for all). */
  setValue(kind: 'designer' | 'license' | 'title', value: string) {
    if (value) {
      const consumed = consumeIntoQuery(state, { t: 'filter', kind, value });
      if (consumed) return userChange(consumed);
    }
    userChange({ ...state, [kind]: value ? [value] : [] });
  },

  /** Add a tag to its list (the select resets to "all"). */
  addValue(kind: 'tags', value: string) {
    const v = value.trim();
    if (!v) return;
    const consumed = consumeIntoQuery(state, { t: 'filter', kind: 'tag', value: v });
    if (consumed) return userChange(consumed);
    if (state[kind].includes(v)) return;
    userChange({ ...state, [kind]: [...state[kind], v] });
  },

  removeValue(kind: MultiKind, value: string) {
    const remaining = state[kind].filter((v) => v !== value);
    const invertKey = kind === 'tags' ? 'tag' : kind;
    const inverted = remaining.length ? state.inverted : { ...state.inverted, [invertKey]: false };
    userChange({ ...state, [kind]: remaining, inverted });
  },

  /** Replace the tag filter (a tag link on a card). */
  setTags(names: string[]) {
    userChange({ ...state, tags: names.map((n) => n.trim()).filter(Boolean) });
  },

  setCombine(kind: MultiKind, combine: Combine) {
    set({ ...state, combine: { ...state.combine, [kind]: combine } });
  },

  /** Search for any of these words (the AI searches); the filters stay. */
  searchAny(words: string[]) {
    const clean = words.map((word) => word.trim()).filter(Boolean);
    if (!clean.length) return;
    const tokens = clean.flatMap((value, i): SearchToken[] =>
      i
        ? [
            { t: 'op', op: 'OR' },
            { t: 'clause', field: 'all', value }
          ]
        : [{ t: 'clause', field: 'all', value }]
    );
    userChange({ ...state, tokens, awaiting: false, inverted: { ...state.inverted, search: false } });
  },

  /**
   * The search box's text: a typed search (filters/typed.ts) becomes its terms (in brackets after
   * a query already there), plain words search every field as before. Answers what could not be read.
   */
  searchTyped(text: string): string | null {
    if (!looksTyped(text)) {
      userChange(appendClause(state, 'all', text));
      return null;
    }
    const { tokens, error } = parseTyped(text);
    if (!tokens.length) return error;
    const before = normalizeTokens(state.tokens);
    const joined: SearchToken[] = before.length ? [...before, { t: 'op', op: 'AND' }, { t: 'open' }, ...tokens, { t: 'close' }] : tokens;
    userChange({ ...state, tokens: normalizeTokens(joined), awaiting: false, inverted: { ...state.inverted, search: false } });
    return error;
  },

  /** Search for one category instead of the one searched for ('' for none). */
  setCategory(value: string) {
    userChange(setCategoryClause(state, value));
  },

  /** Add the search box text to the query. */
  search(field: string, text: string) {
    userChange(appendClause(state, field, text));
  },

  op(op: Combine) {
    userChange(appendOp(state, op));
  },

  not() {
    userChange(appendNot(state));
  },

  /** Clear the query (the search box's ×). */
  clearQuery() {
    userChange({ ...state, tokens: [], awaiting: false, inverted: { ...state.inverted, search: false } });
  },

  /** Invert Filters. Returns false when nothing could be inverted. */
  invert(searchDraft = ''): boolean {
    const next = invertNext(state, searchDraft);
    if (!next) return false;
    set(next);
    return true;
  },

  /** A chip's × in the filter strip. */
  removeChip(remove: ChipRemove) {
    switch (remove.type) {
      case 'token':
        return userChange({ ...removeToken(state, remove.index), inverted: { ...state.inverted, search: false } });
      case 'tag':
        return filterActions.removeValue('tags', remove.value);
      case 'multi':
        return userChange({ ...state, [remove.kind]: [], inverted: { ...state.inverted, [remove.kind]: false } });
      case 'single':
        return userChange(clearSidebarKinds(state, new Set([SINGLE_TO_ATOM[remove.key]])));
      case 'directory':
        return set({ ...state, directory: '' });
      case 'fits':
        return userChange({ ...state, fitsMyFilament: false });
    }
  },

  /** Show a saved search (a smart collection) in the library. */
  restore(saved: unknown) {
    set(restoredState(state, saved));
  },

  /** Clear All Filters / View Entire Library. */
  clearAll() {
    set(clearedState(state));
  },

  setDirectory(directory: string | null | undefined) {
    set({ ...state, directory: directory || '', viewingEntireLibrary: directory ? false : state.viewingEntireLibrary });
  },

  /** The "new models" view after a scan: every filter off, only models added since `since`. */
  showAddedSince(since: string | null) {
    if (!since) return set({ ...state, dateAdded: null });
    set({ ...clearedState(state), dateAdded: since, viewingEntireLibrary: false });
  },

  setIncludeNotes(includeNotes: boolean) {
    set({ ...state, includeNotes });
    settings.save('searchIncludeNotes', includeNotes ? '1' : '0').catch((error) => console.error('Error saving searchIncludeNotes:', error));
  },

  setSort(sort: string) {
    set({ ...state, sort });
    settings.save('sortOption', sort).catch((error) => console.error('Error saving sort preference:', error));
  },

  setViewingEntireLibrary(value: boolean) {
    if (state.viewingEntireLibrary !== value) set({ ...state, viewingEntireLibrary: value });
  }
};

/** Read the saved sort order and notes setting. */
export async function loadSavedFilterSettings() {
  try {
    const [sort, notes] = await Promise.all([settings.get<string | null>('sortOption'), settings.get<string | null>('searchIncludeNotes')]);
    const validSort = sort && SORT_OPTIONS.some(([value]) => value === sort) ? sort : DEFAULT_SORT;
    set({ ...state, sort: validSort, includeNotes: notes !== '0' });
  } catch (error) {
    console.error('Error loading filter settings:', error);
  }
}

// The older scripts' globals, backed by the store.
const globals: [string, () => unknown, (value: unknown) => void][] = [
  ['currentDirectoryFilter', () => state.directory, (v) => filterActions.setDirectory(v as string)],
  ['dateAddedFilter', () => state.dateAdded, (v) => set({ ...state, dateAdded: (v as string) || null })],
  ['_lastDateAddedFilter', () => state.dateAdded, () => {}],
  ['viewingEntireLibrary', () => state.viewingEntireLibrary, (v) => filterActions.setViewingEntireLibrary(!!v)]
];
if (typeof window !== 'undefined') {
  for (const [name, get, put] of globals) {
    Object.defineProperty(window, name, { configurable: true, get, set: put });
  }
}
