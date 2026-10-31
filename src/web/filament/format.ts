/**
 * Figures on the Filament page: weights, drying time left, and the spool filters.
 */
import type { Spool, SpoolForecast } from '../api';
import { formatDay, formatWeightIn } from '../units';

/** Under this many grams a spool is running low (src/core/spools.js LOW_GRAMS, the ring's light coral). */
export const LOW_GRAMS = 300;

/** 640 → "640 g", 18600 → "18.6 kg", 1000 → "1 kg"; in the library's weight unit (units.ts). */
export function formatWeight(grams: number | null | undefined): string {
  return formatWeightIn(grams);
}

/** How far a drying session is: the share of its time gone (0 to 1) and milliseconds left. */
export function dryingProgress(startedAt: string, targetHours: number | null, now = Date.now()) {
  const start = Date.parse(startedAt);
  const total = (Number(targetHours) || 0) * 3600_000;
  if (!Number.isFinite(start) || total <= 0) return { share: 0, leftMs: 0 };
  const gone = Math.max(0, now - start);
  return { share: Math.min(1, gone / total), leftMs: Math.max(0, total - gone) };
}

/** 7_440_000 → "2 h 4 min left"; 0 → "Done". */
export function formatTimeLeft(ms: number): string {
  if (ms <= 0) return 'Done';
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [h ? `${h} h` : '', m || !h ? `${m} min` : ''].filter(Boolean);
  return `${parts.join(' ')} left`;
}

export type SpoolFilter = 'all' | 'low' | 'drying' | 'archived' | `material:${string}`;

/** Does a spool show under a filter? Archived spools show only under Archived. */
export function matchesFilter(spool: Spool, filter: SpoolFilter): boolean {
  if (filter === 'archived') return spool.status === 'archived';
  if (spool.status === 'archived') return false;
  if (filter === 'low') return spool.remaining < LOW_GRAMS;
  if (filter === 'drying') return !!spool.drying;
  if (filter.startsWith('material:')) return spool.material.toLowerCase() === filter.slice(9).toLowerCase();
  return true;
}

/** Does a spool match the search words (name, brand, material, color, place)? */
export function matchesSearch(spool: Spool, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [
    spool.display_name,
    spool.brand_name,
    spool.material,
    spool.material_type,
    spool.color_name,
    spool.location_name,
    ...spool.loaded.map((p) => p.label)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Where a spool is, in a few words: loaded in a printer, its place, drying, or archived. */
export function spoolWhere(spool: Spool): string {
  if (spool.status === 'archived') return 'Archived';
  if (spool.drying) return 'Drying';
  if (spool.loaded.length) return spool.loaded.map((place) => place.label).join(', ');
  return spool.location_name || 'No place';
}

/** A number field's text as a number, or null when empty. */
export function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** The currencies Filament settings offers (ISO 4217). */
export const CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'JPY',
  'CNY',
  'INR',
  'BRL',
  'MXN',
  'ZAR'
] as const;

/** "$18.80", "18,80 €": an amount in the library's currency, in the browser's locale. */
export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  const value = Number(amount) || 0;
  try {
    return value.toLocaleString(undefined, { style: 'currency', currency });
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

// ---- The spool list: sorting and saved views (docs/plan-10.1.md, Phase 4) ----

export type SpoolSortKey = 'default' | 'name' | 'material' | 'color' | 'remaining' | 'pct' | 'place' | 'price' | 'lastUsed';
export interface SpoolSort {
  key: SpoolSortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_SORT: SpoolSort = { key: 'default', dir: 'asc' };
export const SORT_LABELS: Record<SpoolSortKey, string> = {
  default: 'In use first, fullest first',
  name: 'Name',
  material: 'Material',
  color: 'Color',
  remaining: 'Grams left',
  pct: 'Percent left',
  place: 'Where',
  price: 'Price',
  lastUsed: 'Last used'
};

/** A color's hue (0–360), then lightness, so a sort by color runs through the rainbow; grays last. */
function colorKey(hex: string | null): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 1e6;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  if (max - min < 0.08) return 1000 + light;
  let hue = 0;
  if (max === r) hue = ((g - b) / (max - min)) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  return ((hue * 60 + 360) % 360) + light / 10;
}

const pctOf = (spool: Spool) => (spool.initial_weight > 0 ? spool.remaining / spool.initial_weight : 0);

/** The value a spool sorts by; null sorts last either way. */
function sortValue(spool: Spool, key: SpoolSortKey): string | number | null {
  switch (key) {
    case 'name':
      return spool.display_name.toLowerCase();
    case 'material':
      return `${spool.material} ${spool.material_type || ''}`.toLowerCase();
    case 'color':
      return spool.color_hex ? colorKey(spool.color_hex) : null;
    case 'remaining':
      return spool.remaining;
    case 'pct':
      return pctOf(spool);
    case 'place':
      return spoolWhere(spool).toLowerCase();
    case 'price':
      return spool.purchase_price;
    case 'lastUsed':
      return spool.last_used_at;
    default:
      return null;
  }
}

/** The spools in the chosen order (a copy); `default` keeps the server's (in use first, fullest first). */
export function sortSpools(spools: Spool[], sort: SpoolSort): Spool[] {
  if (sort.key === 'default') return spools.slice();
  const factor = sort.dir === 'desc' ? -1 : 1;
  return spools
    .map((spool, index) => ({ spool, index, value: sortValue(spool, sort.key) }))
    .sort((a, b) => {
      if (a.value === null || a.value === undefined) return b.value === null || b.value === undefined ? a.index - b.index : 1;
      if (b.value === null || b.value === undefined) return -1;
      const order = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : String(a.value).localeCompare(String(b.value));
      return order * factor || a.index - b.index;
    })
    .map((item) => item.spool);
}

export type SpoolLayout = 'cards' | 'table';

/** A saved view: a name for a filter, a search, an order and a layout, kept per person. */
export interface SpoolView {
  name: string;
  filter: SpoolFilter;
  search: string;
  sort: SpoolSort;
  layout: SpoolLayout;
}

export const MAX_VIEWS = 20;

/** The saved views from the spoolViews setting; anything malformed is left out. */
export function parseViews(raw: string | null | undefined): SpoolView[] {
  let list: unknown;
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const keys = Object.keys(SORT_LABELS);
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const sort = (item.sort || {}) as Record<string, unknown>;
      const filter = String(item.filter || 'all');
      return {
        name: String(item.name || '')
          .trim()
          .slice(0, 60),
        filter: (/^(all|low|drying|archived|material:.+)$/.test(filter) ? filter : 'all') as SpoolFilter,
        search: String(item.search || '').slice(0, 200),
        sort: { key: (keys.includes(String(sort.key)) ? sort.key : 'default') as SpoolSortKey, dir: sort.dir === 'desc' ? 'desc' : 'asc' },
        layout: item.layout === 'table' ? 'table' : 'cards'
      } satisfies SpoolView;
    })
    .filter((view) => view.name)
    .slice(0, MAX_VIEWS);
}

/** "Runs out in about 5 days (Nov 5) at 12 g a day", or "" with no forecast (docs/plan-10.1.md, Phase 7). */
export function runsOutText(forecast: SpoolForecast | null | undefined): string {
  if (!forecast) return '';
  const days = Math.round(forecast.daysLeft);
  const when = days < 1 ? 'Runs out today' : days === 1 ? 'Runs out in about a day' : `Runs out in about ${days} days`;
  const rate = forecast.perDay < 1 ? `under ${formatWeight(1)}` : formatWeight(forecast.perDay);
  return `${when} (${formatDay(`${forecast.runsOut}T12:00:00`)}) at ${rate} a day`;
}

/** "5 days", "today": how soon, short (the reorder list, Home). */
export function runsOutShort(forecast: SpoolForecast | null | undefined): string {
  if (!forecast) return '';
  const days = Math.round(forecast.daysLeft);
  return days < 1 ? 'today' : days === 1 ? '1 day' : `${days} days`;
}

/** The cost of a print by hand: grams at a price per kg, plus hours at a printer's watts (Phase 8). */
export function printCostOf(input: { grams: number; perKg: number; hours: number; watts: number; perKWh: number }) {
  const filamentCost = (Math.max(0, input.grams) / 1000) * Math.max(0, input.perKg);
  const electricityCost = ((Math.max(0, input.hours) * Math.max(0, input.watts)) / 1000) * Math.max(0, input.perKWh);
  return { filamentCost, electricityCost, total: filamentCost + electricityCost };
}
