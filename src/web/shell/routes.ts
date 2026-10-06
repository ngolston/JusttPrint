/**
 * Pages of the JusttPrint 5 shell, addressed by the URL hash (#/library, #/settings/ai, ...), so
 * back, forward and reload keep the page. Unknown hashes (and #/design-system, the component
 * gallery) show Home.
 */
import { useSyncExternalStore } from 'react';

export const PAGES = ['home', 'library', 'settings', 'help'] as const;
export type PageId = (typeof PAGES)[number];

export interface Route {
  page: PageId;
  /** A part of the page, e.g. the settings group (#/settings/ai). */
  section: string;
}

/** The app opens on Home: the dashboard above the library. */
export const DEFAULT_PAGE: PageId = 'home';

export function parseRoute(hash: string): Route {
  const [page = '', section = ''] = String(hash || '').replace(/^#\/?/, '').split('/');
  return (PAGES as readonly string[]).includes(page)
    ? { page: page as PageId, section: decodeURIComponent(section) }
    : { page: DEFAULT_PAGE, section: '' };
}

export function formatRoute(page: PageId, section = ''): string {
  return `#/${page}${section ? `/${encodeURIComponent(section)}` : ''}`;
}

export function navigate(page: PageId, section = '') {
  const hash = formatRoute(page, section);
  if (window.location.hash !== hash) window.location.hash = hash;
}

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

/** The current page; re-renders when the hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
