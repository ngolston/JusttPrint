/** The UI theme's accent colors (Settings → Theme; saved as uiTheme). */

export const THEME_ACCENTS: Record<string, { accent: string; hover: string; shadow: string }> = {
  'modern-cyan': { accent: '#00d4ff', hover: '#5b9fff', shadow: 'rgba(91, 159, 255, 0.3)' },
  'modern-purple': { accent: '#a855f7', hover: '#c084fc', shadow: 'rgba(168, 85, 247, 0.3)' },
  'modern-green': { accent: '#4ade80', hover: '#22c55e', shadow: 'rgba(34, 197, 94, 0.3)' },
  'modern-orange': { accent: '#fb923c', hover: '#f97316', shadow: 'rgba(249, 115, 22, 0.3)' },
  'modern-pink': { accent: '#f472b6', hover: '#ec4899', shadow: 'rgba(236, 72, 153, 0.3)' },
  'dark-minimal': { accent: '#9ca3af', hover: '#d1d5db', shadow: 'rgba(75, 85, 99, 0.3)' }
};

/** Mark the page with a theme and set its accent variables (unknown themes get cyan). */
export function applyTheme(theme: string) {
  const colors = THEME_ACCENTS[theme] || THEME_ACCENTS['modern-cyan'];
  const root = document.documentElement.style;
  document.body.setAttribute('data-theme', theme);
  root.setProperty('--primary-accent', colors.accent);
  root.setProperty('--primary-accent-hover', colors.hover);
  root.setProperty('--accent-color', colors.accent);
  root.setProperty('--primary-gradient', colors.accent);
  root.setProperty('--primary-gradient-hover', colors.hover);
  root.setProperty('--primary-shadow', colors.shadow);
  root.setProperty('--primary-shadow-hover', colors.shadow.replace(/0\.3\)$/, '0.4)'));
}

declare global {
  interface Window {
    applyThemeColors?: (theme: string) => void;
  }
}

if (typeof window !== 'undefined') window.applyThemeColors = (theme) => applyTheme(theme);
