import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, CircleUserRound, Home, Library, ListChecks, Lock, Menu as MenuIcon, MousePointerClick, Printer, X } from 'lucide-react';
import { library, type LibraryCounts, type LibraryStorage } from '../api';
import { Menu } from '../components/Menu';
import { cx } from '../components/Button';
import { EmptyState, ProgressBar } from '../components/Panel';
import { SearchBox, shortcutLabel } from '../components/SearchBox';
import { ModelDetailsPanel } from '../details/ModelDetailsPanel';
import { detailsAreOpen, hideDetailsPanels, useDetailsVisibility } from '../details/visibility';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { HelpPage } from '../pages/HelpPage';
import { HomePage } from '../pages/HomeDashboard';
import { LibraryHeader } from '../pages/LibraryPage';
import { DuplicatesPage } from '../pages/DuplicatesPage';
import { OrganizePage } from '../pages/OrganizePage';
import { PrintersPage } from '../pages/PrintersPage';
import { QueuePage } from '../pages/QueuePage';
import { TagsPage } from '../pages/TagsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { StatsPage } from '../pages/StatsPage';
import { CollectionsPage } from '../pages/CollectionsPage';
import { roleAllows, useCurrentUser } from '../session';
import { useAdopt } from './adopt';
import { useLibraryData } from './libraryData';
import { ACCOUNT, NAV, itemsFor, navFor, type NavItem } from './nav';
import { navigate, useRoute, type PageId } from './routes';

/** "12.4 GB", "820 MB", "0 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function StorageIndicator() {
  const storage = useLibraryData<LibraryStorage>(library.storage);
  if (!storage) return null;
  const volume = storage.volume;
  const percent = volume ? Math.round((volume.usedBytes / volume.totalBytes) * 100) : 0;
  return (
    <div className="jp-storage" title={volume ? `Library files: ${formatBytes(storage.libraryBytes)} (${storage.modelCount} models)\nVolume: ${volume.path}` : undefined}>
      <div className="jp-storage__title">Library Storage</div>
      {volume ? (
        <>
          <ProgressBar value={volume.usedBytes} max={volume.totalBytes} label="Library volume used" />
          <div className="jp-storage__figures">
            <span>{formatBytes(volume.usedBytes)} of {formatBytes(volume.totalBytes)}</span>
            <span>{percent}%</span>
          </div>
        </>
      ) : (
        <div className="jp-storage__figures"><span>{formatBytes(storage.libraryBytes)} in {storage.modelCount} models</span></div>
      )}
    </div>
  );
}

function NavRow({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  const Icon = item.icon;
  return (
    <li>
      <button type="button" className={cx('jp-nav__row', active && 'is-active')} aria-current={active ? 'page' : undefined}
        title={item.label} onClick={() => (item.page ? navigate(item.page) : item.run?.())}>
        <Icon size={18} aria-hidden="true" />
        <span className="jp-nav__label">{item.label}</span>
        {badge ? <span className="jp-nav__badge" aria-label={`${badge} in the queue`}>{badge}</span> : null}
      </button>
    </li>
  );
}

function useQueueCount(): number {
  const counts = useLibraryData<LibraryCounts>(library.counts);
  return counts ? counts.queued + counts.printing : 0;
}

function Sidebar({ page, onClose }: { page: PageId; onClose: () => void }) {
  const queue = useQueueCount();
  const user = useCurrentUser();
  // Scan and thumbnail job progress (src/web/scan/Progress.tsx), above Library Storage.
  const [jobs, setJobs] = useState<HTMLDivElement | null>(null);
  useAdopt('#sidebar-progress-slot', jobs);
  return (
    <nav className="jp-sidebar" id="jp-sidebar" aria-label="Main">
      <button type="button" className="jp-sidebar__close jp-icon-btn jp-icon-btn--md" aria-label="Close menu" title="Close menu" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
      <button type="button" className="jp-brand" onClick={() => navigate('home')} title="Home">
        <span className="jp-brand__logo"><img src="assets/logo.png" alt="" /></span>
        <span className="jp-brand__text">
          <span className="jp-brand__name">JusttPrint</span>
          <span className="jp-brand__tagline">Your 3D Printing Library</span>
        </span>
      </button>
      <div className="jp-nav">
        {navFor(user?.role).map((section, index) => (
          <div key={section.label ?? index} className="jp-nav__section">
            {section.label && <div className="jp-label jp-nav__heading">{section.label}</div>}
            <ul>
              {section.items.map((item) => (
                <NavRow key={item.id} item={item} active={!!item.page && item.page === page} badge={item.id === 'queue' ? queue : undefined} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="jp-jobs" ref={setJobs} />
      <StorageIndicator />
    </nav>
  );
}

function TopBar({ onMenu, menuOpen }: { onMenu: () => void; menuOpen: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const user = useCurrentUser();
  const [text, setText] = useState('');

  // Ctrl+K / ⌘K focuses the search from anywhere (spec §35).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setText('');
      input.current?.blur();
      return;
    }
    if (event.key !== 'Enter') return;
    const query = text.trim();
    if (!query) return;
    navigate('library');
    applyFilterChange(() => filterActions.search('all', query));
    setText('');
  }

  return (
    <header className="jp-topbar">
      <button type="button" className="jp-topbar__menu jp-icon-btn jp-icon-btn--md" aria-label="Menu" title="Menu"
        aria-controls="jp-sidebar" aria-expanded={menuOpen} onClick={onMenu}>
        <MenuIcon size={20} aria-hidden="true" />
      </button>
      <SearchBox ref={input} className="jp-topbar__search" label="Search the library" value={text}
        placeholder="Search models, designers, tags, or anything..." shortcut={shortcutLabel(navigator.platform)}
        onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
      <div className="jp-topbar__actions">
        <Menu label="Account" items={itemsFor(ACCOUNT, user?.role).map((item) => ({ id: item.id, label: item.label, icon: item.icon, onSelect: item.run }))}
          trigger={(props) => (
            <button type="button" className="jp-account" aria-label={user ? undefined : 'Account'}
              title={user ? `${user.username} · ${user.roleLabel}` : 'Account'} {...props}>
              <CircleUserRound size={26} aria-hidden="true" />
              {user && (
                <span className="jp-account__who" id="jp-account-who">
                  <span className="jp-account__name">{user.username}</span>{' '}
                  <span className="jp-account__role">{user.roleLabel}</span>
                </span>
              )}
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          )} />
      </div>
    </header>
  );
}

/** Phones (spec §36): the main destinations at the bottom, and Menu for the rest. */
function BottomNav({ page, onMenu }: { page: PageId; onMenu: () => void }) {
  const queue = useQueueCount();
  const items: [PageId, string, typeof Home][] = [['home', 'Home', Home], ['library', 'Library', Library], ['queue', 'Queue', ListChecks], ['printers', 'Printers', Printer]];
  return (
    <nav className="jp-bottom-nav" id="jp-bottom-nav" aria-label="Main (phone)">
      {items.map(([id, label, Icon]) => (
        <button key={id} type="button" className={cx('jp-bottom-nav__item', page === id && 'is-active')} aria-current={page === id ? 'page' : undefined}
          onClick={() => navigate(id)}>
          <span className="jp-bottom-nav__icon">
            <Icon size={20} aria-hidden="true" />
            {id === 'queue' && queue > 0 && <span className="jp-bottom-nav__badge" aria-label={`${queue} in the queue`}>{queue}</span>}
          </span>
          <span>{label}</span>
        </button>
      ))}
      <button type="button" className="jp-bottom-nav__item" aria-controls="jp-sidebar" onClick={onMenu}>
        <span className="jp-bottom-nav__icon"><MenuIcon size={20} aria-hidden="true" /></span>
        <span>Menu</span>
      </button>
    </nav>
  );
}

/** Below 1200 px the details panels are a drawer (phones: full screen) with a close button. */
function DetailsDrawerBar() {
  const [bar] = useState(() => {
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    if (!sidebar) return null;
    const element = document.createElement('div');
    element.className = 'jp jp-details-bar';
    sidebar.prepend(element);
    return element;
  });
  useEffect(() => () => bar?.remove(), [bar]);
  if (!bar) return null;
  return createPortal(
    <button type="button" className="jp-icon-btn jp-icon-btn--md" id="jp-details-close" aria-label="Close details" title="Close details" onClick={hideDetailsPanels}>
      <X size={18} aria-hidden="true" />
    </button>,
    bar
  );
}

/** The details column with nothing selected (spec §49: never a blank panel). */
function DetailsPlaceholder() {
  const [slot] = useState(() => document.querySelector<HTMLElement>('.sidebar'));
  const visibility = useDetailsVisibility();
  if (!slot || detailsAreOpen(visibility)) return null;
  return createPortal(
    <div className="jp jp-details-empty">
      <EmptyState icon={MousePointerClick} title="No model selected">
        Click a model to see its details here. Ctrl/⌘-click or Shift-click several to edit them together.
      </EmptyState>
    </div>,
    slot
  );
}

/** The window is at most this wide (a media query). */
const narrow = (query: string) => typeof window !== 'undefined' && window.matchMedia(query).matches;

/** Skip link (spec §37): past the sidebar and top bar to the page's content. */
function SkipLink({ page }: { page: PageId }) {
  return (
    <nav className="jp-skip-nav" aria-label="Skip links">
      <a href={isOverlayPage(page) ? '#jp-content' : '#library-content'} className="jp-skip" onClick={(event) => {
        event.preventDefault();
        const target = isOverlayPage(page)
          ? document.querySelector<HTMLElement>('.jp-page')
          : document.querySelector<HTMLElement>('.file-grid .file-item') ?? document.querySelector<HTMLElement>('.jp-library-header');
        if (!target) return;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus();
      }}>Skip to content</a>
    </nav>
  );
}

const isThumbnailWorker = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1';

const PAGE_TITLES: Record<PageId, string> = { home: 'Home', library: 'Library', queue: 'Print Queue', printers: 'Printers', stats: 'Statistics', collections: 'Collections', tags: 'Tags', duplicates: 'Duplicates', organize: 'Organize Library', settings: 'Settings', help: 'Help' };
/** The least role a page needs: the role of its sidebar entry. */
function pageRole(page: PageId) {
  return NAV.flatMap((section) => section.items).find((item) => item.page === page)?.role || 'viewer';
}

/** A page the account cannot use, opened by its address. */
function NotAllowed() {
  return (
    <div className="jp-page__inner">
      <EmptyState icon={Lock} title="Not available to your account">
        Ask an admin if you need this page.
      </EmptyState>
    </div>
  );
}

/** Pages drawn over the library screen (every page but Library). */
const isOverlayPage = (page: PageId) => page !== 'library';

/**
 * The JusttPrint 5 frame (spec §5): sidebar, top bar, and the page area. The library page is the
 * grid (src/web/grid/) under its header (pages/LibraryPage.tsx), with the old sidebar's details
 * panels as the right column, placed by src/web/styles/library-frame.css; other pages cover it.
 * Responsive (spec §36, styles/responsive.css): below 1200 px the details are a drawer; tablets
 * get an icon rail; phones a sidebar drawer, a bottom bar and full-screen details.
 */
export function AppShell() {
  const { page, section } = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const user = useCurrentUser();
  // While the user is loading, nothing is drawn rather than a page that is then taken away.
  const allowed = !!user && roleAllows(user.role, pageRole(page));
  const details = useDetailsVisibility();
  const detailsOpen = detailsAreOpen(details);

  useEffect(() => {
    if (isThumbnailWorker) return undefined;
    document.body.classList.add('jp-shell-on');
    return () => document.body.classList.remove('jp-shell-on');
  }, []);

  // Body classes for the drawers (responsive.css).
  useEffect(() => {
    document.body.classList.toggle('jp-details-open', detailsOpen);
    document.body.classList.toggle('jp-nav-open', menuOpen);
    document.body.classList.toggle('jp-overlay-page', isOverlayPage(page));
  }, [detailsOpen, menuOpen, page]);

  // A page change closes the menu drawer.
  useEffect(() => { setMenuOpen(false); }, [page, section]);

  // What a page or a drawer covers is out of reach for the keyboard and screen readers (spec §37).
  useEffect(() => {
    const covered = isOverlayPage(page);
    const set = (selector: string, value: boolean) => document.querySelectorAll<HTMLElement>(selector).forEach((el) => { el.inert = value; });
    // Not all of .main-content: some older dialogs (Quick Start Guide) live inside it.
    set('.grid-view-selector, .file-grid, #folder-rail', covered || menuOpen);
    set('.sidebar', covered || (menuOpen && narrow('(max-width: 700px)')));
    set('.jp-page, .jp-topbar, .jp-bottom-nav', menuOpen && narrow('(max-width: 700px)'));
    // One main landmark: the page's while one covers the library (which is then a plain region).
    document.querySelector('.main-content > .library-main')?.setAttribute('role', covered ? 'region' : 'main');
  }, [page, menuOpen]);

  // The menu drawer takes the focus while open and gives it back to the Menu button (after it
  // was open: not when the page loads).
  const menuWasOpen = useRef(false);
  useEffect(() => {
    const wasOpen = menuWasOpen.current;
    menuWasOpen.current = menuOpen;
    if (!narrow('(max-width: 700px)')) return;
    if (menuOpen) document.querySelector<HTMLElement>('#jp-sidebar .jp-nav__row[aria-current="page"], #jp-sidebar .jp-nav__row')?.focus();
    else if (wasOpen && document.activeElement === document.body) document.querySelector<HTMLElement>('.jp-topbar__menu')?.focus();
  }, [menuOpen]);

  // The details drawer (below 1200 px) takes the focus when it opens; closing it returns to the model.
  useEffect(() => {
    if (!narrow('(max-width: 1199px)') || isOverlayPage(page)) return;
    if (detailsOpen) {
      const focused = document.activeElement;
      if (!focused || !focused.closest('.sidebar')) document.getElementById('jp-details-close')?.focus({ preventScroll: true });
    } else if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest('.sidebar')) {
      document.querySelector<HTMLElement>('.file-grid .file-item.selected')?.focus();
    }
  }, [detailsOpen, page]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  useEffect(() => {
    document.title = page === 'home' ? 'JusttPrint' : `${PAGE_TITLES[page]} · JusttPrint`;
  }, [page]);

  // The server's hidden thumbnail page has no UI.
  if (isThumbnailWorker) return null;
  return createPortal(
    <div className="jp jp-shell">
      <SkipLink page={page} />
      <Sidebar page={page} onClose={() => setMenuOpen(false)} />
      <div className="jp-nav-backdrop" hidden={!menuOpen} onClick={() => setMenuOpen(false)} />
      <TopBar onMenu={() => setMenuOpen(!menuOpen)} menuOpen={menuOpen} />
      <BottomNav page={page} onMenu={() => setMenuOpen(true)} />
      <div className="jp-details-backdrop" hidden={!detailsOpen} onClick={hideDetailsPanels} />
      <DetailsDrawerBar />
      <LibraryHeader />
      <ModelDetailsPanel />
      <DetailsPlaceholder />
      {isOverlayPage(page) && (
        <main className="jp-page" id="jp-content" aria-label={PAGE_TITLES[page]} tabIndex={-1}>
          {user && !allowed && <NotAllowed />}
          {allowed && page === 'home' && <HomePage />}
          {allowed && page === 'stats' && <StatsPage />}
          {allowed && page === 'collections' && <CollectionsPage section={section} />}
          {allowed && page === 'queue' && <QueuePage />}
          {allowed && page === 'printers' && <PrintersPage section={section} />}
          {allowed && page === 'tags' && <TagsPage />}
          {allowed && page === 'duplicates' && <DuplicatesPage />}
          {allowed && page === 'organize' && <OrganizePage />}
          {allowed && page === 'settings' && <SettingsPage section={section} />}
          {allowed && page === 'help' && <HelpPage />}
        </main>
      )}
    </div>,
    // Inside the React root, so screens moved into the shell (settings/EmbeddedDialog.tsx) keep their events.
    document.getElementById('react-root') ?? document.body
  );
}
