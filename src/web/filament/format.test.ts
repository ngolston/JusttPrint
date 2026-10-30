import { describe, expect, it } from 'vitest';
import type { Spool } from '../api';
import { dryingProgress, formatTimeLeft, formatWeight, matchesFilter, matchesSearch, numberOrNull, spoolWhere } from './format';

const spool = (over: Partial<Spool> = {}): Spool =>
  ({
    id: 1,
    display_name: 'PLA Basic Black',
    brand_name: 'Bambu Lab',
    material: 'PLA',
    material_type: 'PLA Basic',
    color_name: 'Black',
    location_name: 'Shelf 2',
    remaining: 640,
    status: 'storage',
    loaded: [],
    drying: null,
    ...over
  }) as Spool;

describe('filament figures', () => {
  it('writes grams under a kilo and kilos above', () => {
    expect(formatWeight(640)).toBe('640 g');
    expect(formatWeight(18600)).toBe('18.6 kg');
    expect(formatWeight(1000)).toBe('1 kg');
    expect(formatWeight(-5)).toBe('0 g');
    expect(formatWeight(null)).toBe('0 g');
  });

  it('says how long a drying session has left', () => {
    const start = '2026-10-30T10:00:00Z';
    const now = Date.parse('2026-10-30T11:56:00Z');
    const progress = dryingProgress(start, 4, now);
    expect(progress.share).toBeCloseTo(116 / 240);
    expect(formatTimeLeft(progress.leftMs)).toBe('2 h 4 min left');
    expect(formatTimeLeft(3600_000)).toBe('1 h left');
    expect(formatTimeLeft(30_000)).toBe('1 min left');
    expect(formatTimeLeft(0)).toBe('Done');
    expect(dryingProgress('nonsense', 4)).toEqual({ share: 0, leftMs: 0 });
  });

  it('filters spools, keeping archived ones under Archived only', () => {
    expect(matchesFilter(spool(), 'all')).toBe(true);
    expect(matchesFilter(spool({ remaining: 18 }), 'low')).toBe(true);
    expect(matchesFilter(spool(), 'low')).toBe(false);
    expect(matchesFilter(spool({ material: 'PETG' }), 'material:petg')).toBe(true);
    expect(matchesFilter(spool({ status: 'archived', remaining: 0 }), 'low')).toBe(false);
    expect(matchesFilter(spool({ status: 'archived' }), 'archived')).toBe(true);
    expect(matchesFilter(spool({ drying: { id: 1, drying_temp: 50, target_hours: 4, started_at: '' } }), 'drying')).toBe(true);
  });

  it('searches every word in the name, brand, material, color and place', () => {
    expect(matchesSearch(spool(), 'bambu black')).toBe(true);
    expect(matchesSearch(spool(), 'shelf')).toBe(true);
    expect(matchesSearch(spool(), 'petg')).toBe(false);
    expect(matchesSearch(spool(), '  ')).toBe(true);
  });

  it('says where a spool is', () => {
    expect(spoolWhere(spool())).toBe('Shelf 2');
    expect(spoolWhere(spool({ location_name: null }))).toBe('No place');
    expect(spoolWhere(spool({ loaded: [{ printerId: 1, label: 'P1S · A4' }] }))).toBe('P1S · A4');
    expect(spoolWhere(spool({ status: 'archived' }))).toBe('Archived');
  });

  it('reads number fields, with a comma for decimals too', () => {
    expect(numberOrNull('')).toBe(null);
    expect(numberOrNull('1,75')).toBe(1.75);
    expect(numberOrNull('abc')).toBe(null);
  });
});
