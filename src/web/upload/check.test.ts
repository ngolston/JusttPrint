import { describe, expect, it } from 'vitest';
import { checkFile, extensionOf } from './check';

const info = { extensions: ['.3mf', '.stl'], maxBytes: 100 };

describe('upload checks', () => {
  it('reads extensions in lower case', () => {
    expect(extensionOf('Benchy.STL')).toBe('.stl');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });

  it('lets through model files within the limit, and says why others are skipped', () => {
    expect(checkFile({ name: 'a.stl', size: 100 }, info)).toEqual({ ok: true });
    expect(checkFile({ name: 'a.obj', size: 1 }, info)).toEqual({ ok: false, reason: '.obj files are not scanned (Settings → File Types)' });
    expect(checkFile({ name: 'a.3mf', size: 101 }, info)).toEqual({ ok: false, reason: 'larger than the upload limit' });
    expect(checkFile({ name: '.a.stl', size: 1 }, info)).toEqual({ ok: false, reason: 'hidden files are not uploaded' });
    expect(checkFile({ name: 'notes', size: 1 }, info)).toEqual({ ok: false, reason: 'no file extension' });
  });

  it('warns about files the scan will skip', () => {
    const check = checkFile({ name: 'huge.stl', size: 60 }, { ...info, scanMaxBytes: 50 });
    expect(check.ok).toBe(true);
    expect(check.ok && check.warning).toMatch(/scan limit/);
  });
});
