/** The UI theme's accent colors (Settings → Theme; saved as uiTheme). */

/** Accent and hover per theme; cyan keeps the tokens' own accent (tokens.css). */
export const THEME_ACCENTS: Record<string, { accent: string; hover: string } | null> = {
  'modern-cyan': null,
  'modern-purple': { accent: '#b47cfa', hover: '#c9a0fc' },
  'modern-green': { accent: '#4ade80', hover: '#86efac' },
  'modern-orange': { accent: '#fb923c', hover: '#fdba74' },
  'modern-pink': { accent: '#f472b6', hover: '#f9a8d4' },
  'dark-minimal': { accent: '#9ca3af', hover: '#d1d5db' }
};

const ACCENT_VARS = ['--jp-accent', '--jp-accent-hover', '--jp-accent-soft', '--jp-accent-border'];

/** '#a855f7' at an opacity, as rgba(). */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Mark the page with a theme and set the accent tokens (unknown themes get cyan). */
export function applyTheme(theme: string) {
  const colors = THEME_ACCENTS[theme] ?? null;
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
}

declare global {
  interface Window {
    applyThemeColors?: (theme: string) => void;
  }
}

if (typeof window !== 'undefined') window.applyThemeColors = (theme) => applyTheme(theme);
