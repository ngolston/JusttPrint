import { describe, expect, it } from 'vitest';
import {
  addItem,
  defaultLayout,
  dropOn,
  hiddenWidgets,
  HOME_WIDGETS,
  moveItem,
  parseLayout,
  removeItem,
  serializeLayout,
  spanOf,
  updateItem
} from './homeLayout';

const ids = (layout: { items: { id: string }[] }) => layout.items.map((item) => item.id);

describe('Home layout', () => {
  it('starts with the widgets shown by default, in order, at their first size', () => {
    const layout = defaultLayout();
    expect(ids(layout)).toEqual(HOME_WIDGETS.filter((w) => w.shown).map((w) => w.id));
    expect(layout.items[0]).toEqual({ id: 'library', size: '2x2' });
    expect(ids(layout)).not.toContain('color-wall');
  });

  it('reads back what it saved', () => {
    const layout = updateItem(moveItem(defaultLayout(), 0, 3), 'camera', { size: '4x2', printerId: 7 });
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
  });

  it('drops unknown and repeated widgets, resets sizes a widget cannot have, and starts over on junk', () => {
    const parsed = parseLayout(
      JSON.stringify({
        items: [{ id: 'gone' }, { id: 'month', size: '4x2' }, { id: 'month', size: '2x1' }, { id: 'camera', size: '1x1', printerId: 'x' }],
        known: HOME_WIDGETS.map((w) => w.id)
      })
    );
    expect(parsed.items).toEqual([
      { id: 'month', size: '1x1' },
      { id: 'camera', size: '1x1' }
    ]);
    expect(parseLayout('not json')).toEqual(defaultLayout());
    expect(parseLayout(null)).toEqual(defaultLayout());
  });

  it('adds a widget new in JusttPrint (shown by default) to a saved layout, once', () => {
    const known = HOME_WIDGETS.map((w) => w.id).filter((id) => id !== 'duplicates' && id !== 'color-wall');
    const parsed = parseLayout(JSON.stringify({ items: [{ id: 'month', size: '1x1' }], known }));
    expect(ids(parsed)).toEqual(['month', 'duplicates']);
    // Removed later, it stays removed.
    expect(ids(parseLayout(serializeLayout(removeItem(parsed, 'duplicates'))))).toEqual(['month']);
  });

  it('moves, drops, adds and removes', () => {
    const start = { items: ['a', 'b', 'c', 'd'].map((id) => ({ id, size: '1x1' as const })), known: [] };
    expect(ids(moveItem(start, 0, 2))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(moveItem(start, 3, 0))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(dropOn(start, 'a', 'c'))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(dropOn(start, 'd', 'b'))).toEqual(['a', 'd', 'b', 'c']);
    const layout = removeItem(defaultLayout(), 'month');
    expect(hiddenWidgets(layout).map((w) => w.id)).toContain('month');
    expect(ids(addItem(layout, 'month')).at(-1)).toBe('month');
    expect(addItem(defaultLayout(), 'month')).toEqual(defaultLayout());
  });

  it('gives the grid span of a size', () => {
    expect(spanOf('2x1')).toEqual([2, 1]);
    expect(spanOf('4x2')).toEqual([4, 2]);
  });
});
