import { describe, expect, it } from 'vitest';
import { calendarLevel, calendarStreaks, calendarWeeks, type CalendarDay } from './PrintCalendar';

const day = (key: string, printed = 0, failed = 0): CalendarDay => ({ day: key, printed, failed });

describe('print calendar', () => {
  it('puts days in Monday-first weeks, with blanks before the first day', () => {
    // 2026-10-15 is a Thursday.
    const weeks = calendarWeeks([day('2026-10-15'), day('2026-10-16'), day('2026-10-17'), day('2026-10-18'), day('2026-10-19')]);
    expect(weeks).toHaveLength(2);
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]?.day).toBe('2026-10-15');
    expect(weeks[1][0]?.day).toBe('2026-10-19');
  });
  it('shades days 0 to 4 against the busiest one', () => {
    expect(calendarLevel(0, 8)).toBe(0);
    expect(calendarLevel(1, 8)).toBe(1);
    expect(calendarLevel(8, 8)).toBe(4);
    expect(calendarLevel(3, 0)).toBe(0);
  });
  it('counts the longest streak and the one up to today or yesterday', () => {
    const days = [day('a', 1), day('b', 1), day('c', 0, 1), day('d'), day('e', 2), day('f', 1), day('g')];
    expect(calendarStreaks(days)).toEqual({ longest: 3, current: 2 });
    expect(calendarStreaks([day('a', 1), day('b'), day('c')]).current).toBe(0);
  });
});
