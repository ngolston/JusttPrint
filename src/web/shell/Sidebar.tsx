import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ChevronRight, Menu as MenuIcon, X } from 'lucide-react';
import { library, type LibraryCounts } from '../api';
import { cx } from '../components/Button';
import { nextMenuIndex } from '../components/Menu';
import { useCurrentUser } from '../session';
import { useAdopt } from './adopt';
import { useLibraryData } from './libraryData';
import { navFor, type NavItem } from './nav';
import { navigate, type PageId } from './routes';

/** Whether a media query matches, following resizes. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => window.matchMedia(query).matches
  );
}

export function useQueueCount(): number {
  const counts = useLibraryData<LibraryCounts>(library.counts);
  return counts ? counts.queued + counts.printing : 0;
}

// ---- Collapsed or not: kept in this browser, from page to page -------------------------------

const COLLAPSED_KEY = 'jp-nav-collapsed';
const collapsedListeners = new Set<() => void>();
let collapsed = (() => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
})();

function setCollapsed(value: boolean) {
  collapsed = value;
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    // Private windows may refuse; the choice then lasts until a reload.
  }
  collapsedListeners.forEach((listener) => listener());
}

/** Whether ☰ has shrunk the sidebar to its icons. */
export function useNavCollapsed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      collapsedListeners.add(listener);
      return () => collapsedListeners.delete(listener);
    },
    () => collapsed
  );
}

// ---- The rows ----------------------------------------------------------------------------------

/** The item's page or one in its fly-out menu is open. */
const isCurrent = (item: NavItem, page: PageId) => item.page === page || !!item.children?.some((child) => child.page === page);

function NavRow({
  item,
  page,
  rail,
  flyOpen,
  badge,
  onFly
}: {
  item: NavItem;
  page: PageId;
  rail: boolean;
  flyOpen: boolean;
  badge: number;
  onFly: (id: string, anchor: HTMLElement, toggle: boolean) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const Icon = item.icon;
  const children = item.children ?? [];
  const current = isCurrent(item, page);
  // On a page of its menu, the row says which one (Models / Tags).
  const child = children.find((c) => c.page === page && c.page !== item.page);
  return (
    <li ref={row} className={cx('jp-nav__item', current && 'is-active', flyOpen && 'is-flying')}>
      <button
        type="button"
        className={cx('jp-nav__row', current && 'is-active')}
        aria-current={item.page === page ? 'page' : current ? 'true' : undefined}
        title={item.label}
        onClick={() => {
          if (item.page) navigate(item.page);
          // Icons only: the icon also opens its menu (a second click closes it).
          if (rail && children.length && row.current) onFly(item.id, row.current, true);
          else onFly('', row.current!, false);
        }}
      >
        <Icon size={20} aria-hidden="true" />
        <span className="jp-nav__label">
          <span>{item.label}</span>
          {child && <span className="jp-nav__hint">{child.label}</span>}
        </span>
        {badge > 0 && (
          <span className="jp-nav__badge" aria-label={`${badge} in the queue`}>
            {badge}
          </span>
        )}
        {children.length > 0 && <ChevronRight size={10} strokeWidth={3} aria-hidden="true" className="jp-nav__has-menu" />}
      </button>
      {children.length > 0 && (
        <button
          type="button"
          className="jp-nav__fly"
          aria-label={`${item.label} pages`}
          title={`${item.label} pages`}
          aria-haspopup="menu"
          aria-expanded={flyOpen}
          onClick={() => row.current && onFly(item.id, row.current, true)}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

// ---- The fly-out menu --------------------------------------------------------------------------

function NavFlyout({
  item,
  anchor,
  page,
  queue,
  onClose
}: {
  item: NavItem;
  anchor: HTMLElement;
  page: PageId;
  queue: number;
  onClose: (focus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const children = item.children ?? [];
  // "All Models": the parent's own page, when it is not one of the menu's.
  const entries: NavItem[] = [
    ...(item.page && !children.some((c) => c.page === item.page) ? [{ ...item, id: `${item.id}-all`, label: `All ${item.label}`, children: undefined }] : []),
    ...children
  ];
  const [active, setActive] = useState(0);

  // Beside the sidebar, level with the row (in the phone drawer: under the row), kept inside the window.
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const side = anchor.closest('.jp-sidebar')?.getBoundingClientRect().right ?? rect.right;
    const width = menu.current?.offsetWidth ?? 300;
    const height = menu.current?.offsetHeight ?? 0;
    const phone = window.matchMedia('(max-width: 700px)').matches;
    const left = Math.max(8, Math.min(phone ? rect.left : side + 12, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(phone ? rect.bottom + 4 : rect.top - 6, window.innerHeight - height - 8));
    setPlace({ top, left });
  }, [anchor]);

  // The first entry takes the focus once the menu is placed (a hidden one cannot).
  const focused = useRef(false);
  useEffect(() => {
    if (!place || focused.current) return;
    focused.current = true;
    refs.current[0]?.focus({ preventScroll: true });
  }, [place]);

  // A click outside, Escape (wherever the focus is) or a resize closes it.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    const onResize = () => onClose(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      onClose(false);
      return;
    }
    const next = nextMenuIndex(
      event.key,
      active,
      entries.map(() => ({}))
    );
    if (next < 0) return;
    event.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  }

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={`${item.label} pages`}
      id="jp-nav-flyout"
      className="jp-nav-flyout"
      style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      <div className="jp-nav-flyout__title" aria-hidden="true">
        {item.label}
      </div>
      {entries.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          tabIndex={index === active ? 0 : -1}
          ref={(el) => {
            refs.current[index] = el;
          }}
          className={cx('jp-nav-flyout__item', entry.page === page && 'is-active')}
          aria-current={entry.page === page ? 'page' : undefined}
          onClick={() => {
            onClose(false);
            if (entry.page) navigate(entry.page);
          }}
        >
          <span className="jp-nav-flyout__text">
            <span className="jp-nav-flyout__label">{entry.label}</span>
            {entry.description && <span className="jp-nav-flyout__description">{entry.description}</span>}
          </span>
          {entry.id === 'queue' && queue > 0 && (
            <span className="jp-nav__badge" aria-label={`${queue} in the queue`}>
              {queue}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ---- The sidebar -------------------------------------------------------------------------------

/**
 * The sidebar: Home, Models, Filament, Printing and Settings on a dark rail. A name opens its page;
 * › opens a fly-out menu with the pages under it. ☰ shrinks it to icons (remembered in this
 * browser); then an icon opens its page and its menu. Tablets always show the icons; on phones it
 * is a drawer with the names. What runs in the background shows at the bottom.
 */
export function Sidebar({ page, onClose }: { page: PageId; onClose: () => void }) {
  const queue = useQueueCount();
  const user = useCurrentUser();
  const shrunk = useNavCollapsed();
  const phone = useMedia('(max-width: 700px)');
  const tablet = useMedia('(max-width: 1023px)');
  const rail = !phone && (shrunk || tablet);
  const [fly, setFly] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  // Background job progress (src/web/scan/Progress.tsx).
  const [jobs, setJobs] = useState<HTMLDivElement | null>(null);
  useAdopt('#sidebar-progress-slot', jobs);
  const items = navFor(user?.role);

  useEffect(() => {
    document.body.classList.toggle('jp-nav-collapsed', shrunk);
  }, [shrunk]);

  const flyNow = useRef(fly);
  flyNow.current = fly;
  // Escape gives the focus back to the row's › (or the icon, on the rail).
  const closeFly = useCallback((focus: boolean) => {
    const open = flyNow.current;
    setFly(null);
    if (!focus || !open) return;
    const fly = open.anchor.querySelector<HTMLElement>('.jp-nav__fly');
    (fly && fly.offsetParent ? fly : open.anchor.querySelector<HTMLElement>('.jp-nav__row'))?.focus();
  }, []);

  function onFly(id: string, anchor: HTMLElement, toggle: boolean) {
    if (!toggle) return setFly(null);
    setFly((open) => (open?.id === id ? null : { id, anchor }));
  }

  const flying = fly && items.find((item) => item.id === fly.id);
  return (
    <>
      <nav className={cx('jp-sidebar', rail && 'is-rail')} id="jp-sidebar" aria-label="Main">
        <button type="button" className="jp-sidebar__close jp-icon-btn jp-icon-btn--md" aria-label="Close menu" title="Close menu" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
        <div className="jp-sidebar__head">
          <button
            type="button"
            id="jp-nav-toggle"
            className="jp-sidebar__toggle"
            aria-label={shrunk ? 'Expand menu' : 'Collapse menu'}
            title={shrunk ? 'Expand menu' : 'Collapse menu'}
            aria-expanded={!shrunk}
            onClick={() => {
              setFly(null);
              setCollapsed(!shrunk);
            }}
          >
            <MenuIcon size={20} aria-hidden="true" />
          </button>
          <button type="button" className="jp-brand" onClick={() => navigate('home')} title="Home">
            <span className="jp-brand__logo">
              <img src="assets/logo.png" alt="" />
            </span>
            <span className="jp-brand__text">
              <span className="jp-brand__name">JusttPrint</span>
              <span className="jp-brand__tagline">Your 3D Printing Library</span>
            </span>
          </button>
        </div>
        <ul className="jp-nav">
          {items.map((item) => (
            <NavRow key={item.id} item={item} page={page} rail={rail} flyOpen={fly?.id === item.id} badge={item.id === 'printing' ? queue : 0} onFly={onFly} />
          ))}
        </ul>
        <div className="jp-jobs" ref={setJobs} />
      </nav>
      {flying && fly && <NavFlyout key={fly.id} item={flying} anchor={fly.anchor} page={page} queue={queue} onClose={closeFly} />}
    </>
  );
}
