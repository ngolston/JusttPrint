import { describe, expect, it } from 'vitest';
import { arrangeTags } from './TagsPage';
import { mergeTarget } from '../tags/manage';

const tags = [
  { id: 1, name: 'Workshop', model_count: 3 },
  { id: 2, name: 'gridfinity', model_count: 12 },
  { id: 3, name: 'Benchy', model_count: 0 },
  { id: 4, name: 'Tools', model_count: 3 }
];

describe('Tags page', () => {
  it('orders by use (ties A–Z) or by name, searches and shows unused ones', () => {
    expect(arrangeTags(tags, '', 'count', false).map((t) => t.name)).toEqual(['gridfinity', 'Tools', 'Workshop', 'Benchy']);
    expect(arrangeTags(tags, '', 'name', false).map((t) => t.name)).toEqual(['Benchy', 'gridfinity', 'Tools', 'Workshop']);
    expect(arrangeTags(tags, 'O', 'name', false).map((t) => t.name)).toEqual(['Tools', 'Workshop']);
    expect(arrangeTags(tags, '', 'count', true).map((t) => t.name)).toEqual(['Benchy']);
  });

  it('finds the tag a rename would merge into, ignoring case', () => {
    expect(mergeTarget(tags, tags[0], ' TOOLS ')?.id).toBe(4);
    expect(mergeTarget(tags, tags[0], 'workshop')).toBeUndefined();
    expect(mergeTarget(tags, tags[0], 'New')).toBeUndefined();
  });
});
