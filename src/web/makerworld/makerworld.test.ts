import { describe, expect, it } from 'vitest';
import { formatDuration, formatGrams, gcodeSummary, linkParts, makerWorldUrl, shownProfiles, siteModelUrl, type MakerWorldProfile } from './makerworld';

describe('MakerWorld in the details panel', () => {
  it('offers only the downloaded print profiles once there are some', () => {
    const profiles = ['1', '2', '3'].map((id) => ({ id }) as MakerWorldProfile);
    const ids = (rows: { profile: MakerWorldProfile; index: number }[]) => rows.map((row) => `${row.index + 1}:${row.profile.id}`);
    expect(ids(shownProfiles(profiles, []))).toEqual(['1:1', '2:2', '3:3']);
    expect(ids(shownProfiles(profiles, [{ profileId: '3', filePath: '/l/c.3mf', fileName: 'c.3mf' }]))).toEqual(['3:3']);
  });

  it('finds the MakerWorld link of a model', () => {
    expect(makerWorldUrl({ filePath: 'url::https://makerworld.com/en/models/3006565' })).toBe('https://makerworld.com/en/models/3006565');
    expect(makerWorldUrl({ filePath: '/library/legs.stl', source: 'makerworld.com/models/1-x' })).toBe('https://makerworld.com/models/1-x');
    expect(makerWorldUrl({ filePath: '/library/legs.stl', source: 'https://www.printables.com/model/1' })).toBeNull();
    expect(makerWorldUrl({ filePath: '/library/legs.stl', source: 'https://makerworld.com.evil.example/models/1' })).toBeNull();
    expect(makerWorldUrl(null)).toBeNull();
  });

  it('finds Printables and Thingiverse links too', () => {
    expect(siteModelUrl({ filePath: 'url::https://www.printables.com/model/1839122' })).toEqual({
      site: 'printables',
      url: 'https://www.printables.com/model/1839122'
    });
    expect(siteModelUrl({ filePath: '/l/bear.stl', source: 'https://www.thingiverse.com/thing:7418273' })).toEqual({
      site: 'thingiverse',
      url: 'https://www.thingiverse.com/thing:7418273'
    });
    expect(siteModelUrl({ filePath: '/l/x.stl', source: 'https://thangs.com/m/1' })).toBeNull();
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
      { text: 'See ' },
      { text: 'https://youtu.be/abc', href: 'https://youtu.be/abc' },
      { text: '. Or javascript:alert(1)' }
    ]);
  });

  it('sums up what a Printables G-code file was sliced for', () => {
    expect(gcodeSummary({ printer: 'Prusa MK4S', material: 'PLA', seconds: 7200, grams: 11, layerHeight: 0.2, nozzle: 0.4 })).toBe(
      `Prusa MK4S · PLA · 0.2 mm layers · 0.4 mm nozzle · about ${formatDuration(7200)} · 11 g`
    );
    expect(gcodeSummary({ printer: null, material: 'PETG', seconds: null, grams: null, layerHeight: null, nozzle: null })).toBe('PETG');
    expect(gcodeSummary({ printer: null, material: null, seconds: null, grams: null, layerHeight: null, nozzle: null })).toBe('');
  });
});
