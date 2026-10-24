import { describe, expect, it } from 'vitest';
import { directoryLabel, folderCrumbs, folderFilterFor, parentDirectory } from './paths';

describe('model paths', () => {
  it('gives the parent folder, keeping drive and file system roots', () => {
    expect(parentDirectory('/lib/a/b.stl')).toBe('/lib/a');
    expect(parentDirectory('E:\\b.stl')).toBe('E:\\');
    expect(parentDirectory('/b.stl')).toBe('/');
    expect(parentDirectory('/lib/x.zip::in/b.stl')).toBe('/lib');
    expect(parentDirectory('url::https://x')).toBe('');
    expect(parentDirectory('b.stl')).toBe('');
  });

  it('labels ZIP entries with the archive and the folder inside', () => {
    expect(directoryLabel('/lib/x.zip::in/deep/b.stl')).toBe('/lib/x.zip → in/deep');
    expect(directoryLabel('E:\\x.zip::b.stl')).toBe('E:\\x.zip → root');
    expect(directoryLabel('url::https://x')).toBe('Open in browser');
    expect(directoryLabel('/lib/a/b.stl')).toBe('/lib/a');
  });

  it('gives the folder filter for a model', () => {
    expect(folderFilterFor('/lib/a/b.stl')).toBe('/lib/a');
    expect(folderFilterFor('/lib/x.zip::in/b.stl')).toBe('/lib/x.zip::in');
    expect(folderFilterFor('/lib/x.zip::b.stl')).toBe('/lib/x.zip');
  });
});

describe('folderCrumbs', () => {
  it('lists the folders below the library root', () => {
    expect(folderCrumbs('/mnt/models/Toys/Robots', ['/mnt/models'])).toEqual([
      { label: 'Toys', path: '/mnt/models/Toys' },
      { label: 'Robots', path: '/mnt/models/Toys/Robots' }
    ]);
  });
  it('uses the deepest root and gives none for the root itself', () => {
    expect(folderCrumbs('/mnt/models/', ['/mnt/models'])).toEqual([]);
    expect(folderCrumbs('/mnt/models/Uploads/A', ['/mnt/models', '/mnt/models/Uploads'])).toEqual([{ label: 'A', path: '/mnt/models/Uploads/A' }]);
  });
  it('matches Windows paths without regard to case', () => {
    expect(folderCrumbs('E:\\Models\\Toys', ['e:\\models'])).toEqual([{ label: 'Toys', path: 'E:\\Models\\Toys' }]);
  });
  it('gives the folder name outside every root', () => {
    expect(folderCrumbs('/elsewhere/Thing', ['/mnt/models'])).toEqual([{ label: 'Thing', path: '/elsewhere/Thing' }]);
  });
});
