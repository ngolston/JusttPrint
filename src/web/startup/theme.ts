/**
 * The UI's color scheme: light, dark or the system's, saved as uiColorScheme under Settings → Theme,
 * each person their own. The accent is coral in both (tokens.css); the accent themes of 9.x
 * (uiTheme) are gone.
 */

export type ColorScheme = 'dark' | 'light';
export type ColorSchemePreference = ColorScheme | 'system';

/** Where the page remembers the scheme, so color-scheme.js can set it before the first paint. */
export const SCHEME_STORAGE_KEY = 'jp-color-scheme';

/** The browser toolbar's color for each scheme (tokens.css --jp-bg). */
export const SCHEME_BACKGROUNDS: Record<ColorScheme, string> = { light: '#eef1f5', dark: '#11161d' };

/** A saved preference, cleaned up: anything unknown is light (Bento is light first). */
export function schemePreference(value: unknown): ColorSchemePreference {
  return value === 'dark' || value === 'system' ? value : 'light';
}

/** The scheme a preference gives now: 'system' follows the computer's setting. */
export function resolveScheme(preference: ColorSchemePreference, systemPrefersLight: boolean): ColorScheme {
  if (preference === 'system') return systemPrefersLight ? 'light' : 'dark';
  return preference;
}

const systemPrefersLight = () => typeof window === 'undefined' || !window.matchMedia?.('(prefers-color-scheme: dark)').matches;

let currentPreference: ColorSchemePreference = 'light';

/** The scheme on the page now. */
export function currentScheme(): ColorScheme {
  return document.documentElement.dataset.colorScheme === 'dark' ? 'dark' : 'light';
}

/** Set the color scheme and remember it for the next page load. */
export function applyColorScheme(value: unknown) {
  currentPreference = schemePreference(value);
  const scheme = resolveScheme(currentPreference, systemPrefersLight());
  document.documentElement.dataset.colorScheme = scheme;
  // The browser's toolbar and the phone's status bar match the page.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', SCHEME_BACKGROUNDS[scheme]);
  try {
    localStorage.setItem(SCHEME_STORAGE_KEY, currentPreference);
  } catch {
    // Private windows may refuse storage: the scheme still applies after the settings load.
  }
}

declare global {
  interface Window {
    applyColorScheme?: (preference: string) => void;
  }
}

if (typeof window !== 'undefined') {
  window.applyColorScheme = (preference) => applyColorScheme(preference);
  // "Match system" follows the computer switching between light and dark.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (currentPreference === 'system') applyColorScheme('system');
  });
}
