import { describe, expect, it } from 'vitest';
import { changedFields, listText, nameParts, parseList } from './editModel';

describe('the Edit dialog', () => {
  it('edits the name without its extension', () => {
    expect(nameParts('/l/Voltron/VOLTRON.3mf', 'VOLTRON.3mf')).toEqual({ stem: 'VOLTRON', extension: '.3mf', locked: null });
    expect(nameParts('url::https://makerworld.com/models/1', 'VOLTRON – v1.2')).toEqual({ stem: 'VOLTRON – v1.2', extension: '', locked: null });
    expect(nameParts('/l/kit.zip::legs.stl', 'legs.stl').locked).toMatch(/zip/);
    expect(nameParts('/l/kit.zip', 'kit.zip').locked).toMatch(/Zip files/);
    expect(nameParts('/l/.hidden', null).stem).toBe('.hidden');
  });

  it('reads lists typed with commas', () => {
    expect(parseList(' robot,  lion ,, robot,big   head ')).toEqual(['robot', 'lion', 'big head']);
    expect(parseList('')).toEqual([]);
    expect(listText(['a', 'b'])).toBe('a, b');
  });

  it('finds what changed', () => {
    expect(changedFields({ name: 'a', notes: 'x', tags: 'p, q' }, { name: 'a ', notes: 'y', tags: 'p, q' })).toEqual(['notes']);
  });
});
