import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CheckSquare, FilterX, FolderOpen, LayoutGrid, Library, Link2, PanelRight, ScanSearch, SlidersHorizontal, Upload, X } from 'lucide-react';
import { Button, IconButton } from '../components/Button';
import { EmptyState } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { useModelCounts } from '../filters/counts';
import { FacetBar } from '../filters/FacetBar';
import { applyFilterChange, getSearchStatus, subscribeSearchStatus } from '../filters/search';
import { filterActions, getFilterState, subscribeFilters } from '../filters/store';
import { LIBRARY_TABS, extraFilterCount, tabInfo, tabOf, type LibraryTab } from '../library/tabs';
import { useAdopt } from '../shell/adopt';
import { NAV } from '../shell/nav';
import { useCan } from '../session';
import { setSidebarOn, useSidebarOn } from '../details/sidebarPref';
import { setFoldersAsModels, useFoldersAsModels } from '../library/folderMode';
import { toggleMultiEdit, useEditMode } from '../library/details';
import { selection } from '../selection';
import { OrganizeNotice, UnorganizedButton } from '../upload/Organize';
import { Banners, CategoryRow } from '../library/BrowseHeader';
import { Toggle } from '../components/Browse';
import { library } from '../api';
import { useLibraryData } from '../shell/libraryData';

const scanLibrary = () =>
  NAV.flatMap((section) => section.items)
    .find((item) => item.id === 'scan')
    ?.run?.();

function useFilters() {
  return useSyncExternalStore(subscribeFilters, getFilterState);
}

function useSearchStatus() {
  return useSyncExternalStore(subscribeSearchStatus, getSearchStatus);
}

/** How many models are chosen. */
function useChosenCount(): number {
  return useSyncExternalStore(
    (listener) => selection.subscribe(listener),
    () => selection.size
  );
}

/**
 * The Filter popover: the old sidebar's filter section (search options, sort, folders, every
 * filter), moved in while the shell is shown. It stays in the page while closed
 * so the moved section always has a home. Closes on Escape, the ×, the Filter button, or a click
 * elsewhere in the app (not in dialogs and pickers the filters open).
 */
function FilterPopover({ open, onClose, button }: { open: boolean; onClose: () => void; button: HTMLElement | null }) {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useAdopt('.filter-section', body);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || panel.current?.contains(target) || button?.contains(target)) return;
      if (target.closest('.main-content, .jp-shell, .sidebar, #folder-rail')) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      onClose();
      button?.focus();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, button]);

  return (
    <div ref={panel} id="jp-filter-popover" className="jp-filter-popover" role="dialog" aria-label="Filters" hidden={!open}>
      <div className="jp-filter-popover__head">
        <span className="jp-filter-popover__title">Filters</span>
        <IconButton icon={X} label="Close filters" size="sm" onClick={onClose} />
      </div>
      <div className="jp-filter-popover__body" ref={setBody} />
    </div>
  );
}

/** Nothing to show: an empty library, or filters that match nothing (spec §49). */
function LibraryEmpty() {
  const state = useFilters();
  const canEdit = useCan('editor');
  const { loading, count } = useSearchStatus();
  if (loading || count !== 0) return null;
  const filtered = tabOf(state) !== 'all' || extraFilterCount(state) > 0 || !!state.directory || !!state.dateAdded;
  if (!filtered) {
    return (
      <div className="jp-library-empty">
        <EmptyState
          icon={Library}
          title="Your library is empty"
          action={
            canEdit ? (
              <>
                <Button variant="primary" icon={ScanSearch} onClick={scanLibrary}>
                  Scan Library
                </Button>
                <Button icon={Upload} onClick={() => window.openUpload?.()}>
                  Upload Models
                </Button>
                <Button icon={Link2} onClick={() => window.openLinkImport?.()}>
                  Add Links
                </Button>
              </>
            ) : undefined
          }
        >
          {canEdit
            ? 'Scan your model folders (STL Home), upload models, or add links from Printables, Thingiverse or MakerWorld.'
            : 'An editor or admin adds the models.'}
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="jp-library-empty">
      <EmptyState
        icon={FilterX}
        title="No models match"
        action={
          <Button icon={FilterX} onClick={() => document.getElementById('clear-all-filters-button')?.click()}>
            Clear filters
          </Button>
        }
      >
        Try another tab, or clear the filters and search.
      </EmptyState>
    </div>
  );
}

/**
 * The Library's header: the title with the model count, Filter and Edit on the right; then the
 * state tabs, with the view buttons and the Folders and sidebar toggles on the right (Upload and
 * Add Links only on phones, where the top bar has no Add New Model); the active filters under it.
 */
export function LibraryHeader() {
  const [slot] = useState(() => document.querySelector<HTMLElement>('.grid-view-selector'));
  const state = useFilters();
  const { view, total } = useModelCounts();
  const [open, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [filterButton, setFilterButton] = useState<HTMLButtonElement | null>(null);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [chips, setChips] = useState<HTMLDivElement | null>(null);
  const canUpload = useCan('editor');
  const sidebar = useSidebarOn();
  const folders = useFoldersAsModels();
  const editing = useEditMode();
  const chosen = useChosenCount();
  useAdopt('#grid-toolbar-slot', tools);
  useAdopt('#folder-rail-toggle-slot', rail);
  useAdopt('#current-filter', chips);

  const tab = tabOf(state);
  const extra = extraFilterCount(state);
  const counts = useLibraryData(library.counts);
  // Fits my filament is offered once there is filament to check (Phase 7).
  const showFits = state.fitsMyFilament || (counts?.readyToPrint ?? 0) > 0;

  if (!slot) return null;
  return createPortal(
    <div className="jp jp-library-header">
      <div className="jp-library-header__top">
        <div className="jp-library-header__heading">
          <h1 className="jp-library-header__title">
            Library
            <span className="jp-library-header__count" id="jp-library-count" title={`${total.toLocaleString()} models in the library`}>
              {view.toLocaleString()} {view === 1 ? 'model' : 'models'}
            </span>
          </h1>
          <div className="jp-library-header__actions">
            <UnorganizedButton directory={state.directory} />
            {canUpload && (
              <Button
                icon={Upload}
                id="jp-upload-button"
                className="jp-library-header__add"
                onClick={() => window.openUpload?.()}
                title="Upload model files into a library folder (or drop them on the page)"
              >
                Upload
              </Button>
            )}
            {canUpload && (
              <Button
                icon={Link2}
                id="jp-links-button"
                className="jp-library-header__add"
                onClick={() => window.openLinkImport?.()}
                title="Add models from Printables, Thingiverse or MakerWorld links"
              >
                Add Links
              </Button>
            )}
            {canUpload && editing && (
              <span className="jp-library-header__chosen" id="jp-chosen-count" role="status">
                {chosen.toLocaleString()} chosen
              </span>
            )}
            {canUpload && editing && (
              <Button id="jp-select-all-button" onClick={() => void window.shortcutHost?.selectAll()} title="Choose every model shown (Ctrl/⌘ A)">
                Select all
              </Button>
            )}
            {canUpload && (
              <button
                type="button"
                id="jp-edit-button"
                className={`jp-btn jp-btn--${editing ? 'primary' : 'secondary'} jp-btn--md`}
                aria-pressed={editing}
                title={
                  editing
                    ? 'Stop choosing'
                    : 'Select: click models (or the checkbox on a card) to choose them. One model: its details; more: Multi-edit, to change, merge or delete them all'
                }
                onClick={() => toggleMultiEdit()}
              >
                <CheckSquare size={16} aria-hidden="true" />
                <span>{editing ? 'Done' : 'Select'}</span>
              </button>
            )}
          </div>
        </div>
        <CategoryRow state={state} />
        {tab === 'all' && !state.directory && !state.dateAdded && <Banners state={state} />}
        <div className="jp-library-header__bar">
          <Tabs<LibraryTab | 'none'>
            label="Show"
            items={LIBRARY_TABS}
            value={tab ?? 'none'}
            onChange={(id) => {
              if (id === 'none') return;
              const info = tabInfo(id);
              applyFilterChange(() => filterActions.setTab(info.printed, info.favorite));
            }}
          />
          {showFits && (
            <span className="jp-library-header__fits">
              <Toggle checked={state.fitsMyFilament} onChange={(on) => applyFilterChange(() => filterActions.setFitsMyFilament(on))} label="Fits my filament" />
            </span>
          )}
          {/* Phones: the view buttons fold behind one View button. */}
          <button
            type="button"
            id="jp-view-menu-button"
            className={`jp-btn jp-btn--secondary jp-btn--md jp-library-header__view-toggle${viewOpen ? ' is-open' : ''}`}
            aria-expanded={viewOpen}
            aria-controls="jp-library-tools"
            onClick={() => setViewOpen(!viewOpen)}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            <span>View</span>
          </button>
          <div className={`jp-library-header__tools${viewOpen ? ' is-open' : ''}`} id="jp-library-tools">
            <div className="jp-library-header__rail" ref={setRail} />
            <div className="jp-library-header__view" ref={setTools} />
            <IconButton
              icon={FolderOpen}
              id="jp-folders-toggle"
              className="jp-library-header__sidebar"
              pressed={folders}
              label={folders ? 'Show every file (folders as models is on)' : 'Folders as models: each folder of model files as one card'}
              onClick={() => setFoldersAsModels(!folders)}
            />
            <IconButton
              icon={PanelRight}
              id="jp-sidebar-toggle"
              className="jp-library-header__sidebar"
              pressed={sidebar}
              label={sidebar ? 'Hide the details sidebar (a click on a model opens its page)' : 'Show the details sidebar'}
              onClick={() => setSidebarOn(!sidebar)}
            />
          </div>
        </div>
        <div className="jp-library-header__facets">
          <FacetBar>
            <button
              type="button"
              ref={setFilterButton}
              id="jp-filter-button"
              className={`jp-btn jp-btn--ghost jp-btn--sm jp-facet-bar__all${open ? ' is-open' : ''}${extra > 0 ? ' has-filters' : ''}`}
              aria-expanded={open}
              aria-controls="jp-filter-popover"
              onClick={() => setOpen(!open)}
            >
              <SlidersHorizontal size={16} aria-hidden="true" />
              <span>All filters</span>
              {extra > 0 && (
                <span className="jp-library-header__filter-count" aria-label={`${extra} filters set`}>
                  {extra}
                </span>
              )}
            </button>
          </FacetBar>
        </div>
        <div className="jp-library-header__chips" ref={setChips} />
        <OrganizeNotice directory={state.directory} />
        {editing && (
          <p className="jp-library-header__editing" id="jp-edit-hint" role="status">
            Click models to choose them. One shows its details; more open Multi-edit, to change, merge or delete them all at once.
          </p>
        )}
        {/* Below the chips, so it never covers them (Clear All, AND / OR / NOT). */}
        <FilterPopover open={open} onClose={() => setOpen(false)} button={filterButton} />
      </div>
      <LibraryEmpty />
    </div>,
    slot
  );
}
