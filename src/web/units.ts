import { settings } from './api';

/*
 * The library's units and date format (docs/plan-10.1.md, Phase 6): Settings → Printers → Filament
 * settings, one choice for everyone. The database keeps grams, °C and millimetres; these turn
 * them into what people read and type. Loaded once before the page first draws (main.tsx);
 * saving reloads the page, so every number on it follows.
 */

export type WeightUnit = 'g' | 'kg' | 'oz' | 'lb';
export type TemperatureUnit = 'C' | 'F';
export type LengthUnit = 'mm' | 'in';
export type DateFormat = 'locale' | 'ymd' | 'dmy' | 'mdy';

export interface Units {
  weight: WeightUnit;
  temperature: TemperatureUnit;
  length: LengthUnit;
  date: DateFormat;
}

export const DEFAULT_UNITS: Units = { weight: 'g', temperature: 'C', length: 'mm', date: 'locale' };

const GRAMS_PER: Record<WeightUnit, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };

/** The setting's value (JSON) → units, each unknown part its default. */
export function parseUnits(raw: unknown): Units {
  let value: Record<string, unknown> = {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    value = {};
  }
  const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
  return {
    weight: pick(value.weight, ['g', 'kg', 'oz', 'lb'] as const, 'g'),
    temperature: pick(value.temperature, ['C', 'F'] as const, 'C'),
    length: pick(value.length, ['mm', 'in'] as const, 'mm'),
    date: pick(value.date, ['locale', 'ymd', 'dmy', 'mdy'] as const, 'locale')
  };
}

let current: Units = DEFAULT_UNITS;

/** The units in use on this page. */
export const getUnits = (): Units => current;

/** For tests: use these units. */
export function setUnitsForTest(units: Partial<Units>) {
  current = { ...DEFAULT_UNITS, ...units };
}

/** Read the setting (before the page first draws); the defaults when it cannot be read. */
export async function loadUnits(): Promise<Units> {
  try {
    current = parseUnits(await settings.get<string | null>('units'));
  } catch {
    current = DEFAULT_UNITS;
  }
  return current;
}

/** Save the units for the library (admins), then reload so the whole page uses them. */
export async function saveUnits(units: Units) {
  await settings.save('units', JSON.stringify(units));
  current = units;
}

const number = (value: number, digits: number) => value.toLocaleString(undefined, { maximumFractionDigits: digits });

// ---- Weight ----

/** 640 → "640 g", 18600 → "18.6 kg"; in kg, oz or lb when chosen. */
export function formatWeightIn(grams: number | null | undefined, unit: WeightUnit = current.weight): string {
  const g = Math.max(0, Number(grams) || 0);
  if (unit === 'g') {
    const whole = Math.round(g);
    if (whole < 1000) return `${whole} g`;
    return `${number(Math.round(whole / 100) / 10, 1)} kg`;
  }
  if (unit === 'kg') return `${number(Math.round((g / 1000) * 100) / 100, 2)} kg`;
  if (unit === 'oz') return `${number(Math.round((g / GRAMS_PER.oz) * 10) / 10, 1)} oz`;
  return `${number(Math.round((g / GRAMS_PER.lb) * 100) / 100, 2)} lb`;
}

/** "Grams", "Kilograms", "Ounces", "Pounds": for labels read aloud. */
export const weightUnitName = (unit: WeightUnit = current.weight) => ({ g: 'Grams', kg: 'Kilograms', oz: 'Ounces', lb: 'Pounds' })[unit];

/** The unit weight fields take: grams for g, else the chosen one. */
export const weightInputUnit = (unit: WeightUnit = current.weight) => unit;

/** Grams → the number a weight field shows (empty for none). */
export function toWeightInput(grams: number | null | undefined, unit: WeightUnit = current.weight): string {
  if (grams === null || grams === undefined || (grams as unknown) === '') return '';
  const value = Number(grams) / GRAMS_PER[unit];
  const digits = unit === 'g' ? 1 : unit === 'oz' ? 2 : 3;
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

/** What a weight field holds → grams (null when empty or not a number, as numberOrNull). */
export function fromWeightInput(text: string, unit: WeightUnit = current.weight): number | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * GRAMS_PER[unit] * 10) / 10;
}

// ---- Temperature ----

export const temperatureLabel = (unit: TemperatureUnit = current.temperature) => (unit === 'F' ? '°F' : '°C');

const toF = (c: number) => Math.round((c * 9) / 5 + 32);

/** 210 → "210 °C" or "410 °F". */
export function formatTemperature(celsius: number | null | undefined, unit: TemperatureUnit = current.temperature): string {
  if (celsius === null || celsius === undefined || !Number.isFinite(Number(celsius))) return '';
  return unit === 'F' ? `${toF(Number(celsius))} °F` : `${Math.round(Number(celsius))} °C`;
}

/** A range of temperatures: "190–230 °C", or one when both ends are the same or one is missing. */
export function formatTemperatureRange(min: number | null, max: number | null, unit: TemperatureUnit = current.temperature): string {
  if (min === null && max === null) return '';
  if (min === null || max === null || min === max) return formatTemperature(min ?? max, unit);
  const [a, b] = unit === 'F' ? [toF(min), toF(max)] : [Math.round(min), Math.round(max)];
  return `${a}–${b} ${temperatureLabel(unit)}`;
}

export function toTemperatureInput(celsius: number | null | undefined, unit: TemperatureUnit = current.temperature): string {
  if (celsius === null || celsius === undefined) return '';
  return String(unit === 'F' ? toF(Number(celsius)) : Number(celsius));
}

export function fromTemperatureInput(text: string, unit: TemperatureUnit = current.temperature): number | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return unit === 'F' ? Math.round((((value - 32) * 5) / 9) * 10) / 10 : value;
}

// ---- Length ----

export const lengthLabel = (unit: LengthUnit = current.length) => unit;

/** 1.75 → "1.75 mm" or "0.069 in". */
export function formatLength(mm: number | null | undefined, unit: LengthUnit = current.length): string {
  if (mm === null || mm === undefined || !Number.isFinite(Number(mm))) return '';
  return unit === 'in' ? `${number(Math.round((Number(mm) / 25.4) * 1000) / 1000, 3)} in` : `${number(Number(mm), 2)} mm`;
}

export function toLengthInput(mm: number | null | undefined, unit: LengthUnit = current.length): string {
  if (mm === null || mm === undefined) return '';
  return String(unit === 'in' ? Math.round((Number(mm) / 25.4) * 10000) / 10000 : Number(mm));
}

export function fromLengthInput(text: string, unit: LengthUnit = current.length): number | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return unit === 'in' ? Math.round(value * 25.4 * 1000) / 1000 : value;
}

// ---- Dates ----

const pad = (n: number) => String(n).padStart(2, '0');

/** A day in the chosen format: "Oct 30, 2026" (this browser's way), 2026-10-30, 30/10/2026 or 10/30/2026. */
export function formatDay(value: string | number | Date | null | undefined, format: DateFormat = current.date): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const [y, m, d] = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())];
  if (format === 'ymd') return `${y}-${m}-${d}`;
  if (format === 'dmy') return `${d}/${m}/${y}`;
  if (format === 'mdy') return `${m}/${d}/${y}`;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A day and time: the day as above, then the time (this browser's way). */
export function formatDayTime(value: string | number | Date | null | undefined, format: DateFormat = current.date): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${formatDay(date, format)}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
