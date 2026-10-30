import { useEffect, useState } from 'react';
import { settings } from '../api';

/*
 * The library's currency (Settings → Printers → Filament settings), read once per page and
 * again when it is saved. Prices and costs are shown in it; amounts are not converted.
 */

const CHANGED = 'justtprint:currency-changed';
let current: Promise<string> | null = null;

function load(): Promise<string> {
  current ??= settings
    .get<string | null>('currency')
    .then((value) => (value && /^[A-Z]{3}$/.test(value) ? value : 'USD'))
    .catch(() => 'USD');
  return current;
}

/** After saving: every page showing money reads it again. */
export function currencyChanged(value: string) {
  current = Promise.resolve(value);
  window.dispatchEvent(new CustomEvent(CHANGED));
}

export function useCurrency(): string {
  const [code, setCode] = useState('USD');
  useEffect(() => {
    let live = true;
    const read = () => void load().then((value) => live && setCode(value));
    read();
    window.addEventListener(CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, read);
    };
  }, []);
  return code;
}
