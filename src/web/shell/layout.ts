/**
 * When the page uses the phone layout (body.mobile-ui), and which sheet it shows.
 */
import { useSyncExternalStore } from 'react';

export const PHONE = '(max-width: 700px)';
export const NARROW = '(max-width: 900px)';
export const WIDE = '(min-width: 701px) and (max-width: 1100px)';
const QUERIES = [PHONE, NARROW, WIDE, '(pointer: coarse)', '(orientation: landscape)'];

export interface Screen {
  phone: boolean;
  narrow: boolean;
  wide: boolean;
  coarse: boolean;
  landscape: boolean;
  /** The user agent says phone or tablet. */
  mobileAgent: boolean;
}

export interface Layout {
  mobile: boolean;
  /** The phone layout on a tablet-sized screen. */
  wide: boolean;
  landscape: boolean;
}

/** Phone width; a narrow window on a mobile browser; or a tablet-sized touch screen. */
export function layoutFor(screen: Screen): Layout {
  const touch = screen.coarse || screen.mobileAgent;
  const mobile = screen.phone || (screen.mobileAgent && screen.narrow) || (screen.wide && touch);
  return { mobile, wide: mobile && screen.wide, landscape: screen.landscape };
}

function readScreen(): Screen {
  const match = (query: string) => window.matchMedia(query).matches;
  return {
    phone: match(PHONE),
    narrow: match(NARROW),
    wide: match(WIDE),
    coarse: match('(pointer: coarse)'),
    landscape: match('(orientation: landscape)'),
    mobileAgent: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent || '')
  };
}

let layout: Layout | null = null;
function currentLayout(): Layout {
  const next = layoutFor(readScreen());
  if (!layout || layout.mobile !== next.mobile || layout.wide !== next.wide || layout.landscape !== next.landscape) layout = next;
  return layout;
}

function subscribeLayout(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  const lists = QUERIES.map((query) => window.matchMedia(query));
  lists.forEach((list) => list.addEventListener('change', listener));
  return () => {
    window.removeEventListener('resize', listener);
    lists.forEach((list) => list.removeEventListener('change', listener));
  };
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, currentLayout);
}
