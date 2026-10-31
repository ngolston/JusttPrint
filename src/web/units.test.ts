import { describe, expect, it } from 'vitest';
import {
  formatDay,
  formatLength,
  formatTemperature,
  formatTemperatureRange,
  formatWeightIn,
  fromLengthInput,
  fromTemperatureInput,
  fromWeightInput,
  parseUnits,
  toLengthInput,
  toTemperatureInput,
  toWeightInput
} from './units';

describe('units (10.2)', () => {
  it('reads the setting, each unknown part its default', () => {
    expect(parseUnits(null)).toEqual({ weight: 'g', temperature: 'C', length: 'mm', date: 'locale' });
    expect(parseUnits('{"weight":"lb","temperature":"F","length":"in","date":"dmy"}')).toEqual({ weight: 'lb', temperature: 'F', length: 'in', date: 'dmy' });
    expect(parseUnits('{"weight":"stone","date":"x"}')).toEqual({ weight: 'g', temperature: 'C', length: 'mm', date: 'locale' });
    expect(parseUnits('not json')).toEqual({ weight: 'g', temperature: 'C', length: 'mm', date: 'locale' });
    expect(parseUnits('null')).toEqual({ weight: 'g', temperature: 'C', length: 'mm', date: 'locale' });
  });
  it('writes weights in each unit; grams switch to kg from 1,000 as before', () => {
    expect(formatWeightIn(640, 'g')).toBe('640 g');
    expect(formatWeightIn(18600, 'g')).toBe('18.6 kg');
    expect(formatWeightIn(640, 'kg')).toBe('0.64 kg');
    expect(formatWeightIn(1000, 'oz')).toBe('35.3 oz');
    expect(formatWeightIn(1000, 'lb')).toBe('2.2 lb');
    expect(formatWeightIn(-5, 'g')).toBe('0 g');
  });
  it('weight fields show the unit and give grams back', () => {
    expect(toWeightInput(1000, 'lb')).toBe('2.205');
    expect(fromWeightInput('2.205', 'lb')).toBe(1000.2);
    expect(toWeightInput(250, 'oz')).toBe('8.82');
    expect(fromWeightInput('1', 'kg')).toBe(1000);
    expect(fromWeightInput('0,5', 'kg')).toBe(500);
    expect(fromWeightInput('', 'g')).toBeNull();
    expect(fromWeightInput('abc', 'g')).toBeNull();
    expect(toWeightInput(null, 'g')).toBe('');
  });
  it('temperatures in °C or °F, and back', () => {
    expect(formatTemperature(210, 'C')).toBe('210 °C');
    expect(formatTemperature(210, 'F')).toBe('410 °F');
    expect(formatTemperatureRange(190, 230, 'F')).toBe('374–446 °F');
    expect(formatTemperatureRange(null, 230, 'C')).toBe('230 °C');
    expect(formatTemperatureRange(null, null, 'C')).toBe('');
    expect(toTemperatureInput(65, 'F')).toBe('149');
    expect(fromTemperatureInput('149', 'F')).toBe(65);
    expect(fromTemperatureInput('', 'F')).toBeNull();
  });
  it('lengths in mm or inches, and back', () => {
    expect(formatLength(1.75, 'mm')).toBe('1.75 mm');
    expect(formatLength(1.75, 'in')).toBe('0.069 in');
    expect(toLengthInput(1.75, 'in')).toBe('0.0689');
    expect(fromLengthInput('0.0689', 'in')).toBe(1.75);
  });
  it('days in the chosen format', () => {
    const day = new Date(2026, 9, 30, 14, 5);
    expect(formatDay(day, 'ymd')).toBe('2026-10-30');
    expect(formatDay(day, 'dmy')).toBe('30/10/2026');
    expect(formatDay(day, 'mdy')).toBe('10/30/2026');
    expect(formatDay(day, 'locale')).toMatch(/2026/);
    expect(formatDay(null, 'ymd')).toBe('');
  });
});
