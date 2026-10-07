import { describe, expect, it } from 'vitest';
import { labelEvery, monthLabel, monthTitle, niceMax, percent, ticks } from './scale';

describe('statistics scales', () => {
  it('rounds the axis top up to a readable number', () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(21)).toBe(25);
    expect(niceMax(260)).toBe(500);
  });

  it('puts gridlines on whole numbers', () => {
    expect(ticks(20)).toEqual([0, 5, 10, 15, 20]);
    expect(ticks(10)).toEqual([0, 5, 10]);
  });

  it('names months, with the year on January and when asked', () => {
    expect(monthLabel('2026-10', false, 'en-US')).toBe('Oct');
    expect(monthLabel('2026-01', false, 'en-US')).toBe('Jan 2026');
    expect(monthLabel('2025-11', true, 'en-US')).toBe('Nov 2025');
    expect(monthTitle('2026-10', 'en-US')).toBe('October 2026');
  });

  it('thins month labels on narrow charts', () => {
    expect(labelEvery(12, 600)).toBe(1);
    expect(labelEvery(24, 300)).toBe(4);
    expect(labelEvery(0, 300)).toBe(1);
  });

  it('formats rates', () => {
    expect(percent(5 / 6)).toBe('83%');
    expect(percent(null)).toBe('–');
  });
});
