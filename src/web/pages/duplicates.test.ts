import { describe, expect, it } from 'vitest';
import { keepOnly, splitPath } from './DuplicatesPage';

describe('Duplicates page', () => {
  it('splits a path into name and folder, also for ZIP entries', () => {
    expect(splitPath('/lib/Designer A/cube.stl')).toEqual({ name: 'cube.stl', folder: '/lib/Designer A' });
    expect(splitPath('C:\\lib\\cube.stl')).toEqual({ name: 'cube.stl', folder: 'C:\\lib' });
    expect(splitPath('/lib/pack.zip::inner/widget.stl')).toEqual({ name: 'widget.stl', folder: '/lib/pack.zip → inner' });
    expect(splitPath('/lib/pack.zip::widget.stl')).toEqual({ name: 'widget.stl', folder: '/lib/pack.zip' });
  });

  it('keeps one copy and selects the others, never ZIP entries; Keep all clears the group', () => {
    const group = { hash: 'h', files: [{ filePath: '/a.stl' }, { filePath: '/b.stl' }, { filePath: '/p.zip::c.stl' }] };
    const other = '/other.stl';
    const kept = keepOnly(new Set([other, '/a.stl']), group, '/a.stl');
    expect([...kept].sort()).toEqual(['/b.stl', other]);
    expect([...keepOnly(kept, group, null)]).toEqual([other]);
  });
});
