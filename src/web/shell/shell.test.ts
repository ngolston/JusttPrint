import { describe, expect, it } from 'vitest';
import { layoutFor, type Screen } from './layout';
import { MENU, findMenuAction, tidySeparators, type MenuItem } from './menu';

const screen = (over: Partial<Screen>): Screen => ({
  phone: false, narrow: false, wide: false, coarse: false, landscape: false, mobileAgent: false, ...over
});

describe('phone layout rule', () => {
  it('uses the phone layout at phone width, whatever the device', () => {
    expect(layoutFor(screen({ phone: true, narrow: true })).mobile).toBe(true);
  });

  it('uses it on a narrow mobile browser, not a narrow desktop window', () => {
    expect(layoutFor(screen({ narrow: true, wide: true, mobileAgent: true })).mobile).toBe(true);
    expect(layoutFor(screen({ narrow: true, wide: true })).mobile).toBe(false);
  });

  it('uses the wide variant on a tablet-sized touch screen', () => {
    expect(layoutFor(screen({ wide: true, coarse: true }))).toEqual({ mobile: true, wide: true, landscape: false });
    expect(layoutFor(screen({}))).toEqual({ mobile: false, wide: false, landscape: false });
  });
});

describe('menu', () => {
  it('has Tools, Settings and Help, with no empty labels', () => {
    expect(MENU.map((group) => group.label)).toEqual(['Tools', 'Settings', 'Help']);
    const labels = MENU.flatMap((group) => group.items).flatMap((item) => (item.kind === 'submenu' ? item.items : [item]))
      .filter((item) => item.kind === 'action').map((item) => (item as { label: string }).label);
    expect(labels.every(Boolean)).toBe(true);
    expect(new Set(labels.filter((l) => l !== 'Settings')).size).toBe(labels.filter((l) => l !== 'Settings').length);
  });

  it('finds actions by label, including in submenus', () => {
    expect(findMenuAction('Library Stats')).toBeTypeOf('function');
    expect(findMenuAction('HTTPS / SSL')).toBeTypeOf('function');
    expect(findMenuAction('Nope')).toBeNull();
    expect(findMenuAction('Browser Extension')).toBeNull();
  });

  it('drops leading, trailing and doubled separators', () => {
    const sep: MenuItem = { kind: 'separator' };
    const a: MenuItem = { kind: 'action', label: 'a', run: () => {} };
    const b: MenuItem = { kind: 'action', label: 'b', run: () => {} };
    expect(tidySeparators([sep, a, sep, sep, b, sep])).toEqual([a, sep, b]);
    expect(tidySeparators([sep, sep])).toEqual([]);
  });
});
