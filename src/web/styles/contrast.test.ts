import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

/** Hex color tokens declared in a block of tokens.css. */
const hexTokens = (block: string) => Object.fromEntries([...block.matchAll(/--(jp-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
const darkStart = css.indexOf(":root[data-color-scheme='dark'] {");
const lightBlock = css.slice(0, darkStart);
const darkBlock = css.slice(darkStart, css.indexOf('}', darkStart));
/** Each scheme's tokens: the dark scheme overrides the light (default) ones. */
const SCHEMES = {
  light: hexTokens(lightBlock),
  dark: { ...hexTokens(lightBlock), ...hexTokens(darkBlock) }
} as const;

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** WCAG contrast ratio of two colors. */
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ['jp-bg', 'jp-bg-2', 'jp-sidebar', 'jp-surface-1', 'jp-surface-2'];

for (const [scheme, tokens] of Object.entries(SCHEMES)) {
  describe(`token contrast, ${scheme} scheme (spec §37, WCAG 2.2 AA)`, () => {
    const pair = (text: string, background: string, min = 4.5) =>
      expect(contrast(tokens[text], tokens[background]), `${text} on ${background}`).toBeGreaterThanOrEqual(min);

    it('reads the tokens', () => {
      expect(Object.keys(tokens).length).toBeGreaterThan(30);
    });

    it('body, secondary and muted text reach 4.5:1 on every surface', () => {
      for (const text of ['jp-text', 'jp-text-2', 'jp-text-3']) for (const surface of SURFACES) pair(text, surface);
    });

    it('coral and status colors used as text reach 4.5:1 on every surface', () => {
      for (const text of ['jp-accent-text', 'jp-accent-text-hover', 'jp-success-text', 'jp-warning-text', 'jp-danger-text', 'jp-info-text']) {
        for (const surface of SURFACES) pair(text, surface);
      }
    });

    it('status text reaches 4.5:1 on its soft background', () => {
      pair('jp-accent-strong-text', 'jp-accent-soft');
      for (const tone of ['success', 'warning', 'danger', 'info']) pair(`jp-${tone}-text`, `jp-${tone}-soft`);
    });

    it('text on coral (primary buttons, "Needs you" tiles) reaches 4.5:1, hovered too', () => {
      pair('jp-on-accent', 'jp-accent');
      pair('jp-on-accent', 'jp-accent-hover');
    });

    it('text on dark feature tiles reaches 4.5:1', () => {
      for (const text of ['jp-on-ink', 'jp-on-ink-2', 'jp-accent-tint']) pair(text, 'jp-ink-tile');
      pair('jp-on-ink', 'jp-ink-tile-2');
    });

    it('muted text stays readable on hover and quiet tiles', () => {
      pair('jp-text', 'jp-surface-hover');
      pair('jp-text-3', 'jp-surface-hover');
    });

    it('the focus ring and coral fills reach 3:1 where they are the only boundary', () => {
      // --jp-focus is var(--jp-accent-text).
      pair('jp-accent-text', 'jp-bg', 3);
      pair('jp-accent', 'jp-surface-1', 3);
    });
  });
}
