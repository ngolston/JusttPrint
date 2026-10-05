import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { models } from '../api';
import { hideDetailsPanels, useDetailsVisibility } from '../details/visibility';
import { useModelCounts, plural } from '../filters/counts';
import { filterStrip, type StripItem } from '../filters/query';
import { labels, runSearch } from '../filters/search';
import { applyFilterChange } from '../filters/Sidebar';
import { filterActions, getFilterState, subscribeFilters } from '../filters/store';
import { folderTreeActions, getFolderTreeState, subscribeFolderTree } from '../folders/store';
import { findNode, folderName } from '../folders/tree';
import { Icon, type IconName } from './icons';
import { useLayout } from './layout';
import { MENU, findMenuAction, tidySeparators, type MenuItem } from './menu';

type Sheet = 'filters' | 'more' | null;
type Nav = 'library' | 'folders' | 'filters' | 'more';

/** The menu's tools that get their own buttons at the top of the More sheet (or elsewhere on the phone). */
const TOOLS: [string, IconName, string][] = [
  ['Filament Manager', 'filament', 'Filament'],
  ['Printer Manager', 'printer', 'Printers'],
  ['Parts Manager', 'parts', 'Parts'],
  ['Tag Manager', 'tag', 'Tags'],
  ['De-Dup', 'dedup', 'De-Dup'],
  ['Organize Library', 'organize', 'Organize'],
  ['Print Roulette', 'roulette', 'Roulette']
];
const ACTIONS = ['Scan Directory', 'View Entire Library'];
const PROMOTED = new Set([...TOOLS.map(([label]) => label), ...ACTIONS]);

/** Where a swipe down on a sheet's header closes it. */
const SWIPE_HANDLES = '#mobile-drawer-head, #mobile-more-head, .folder-rail-header, #model-details > h3, #bundle-details > h3, #multi-edit-panel > h3';

/** The grid view (.view-button.active, renderer.js). */
function useGridView(): string {
  const [view, setView] = useState(() => document.querySelector<HTMLElement>('.view-button.active')?.dataset.view || '');
  useEffect(() => {
    const switcher = document.querySelector('.grid-view-selector');
    if (!switcher) return;
    const observer = new MutationObserver(() => setView(document.querySelector<HTMLElement>('.view-button.active')?.dataset.view || ''));
    observer.observe(switcher, { attributes: true, subtree: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return view;
}

const showGridView = (view: string) => document.querySelector<HTMLElement>(`.view-button[data-view="${view}"]`)?.click();

function chipText(item: StripItem): string {
  if (item.kind === 'op') return item.text;
  if (item.kind !== 'chip') return '';
  return [item.text, item.notesOff && 'notes off', item.inverted && 'NOT'].filter(Boolean).join(' ');
}

/** The app bar: where you are, how many models, the active filters, and wall / list. */
function AppBar({ barRef }: { barRef: RefObject<HTMLElement | null> }) {
  const filters = useSyncExternalStore(subscribeFilters, getFilterState);
  const { forest } = useSyncExternalStore(subscribeFolderTree, getFolderTreeState);
  const { view: viewCount } = useModelCounts();
  const gridView = useGridView();
  const directory = filters.directory;
  const title = directory ? findNode(forest.roots, directory)?.label || folderName(directory) || 'Folder' : 'Library';
  const strip = filterStrip(filters, labels);
  const chips = strip.active ? [...strip.chain, ...strip.chips].filter((item) => item.kind === 'chip' || item.kind === 'op') : [];
  const active = gridView === 'list' ? 'list' : 'preview';
  return (
    <header id="mobile-app-bar" aria-label="JusttPrint" ref={barRef}>
      <div className="mobile-bar-top">
        <span className="mobile-bar-logo" aria-hidden="true" />
        <div className="mobile-bar-text">
          <div className="mobile-bar-title" id="mobile-bar-title">{title}</div>
          <div className="mobile-bar-subtitle" id="mobile-bar-count">{plural(viewCount)}</div>
        </div>
        <div className="mobile-view-switch" role="group" aria-label="Library view">
          {([['preview', 'grid', 'Wall'], ['list', 'list', 'List']] as const).map(([view, icon, label]) => (
            <button key={view} type="button" data-mobile-view={view} className={active === view ? 'is-active' : undefined}
              aria-pressed={active === view} aria-label={label} onClick={() => showGridView(view)}>
              <Icon name={icon} />
            </button>
          ))}
        </div>
      </div>
      <div id="mobile-filter-chips" hidden={!chips.length}>
        {chips.map((item, i) => (
          <button key={i} type="button" className="mobile-chip"
            onClick={() => { if (item.kind === 'chip' || item.kind === 'op') applyFilterChange(() => filterActions.removeChip(item.remove)); }}>
            {chipText(item)}
          </button>
        ))}
        {chips.length > 0 && (
          <button type="button" className="mobile-chip mobile-chip-clear" onClick={() => {
            filterActions.clearAll();
            window.sidebarHost?.resetSelection();
            runSearch({ force: true });
          }}>Clear</button>
        )}
      </div>
    </header>
  );
}

function MoreList({ items, run, drill }: { items: MenuItem[]; run: (fn: () => void | Promise<void>) => void; drill: (item: MenuItem & { kind: 'submenu' }) => void }) {
  if (!items.length) return null;
  return (
    <div className="mobile-more-list">
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className="mobile-more-sep" />;
        if (item.kind === 'submenu') return <button key={i} type="button" className="mobile-more-row has-children" onClick={() => drill(item)}>{item.label}</button>;
        return <button key={i} type="button" className="mobile-more-row" onClick={() => run(item.run)}>{item.label}</button>;
      })}
    </div>
  );
}

/** The More sheet: the main tools as buttons, then the rest of the menu. Submenus open as a page. */
function MoreSheet({ open, close, run }: { open: boolean; close: () => void; run: (fn: () => void | Promise<void>) => void }) {
  const [stack, setStack] = useState<(MenuItem & { kind: 'submenu' })[]>([]);
  useEffect(() => { if (open) setStack([]); }, [open]);
  const page = stack[stack.length - 1];
  const runLabel = (label: string) => {
    const fn = findMenuAction(label);
    if (fn) run(fn);
  };
  const drill = (item: MenuItem & { kind: 'submenu' }) => setStack([...stack, item]);
  return (
    <section id="mobile-more-sheet" hidden={!open} aria-label="More">
      <header id="mobile-more-head">
        <span className="mobile-sheet-grab" aria-hidden="true" />
        <div className="mobile-more-titlebar">
          <button type="button" id="mobile-more-back" hidden={!page} onClick={() => setStack(stack.slice(0, -1))}>Back</button>
          <h2 id="mobile-more-title">{page ? page.label : 'More'}</h2>
          <button type="button" id="mobile-more-close" onClick={close}>Close</button>
        </div>
      </header>
      <div id="mobile-more-body">
        <div id="mobile-more-home" hidden={!!page}>
          <div className="mobile-tool-grid">
            {TOOLS.map(([label, icon, text]) => (
              <button key={label} type="button" className="mobile-tool" data-menu-label={label} onClick={() => runLabel(label)}>
                <Icon name={icon} />
                <span>{text}</span>
              </button>
            ))}
          </div>
          <div className="mobile-more-actions">
            {ACTIONS.map((label) => <button key={label} type="button" data-menu-label={label} onClick={() => runLabel(label)}>{label}</button>)}
          </div>
          <div id="mobile-more-sections">
            {MENU.map((group) => {
              const items = tidySeparators(group.items.filter((item) => item.kind !== 'action' || !PROMOTED.has(item.label)));
              if (!items.some((item) => item.kind !== 'separator')) return null;
              return (
                <section key={group.label} className="mobile-more-section">
                  <h3>{group.label}</h3>
                  <MoreList items={items} run={run} drill={drill} />
                </section>
              );
            })}
          </div>
        </div>
        <div id="mobile-more-drill" hidden={!page}>
          {page && <MoreList items={page.items} run={run} drill={drill} />}
        </div>
      </div>
    </section>
  );
}

/** The phone buttons in the details panels' headers: close, 3D, favorite, log a print, and "More details". */
function DetailsHeaders({ close }: { close: () => void }) {
  const [slots] = useState(() => ({
    model: document.getElementById('details-header-slot'),
    more: document.getElementById('details-more-slot'),
    bundle: document.getElementById('bundle-header-slot'),
    multi: document.getElementById('multi-header-slot')
  }));
  const { panel, filePath } = useDetailsVisibility();
  const [name, setName] = useState('');
  const [favorite, setFavorite] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);

  // The name and favorite of the open model; the name follows edits in the Name field.
  useEffect(() => {
    if (panel !== 'model' || !filePath) return;
    let current = true;
    const readName = () => setName((document.getElementById('model-name') as HTMLInputElement | null)?.value.trim() || '');
    readName();
    const timer = setTimeout(readName, 80);
    models.get<{ favorite?: number | boolean }>(filePath)
      .then((model) => { if (current) setFavorite(model ? !!model.favorite : null); }, () => { if (current) setFavorite(null); });
    const onInput = (event: Event) => { if ((event.target as HTMLElement)?.id === 'model-name') readName(); };
    document.addEventListener('input', onInput);
    return () => {
      current = false;
      clearTimeout(timer);
      document.removeEventListener('input', onInput);
    };
  }, [panel, filePath]);

  useEffect(() => {
    document.getElementById('model-details')?.classList.toggle('is-expanded', expanded);
  }, [expanded]);

  const toggleFavorite = async () => {
    if (!filePath || favorite === null) return;
    // The selected card's heart also updates the card.
    const cardButton = document.querySelector<HTMLElement>('.file-item.selected .model-favorite-btn, .parent-model-group.selected .model-favorite-btn');
    if (cardButton) cardButton.click();
    else await window.gridHost?.saveField(filePath, 'favorite', !favorite);
    setTimeout(async () => {
      const model = await models.get<{ favorite?: number | boolean }>(filePath).catch(() => null);
      setFavorite(model ? !!model.favorite : null);
    }, 200);
  };

  const closeButton = <button type="button" className="mobile-panel-close" data-mobile-close-details aria-label="Close details" onClick={close}>×</button>;
  const stop = (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation(); };
  return (
    <>
      {slots.model && createPortal(
        <>
          <span className="mobile-details-name" id="mobile-details-name" hidden>{name || 'Model'}</span>
          {closeButton}
          <span className="mobile-details-actions">
            <button type="button" className="mobile-details-preview-btn" id="mobile-details-open-preview" aria-label="View in 3D"
              onClick={(e) => { stop(e); if (filePath) window.openPreview?.(filePath); }}>
              <Icon name="cube" /><span>3D</span>
            </button>
            <button type="button" className={`mobile-details-preview-btn${favorite ? ' is-on' : ''}`} id="mobile-details-favorite" hidden={favorite === null}
              aria-pressed={!!favorite} aria-label={favorite ? 'Favorited' : 'Favorite'} onClick={(e) => { stop(e); toggleFavorite(); }}>
              <Icon name="heart" /><span className="mobile-action-label">Favorite</span>
            </button>
            <button type="button" className="mobile-details-preview-btn" id="mobile-details-log-print" aria-label="Log a print"
              onClick={(e) => { stop(e); document.getElementById('log-print-button')?.click(); }}>
              <Icon name="log" /><span>Log print</span>
            </button>
          </span>
        </>,
        slots.model
      )}
      {slots.more && createPortal(
        <button type="button" id="mobile-details-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Less' : 'More details'}</button>,
        slots.more
      )}
      {slots.bundle && createPortal(
        <>
          {closeButton}
          <span className="mobile-details-actions">
            <button type="button" className="mobile-details-preview-btn" id="mobile-bundle-open-preview" aria-label="View in 3D"
              onClick={(e) => {
                stop(e);
                const record = (document.getElementById('bundle-details') as (HTMLElement & { _bundleRecord?: unknown }) | null)?._bundleRecord;
                if (record) window.openBundlePreview?.(record as Parameters<NonNullable<typeof window.openBundlePreview>>[0]);
              }}>
              <Icon name="cube" /><span>3D</span>
            </button>
          </span>
        </>,
        slots.bundle
      )}
      {slots.multi && createPortal(closeButton, slots.multi)}
    </>
  );
}

/**
 * The phone layout (body.mobile-ui): an app bar, a bottom nav (Library, Folders, Filters, More),
 * the sidebar as a Filters sheet, the folder rail and details panels as sheets, and the More
 * sheet with the menu. On a computer only the details panels' header buttons render (hidden by CSS).
 */
export function MobileShell() {
  const [slots] = useState(() => ({
    shell: document.getElementById('mobile-shell-slot'),
    drawer: document.getElementById('mobile-drawer-slot')
  }));
  const layout = useLayout();
  const mobile = layout.mobile;
  const details = useDetailsVisibility();
  const { railOpen } = useSyncExternalStore(subscribeFolderTree, getFolderTreeState);
  const gridView = useGridView();
  const [sheet, setSheet] = useState<Sheet>(null);
  const barRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const detailsOpen = mobile && details.panel !== null;
  const anySheet = mobile && (sheet !== null || detailsOpen || railOpen);
  const nav: Nav = detailsOpen ? 'library' : sheet ?? (railOpen ? 'folders' : 'library');

  const closeAll = () => {
    setSheet(null);
    if (getFolderTreeState().railOpen) folderTreeActions.setRailOpen(false);
    hideDetailsPanels();
  };
  const openSheet = (next: Sheet) => {
    hideDetailsPanels();
    if (getFolderTreeState().railOpen) folderTreeActions.setRailOpen(false);
    setSheet(next);
  };
  const run = (fn: () => void | Promise<void>) => {
    closeAll();
    fn();
  };

  // The page's classes for the layout and the open sheets (mobile-ui.css).
  useLayoutEffect(() => {
    const { body, documentElement: html } = document;
    body.classList.toggle('mobile-ui', mobile);
    html.classList.toggle('mobile-ui', mobile);
    body.classList.toggle('mobile-ui-wide', layout.wide);
    html.classList.toggle('mobile-ui-wide', layout.wide);
    if (!mobile) setSheet(null);
    // Let the grid measure itself for the new layout.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, [mobile, layout.wide, layout.landscape]);

  useEffect(() => {
    const body = document.body;
    body.classList.toggle('mobile-sidebar-open', mobile && sheet === 'filters');
    body.classList.toggle('mobile-menu-open', mobile && sheet === 'more');
    body.classList.toggle('mobile-details-open', detailsOpen);
    body.classList.toggle('mobile-sheet-open', anySheet);
  }, [mobile, sheet, detailsOpen, anySheet]);

  // Opening a model closes the other sheets.
  useEffect(() => {
    if (!detailsOpen) return;
    setSheet(null);
    if (getFolderTreeState().railOpen) folderTreeActions.setRailOpen(false);
  }, [detailsOpen, details.filePath]);

  // The phone shows the wall or the list, not the detailed cards.
  useEffect(() => {
    if (mobile && gridView === 'detailed') showGridView('preview');
  }, [mobile, gridView]);

  // The app bar's and nav's heights, for the page's padding (mobile-ui.css).
  useEffect(() => {
    const style = document.body.style;
    if (!mobile) {
      style.removeProperty('--mobile-bar-height');
      style.removeProperty('--mobile-nav-height');
      return;
    }
    const measure = () => {
      style.setProperty('--mobile-bar-height', `${barRef.current?.offsetHeight || 0}px`);
      style.setProperty('--mobile-nav-height', `${navRef.current?.offsetHeight || 0}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (barRef.current) observer.observe(barRef.current);
    if (navRef.current) observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [mobile]);

  // Escape, and a swipe down on a sheet's header, close the sheets.
  useEffect(() => {
    if (!mobile) return;
    let start: { x: number; y: number } | null = null;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeAll(); };
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      start = event.button === 0 && target.closest(SWIPE_HANDLES) && !target.closest('button, a, input, select, textarea')
        ? { x: event.clientX, y: event.clientY } : null;
    };
    const onUp = (event: PointerEvent) => {
      if (!start) return;
      const dy = event.clientY - start.y;
      const dx = Math.abs(event.clientX - start.x);
      start = null;
      if (dy > 64 && dy > dx) closeAll();
    };
    const onCancel = () => { start = null; };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
    };
  }, [mobile]);

  const navButton = (id: Nav, icon: IconName, label: string, onClick: () => void) => (
    <button type="button" id={`mobile-nav-${id}`} data-nav={id} className={nav === id ? 'is-active' : undefined}
      aria-current={nav === id ? 'page' : 'false'} onClick={(e) => { e.preventDefault(); onClick(); }}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );

  return (
    <>
      <DetailsHeaders close={() => hideDetailsPanels()} />
      {slots.shell && mobile && createPortal(
        <>
          <div id="mobile-ui-overlay" className={anySheet ? 'is-open' : undefined} hidden={!anySheet} onClick={closeAll} />
          <AppBar barRef={barRef} />
          <nav id="mobile-bottom-nav" aria-label="Mobile navigation" ref={navRef}>
            <div className="mobile-dock">
              {navButton('library', 'grid', 'Library', closeAll)}
              {navButton('folders', 'folder', 'Folders', () => {
                hideDetailsPanels();
                setSheet(null);
                folderTreeActions.setRailOpen(!railOpen);
              })}
              {navButton('filters', 'filter', 'Filters', () => (sheet === 'filters' ? closeAll() : openSheet('filters')))}
              {navButton('more', 'more', 'More', () => (sheet === 'more' ? closeAll() : openSheet('more')))}
            </div>
          </nav>
          <MoreSheet open={sheet === 'more'} close={closeAll} run={run} />
        </>,
        slots.shell
      )}
      {slots.drawer && createPortal(
        <div id="mobile-drawer-head">
          <span className="mobile-sheet-grab" aria-hidden="true" />
          <div className="mobile-drawer-titlebar">
            <strong>Filters</strong>
            <button type="button" id="mobile-drawer-done" onClick={(e) => { e.preventDefault(); closeAll(); }}>Done</button>
          </div>
        </div>,
        slots.drawer
      )}
    </>
  );
}
