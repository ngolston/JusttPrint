import { beforeEach, describe, expect, it } from 'vitest';
import { forgetSession, saveSession, savedSession } from './resume';

const file = { name: 'Big.stl', size: 5e9, lastModified: 123 };

describe('upload resume', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem'> }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      }
    };
  });

  it('remembers the session of a file in a folder until it is forgotten', () => {
    saveSession('/lib', file, 'abc', 1000);
    expect(savedSession('/lib', file, 2000)).toBe('abc');
    expect(savedSession('/other', file, 2000)).toBeNull();
    expect(savedSession('/lib', { ...file, lastModified: 124 }, 2000)).toBeNull();
    forgetSession('/lib', file, 3000);
    expect(savedSession('/lib', file, 4000)).toBeNull();
  });

  it('drops sessions older than a day (the server has deleted them)', () => {
    saveSession('/lib', file, 'abc', 0);
    expect(savedSession('/lib', file, 25 * 60 * 60 * 1000)).toBeNull();
  });
});
