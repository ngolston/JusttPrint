import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fileTypes as fileTypeApi, filaments as filamentApi, libraryValues, settings, tags as tagApi } from '../api';
import { SORT_OPTIONS, filterStrip, type ChipRemove, type Combine, type FilterState, type MultiKind, type StripItem } from './query';
import { detailsAreOpen, useDetailsVisibility } from '../details/visibility';
import { exposeGlobal } from '../page';
import { getSearchStatus, labels, onReloadOptions, runSearch, subscribeSearchStatus } from './search';
import { filterActions, getFilterState, subscribeFilters } from './store';
import { pickFromList } from '../components/ListPicker';

/** What the sidebar asks of renderer.js. */
export interface SidebarHost {
  /** Clear the selection and the details panel (the result set is about to change). */
  resetSelection(): void;
}

declare global {
  interface Window {
    sidebarHost?: SidebarHost;
    /** renderer.js: fold "More filters" away when a details panel opens. */
    collapseSidebarFilters?: () => void;
  }
}

interface Options {
  designers: string[];
  licenses: string[];
  parents: string[];
  tags: { name: string; count: number }[];
  filaments: { id: string; label: string; count: number }[];
  fileTypes: { value: string; label: string }[];
}

const filamentLabel = (f: { vendor?: string | null; name?: string | null; material?: string | null }) => {
  const base = [f.vendor, f.name].map((s) => String(s || '').trim()).filter(Boolean).join(' ') || 'Unnamed filament';
  const material = String(f.material || '').trim();
  return material ? `${base} (${material})` : base;
};

async function loadFileTypes(): Promise<{ value: string; label: string }[]> {
  const types = [{ value: '', label: 'All Types' }, { value: 'stl', label: 'STL' }, { value: '3mf', label: '3MF' }];
  try {
    const [zip, scanRaw, catalog] = await Promise.all([
      settings.get<string | null>('enableZipArchives'),
      settings.get<string | null>('scanAdditionalFileTypes'),
      fileTypeApi.catalog().catch(() => [])
    ]);
    let enabled: string[] = [];
    try {
      enabled = JSON.parse(scanRaw || '[]');
    } catch { /* none */ }
    if (zip === '1') types.push({ value: 'zip', label: 'Zip' });
    for (const entry of catalog || []) if (entry.id && enabled.includes(entry.id)) types.push({ value: entry.id, label: entry.label || entry.id });
  } catch (error) {
    console.error('Error loading file types:', error);
  }
  return types;
}

async function loadOptions(): Promise<Options> {
  const clean = (list: (string | null)[]) => [...new Set(list.filter((v): v is string => !!v))];
  const [designers, licenses, parents, allTags, allFilaments, fileTypes] = await Promise.all([
    libraryValues.designers().catch(() => []),
    libraryValues.licenses().catch(() => []),
    libraryValues.parentModels().catch(() => []),
    tagApi.list().catch(() => []),
    filamentApi.list().catch(() => []),
    loadFileTypes()
  ]);
  const filamentList = allFilaments.map((f) => ({ id: String(f.id), label: filamentLabel(f), count: f.model_count || 0 }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // The strip and the query show filaments by name.
  window.filamentLabelById = { ...(window.filamentLabelById || {}), ...Object.fromEntries(filamentList.map((f) => [f.id, f.label])) };
  return {
    designers: clean(designers),
    licenses: clean(licenses),
    parents: clean(parents),
    tags: allTags.map((t) => ({ name: t.name, count: t.model_count })).sort((a, b) => a.name.localeCompare(b.name)),
    filaments: filamentList,
    fileTypes
  };
}

/** Run the search for a user change (the result set changes: drop the selection first). */
export function applyFilterChange(change: () => void) {
  change();
  window.sidebarHost?.resetSelection();
  runSearch({ force: true });
}

function useFilters(): FilterState {
  return useSyncExternalStore(subscribeFilters, getFilterState);
}

function useSearchStatus() {
  return useSyncExternalStore(subscribeSearchStatus, getSearchStatus);
}

function StripView({ items, disabled, onRemove }: { items: StripItem[]; disabled: boolean; onRemove: (remove: ChipRemove) => void }) {
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === 'connector') return <span key={i} className="filter-pill-search-op filter-pill-logic-connector" aria-hidden="true">AND</span>;
        if (item.kind === 'combineHint') return <span key={i} className="filter-pill-tag-combine-hint">{item.text}</span>;
        const remove = (
          <span className={`filter-remove${disabled ? ' disabled-during-loading' : ''}`} onClick={() => { if (!disabled) onRemove(item.remove); }}>×</span>
        );
        if (item.kind === 'op') return <span key={i} className="filter-pill filter-pill-search-op">{item.text} {remove}</span>;
        return (
          <div key={i} className={['filter-pill', item.className, item.inverted && 'inverted'].filter(Boolean).join(' ')}>
            {item.text}
            {item.notesOff && <> <span className="pill-notes-off">notes off</span></>}
            {item.inverted && <> <span className="pill-invert">NOT</span></>}
            {' '}{remove}
          </div>
        );
      })}
    </>
  );
}

/** The "current filter" strip (#current-filter): result count and active filters (#current-filter-body), search logic and Clear All. */
function FilterStrip({ container, body, actions }: { container: HTMLElement; body: HTMLElement; actions: HTMLElement }) {
  const state = useFilters();
  const { loading, count } = useSearchStatus();
  const strip = filterStrip(state, labels);
  useEffect(() => { container.classList.toggle('visible', strip.active); }, [container, strip.active]);
  const link = (id: string, text: string, title: string, run: () => void) => (
    <a href="#" id={id} className={`search-boolean-op-link${loading ? ' disabled-during-loading' : ''}`} title={title}
      aria-disabled={loading} tabIndex={loading ? -1 : 0}
      onClick={(event) => { event.preventDefault(); if (!loading) applyFilterChange(run); }}>{text}</a>
  );
  return (
    <>
      {createPortal(strip.active && (
        <>
          {count === 0 ? <div className="no-results">No models match your filters</div> : <div className="filter-count">Showing {count ?? 0} models</div>}
          <div className="filter-pills-container">
            {strip.chain.length > 0 && (
              <div className="filter-pills-search-chain">
                <StripView items={strip.chain} disabled={loading} onRemove={(remove) => applyFilterChange(() => filterActions.removeChip(remove))} />
              </div>
            )}
            <StripView items={strip.chips} disabled={loading} onRemove={(remove) => applyFilterChange(() => filterActions.removeChip(remove))} />
          </div>
        </>
      ), body)}
      {createPortal(<>
      <div id="search-boolean-toolbar" className="search-boolean-toolbar query-builder-control" hidden={!strip.active}>
        <span className="search-boolean-toolbar-label">Search logic:</span>
        {link('search-add-and-btn', 'AND', 'Add AND to the query, then choose your next search or filter', () => filterActions.op('AND'))}
        <span className="search-boolean-op-sep" aria-hidden="true">·</span>
        {link('search-add-or-btn', 'OR', 'Add OR to the query, then choose your next search or filter', () => filterActions.op('OR'))}
        <span className="search-boolean-op-sep" aria-hidden="true">·</span>
        {link('search-add-not-btn', 'NOT', 'Add NOT before the next search term', () => filterActions.not())}
        <span id="search-boolean-hint" className="search-boolean-hint" hidden={!state.awaiting}>Next: enter another search and press search, or pick a filter below.</span>
      </div>
      <button type="button" id="clear-all-filters-button" className="clear-filter-button" hidden={!strip.active} disabled={loading}
        onClick={async () => {
          filterActions.clearAll();
          // Let the cleared sidebar paint first.
          await new Promise((resolve) => requestAnimationFrame(resolve));
          window.sidebarHost?.resetSelection();
          runSearch({ force: true });
        }}>Clear All Filters</button>
      </>, actions)}
    </>
  );
}

/** Search box, notes toggle and sort (the top of the filter section). */
function SearchControls({ container }: { container: HTMLElement }) {
  const state = useFilters();
  const { loading } = useSearchStatus();
  const [draft, setDraft] = useState('');
  const search = () => {
    const text = draft.trim();
    applyFilterChange(() => {
      if (text) filterActions.search('all', text);
      else filterActions.setViewingEntireLibrary(false);
    });
    if (text) setDraft('');
  };
  const disabledClass = loading ? 'disabled-during-loading' : undefined;
  return createPortal(
    <>
      <div className="form-group search-models-field">
        <label htmlFor="search-filter-input">Search Models:</label>
        <div className="input-with-icon">
          <input type="search" id="search-filter-input" placeholder="Search models" enterKeyHint="search" autoComplete="off" value={draft}
            disabled={loading} className={disabledClass}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
          <button id="filter-search-button" className={['icon-button', disabledClass].filter(Boolean).join(' ')} title="Add this text to the active query (all fields)"
            disabled={loading} onClick={search}>🔍</button>
          <button id="clear-filter-search-button" className={['icon-button', disabledClass].filter(Boolean).join(' ')} title="Clear search" disabled={loading}
            style={{ display: draft.trim() ? 'block' : 'none' }}
            onClick={(e) => {
              setDraft('');
              applyFilterChange(() => filterActions.clearQuery());
              (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement | null)?.focus();
            }}>×</button>
        </div>
        <label className="search-notes-toggle" title="Include notes in all-fields search. Turn off to skip long imported descriptions. A search limited to the Notes field still matches notes.">
          <input type="checkbox" id="search-include-notes" checked={state.includeNotes} disabled={loading} className={disabledClass}
            onChange={(e) => { filterActions.setIncludeNotes(e.target.checked); runSearch({ force: true }); }} />
          <span>Include Notes</span>
        </label>
      </div>
      <div className="form-group">
        <label htmlFor="sort-select">Sort By:</label>
        <select id="sort-select" value={state.sort} disabled={loading} className={disabledClass}
          onChange={(e) => {
            filterActions.setSort(e.target.value);
            runSearch({ force: true });
          }}>
          {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
    </>,
    container
  );
}

function ValueChips({ kind, values, labelOf, combine, combineLabels, disabled }: {
  kind: MultiKind; values: string[]; labelOf: (value: string) => string; combine: Combine; combineLabels: [string, string]; disabled: boolean;
}) {
  return (
    <>
      <div id={`${kind}-filter-chips`} className="filter-multi-chips" hidden={!values.length}>
        {values.map((value) => (
          <span key={value} className="filter-value-chip" data-kind={kind} data-value={value}>
            {labelOf(value)}
            <button type="button" className="filter-chip-remove" aria-label="Remove" disabled={disabled}
              onClick={() => applyFilterChange(() => filterActions.removeValue(kind, value))}>×</button>
          </span>
        ))}
      </div>
      <div id={`${kind}-combine-row`} className="filter-combine-row query-builder-control" hidden={values.length < 2}>
        <span className="filter-combine-label">Match:</span>
        {(['OR', 'AND'] as Combine[]).map((mode, i) => (
          <label key={mode}>
            <input type="radio" name={`${kind}-combine`} value={mode} checked={combine === mode} disabled={disabled}
              onChange={() => { filterActions.setCombine(kind, mode); runSearch({ force: true }); }} /> {combineLabels[i]}
          </label>
        ))}
      </div>
    </>
  );
}

/** The filters under "More filters" (#filter-stack). */
function FilterControls({ container, options }: { container: HTMLElement; options: Options }) {
  const state = useFilters();
  const { loading } = useSearchStatus();
  const disabledClass = loading ? 'disabled-during-loading' : undefined;
  const pick = async (field: 'designer' | 'parent' | 'license' | 'tag' | 'filament', use: (value: string) => void) => {
    const value = await pickFromList(field);
    if (value) applyFilterChange(() => use(value));
  };
  const listButton = (field: 'designer' | 'parent' | 'license' | 'tag' | 'filament', title: string, use: (value: string) => void) => (
    <button type="button" className="list-button icon-button" title={title} disabled={loading} onClick={() => pick(field, use)}>☰</button>
  );
  const valueSelect = (kind: 'designer' | 'license' | 'parentModel', id: string, label: string, all: string, values: string[], field: 'designer' | 'parent' | 'license', listTitle: string) => {
    const current = state[kind].length === 1 ? state[kind][0] : '';
    return (
      <div className="form-group">
        <label htmlFor={id}>{label}</label>
        <div className="dropdown-with-list">
          <select id={id} value={current} disabled={loading} className={disabledClass}
            onChange={(e) => applyFilterChange(() => filterActions.setValue(kind, e.target.value))}>
            <option value="">{all}</option>
            <option value="__none__">None</option>
            {values.map((v) => <option key={v} value={v}>{v}</option>)}
            {current && current !== '__none__' && !values.includes(current) && <option value={current}>{current}</option>}
          </select>
          {listButton(field, listTitle, (v) => filterActions.setValue(kind, v))}
        </div>
      </div>
    );
  };
  const single = (key: 'printed' | 'isNew' | 'favorite' | 'rating' | 'ratingMin' | 'fileType', id: string, label: string, choices: [string, string][]) => (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={state[key]} disabled={loading} className={disabledClass}
        onChange={(e) => applyFilterChange(() => filterActions.setSingle(key, e.target.value))}>
        {choices.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        {key === 'fileType' && state.fileType && !choices.some(([v]) => v === state.fileType) && <option value={state.fileType}>{state.fileType}</option>}
      </select>
    </div>
  );
  const filamentName = (id: string) => options.filaments.find((f) => f.id === id)?.label || window.filamentLabelById?.[id] || id;
  const anyInverted = Object.values(state.inverted).some(Boolean);

  return createPortal(
    <>
      {valueSelect('designer', 'designer-select', 'Select Designer:', 'All Designers', options.designers, 'designer', 'Search existing designers')}
      {valueSelect('parentModel', 'parent-select', 'Select Parent Model:', 'All Parent Models', options.parents, 'parent', 'Search existing parent models')}
      {valueSelect('license', 'license-select', 'Select License:', 'All Licenses', options.licenses, 'license', 'Search existing licenses')}
      {single('printed', 'printed-select', 'Print Status:', [
        ['all', 'All Models'], ['unprinted', 'Unprinted'], ['want', 'Want'], ['queued', 'Queued'], ['printing', 'Printing'], ['printed', 'Printed'],
        ['failed', 'Failed'], ['ever-printed', 'Ever printed'], ['never-printed', 'Never printed'], ['not-printed', 'Not printed']
      ])}
      {single('isNew', 'new-select', 'New Status:', [['all', 'All Models'], ['new', 'New Models Only'], ['not-new', 'Exclude New Models']])}
      {single('favorite', 'favorite-select', 'Favorite:', [['all', 'All Models'], ['favorited', 'Favorites'], ['not-favorited', 'Not Favorites']])}
      {single('rating', 'rating-select', 'Rating:', [['all', 'All Ratings'], ['unrated', 'Unrated'], ['1', '1 Star'], ['2', '2 Stars'], ['3', '3 Stars'], ['4', '4 Stars'], ['5', '5 Stars']])}
      {single('ratingMin', 'rating-min-select', 'Min Rating:', [['all', 'All'], ['1', 'At Least 1'], ['2', 'At Least 2'], ['3', 'At Least 3'], ['4', 'At Least 4'], ['5', 'At Least 5']])}
      {single('fileType', 'filetype-select', 'File Type:', options.fileTypes.map((t) => [t.value, t.label]))}
      <div className="form-group">
        <label htmlFor="tag-filter">Filter by Tag:</label>
        <div className="dropdown-with-list">
          <div className="tags-input-container">
            <select id="tag-filter" value="" disabled={loading} className={disabledClass}
              onChange={(e) => { const v = e.target.value; if (v) applyFilterChange(() => filterActions.addValue('tags', v)); }}>
              <option value="">All Tags</option>
              {options.tags.map((t) => <option key={t.name} value={t.name}>{`${t.name} (${t.count})`}</option>)}
            </select>
          </div>
          {listButton('tag', 'Search existing tags', (v) => filterActions.addValue('tags', v))}
        </div>
        <ValueChips kind="tags" values={state.tags} labelOf={(v) => (v === '__none__' ? '(empty)' : v)} combine={state.combine.tags}
          combineLabels={['Any tag', 'All tags']} disabled={loading} />
      </div>
      <div className="form-group">
        <label htmlFor="filament-filter">Filter by Filament:</label>
        <div className="dropdown-with-list">
          <div className="tags-input-container">
            <select id="filament-filter" value="" disabled={loading} className={disabledClass}
              onChange={(e) => { const v = e.target.value; if (v) applyFilterChange(() => filterActions.addValue('filaments', v)); }}>
              <option value="">All Filaments</option>
              {options.filaments.map((f) => <option key={f.id} value={f.id}>{`${f.label} (${f.count})`}</option>)}
            </select>
          </div>
          {listButton('filament', 'Search existing filaments', (v) => filterActions.addValue('filaments', v))}
        </div>
        <ValueChips kind="filaments" values={state.filaments} labelOf={filamentName} combine={state.combine.filaments}
          combineLabels={['Any filament', 'All filaments']} disabled={loading} />
      </div>
      <div className="form-group">
        <button type="button" id="invert-filter-button" className={anyInverted ? 'active' : undefined}
          title={anyInverted ? 'Filter is inverted (NOT equal)' : 'Invert the current filter (NOT equal instead of equal)'}
          onClick={() => {
            const draft = (document.getElementById('search-filter-input') as HTMLInputElement | null)?.value || '';
            if (filterActions.invert(draft)) applyFilterChange(() => {});
          }}>Invert Filters</button>
      </div>
    </>,
    container
  );
}

/**
 * "More filters": shows or hides the filter stack (.sidebar.filters-expanded). It folds away
 * when a details panel opens, and the sidebar is marked .details-open while one is showing.
 */
function FilterStackToggle({ container }: { container: HTMLElement }) {
  const [expanded, setExpanded] = useState(false);
  const detailsOpen = detailsAreOpen(useDetailsVisibility());

  useEffect(() => {
    document.querySelector('.sidebar')?.classList.toggle('filters-expanded', expanded);
  }, [expanded]);

  useEffect(() => {
    document.querySelector('.sidebar')?.classList.toggle('details-open', detailsOpen);
    if (detailsOpen) setExpanded(false);
  }, [detailsOpen]);

  useEffect(() => exposeGlobal('collapseSidebarFilters', () => setExpanded(false)), []);

  return createPortal(
    <button type="button" id="filter-stack-toggle" className="filter-stack-toggle" aria-expanded={expanded} aria-controls="filter-stack"
      onClick={(e) => { e.preventDefault(); setExpanded(!expanded); }}>
      <span className="filter-stack-toggle-label">{expanded ? 'Filters' : 'More filters'}</span>
      <span className="filter-stack-toggle-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
    </button>,
    container
  );
}

/** The sidebar's filters: the strip, the search box and sort, and the filter controls. */
export function Sidebar() {
  const [slots] = useState(() => ({
    strip: document.getElementById('current-filter'),
    stripBody: document.getElementById('current-filter-body'),
    stripActions: document.getElementById('current-filter-actions'),
    search: document.getElementById('sidebar-search-slot'),
    filters: document.getElementById('sidebar-filters-slot'),
    stackToggle: document.getElementById('filter-stack-toggle-slot')
  }));
  const [options, setOptions] = useState<Options>({ designers: [], licenses: [], parents: [], tags: [], filaments: [], fileTypes: [] });
  const { loading } = useSearchStatus();
  const state = useFilters();

  const reloadOptions = () => { loadOptions().then(setOptions).catch((error) => console.error('Error loading filter options:', error)); };
  useEffect(() => {
    reloadOptions();
    return onReloadOptions(reloadOptions);
  }, []);

  // The section greys out while a filtered search loads, and marks when the query waits for an operand.
  useEffect(() => {
    const section = document.querySelector('.filter-section');
    section?.classList.toggle('loading', loading);
    section?.classList.toggle('filter-section-awaiting-search', state.awaiting);
    document.getElementById('spinner')?.classList.toggle('hidden', !loading);
  }, [loading, state.awaiting]);

  const parts: ReactNode[] = [];
  if (slots.strip && slots.stripBody && slots.stripActions) {
    parts.push(<FilterStrip key="strip" container={slots.strip} body={slots.stripBody} actions={slots.stripActions} />);
  }
  if (slots.search) parts.push(<SearchControls key="search" container={slots.search} />);
  if (slots.stackToggle) parts.push(<FilterStackToggle key="stack-toggle" container={slots.stackToggle} />);
  if (slots.filters) parts.push(<FilterControls key="filters" container={slots.filters} options={options} />);
  return <>{parts}</>;
}
