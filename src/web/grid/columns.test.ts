import { describe, expect, it } from 'vitest';
import { COLUMNS, defaultLayout, mergeLayout, normalizeOrder, reorder } from './columns';

describe('list view columns', () => {
  it('starts with every column shown at its default width', () => {
    const layout = defaultLayout();
    expect(layout.order).toEqual(COLUMNS.map((c) => c.id));
    expect(Object.values(layout.visibility).every(Boolean)).toBe(true);
    expect(layout.widths.name).toBe(140);
  });

  it('keeps a saved order of known ids, then adds any it lacks', () => {
    expect(normalizeOrder(['tags', 'bogus', 'name', 'tags']).slice(0, 3)).toEqual(['tags', 'name', 'size']);
    expect(normalizeOrder(null)).toHaveLength(COLUMNS.length);
  });

  it('merges a saved layout, clamping widths and ignoring bad values', () => {
    const merged = mergeLayout({ visibility: { size: false, name: 'no' }, widths: { name: 5000, tags: 'wide', size: 60.4 }, order: ['size'] });
    expect(merged.visibility.size).toBe(false);
    expect(merged.visibility.name).toBe(true);
    expect(merged.widths.name).toBe(800);
    expect(merged.widths.tags).toBe(180);
    expect(merged.widths.size).toBe(60);
    expect(merged.order[0]).toBe('size');
    expect(mergeLayout('garbage')).toEqual(defaultLayout());
  });

  it('widens the old 100 px Print Status default from layouts saved without an order', () => {
    expect(mergeLayout({ widths: { printed: 100 } }).widths.printed).toBe(130);
    expect(mergeLayout({ widths: { printed: 100 }, order: [] }).widths.printed).toBe(100);
  });

  it('moves a column before or after another, or reports no change', () => {
    const order = defaultLayout().order;
    expect(reorder(order, 'tags', 'name', 'before')?.slice(0, 2)).toEqual(['tags', 'name']);
    expect(reorder(order, 'name', 'size', 'after')?.slice(0, 2)).toEqual(['size', 'name']);
    expect(reorder(order, 'name', 'size', 'before')).toBeNull();
    expect(reorder(order, 'name', 'name', 'after')).toBeNull();
  });
});
