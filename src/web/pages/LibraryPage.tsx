import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { FilterX, Library, Link2, ScanSearch, SlidersHorizontal, Upload, X } from 'lucide-react';
import { Button, IconButton } from '../components/Button';
import { EmptyState } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { useModelCounts } from '../filters/counts';
import { applyFilterChange, getSearchStatus, subscribeSearchStatus } from '../filters/search';
import { filterActions, getFilterState, subscribeFilters } from '../filters/store';
import { LIBRARY_TABS, extraFilterCount, tabInfo, tabOf, type LibraryTab } from '../library/tabs';
import { useAdopt } from '../shell/adopt';
import { NAV } from '../shell/nav';
import { useCan } from '../session';

const scanLibrary = () => NAV.flatMap((section) => section.items).find((item) => item.id === 'scan')?.run?.();

function useFilters() {
  return useSyncExternalStore(subscribeFilters, getFilterState);
}

function useSearchStatus() {
  return useSyncExternalStore(subscribeSearchStatus, getSearchStatus);
}

/**
 * The Filter popover: the old sidebar's filter section (search options, sort, folders, every
 * filter, Multi-Edit Mode), moved in while the shell is shown. It stays in the page while closed
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
        <EmptyState icon={Library} title="Your library is empty"
          action={canEdit ? (
            <>
              <Button variant="primary" icon={ScanSearch} onClick={scanLibrary}>Scan Library</Button>
              <Button icon={Upload} onClick={() => window.openUpload?.()}>Upload Models</Button>
              <Button icon={Link2} onClick={() => window.openLinkImport?.()}>Add Links</Button>
            </>
          ) : undefined}>
          {canEdit ? 'Scan your model folders (STL Home), upload models, or add links from Printables, Thingiverse or MakerWorld.' : 'An editor or admin adds the models.'}
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="jp-library-empty">
      <EmptyState icon={FilterX} title="No models match"
        action={<Button icon={FilterX} onClick={() => document.getElementById('clear-all-filters-button')?.click()}>Clear filters</Button>}>
        Try another tab, or clear the filters and search.
      </EmptyState>
    </div>
  );
}

/**
 * "Your Library" above the grid (spec §15): state tabs, the model count, the view buttons and
 * Folders toggle (moved in from the old toolbar), the Filter popover, and the active filters.
 */
export function LibraryHeader() {
  const [slot] = useState(() => document.querySelector<HTMLElement>('.grid-view-selector'));
  const state = useFilters();
  const { view, total } = useModelCounts();
  const [open, setOpen] = useState(false);
  const [filterButton, setFilterButton] = useState<HTMLButtonElement | null>(null);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  const [chips, setChips] = useState<HTMLDivElement | null>(null);
  const canUpload = useCan('editor');
  useAdopt('#grid-toolbar-slot', tools);
  useAdopt('#folder-rail-toggle-slot', rail);
  useAdopt('#current-filter', chips);

  const tab = tabOf(state);
  const extra = extraFilterCount(state);

  if (!slot) return null;
  return createPortal(
    <div className="jp jp-library-header">
      <div className="jp-library-header__top">
        <h1 className="jp-library-header__title">Your Library</h1>
        <div className="jp-library-header__bar">
          <Tabs<LibraryTab | 'none'> label="Show" items={LIBRARY_TABS} value={tab ?? 'none'}
            onChange={(id) => {
              if (id === 'none') return;
              const info = tabInfo(id);
              applyFilterChange(() => filterActions.setTab(info.printed, info.favorite));
            }} />
          <div className="jp-library-header__tools">
            <span className="jp-library-header__count" id="jp-library-count" title={`${total.toLocaleString()} models in the library`}>
              {view.toLocaleString()} {view === 1 ? 'model' : 'models'}
            </span>
            <div className="jp-library-header__rail" ref={setRail} />
            <div className="jp-library-header__view" ref={setTools} />
            {canUpload && (
              <Button icon={Upload} id="jp-upload-button" onClick={() => window.openUpload?.()} title="Upload model files into a library folder (or drop them on the page)">
                Upload
              </Button>
            )}
            {canUpload && (
              <Button icon={Link2} id="jp-links-button" onClick={() => window.openLinkImport?.()} title="Add models from Printables, Thingiverse or MakerWorld links">
                Add Links
              </Button>
            )}
            <button type="button" ref={setFilterButton} id="jp-filter-button" className={`jp-btn jp-btn--secondary jp-btn--md${open ? ' is-open' : ''}`}
              aria-expanded={open} aria-controls="jp-filter-popover" onClick={() => setOpen(!open)}>
              <SlidersHorizontal size={16} aria-hidden="true" />
              <span>Filter</span>
              {extra > 0 && <span className="jp-library-header__filter-count" aria-label={`${extra} filters set`}>{extra}</span>}
            </button>
          </div>
        </div>
        <div className="jp-library-header__chips" ref={setChips} />
        {/* Below the chips, so it never covers them (Clear All, AND / OR / NOT). */}
        <FilterPopover open={open} onClose={() => setOpen(false)} button={filterButton} />
      </div>
      <LibraryEmpty />
    </div>,
    slot
  );
}
