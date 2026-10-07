import type { Filament } from './api';

/** "Vendor Name (Material)", as on model cards and pickers. */
export function formatFilamentLabel(filament: Pick<Filament, 'vendor' | 'name' | 'material'>): string {
  const base = [filament.vendor, filament.name].map((part) => String(part || '').trim()).filter(Boolean).join(' ') || 'Unnamed filament';
  const material = String(filament.material || '').trim();
  return material ? `${base} (${material})` : base;
}

/** "abc", "#AABBCC", "aabbccdd" or "aabbcc,ddeeff" → "AABBCC"; anything else → "". */
export function normalizeColorHex(value: string | null | undefined): string {
  let hex = String(value || '').replace(/^#/, '').trim();
  if (hex.includes(',')) hex = hex.split(',')[0].trim();
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length === 8) hex = hex.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : '';
}
