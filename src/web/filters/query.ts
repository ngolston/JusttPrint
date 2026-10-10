/**
 * The library filters as data, and what is derived from them: the payload for the server's
 * get-models-filtered (src/core/model-filters.js), whether any filter is active, a one-line
 * summary, and the chips of the "current filter" strip. Pure functions; the store (store.ts)
 * holds the state and the sidebar (Sidebar.tsx) shows it.
 */

export type Combine = 'AND' | 'OR';
export type MultiKind = 'designer' | 'license' | 'parentModel' | 'tags';
export type InvertKind = 'designer' | 'license' | 'parentModel' | 'tag' | 'search';
/** Filter kinds as the server names them inside search tokens. */
export type AtomKind = 'designer' | 'license' | 'parentModel' | 'tag' | 'fileType' | 'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin';

export type SearchToken =
  | { t: 'clause'; field: string; value: string }
  | { t: 'op'; op: Combine }
  | { t: 'not' }
  | { t: 'filter'; kind: AtomKind; value: string }
  | { t: 'filterMulti'; kind: AtomKind; values: string[]; combine: Combine };

export interface FilterState {
  /** Multi-value filters. Designer, license and parent model hold the select's one value. */
  designer: string[];
  license: string[];
  parentModel: string[];
  tags: string[];
  combine: Record<MultiKind, Combine>;
  printed: string;
  isNew: string;
  favorite: string;
  rating: string;
  ratingMin: string;
  fileType: string;
  /** The search query: clauses, AND/OR/NOT, and filters moved into it. */
  tokens: SearchToken[];
  /** AND/OR/NOT was pressed: the next search or filter pick completes the query. */
  awaiting: boolean;
  inverted: Record<InvertKind, boolean>;
  directory: string;
  /** "New models" view after a scan: only models added since then. */
  dateAdded: string | null;
  includeNotes: boolean;
  sort: string;
  viewingEntireLibrary: boolean;
}

export const SORT_OPTIONS: [string, string][] = [
  ['name-asc', 'Name (A-Z)'],
  ['name-desc', 'Name (Z-A)'],
  ['size-asc', 'Size (Smallest First)'],
  ['size-desc', 'Size (Largest First)'],
  ['date-asc', 'Modified (Oldest First)'],
  ['date-desc', 'Modified (Newest First)'],
  ['dateadded-asc', 'Date Added (Oldest First)'],
  ['dateadded-desc', 'Date Added (Newest First)'],
  ['directory-asc', 'Parent Directory (A-Z)'],
  ['directory-desc', 'Parent Directory (Z-A)'],
  ['designer-asc', 'Designer (A-Z)'],
  ['designer-desc', 'Designer (Z-A)'],
  ['parentmodel-asc', 'Parent Model (A-Z)'],
  ['parentmodel-desc', 'Parent Model (Z-A)'],
  ['printed-asc', 'Printed (Not Printed First)'],
  ['printed-desc', 'Printed (Printed First)'],
  ['printstatus-asc', 'Print Status (Printing First)'],
  ['printstatus-desc', 'Print Status (Unprinted First)'],
  ['printcount-desc', 'Print Count (Most First)'],
  ['printcount-asc', 'Print Count (Least First)'],
  ['lastprinted-desc', 'Last Printed (Newest First)'],
  ['lastprinted-asc', 'Last Printed (Oldest First)'],
  ['rating-desc', 'Rating (Highest First)'],
  ['rating-asc', 'Rating (Lowest First)']
];
export const DEFAULT_SORT = 'date-desc';

export function emptyFilterState(): FilterState {
  return {
    designer: [],
    license: [],
    parentModel: [],
    tags: [],
    combine: { designer: 'OR', license: 'OR', parentModel: 'OR', tags: 'AND' },
    printed: 'all',
    isNew: 'all',
    favorite: 'all',
    rating: 'all',
    ratingMin: 'all',
    fileType: '',
    tokens: [],
    awaiting: false,
    inverted: { designer: false, license: false, parentModel: false, tag: false, search: false },
    directory: '',
    dateAdded: null,
    includeNotes: true,
    sort: DEFAULT_SORT,
    viewingEntireLibrary: false
  };
}

const PRINTED_VALUES = new Set(['printed', 'not-printed', 'unprinted', 'want', 'queued', 'printing', 'failed', 'ever-printed', 'never-printed', 'in-queue']);
const SINGLE_KINDS: AtomKind[] = ['designer', 'license', 'parentModel', 'tag', 'fileType', 'printed', 'isNew', 'favorite', 'rating', 'ratingMin'];
const MULTI_TOKEN_KINDS: AtomKind[] = ['designer', 'license', 'parentModel', 'tag'];

const isOperand = (tok: SearchToken | undefined) => !!tok && (tok.t === 'clause' || tok.t === 'filter' || tok.t === 'filterMulti');

/** AND AND / OR OR mean one operator. */
function collapseAdjacentOps(tokens: SearchToken[]) {
  for (let i = 1; i < tokens.length; i++) {
    const a = tokens[i - 1];
    const b = tokens[i];
    if (a.t === 'op' && b.t === 'op' && a.op === b.op) {
      tokens.splice(i, 1);
      i--;
    }
  }
}

/** The tokens the server gets: empty or invalid ones dropped, no dangling operator at the end. */
export function normalizeTokens(tokens: SearchToken[]): SearchToken[] {
  const out = tokens
    .filter((tok) => {
      if (tok.t === 'clause') return !!tok.value.trim();
      if (tok.t === 'op') return tok.op === 'AND' || tok.op === 'OR';
      if (tok.t === 'not') return true;
      if (tok.t === 'filter') {
        if (!SINGLE_KINDS.includes(tok.kind)) return false;
        const v = tok.value.trim();
        if (tok.kind === 'printed') return PRINTED_VALUES.has(v);
        if (tok.kind === 'isNew') return v === 'new' || v === 'not-new';
        if (tok.kind === 'favorite') return v === 'favorited' || v === 'not-favorited';
        if (tok.kind === 'rating') return v === 'unrated' || /^[1-5]$/.test(v);
        if (tok.kind === 'ratingMin') return /^[1-5]$/.test(v);
        return !!v;
      }
      if (tok.t === 'filterMulti') {
        return MULTI_TOKEN_KINDS.includes(tok.kind) && tok.values.some((x) => x.trim());
      }
      return false;
    })
    .map((tok) => ({ ...tok }) as SearchToken);
  collapseAdjacentOps(out);
  while (out.length && (out[out.length - 1].t === 'op' || out[out.length - 1].t === 'not')) out.pop();
  return out;
}

export const hasSearchQuery = (state: FilterState) => normalizeTokens(state.tokens).length > 0;
export const hasMultiValues = (state: FilterState) => (['designer', 'license', 'parentModel', 'tags'] as MultiKind[]).some((k) => state[k].length > 0);

/** Values and how they combine: one value is OR (the server treats it the same either way). */
function effective(state: FilterState, kind: MultiKind): { values: string[]; combine: Combine } {
  const values = state[kind].filter((v) => v.trim());
  return { values, combine: values.length > 1 ? state.combine[kind] : 'OR' };
}

export type ServerFilters = Record<string, unknown>;

/** The get-models-filtered payload (without sort, limit and offset). */
export function serverFilters(state: FilterState): ServerFilters {
  const filters: ServerFilters = {
    designerInverted: state.inverted.designer,
    dateAdded: state.dateAdded || null,
    licenseInverted: state.inverted.license,
    parentModelInverted: state.inverted.parentModel,
    printed: state.printed === 'all' ? undefined : state.printed,
    isNew: state.isNew === 'all' ? undefined : state.isNew,
    favorite: state.favorite === 'all' ? undefined : state.favorite,
    rating: state.rating === 'all' ? undefined : state.rating,
    ratingMin: state.ratingMin === 'all' ? undefined : state.ratingMin,
    tagInverted: state.inverted.tag,
    fileType: state.fileType,
    searchInverted: state.inverted.search,
    directory: state.directory || undefined
  };
  const add = (kind: MultiKind, key: string, combineKey: string) => {
    const { values, combine } = effective(state, kind);
    if (values.length) {
      filters[key] = values;
      filters[combineKey] = combine;
    }
  };
  add('designer', 'designers', 'designerCombine');
  add('license', 'licenses', 'licenseCombine');
  add('parentModel', 'parentModels', 'parentModelCombine');
  add('tags', 'tags', 'tagCombine');

  const normalized = normalizeTokens(state.tokens);
  if (normalized.some(isOperand)) {
    filters.searchTokens = normalized;
    // A kind inside the query is decided there, not by the sidebar too.
    const inQuery = new Set(normalized.flatMap((tok) => (tok.t === 'filter' || tok.t === 'filterMulti' ? [tok.kind] : [])));
    if (inQuery.has('designer')) delete filters.designers;
    if (inQuery.has('license')) delete filters.licenses;
    if (inQuery.has('parentModel')) delete filters.parentModels;
    if (inQuery.has('tag')) delete filters.tags;
    for (const kind of ['fileType', 'printed', 'isNew', 'favorite', 'rating', 'ratingMin'] as const) {
      if (inQuery.has(kind)) delete filters[kind];
    }
  } else {
    // Text in the search box only applies once added to the query.
    filters.search = '';
  }
  filters.searchIncludeNotes = state.includeNotes;
  return filters;
}

const listOf = (primary: unknown, legacy: unknown): string[] => {
  const out = Array.isArray(primary)
    ? primary
        .map(String)
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  if (!out.length && legacy != null && String(legacy).trim()) out.push(String(legacy).trim());
  return out;
};

/** True when a payload narrows the library (works on serverFilters output and older payloads). */
export function payloadIsFiltered(f: ServerFilters | null | undefined): boolean {
  if (!f) return false;
  if (listOf(f.designers, f.designer).length) return true;
  if (listOf(f.licenses, f.license).length) return true;
  if (listOf(f.parentModels, f.parentModel).length) return true;
  if (Array.isArray(f.tags) ? f.tags.length : f.tag) return true;
  if (f.printed) return true;
  for (const key of ['isNew', 'favorite', 'rating', 'ratingMin']) if (f[key] && f[key] !== 'all') return true;
  if (f.fileType || f.directory || f.dateAdded) return true;
  if (Array.isArray(f.searchTokens) && f.searchTokens.length) return true;
  if (Array.isArray(f.searchClauses) && f.searchClauses.length) return true;
  return !!(f.search && String(f.search).trim());
}

export interface Labels {
  /** Print status filter values ("ever-printed" → "Ever printed"). */
  printed(value: string): string;
}

const allFieldsSearch = (tok: SearchToken) => tok.t === 'clause' && (!tok.field || tok.field === 'all');

/** One line describing a payload ("Designer: Bob · Printed · Query"), for De-Dup's scope. */
export function describePayload(f: ServerFilters | null | undefined, labels: Labels): string {
  if (!f) return '';
  const parts: string[] = [];
  const designers = listOf(f.designers, f.designer);
  if (designers.length) parts.push(`Designer: ${designers.join(', ')}`);
  const licenses = listOf(f.licenses, f.license);
  if (licenses.length) parts.push(`License: ${licenses.join(', ')}`);
  const parents = listOf(f.parentModels, f.parentModel);
  if (parents.length) parts.push(`Parent: ${parents.join(', ')}`);
  const tags = Array.isArray(f.tags) ? f.tags.map(String) : f.tag ? [String(f.tag)] : [];
  if (tags.length) parts.push(`Tag: ${tags.join(', ')}`);
  if (f.printed && f.printed !== 'all') parts.push(labels.printed(String(f.printed)));
  if (f.isNew === 'new') parts.push('New');
  if (f.isNew === 'not-new') parts.push('Not new');
  if (f.favorite === 'favorited') parts.push('Favorites');
  if (f.favorite === 'not-favorited') parts.push('Not favorited');
  if (f.rating && f.rating !== 'all') parts.push(f.rating === 'unrated' ? 'Unrated' : `Rating ${f.rating}`);
  if (f.ratingMin && f.ratingMin !== 'all') parts.push(`Rating ≥ ${f.ratingMin}`);
  if (f.fileType) parts.push(`Type: ${f.fileType}`);
  if (f.directory) {
    const bits = String(f.directory).split(/[/\\]/).filter(Boolean);
    parts.push(`Folder: ${bits[bits.length - 1] || f.directory}`);
  }
  if (f.dateAdded) parts.push('Date added');
  const tokens = Array.isArray(f.searchTokens) ? (f.searchTokens as SearchToken[]) : [];
  const clauses = Array.isArray(f.searchClauses) ? (f.searchClauses as { field?: string }[]) : [];
  const notesOff =
    f.searchIncludeNotes === false &&
    (tokens.some(allFieldsSearch) || clauses.some((c) => !c.field || c.field === 'all') || (!tokens.length && !clauses.length && !!f.search))
      ? ' · notes off'
      : '';
  if (tokens.length) parts.push(`Query${notesOff}`);
  else if (clauses.length) parts.push(`Search${notesOff}`);
  else if (f.search && String(f.search).trim()) parts.push(`Search: ${String(f.search).trim()}${notesOff}`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ the filter strip

export const SEARCH_FIELD_LABELS: Record<string, string> = {
  all: 'All fields',
  fileName: 'File name',
  designer: 'Designer',
  parentModel: 'Parent model',
  notes: 'Notes',
  filePath: 'Path',
  source: 'Source',
  license: 'License',
  tag: 'Tag name',
  category: 'Category'
};

const display = (value: string) => (value === '__none__' ? '(empty)' : value);

/** A filter moved into the query, as plain text ("Designer: Bob", "Tag: a, b (all)"). */
export function atomLabel(tok: SearchToken, labels: Labels): string {
  if (tok.t === 'filterMulti') {
    const vs = tok.values.join(', ');
    const mode = tok.combine === 'AND' ? 'all' : 'any';
    const name: Partial<Record<AtomKind, string>> = { designer: 'Designer', license: 'License', parentModel: 'Parent', tag: 'Tag' };
    return name[tok.kind] ? `${name[tok.kind]}: ${vs} (${mode})` : 'Filter';
  }
  if (tok.t !== 'filter') return 'Filter';
  const v = display(tok.value);
  switch (tok.kind) {
    case 'designer':
      return `Designer: ${v}`;
    case 'license':
      return `License: ${v}`;
    case 'parentModel':
      return `Parent: ${v}`;
    case 'tag':
      return `Tag: ${v}`;
    case 'fileType':
      return `Type: ${v}`;
    case 'printed':
      return labels.printed(tok.value);
    case 'isNew':
      return tok.value === 'new' ? 'New models only' : 'Exclude new models';
    case 'favorite':
      return tok.value === 'favorited' ? 'Favorites' : 'Not favorites';
    case 'rating':
      return tok.value === 'unrated' ? 'Rating: Unrated' : `Rating: ${tok.value} star${tok.value === '1' ? '' : 's'}`;
    case 'ratingMin':
      return `Min rating: ${tok.value}+`;
    default:
      return 'Filter';
  }
}

const ATOM_INVERT: Partial<Record<AtomKind, InvertKind>> = { designer: 'designer', license: 'license', parentModel: 'parentModel', tag: 'tag' };

/** What a chip's × removes. */
export type ChipRemove =
  | { type: 'token'; index: number }
  | { type: 'tag'; value: string }
  | { type: 'multi'; kind: 'designer' | 'license' | 'parentModel' }
  | { type: 'single'; key: 'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin' | 'fileType' }
  | { type: 'directory' };

export type StripItem =
  | { kind: 'op'; text: string; remove: ChipRemove }
  | { kind: 'connector' }
  | { kind: 'chip'; text: string; inverted: boolean; notesOff?: boolean; className: string; remove: ChipRemove }
  | { kind: 'combineHint'; text: string };

export interface FilterStrip {
  /** Anything to show (the count alone is shown only with filters). */
  active: boolean;
  /** The search chain: query tokens, then the tag chips, joined by AND. */
  chain: StripItem[];
  /** The other filters, one chip each. */
  chips: StripItem[];
}

/** The "current filter" strip above the search box. */
export function filterStrip(state: FilterState, labels: Labels): FilterStrip {
  const single = (key: 'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin') => state[key] !== 'all';
  const queryActive = hasSearchQuery(state);
  const active = !!(
    state.designer.length ||
    state.license.length ||
    state.parentModel.length ||
    single('printed') ||
    single('isNew') ||
    single('favorite') ||
    single('rating') ||
    single('ratingMin') ||
    state.tags.length ||
    state.fileType ||
    queryActive ||
    state.directory ||
    state.dateAdded
  );

  const chain: StripItem[] = [];
  const tokens = queryActive ? state.tokens : [];
  tokens.forEach((tok, index) => {
    const remove: ChipRemove = { type: 'token', index };
    if (tok.t === 'op') chain.push({ kind: 'op', text: tok.op === 'OR' ? 'OR' : 'AND', remove });
    else if (tok.t === 'not') chain.push({ kind: 'op', text: 'NOT', remove });
    else if (tok.t === 'clause' && tok.value.trim()) {
      const all = !tok.field || tok.field === 'all';
      chain.push({
        kind: 'chip',
        className: 'filter-pill-search-clause',
        text: all ? `Search: "${tok.value}"` : `Search (${SEARCH_FIELD_LABELS[tok.field] || tok.field}): "${tok.value}"`,
        notesOff: all && !state.includeNotes,
        inverted: state.inverted.search,
        remove
      });
    } else if (tok.t === 'filter' || tok.t === 'filterMulti') {
      const invertKind = ATOM_INVERT[tok.kind];
      chain.push({
        kind: 'chip',
        className: 'filter-pill-search-clause filter-pill-query-atom',
        text: atomLabel(tok, labels),
        inverted: !!(invertKind && state.inverted[invertKind]),
        remove
      });
    }
  });
  if (state.tags.length) {
    if (tokens.length && isOperand(tokens[tokens.length - 1])) chain.push({ kind: 'connector' });
    state.tags.forEach((tag, i) => {
      if (i > 0) chain.push({ kind: 'connector' });
      chain.push({
        kind: 'chip',
        className: 'filter-pill-search-clause filter-pill-tag-chip',
        text: `Tag: ${tag}`,
        inverted: state.inverted.tag,
        remove: { type: 'tag', value: tag }
      });
    });
    if (state.tags.length > 1) chain.push({ kind: 'combineHint', text: `(${state.combine.tags === 'AND' ? 'all' : 'any'})` });
  }

  const chips: StripItem[] = [];
  const multi = (kind: 'designer' | 'license' | 'parentModel', title: string, none: string) => {
    const values = state[kind];
    if (!values.length) return;
    const mode = values.length > 1 ? ` (${state.combine[kind] === 'AND' ? 'all' : 'any'})` : '';
    chips.push({
      kind: 'chip',
      className: '',
      text: `${title}: ${values.map((v) => (v === '__none__' ? none : v)).join(', ')}${mode}`,
      inverted: state.inverted[kind],
      remove: { type: 'multi', kind }
    });
  };
  multi('designer', 'Designer', 'No designer');
  multi('license', 'License', 'No license');
  multi('parentModel', 'Parent', 'No parent model');
  const plain = (key: 'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin' | 'fileType', text: string) =>
    chips.push({ kind: 'chip', className: '', text, inverted: false, remove: { type: 'single', key } });
  if (single('printed')) plain('printed', labels.printed(state.printed));
  if (single('isNew')) plain('isNew', state.isNew === 'new' ? 'New models only' : 'Exclude new models');
  if (single('favorite')) plain('favorite', state.favorite === 'favorited' ? 'Favorites' : 'Not favorites');
  if (single('rating')) plain('rating', `Rating: ${state.rating === 'unrated' ? 'Unrated' : `${state.rating} star${state.rating === '1' ? '' : 's'}`}`);
  if (single('ratingMin')) plain('ratingMin', `Min rating: ${state.ratingMin}+`);
  if (state.fileType) plain('fileType', `Type: ${state.fileType}`);
  if (state.directory) chips.push({ kind: 'chip', className: '', text: `Directory: ${state.directory}`, inverted: false, remove: { type: 'directory' } });
  return { active, chain, chips };
}

// ------------------------------------------------------------------ query editing

/** The sidebar's active filters as query atoms (pressing AND/OR/NOT with no query yet moves them in). */
export function sidebarAtoms(state: FilterState): SearchToken[] {
  const atoms: SearchToken[] = [];
  const singles: [AtomKind, 'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin'][] = [
    ['printed', 'printed'],
    ['isNew', 'isNew'],
    ['favorite', 'favorite'],
    ['rating', 'rating'],
    ['ratingMin', 'ratingMin']
  ];
  for (const [kind, key] of singles) if (state[key] !== 'all') atoms.push({ t: 'filter', kind, value: state[key] });
  if (state.fileType.trim()) atoms.push({ t: 'filter', kind: 'fileType', value: state.fileType.trim() });
  const pairs: [MultiKind, AtomKind][] = [
    ['designer', 'designer'],
    ['license', 'license'],
    ['parentModel', 'parentModel'],
    ['tags', 'tag']
  ];
  for (const [key, kind] of pairs) {
    const { values, combine } = effective(state, key);
    if (values.length === 1) atoms.push({ t: 'filter', kind, value: values[0] });
    else if (values.length > 1) atoms.push({ t: 'filterMulti', kind, values, combine });
  }
  return atoms;
}

/** Reset the sidebar filters of these kinds (they moved into the query). */
export function clearSidebarKinds(state: FilterState, kinds: Set<AtomKind>): FilterState {
  const next = { ...state };
  if (kinds.has('designer')) next.designer = [];
  if (kinds.has('license')) next.license = [];
  if (kinds.has('parentModel')) next.parentModel = [];
  if (kinds.has('tag')) next.tags = [];
  if (kinds.has('fileType')) next.fileType = '';
  for (const key of ['printed', 'isNew', 'favorite', 'rating', 'ratingMin'] as const) if (kinds.has(key)) next[key] = 'all';
  return next;
}

const kindsOf = (atoms: SearchToken[]) => new Set(atoms.flatMap((a) => (a.t === 'filter' || a.t === 'filterMulti' ? [a.kind] : [])));

/** Press AND/OR or NOT with no query yet: the sidebar filters become the query (AND-joined). */
function materialize(state: FilterState): FilterState {
  const atoms = sidebarAtoms(state);
  if (!atoms.length) return state;
  const tokens: SearchToken[] = [];
  atoms.forEach((atom, i) => {
    if (i > 0) tokens.push({ t: 'op', op: 'AND' });
    tokens.push(atom);
  });
  return { ...clearSidebarKinds(state, kindsOf(atoms)), tokens, awaiting: false };
}

/** Add a search to the query (joined with AND after another operand). */
export function appendClause(state: FilterState, field: string, raw: string): FilterState {
  const value = raw.trim();
  if (!value) return state;
  const tokens = [...state.tokens];
  if (isOperand(tokens[tokens.length - 1])) tokens.push({ t: 'op', op: 'AND' });
  tokens.push({ t: 'clause', field: field || 'all', value });
  collapseAdjacentOps(tokens);
  return { ...state, tokens, awaiting: false };
}

/** AND / OR from the search logic toolbar. */
export function appendOp(state: FilterState, op: Combine): FilterState {
  let next = state.tokens.length ? state : materialize(state);
  const tokens = [...next.tokens];
  const last = tokens[tokens.length - 1];
  if (!last || last.t === 'not') return next;
  if (last.t === 'op') tokens[tokens.length - 1] = { t: 'op', op };
  else tokens.push({ t: 'op', op });
  next = { ...next, tokens, awaiting: true };
  return next;
}

/** NOT from the search logic toolbar. */
export function appendNot(state: FilterState): FilterState {
  const next = state.tokens.length ? state : materialize(state);
  const tokens = [...next.tokens];
  if (isOperand(tokens[tokens.length - 1])) tokens.push({ t: 'op', op: 'AND' });
  tokens.push({ t: 'not' });
  return { ...next, tokens, awaiting: true };
}

export function removeToken(state: FilterState, index: number): FilterState {
  if (index < 0 || index >= state.tokens.length) return state;
  return { ...state, tokens: state.tokens.filter((_, i) => i !== index), awaiting: false };
}

/** After AND/OR/NOT: the last token waits for an operand. */
export function awaitingOperand(state: FilterState): boolean {
  const last = state.tokens[state.tokens.length - 1];
  return state.awaiting && !!last && (last.t === 'op' || last.t === 'not');
}

/** A sidebar pick while the query waits for an operand: it goes into the query instead. */
export function consumeIntoQuery(state: FilterState, atom: SearchToken): FilterState | null {
  if (!awaitingOperand(state)) return null;
  const tokens = [...state.tokens, atom];
  collapseAdjacentOps(tokens);
  return { ...clearSidebarKinds(state, kindsOf([atom])), tokens, awaiting: false };
}

/** Invert Filters: flips the first active kind (search, tags, designer, license, parent model). */
export function invertNext(state: FilterState, searchDraft = ''): FilterState | null {
  let kind: InvertKind | null = null;
  if (searchDraft.trim() || hasSearchQuery(state)) kind = 'search';
  else if (state.tags.length) kind = 'tag';
  else if (state.designer.length) kind = 'designer';
  else if (state.license.length) kind = 'license';
  else if (state.parentModel.length) kind = 'parentModel';
  if (!kind) return null;
  return { ...state, inverted: { ...state.inverted, [kind]: !state.inverted[kind] } };
}

/** Every filter off (the view, sort and notes setting stay). */
export function clearedState(state: FilterState): FilterState {
  const empty = emptyFilterState();
  return { ...empty, combine: state.combine, includeNotes: state.includeNotes, sort: state.sort, viewingEntireLibrary: true };
}
