import { describe, expect, it } from 'vitest';
import { greeting, timeAgo } from './format';

describe('dashboard words', () => {
  it('greets by the time of day', () => {
    expect([4, 5, 11, 12, 17, 18, 23].map(greeting)).toEqual([
      'Good evening', 'Good morning', 'Good morning', 'Good afternoon', 'Good afternoon', 'Good evening', 'Good evening'
    ]);
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(timeAgo('2026-10-06T11:59:30Z', now, 'en')).toBe('just now');
    expect(timeAgo('2026-10-06T11:55:00Z', now, 'en')).toBe('5 minutes ago');
    expect(timeAgo('2026-10-06T10:00:00Z', now, 'en')).toBe('2 hours ago');
    expect(timeAgo('2026-10-05T12:00:00Z', now, 'en')).toBe('yesterday');
    expect(timeAgo('2026-09-15T12:00:00Z', now, 'en')).toBe('3 weeks ago');
    expect(timeAgo('not a date', now, 'en')).toBe('');
    expect(timeAgo(null, now, 'en')).toBe('');
  });
});
