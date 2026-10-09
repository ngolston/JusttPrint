import { describe, expect, it } from 'vitest';
import { THEME_ACCENTS, resolveScheme, rgbChannels, schemePreference } from './theme';

describe('color scheme', () => {
  it('reads a saved preference, dark when unknown or missing', () => {
    expect(schemePreference('light')).toBe('light');
    expect(schemePreference('system')).toBe('system');
    expect(schemePreference('dark')).toBe('dark');
    expect(schemePreference(null)).toBe('dark');
    expect(schemePreference('sepia')).toBe('dark');
  });

  it('Match system follows the computer; Light and Dark do not', () => {
    expect(resolveScheme('system', true)).toBe('light');
    expect(resolveScheme('system', false)).toBe('dark');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('dark', true)).toBe('dark');
  });

  it('gives a color as channels for rgba(var(--…-rgb), alpha)', () => {
    expect(rgbChannels('#0369a1')).toBe('3, 105, 161');
  });

  it('every accent has a dark and a light shade', () => {
    for (const [theme, colors] of Object.entries(THEME_ACCENTS)) {
      if (!colors) continue;
      expect(colors.dark.accent, theme).toMatch(/^#[0-9a-f]{6}$/i);
      expect(colors.light.accent, theme).toMatch(/^#[0-9a-f]{6}$/i);
      expect(colors.light.accent, theme).not.toBe(colors.dark.accent);
    }
  });
});
