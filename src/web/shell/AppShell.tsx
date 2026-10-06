import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Box, ChevronDown, CircleUserRound, MousePointerClick } from 'lucide-react';
import { LIBRARY_CHANGED, library, type LibraryCounts, type LibraryStorage } from '../api';
import { Menu } from '../components/Menu';
import { cx } from '../components/Button';
import { EmptyState, ProgressBar } from '../components/Panel';
import { SearchBox, shortcutLabel } from '../components/SearchBox';
import { ModelDetailsPanel } from '../details/ModelDetailsPanel';
import { detailsAreOpen, useDetailsVisibility } from '../details/visibility';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { onServerEvent } from '../page';
import { HelpPage } from '../pages/HelpPage';
import { LibraryHeader } from '../pages/LibraryPage';
import { PrintersPage } from '../pages/PrintersPage';
import { QueuePage } from '../pages/QueuePage';
import { SettingsPage } from '../pages/SettingsPage';
import { useAdopt } from './adopt';
import { useLibraryData } from './libraryData';
import { useLayout } from './layout';
import { ACCOUNT, NAV, type NavItem } from './nav';
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
        onClick={() => (item.page ? navigate(item.page) : item.run?.())}>
        <Icon size={18} aria-hidden="true" />
        <span className="jp-nav__label">{item.label}</span>
        {badge ? <span className="jp-nav__badge" aria-label={`${badge} in the queue`}>{badge}</span> : null}
      </button>
    </li>
  );
}

function Sidebar({ page }: { page: PageId }) {
  const counts = useLibraryData<LibraryCounts>(library.counts);
  const queue = counts ? counts.queued + counts.printing : 0;
  // Scan and thumbnail job progress (src/web/scan/Progress.tsx), above Library Storage.
  const [jobs, setJobs] = useState<HTMLDivElement | null>(null);
  useAdopt('#sidebar-progress-slot', jobs);
  return (
    <nav className="jp-sidebar" aria-label="Main">
      <button type="button" className="jp-brand" onClick={() => navigate('home')} aria-label="JusttPrint home">
        <span className="jp-brand__logo"><Box size={22} aria-hidden="true" /></span>
        <span className="jp-brand__text">
          <span className="jp-brand__name">JusttPrint</span>
          <span className="jp-brand__tagline">Your 3D Printing Library</span>
        </span>
      </button>
      <div className="jp-nav">
        {NAV.map((section, index) => (
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

function TopBar() {
  const input = useRef<HTMLInputElement>(null);
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
      <SearchBox ref={input} className="jp-topbar__search" label="Search the library" value={text}
        placeholder="Search models, designers, tags, or anything..." shortcut={shortcutLabel(navigator.platform)}
        onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
      <div className="jp-topbar__actions">
        <Menu label="Account" items={ACCOUNT.map((item) => ({ id: item.id, label: item.label, icon: item.icon, onSelect: item.run }))}
          trigger={(props) => (
            <button type="button" className="jp-account" aria-label="Account" title="Account" {...props}>
              <CircleUserRound size={26} aria-hidden="true" />
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          )} />
      </div>
    </header>
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

const isThumbnailWorker = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1';

const PAGE_TITLES: Record<PageId, string> = { home: 'Home', library: 'Library', queue: 'Print Queue', printers: 'Printers', settings: 'Settings', help: 'Help' };
/** Pages drawn over the library; Home and Library are the library screen (Home adds the dashboard on top). */
const isOverlayPage = (page: PageId) => page !== 'home' && page !== 'library';

/**
 * The JusttPrint 5 frame (spec §5): sidebar, top bar, and the page area. The library page is the
 * grid (src/web/grid/) under its header (pages/LibraryPage.tsx), with the old sidebar's details
 * panels as the right column, placed by src/web/styles/legacy-bridge.css; other pages cover it.
 * Phones keep the old phone layout until Phase 12.
 */
export function AppShell() {
  const { mobile } = useLayout();
  const { page, section } = useRoute();

  useEffect(() => {
    if (isThumbnailWorker) return undefined;
    document.body.classList.toggle('jp-shell-on', !mobile);
    return () => document.body.classList.remove('jp-shell-on');
  }, [mobile]);

  useEffect(() => {
    document.title = page === 'home' ? 'JusttPrint' : `${PAGE_TITLES[page]} · JusttPrint`;
  }, [page]);

  // Phones keep the old phone layout (Phase 12); the server's hidden thumbnail page has no UI.
  if (mobile || isThumbnailWorker) return null;
  return createPortal(
    <div className="jp jp-shell">
      <Sidebar page={page} />
      <TopBar />
      <LibraryHeader />
      <ModelDetailsPanel />
      <DetailsPlaceholder />
      {isOverlayPage(page) && (
        <main className="jp-page" aria-label={PAGE_TITLES[page]}>
          {page === 'queue' && <QueuePage />}
          {page === 'printers' && <PrintersPage section={section} />}
          {page === 'settings' && <SettingsPage section={section} />}
          {page === 'help' && <HelpPage />}
        </main>
      )}
    </div>,
    document.body
  );
}
