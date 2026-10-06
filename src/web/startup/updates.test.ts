import { describe, expect, it } from 'vitest';
import { compareVersions } from './updates';

describe('compareVersions', () => {
  it('compares dotted numbers part by part', () => {
    expect(compareVersions('4.5.0', '4.4.9')).toBe(1);
    expect(compareVersions('4.4.0', '4.10.0')).toBe(-1);
    expect(compareVersions('4.4', '4.4.0')).toBe(0);
    expect(compareVersions('5', '4.99.99')).toBe(1);
  });
});
