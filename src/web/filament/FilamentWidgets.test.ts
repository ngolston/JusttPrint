import { describe, expect, it } from 'vitest';
import type { Spool } from '../api';
import { brandShelf, byHue, colorDistance, guideFor, parseWidgetPrefs, shownWidgets, spoolOfTheDay, WIDGETS } from './FilamentWidgets';

const spool = (over: Partial<Spool> = {}): Spool =>
  ({
    id: 1,
    display_name: 'PLA Basic Black',
    brand_name: 'Bambu Lab',
    material: 'PLA',
    color_hex: '#111111',
    remaining: 640,
    initial_weight: 1000,
    status: 'active',
    last_used_at: null,
    loaded: [],
    drying: null,
    ...over
  }) as Spool;

describe('Filament widgets', () => {
  it('shows every widget at first, keeps the order and hidden ones chosen, and adds new widgets at the end', () => {
    expect(shownWidgets(parseWidgetPrefs(null))).toEqual(WIDGETS.map((w) => w.id));
    const prefs = parseWidgetPrefs(JSON.stringify({ order: ['brand-shelf', 'on-hand', 'gone'], hidden: ['on-hand', 'nope'] }));
    expect(prefs.order.slice(0, 2)).toEqual(['brand-shelf', 'on-hand']);
    expect(prefs.order).toHaveLength(WIDGETS.length);
    expect(shownWidgets(prefs)[0]).toBe('brand-shelf');
    expect(shownWidgets(prefs)).not.toContain('on-hand');
    expect(parseWidgetPrefs('not json').hidden).toEqual([]);
  });

  it('orders colors around the wheel, with greys, blacks and whites after, and finds the closest', () => {
    const red = spool({ id: 1, color_hex: '#d02020' });
    const blue = spool({ id: 2, color_hex: '#2040d0' });
    const green = spool({ id: 3, color_hex: '#20b040' });
    const white = spool({ id: 4, color_hex: '#ffffff' });
    const black = spool({ id: 5, color_hex: '#000000' });
    expect(byHue([white, blue, black, green, red]).map((s) => s.id)).toEqual([1, 3, 2, 5, 4]);
    expect(colorDistance('#d02020', '#c81e1e')).toBeLessThan(colorDistance('#d02020', '#2040d0'));
  });

  it('finds the guide for a material with its kind or grade', () => {
    expect(guideFor('PLA+')?.id).toBe('PLA');
    expect(guideFor('PETG HF')?.id).toBe('PETG');
    expect(guideFor('PA6-CF')?.id).toBe('PA');
    expect(guideFor('PAHT-CF')?.id).toBe('PA');
    expect(guideFor('PC')?.id).toBe('PC');
    expect(guideFor('PCTG')?.id).toBe('PETG');
    expect(guideFor('Wood')).toBeNull();
  });

  it('puts the brands on a shelf by grams, without archived spools or spools with no brand', () => {
    const shelf = brandShelf([
      spool({ id: 1, brand_name: 'eSUN', remaining: 300 }),
      spool({ id: 2, brand_name: 'Bambu Lab', remaining: 800 }),
      spool({ id: 3, brand_name: 'esun', remaining: 400, color_hex: '#ff0000' }),
      spool({ id: 4, brand_name: null }),
      spool({ id: 5, brand_name: 'Gone', status: 'archived' })
    ]);
    expect(shelf.map((b) => [b.name, b.count, b.grams])).toEqual([
      ['Bambu Lab', 1, 800],
      ['eSUN', 2, 700]
    ]);
  });

  it('picks the same idle spool all day, another with Another, and none from empty spools', () => {
    const day = new Date(2026, 10, 3, 9);
    const later = new Date(2026, 10, 3, 21);
    const spools = [
      spool({ id: 1, last_used_at: new Date(2026, 10, 2).toISOString() }),
      spool({ id: 2 }),
      spool({ id: 3, last_used_at: new Date(2026, 5, 1).toISOString() }),
      spool({ id: 4, remaining: 0 })
    ];
    const first = spoolOfTheDay(spools, day);
    expect([2, 3]).toContain(first?.id);
    expect(spoolOfTheDay(spools, later)?.id).toBe(first?.id);
    expect(spoolOfTheDay(spools, day, 1)?.id).not.toBe(first?.id);
    expect(spoolOfTheDay([spool({ remaining: 0 })], day)).toBeNull();
  });
});
