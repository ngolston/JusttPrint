import { describe, expect, it } from 'vitest';
import { clampWidth, FOLDERS } from './layout';
import {
  MAX_RECENT,
  directoryOfFile,
  findNode,
  findWithAncestors,
  folderName,
  matchesQuery,
  parseRecent,
  pathsEqual,
  pushRecent,
  toDirectoryFilter,
  type FolderNode
} from './tree';

const forest: FolderNode[] = [
  {
    path: '/lib',
    label: 'lib',
    count: 3,
    children: [
      {
        path: '/lib/Designer A',
        label: 'Designer A',
        count: 2,
        children: [
          {
            path: '/lib/Designer A/pack.zip',
            label: 'pack.zip',
            count: 1,
            isBundle: true,
            children: [{ path: '/lib/Designer A/pack.zip::parts', label: 'parts', count: 1 }]
          }
        ]
      },
      { path: '/lib/Other', label: 'Other', count: 1 }
    ]
  }
];

describe('folder tree helpers', () => {
  it('compares paths without case, separators or trailing slashes mattering', () => {
    expect(pathsEqual('C:\\Models\\', 'c:/models')).toBe(true);
    expect(pathsEqual('/a/b', '/a/bc')).toBe(false);
  });

  it('filters a ZIP on disk to its entries', () => {
    expect(toDirectoryFilter({ path: '/x/pack.zip', isBundle: true })).toBe('/x/pack.zip::');
    expect(toDirectoryFilter({ path: '/x/pack.zip::parts', isBundle: true })).toBe('/x/pack.zip::parts');
    expect(toDirectoryFilter({ path: '/x/folder' })).toBe('/x/folder');
  });

  it('finds the folder of a file, a ZIP entry, and a top-level ZIP entry', () => {
    expect(directoryOfFile('/lib/Other/a.stl')).toBe('/lib/Other');
    expect(directoryOfFile('/lib/pack.zip::parts/a.stl')).toBe('/lib/pack.zip::parts');
    expect(directoryOfFile('/lib/pack.zip::a.stl')).toBe('/lib/pack.zip::');
    expect(directoryOfFile('url::https://example.com')).toBe('');
  });

  it('finds a node by path or by its directory filter, with its ancestors', () => {
    expect(findNode(forest, '/lib/Designer A/pack.zip::')?.label).toBe('pack.zip');
    const found = findWithAncestors(forest, '/lib/Designer A/pack.zip::parts');
    expect(found?.node.label).toBe('parts');
    expect(found?.ancestors.map((n) => n.label)).toEqual(['lib', 'Designer A', 'pack.zip']);
    expect(findNode(forest, '/nowhere')).toBeNull();
  });

  it('keeps a folder when it or a descendant matches the search', () => {
    expect(matchesQuery(forest[0], 'parts')).toBe(true);
    expect(matchesQuery(forest[0].children![1], 'parts')).toBe(false);
    expect(matchesQuery(forest[0].children![1], '  ')).toBe(true);
  });

  it('names a folder that is not in the tree', () => {
    expect(folderName('/lib/pack.zip::')).toBe('pack.zip');
    expect(folderName('C:\\Models\\Cars')).toBe('Cars');
  });

  it('keeps recent picks newest first, without duplicates, up to the limit', () => {
    let recent = pushRecent([], { path: '/a', label: 'a' });
    recent = pushRecent(recent, { path: '/b', label: 'b' });
    recent = pushRecent(recent, { path: '/A/', label: 'a' });
    expect(recent.map((r) => r.path)).toEqual(['/A/', '/b']);
    for (let i = 0; i < 20; i++) recent = pushRecent(recent, { path: `/p${i}`, label: `p${i}` });
    expect(recent).toHaveLength(MAX_RECENT);
    expect(recent[0].path).toBe('/p19');
  });

  it('reads the saved recent list, ignoring bad values', () => {
    expect(parseRecent('[{"path":"/a","label":"a"},null,{"label":"x"}]')).toEqual([{ path: '/a', label: 'a' }]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
  });

  it('clamps panel widths, also to a smaller limit', () => {
    expect(clampWidth(FOLDERS, 50)).toBe(FOLDERS.min);
    expect(clampWidth(FOLDERS, 9999)).toBe(FOLDERS.max);
    expect(clampWidth(FOLDERS, 400, 300)).toBe(300);
    expect(clampWidth(FOLDERS, 400, 10)).toBe(FOLDERS.min);
  });
});
