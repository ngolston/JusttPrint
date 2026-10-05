import { describe, expect, it } from 'vitest';
import { Selection } from './selection';

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('Selection', () => {
  it('compares normalized paths and keeps the first spelling', () => {
    const s = new Selection();
    expect(s.add('c:\\Models\\a.stl')).toBe('c:\\Models\\a.stl');
    expect(s.add('C:/Models/a.stl')).toBe('c:\\Models\\a.stl');
    expect(s.size).toBe(1);
    expect(s.has('C:/Models/a%2Estl'.replace('%2E', '.'))).toBe(true);
    expect(s.delete('C:/Models/a.stl')).toBe('c:\\Models\\a.stl');
    expect(s.has('c:\\Models\\a.stl')).toBe(false);
    expect(s.delete('/x')).toBeNull();
  });

  it('toggles, replaces, retains and iterates', () => {
    const s = new Selection();
    expect(s.toggle('/a')).toBe(true);
    expect(s.toggle('/a')).toBe(false);
    s.set(['/a', '/b', '/c']);
    s.retain((p) => p !== '/b');
    expect([...s]).toEqual(['/a', '/c']);
    expect(s.values()).toEqual(['/a', '/c']);
    s.clear();
    expect(s.size).toBe(0);
  });

  it('notifies once per batch, and not for changes that change nothing', async () => {
    const s = new Selection();
    let calls = 0;
    const off = s.subscribe(() => { calls++; });
    s.add('/a');
    s.add('/b');
    s.add('/a');
    await flush();
    expect(calls).toBe(1);
    s.delete('/missing');
    s.retain(() => true);
    await flush();
    expect(calls).toBe(1);
    off();
    s.clear();
    await flush();
    expect(calls).toBe(1);
  });
});
