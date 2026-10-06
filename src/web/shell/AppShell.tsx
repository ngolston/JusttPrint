import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Box, ChevronDown, CircleUserRound } from 'lucide-react';
import { LIBRARY_CHANGED, library, type LibraryCounts, type LibraryStorage } from '../api';
import { Menu } from '../components/Menu';
import { cx } from '../components/Button';
import { ProgressBar } from '../components/Panel';
import { SearchBox, shortcutLabel } from '../components/SearchBox';
import { filterActions } from '../filters/store';
import { onServerEvent } from '../page';
import { HelpPage } from '../pages/HelpPage';
import { HomePage } from '../pages/HomePage';
import { SettingsPage } from '../pages/SettingsPage';
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

/**
 * Data that follows the library: loaded once, then again (at most once a second) after the server
 * announces a change (refresh-grid, from any browser) or this page changes something.
 */
function useLibraryData<T>(load: () => Promise<T>): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetchNow = () => { load().then((value) => { if (alive) setData(value); }, () => {}); };
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fetchNow, 1000);
    };
    fetchNow();
    const off = onServerEvent('refresh-grid', refresh);
    window.addEventListener(LIBRARY_CHANGED, refresh);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
      window.removeEventListener(LIBRARY_CHANGED, refresh);
    };
  }, [load]);
  return data;
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
    filterActions.search('all', query);
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

const isThumbnailWorker = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1';

const PAGE_TITLES: Record<PageId, string> = { home: 'Home', library: 'Library', settings: 'Settings', help: 'Help' };

/**
 * The JusttPrint 5 frame (spec §5): sidebar, top bar, and the page area. The library is still the
 * old grid and sidebar, shifted right of the shell by src/web/styles/legacy-bridge.css; other
 * pages cover it. Phones keep the old phone layout until Phase 12.
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
    document.title = page === 'library' ? 'JusttPrint' : `${PAGE_TITLES[page]} · JusttPrint`;
  }, [page]);

  // Phones keep the old phone layout (Phase 12); the server's hidden thumbnail page has no UI.
  if (mobile || isThumbnailWorker) return null;
  return createPortal(
    <div className="jp jp-shell">
      <Sidebar page={page} />
      <TopBar />
      {page !== 'library' && (
        <main className="jp-page" aria-label={PAGE_TITLES[page]}>
          {page === 'home' && <HomePage />}
          {page === 'settings' && <SettingsPage section={section} />}
          {page === 'help' && <HelpPage />}
        </main>
      )}
    </div>,
    document.body
  );
}
