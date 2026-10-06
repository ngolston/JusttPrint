import { describe, expect, it } from 'vitest';
import { filamentName, filterFilaments, materialCounts } from './FilamentPage';

const catalog = [
  { name: 'PLA Basic Black', vendor: 'Bambu Lab', material: 'PLA', color_hex: '111111' },
  { name: 'Galaxy', vendor: 'Prusament', material: 'pla', color_hex: '334455' },
  { name: 'HF Gray', vendor: 'Bambu Lab', material: 'PETG', color_hex: '888888' },
  { name: 'Mystery', vendor: null, material: null, color_hex: null }
];

describe('Filament page', () => {
  it('names a filament by vendor and name', () => {
    expect(filamentName(catalog[0])).toBe('Bambu Lab PLA Basic Black');
    expect(filamentName({ vendor: null, name: '' })).toBe('Unnamed filament');
  });

  it('counts materials, most used first, ignoring case', () => {
    expect(materialCounts(catalog)).toEqual([['PLA', 2], ['PETG', 1]]);
  });

  it('searches every word in vendor, name, material and color, and filters by material', () => {
    expect(filterFilaments(catalog, 'bambu gray', '').map((f) => f.name)).toEqual(['HF Gray']);
    expect(filterFilaments(catalog, '', 'PLA').map((f) => f.name)).toEqual(['PLA Basic Black', 'Galaxy']);
    expect(filterFilaments(catalog, '3344', '').map((f) => f.name)).toEqual(['Galaxy']);
    expect(filterFilaments(catalog, '', '')).toHaveLength(4);
  });
});
