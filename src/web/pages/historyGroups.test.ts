import { describe, expect, it } from 'vitest';
import { groupEntries, type HistoryEntry } from './HistoryPage';

const model = (filePath: string) => ({ id: 1, filePath, fileName: null });
const change = (id: number, at: string, filePath = '/m/a.stl', by: string | null = 'admin'): HistoryEntry => ({
  kind: 'change',
  id,
  at,
  by,
  field: 'rating',
  oldValue: null,
  newValue: '2',
  model: model(filePath)
});

describe('History groups', () => {
  it('makes changes to one model by one person within a minute one entry', () => {
    const items = groupEntries([change(3, '2026-10-24T07:00:30Z'), change(2, '2026-10-24T07:00:10Z'), change(1, '2026-10-24T06:00:00Z')]);
    expect(items.map((item) => (item.kind === 'group' ? item.entries.map((e) => e.id) : item.entry.id))).toEqual([[3, 2], 1]);
  });
  it('keeps changes to other models, by others, or later apart', () => {
    const items = groupEntries([
      change(3, '2026-10-24T07:00:00Z'),
      change(2, '2026-10-24T07:00:00Z', '/m/b.stl'),
      change(1, '2026-10-24T07:00:00Z', '/m/b.stl', 'sam')
    ]);
    expect(items.every((item) => item.kind === 'one')).toBe(true);
  });
});
