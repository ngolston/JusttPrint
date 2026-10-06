/**
 * Data that follows the library (shell figures, the dashboard).
 */
import { useEffect, useState } from 'react';
import { LIBRARY_CHANGED } from '../api';
import { onServerEvent } from '../page';

/**
 * Data that follows the library: loaded once, then again (at most once a second) after the server
 * announces a change (refresh-grid, from any browser) or this page changes something.
 */
export function useLibraryData<T>(load: () => Promise<T>): T | null {
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

