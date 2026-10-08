import { describe, expect, it } from 'vitest';
import { shortcutFor, type KeyContext } from './shortcuts';

const press = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) =>
  ({ key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift });
const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({ inInput: false, detailsVisible: false, multiEdit: false, ...over });

describe('shortcutFor', () => {
  it('maps Ctrl and Cmd shortcuts alike', () => {
    expect(shortcutFor(press('S', { ctrl: true, shift: true }), ctx())).toBe('scan');
    expect(shortcutFor(press('s', { meta: true, shift: true }), ctx())).toBe('scan');
    expect(shortcutFor(press('c', { ctrl: true, shift: true }), ctx())).toBe('clearFilters');
    expect(shortcutFor(press('R', { meta: true, shift: true }), ctx())).toBe('roulette');
    expect(shortcutFor(press('e', { ctrl: true }), ctx())).toBe('toggleMultiEdit');
    expect(shortcutFor(press('a', { meta: true }), ctx())).toBe('selectAll');
    expect(shortcutFor(press('z', { meta: true }), ctx())).toBe('undo');
    expect(shortcutFor(press('Z', { ctrl: true, shift: true }), ctx())).toBeNull();
  });

  it('leaves typing alone, except search focus, the help dialog and leaving multi-edit', () => {
    const typing = ctx({ inInput: true, detailsVisible: true });
    expect(shortcutFor(press('a', { ctrl: true }), typing)).toBeNull();
    expect(shortcutFor(press('j'), typing)).toBeNull();
    // Ctrl/Cmd+Z in a text field is the browser's own undo.
    expect(shortcutFor(press('z', { ctrl: true }), typing)).toBeNull();
    expect(shortcutFor(press('/', { ctrl: true }), typing)).toBe('focusSearch');
    expect(shortcutFor(press('?', { meta: true, shift: true }), typing)).toBe('showShortcuts');
    expect(shortcutFor(press('Escape'), ctx({ inInput: true, multiEdit: true }))).toBe('exitMultiEdit');
  });

  it('moves between models only while the details panel shows', () => {
    expect(shortcutFor(press('ArrowDown'), ctx({ detailsVisible: true }))).toBe('next');
    expect(shortcutFor(press('K'), ctx({ detailsVisible: true }))).toBe('previous');
    expect(shortcutFor(press('ArrowDown'), ctx())).toBeNull();
    expect(shortcutFor(press('ArrowDown', { meta: true }), ctx({ detailsVisible: true }))).toBeNull();
  });

  it('ignores Escape outside multi-edit and plain letters', () => {
    expect(shortcutFor(press('Escape'), ctx())).toBeNull();
    expect(shortcutFor(press('s'), ctx())).toBeNull();
  });
});
