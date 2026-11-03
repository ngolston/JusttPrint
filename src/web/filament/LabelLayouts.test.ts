import { describe, expect, it } from 'vitest';
import type { Spool } from '../api';
import { LABEL_LAYOUTS, layoutOf, PLACE_LAYOUTS, placeLabelData, placeLayoutOf, spoolLabelData } from './LabelLayouts';

const spool = (over: Partial<Spool> = {}): Spool =>
  ({
    id: 7,
    display_name: 'PLA+ Pro Basic White',
    brand_name: 'SUNLU',
    material: 'PLA+',
    material_type: 'Pro Basic',
    color_name: 'White',
    color_hex: '#ffffff',
    profile_print_temp_min: 195,
    profile_print_temp_max: 220,
    profile_bed_temp_min: 50,
    profile_bed_temp_max: 60,
    profile_flow_ratio: 0.981,
    profile_td: 5,
    ...over
  }) as Spool;

describe('spool QR labels', () => {
  it('says the brand, material with its kind, color, hex code, number and the filament settings', () => {
    const data = spoolLabelData(spool());
    expect(data).toMatchObject({ number: '#7', brand: 'SUNLU', material: 'PLA+ Pro Basic', base: 'PLA+', color: 'White', hex: '#FFFFFF' });
    expect(data.specs).toEqual([
      ['Nozzle', '195–220°C'],
      ['Bed Temp', '50–60°C'],
      ['Flow Ratio', '0.981'],
      ['TD', '5']
    ]);
  });

  it('leaves out settings the filament lacks, and never says the material twice', () => {
    const data = spoolLabelData(
      spool({
        material: 'PETG',
        material_type: 'PETG HF',
        color_name: null,
        display_name: 'PETG HF',
        profile_flow_ratio: null,
        profile_td: null,
        profile_bed_temp_min: null,
        profile_bed_temp_max: null
      })
    );
    expect(data.material).toBe('PETG HF');
    expect(data.color).toBe('');
    expect(data.specs.map(([name]) => name)).toEqual(['Nozzle']);
  });

  it('starts each size on its first layout and falls back to it for an unknown one', () => {
    expect(layoutOf('badge', null)).toBe('brand');
    expect(layoutOf('card', 'number')).toBe('number');
    expect(layoutOf('strip', 'gone')).toBe(LABEL_LAYOUTS.strip[0].id);
  });

  it('gives places their name, whether they are a dry box, and their description, in layouts of their own', () => {
    expect(placeLabelData({ name: 'Sunlu FilaDryer S2', is_dry_box: 1, description: ' Top shelf ' })).toEqual({
      name: 'Sunlu FilaDryer S2',
      kind: 'Dry box',
      description: 'Top shelf'
    });
    expect(placeLabelData({ name: 'Shelf 2', is_dry_box: 0 })).toEqual({ name: 'Shelf 2', kind: 'Place', description: '' });
    expect(placeLayoutOf('strip', null)).toBe(PLACE_LAYOUTS.strip[0].id);
    expect(placeLayoutOf('card', 'big-qr')).toBe('big-qr');
  });
});
