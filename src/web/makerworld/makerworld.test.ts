import { describe, expect, it } from 'vitest';
import { formatDuration, formatGrams, linkParts, makerWorldUrl } from './makerworld';

describe('MakerWorld in the details panel', () => {
  it('finds the MakerWorld link of a model', () => {
    expect(makerWorldUrl({ filePath: 'url::https://makerworld.com/en/models/3006565' })).toBe('https://makerworld.com/en/models/3006565');
    expect(makerWorldUrl({ filePath: '/library/legs.stl', source: 'makerworld.com/models/1-x' })).toBe('https://makerworld.com/models/1-x');
    expect(makerWorldUrl({ filePath: '/library/legs.stl', source: 'https://www.printables.com/model/1' })).toBeNull();
    expect(makerWorldUrl({ filePath: '/library/legs.stl', source: 'https://makerworld.com.evil.example/models/1' })).toBeNull();
    expect(makerWorldUrl(null)).toBeNull();
  });

  it('formats print time and weight', () => {
    expect(formatDuration(326981)).toBe('90 h 50 min');
    expect(formatDuration(2700)).toBe('45 min');
    expect(formatDuration(7200)).toBe('2 h');
    expect(formatDuration(null)).toBe('—');
    expect(formatGrams(1918)).toBe((1918).toLocaleString() + ' g');
    expect(formatGrams(null)).toBe('—');
  });

  it('shows only http(s) addresses as links', () => {
    expect(linkParts('See https://youtu.be/abc. Or javascript:alert(1)')).toEqual([
      { text: 'See ' }, { text: 'https://youtu.be/abc', href: 'https://youtu.be/abc' }, { text: '. Or javascript:alert(1)' }
    ]);
  });
});
