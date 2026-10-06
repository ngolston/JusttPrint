/** Words for the dashboard: the greeting and "2 hours ago". */

/** "Good morning" (5-11), "Good afternoon" (12-17), "Good evening" (otherwise). No name: there are no user accounts. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600], ['month', 30 * 24 * 3600], ['week', 7 * 24 * 3600],
  ['day', 24 * 3600], ['hour', 3600], ['minute', 60]
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago"; '' for a bad date. */
export function timeAgo(value: string | number | Date | null | undefined, now: number = Date.now(), locale?: string): string {
  if (value == null || value === '') return '';
  const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 60) return 'just now';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}
