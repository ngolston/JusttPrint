import { describe, expect, it } from 'vitest';
import { pathTreeRows } from './pathTree';

describe('pathTreeRows', () => {
  it('lists the folders and the file of a POSIX path, keeping the leading slash in filters', () => {
    expect(pathTreeRows('/mnt/models/Designer A/cube.stl')).toEqual([
      { depth: 0, kind: 'folder', label: 'mnt', directory: '/mnt' },
      { depth: 1, kind: 'folder', label: 'models', directory: '/mnt/models' },
      { depth: 2, kind: 'folder', label: 'Designer A', directory: '/mnt/models/Designer A' },
      { depth: 3, kind: 'file', label: 'cube.stl' }
    ]);
  });

  it('keeps Windows separators and drive letters', () => {
    expect(pathTreeRows('C:\\Models\\a.stl')).toEqual([
      { depth: 0, kind: 'folder', label: 'C:', directory: 'C:' },
      { depth: 1, kind: 'folder', label: 'Models', directory: 'C:\\Models' },
      { depth: 2, kind: 'file', label: 'a.stl' }
    ]);
  });

  it('shows the ZIP and the folders inside it', () => {
    expect(pathTreeRows('/m/pack.zip::parts/left/arm.stl')).toEqual([
      { depth: 0, kind: 'folder', label: 'm', directory: '/m' },
      { depth: 1, kind: 'zip', label: 'pack.zip', directory: '/m/pack.zip' },
      { depth: 2, kind: 'folder', label: 'parts', directory: '/m/pack.zip::parts' },
      { depth: 3, kind: 'folder', label: 'left', directory: '/m/pack.zip::parts/left' },
      { depth: 4, kind: 'file', label: 'arm.stl' }
    ]);
  });

  it('handles online models and empty paths', () => {
    expect(pathTreeRows('url::https://example.com/x')).toEqual([{ depth: 0, kind: 'file', label: 'Online model' }]);
    expect(pathTreeRows('')).toEqual([]);
  });
});
