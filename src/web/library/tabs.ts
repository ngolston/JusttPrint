/**
 * The library's state tabs (spec §15): All Models, Printed, Unprinted, Queue and Favorites. Each
 * tab is a pair of the print status and favorite filters, so the tabs, the Filter popover and
 * the filter chips always agree.
 */
import type { FilterState } from '../filters/query';
import { CheckCircle2, CircleDashed, Clock, Heart, LayoutGrid, type LucideIcon } from 'lucide-react';

export type LibraryTab = 'all' | 'printed' | 'unprinted' | 'queue' | 'favorites';

export interface LibraryTabInfo {
  id: LibraryTab;
  label: string;
  icon: LucideIcon;
  /** The print status filter value ('all' for none). */
  printed: string;
  /** The favorite filter value ('all' for none). */
  favorite: string;
}

export const LIBRARY_TABS: LibraryTabInfo[] = [
  { id: 'all', label: 'All Models', icon: LayoutGrid, printed: 'all', favorite: 'all' },
  { id: 'printed', label: 'Printed', icon: CheckCircle2, printed: 'printed', favorite: 'all' },
  { id: 'unprinted', label: 'Unprinted', icon: CircleDashed, printed: 'unprinted', favorite: 'all' },
  // Queued and Printing, like the Queue badge in the sidebar.
  { id: 'queue', label: 'Queue', icon: Clock, printed: 'in-queue', favorite: 'all' },
  { id: 'favorites', label: 'Favorites', icon: Heart, printed: 'all', favorite: 'favorited' }
];

/** The tab that matches the filters, or null when they match none (e.g. print status "Failed"). */
export function tabOf(filters: { printed: string; favorite: string }): LibraryTab | null {
  const printed = filters.printed || 'all';
  const favorite = filters.favorite || 'all';
  return LIBRARY_TABS.find((tab) => tab.printed === printed && tab.favorite === favorite)?.id ?? null;
}

export function tabInfo(id: LibraryTab): LibraryTabInfo {
  return LIBRARY_TABS.find((tab) => tab.id === id) ?? LIBRARY_TABS[0];
}

/**
 * How many filters are set besides the tab (and the folder, which has its own control): the
 * number on the Filter button.
 */
export function extraFilterCount(state: FilterState): number {
  let count = state.designer.length + state.license.length + state.parentModel.length + state.tags.length;
  if (state.fileType) count += 1;
  for (const key of ['isNew', 'rating', 'ratingMin'] as const) if (state[key] && state[key] !== 'all') count += 1;
  if (!tabOf(state)) count += (state.printed !== 'all' ? 1 : 0) + (state.favorite !== 'all' ? 1 : 0);
  count += state.tokens.filter((token) => (token.t === 'clause' && token.value.trim()) || token.t === 'filter' || token.t === 'filterMulti').length;
  return count;
}
