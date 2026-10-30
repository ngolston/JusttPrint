/**
 * Figures on the Filament page: weights, drying time left, and the spool filters.
 */
import type { Spool } from '../api';

/** Under this many grams a spool is running low (src/core/spools.js LOW_GRAMS, the ring's light coral). */
export const LOW_GRAMS = 300;

/** 640 → "640 g", 18600 → "18.6 kg", 1000 → "1 kg". */
export function formatWeight(grams: number | null | undefined): string {
  const g = Math.max(0, Math.round(Number(grams) || 0));
  if (g < 1000) return `${g} g`;
  const kg = Math.round(g / 100) / 10;
  return `${kg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
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
