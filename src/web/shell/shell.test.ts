import { describe, expect, it } from 'vitest';
import { MENU, findMenuAction, tidySeparators, type MenuItem } from './menu';

describe('menu', () => {
  it('has Tools, Settings and Help, with no empty labels', () => {
    expect(MENU.map((group) => group.label)).toEqual(['Tools', 'Settings', 'Help']);
    const labels = MENU.flatMap((group) => group.items)
      .flatMap((item) => (item.kind === 'submenu' ? item.items : [item]))
      .filter((item) => item.kind === 'action')
      .map((item) => (item as { label: string }).label);
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
