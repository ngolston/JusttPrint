/** Number helpers for the Statistics charts (pages/StatsPage.tsx). */

/** A round axis top at or above `max`: 1, 2, 2.5, 5 or 10 times a power of ten (at least 4). */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

/** Gridline values from 0 to `top`, `count` steps (whole numbers only). */
export function ticks(top: number, count = 4): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) {
    const value = (top / count) * i;
    if (Number.isInteger(value)) out.push(value);
  }
  return out;
}

/** "Oct" for "2026-10", with the year ("Jan 2026") on January and on the first month shown. */
export function monthLabel(month: string, withYear = false, locale?: string): string {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, (m || 1) - 1, 1));
  const name = date.toLocaleString(locale, { month: 'short', timeZone: 'UTC' });
  return withYear || m === 1 ? `${name} ${year}` : name;
}

/** "October 2026". */
export function monthTitle(month: string, locale?: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, (m || 1) - 1, 1)).toLocaleString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Show every n-th month label so labels about `minGap` px apart never overlap. */
export function labelEvery(count: number, width: number, minGap = 44): number {
  if (count <= 0 || width <= 0) return 1;
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / minGap))));
}

/** "83%" (no decimals), or an en dash when there is nothing to rate. */
export function percent(rate: number | null): string {
  return rate == null ? '–' : `${Math.round(rate * 100)}%`;
}
