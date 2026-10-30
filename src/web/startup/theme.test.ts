import { describe, expect, it } from 'vitest';
import { SCHEME_BACKGROUNDS, resolveScheme, schemePreference } from './theme';
import css from '../styles/tokens.css?raw';

describe('color scheme', () => {
  it('reads a saved preference, light when unknown or missing', () => {
    expect(schemePreference('light')).toBe('light');
    expect(schemePreference('system')).toBe('system');
    expect(schemePreference('dark')).toBe('dark');
    expect(schemePreference(null)).toBe('light');
    expect(schemePreference('sepia')).toBe('light');
  });

  it('Match system follows the computer; Light and Dark do not', () => {
    expect(resolveScheme('system', true)).toBe('light');
    expect(resolveScheme('system', false)).toBe('dark');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('dark', true)).toBe('dark');
  });

  it("the browser toolbar matches each scheme's page ground", () => {
    const dark = css.slice(css.indexOf(":root[data-color-scheme='dark']"));
    expect(css).toContain(`--jp-bg: ${SCHEME_BACKGROUNDS.light};`);
    expect(dark).toContain(`--jp-bg: ${SCHEME_BACKGROUNDS.dark};`);
  });
});
