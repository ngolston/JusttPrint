'use strict';

/** Filament colors and labels, shared by the filament catalog, import and export. */

/** "abc", "#AABBCC", "aabbccdd" or "aabbcc,ddeeff" → "AABBCC"; anything else → "". */
function normalizeColorHex(hex) {
  if (!hex) return '';
  let h = String(hex).replace(/^#/, '').trim();
  if (!h) return '';
  if (h.includes(',')) h = h.split(',')[0].trim();
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : '';
}

/** "Vendor Name (Material)". */
function formatFilamentLabel(filament) {
  const vendor = String(filament?.vendor || '').trim();
  const name = String(filament?.name || '').trim();
  const material = String(filament?.material || '').trim();
  const base = [vendor, name].filter(Boolean).join(' ') || 'Unnamed filament';
  return material ? `${base} (${material})` : base;
}

module.exports = { normalizeColorHex, formatFilamentLabel };
