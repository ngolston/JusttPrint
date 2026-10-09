/**
 * The UI's color scheme (dark, light or the system's; saved as uiColorScheme) and accent color
 * (saved as uiTheme), both chosen under Settings → Theme, each person their own.
 */

export type ColorScheme = 'dark' | 'light';
export type ColorSchemePreference = ColorScheme | 'system';

interface Accent {
  accent: string;
  hover: string;
}

/**
 * Accent and hover per theme, for the dark and the light scheme (darker, so they stay readable on
 * white). Cyan keeps the tokens' own accent (tokens.css) in both.
 */
export const THEME_ACCENTS: Record<string, { dark: Accent; light: Accent } | null> = {
  'modern-cyan': null,
  'modern-purple': { dark: { accent: '#b47cfa', hover: '#c9a0fc' }, light: { accent: '#7c3aed', hover: '#6d28d9' } },
  'modern-green': { dark: { accent: '#4ade80', hover: '#86efac' }, light: { accent: '#137337', hover: '#14532d' } },
  'modern-orange': { dark: { accent: '#fb923c', hover: '#fdba74' }, light: { accent: '#b23c0a', hover: '#9a3412' } },
  'modern-pink': { dark: { accent: '#f472b6', hover: '#f9a8d4' }, light: { accent: '#be185d', hover: '#9d174d' } },
  'dark-minimal': { dark: { accent: '#9ca3af', hover: '#d1d5db' }, light: { accent: '#4b5563', hover: '#374151' } }
};

const ACCENT_VARS = ['--jp-accent', '--jp-accent-hover', '--jp-accent-soft', '--jp-accent-border', '--jp-accent-rgb'];

/** Where the page remembers the scheme, so color-scheme.js can set it before the first paint. */
export const SCHEME_STORAGE_KEY = 'jp-color-scheme';

/** '#a855f7' as "168, 85, 247", for rgba(var(--…-rgb), alpha). */
export function rgbChannels(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** '#a855f7' at an opacity, as rgba(). */
export function withAlpha(hex: string, alpha: number): string {
  return `rgba(${rgbChannels(hex)}, ${alpha})`;
}

/** A saved preference, cleaned up: anything unknown is dark (the look before there was a choice). */
export function schemePreference(value: unknown): ColorSchemePreference {
  return value === 'light' || value === 'system' ? value : 'dark';
}

/** The scheme a preference gives now: 'system' follows the computer's setting. */
export function resolveScheme(preference: ColorSchemePreference, systemPrefersLight: boolean): ColorScheme {
  if (preference === 'system') return systemPrefersLight ? 'light' : 'dark';
  return preference;
}

const systemPrefersLight = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: light)').matches;

let currentTheme = 'modern-cyan';
let currentPreference: ColorSchemePreference = 'dark';

/** The scheme on the page now. */
export function currentScheme(): ColorScheme {
  return document.documentElement.dataset.colorScheme === 'light' ? 'light' : 'dark';
}

/** Mark the page with a theme and set the accent tokens for the current scheme (unknown themes get cyan). */
export function applyTheme(theme: string) {
  currentTheme = theme;
  const colors = THEME_ACCENTS[theme]?.[currentScheme()] ?? null;
  const root = document.documentElement.style;
  document.body.setAttribute('data-theme', theme);
  if (!colors) {
    ACCENT_VARS.forEach((name) => root.removeProperty(name));
    return;
  }
  root.setProperty('--jp-accent', colors.accent);
  root.setProperty('--jp-accent-hover', colors.hover);
  root.setProperty('--jp-accent-soft', withAlpha(colors.accent, 0.12));
  root.setProperty('--jp-accent-border', withAlpha(colors.accent, 0.45));
  root.setProperty('--jp-accent-rgb', rgbChannels(colors.accent));
}

/** Set the color scheme (and the accent's shade for it), and remember it for the next page load. */
export function applyColorScheme(value: unknown) {
  currentPreference = schemePreference(value);
  const scheme = resolveScheme(currentPreference, systemPrefersLight());
  document.documentElement.dataset.colorScheme = scheme;
  // The browser's toolbar and the phone's status bar match the page.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', scheme === 'light' ? '#f2f5f8' : '#081017');
  try {
    localStorage.setItem(SCHEME_STORAGE_KEY, currentPreference);
  } catch {
    // Private windows may refuse storage: the scheme still applies after the settings load.
  }
  applyTheme(currentTheme);
}

declare global {
  interface Window {
    applyThemeColors?: (theme: string) => void;
    applyColorScheme?: (preference: string) => void;
  }
}

if (typeof window !== 'undefined') {
  window.applyThemeColors = (theme) => applyTheme(theme);
  window.applyColorScheme = (preference) => applyColorScheme(preference);
  // "Match system" follows the computer switching between light and dark.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (currentPreference === 'system') applyColorScheme('system');
  });
}
