import { describe, expect, it } from 'vitest';
import css from './tokens.css?raw';

/** The design tokens from tokens.css (hex colors only). */
const tokens = Object.fromEntries([...css
  .matchAll(/--(jp-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));

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

describe('token contrast (spec §37, WCAG 2.2 AA)', () => {
  it('reads the tokens', () => {
    expect(Object.keys(tokens).length).toBeGreaterThan(15);
  });

  it('body and secondary text reach 4.5:1 on every surface', () => {
    for (const text of ['jp-text', 'jp-text-2']) {
      for (const surface of SURFACES) expect(contrast(tokens[text], tokens[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('muted text, the accent and status colors reach 4.5:1 on the surfaces they sit on', () => {
    for (const color of ['jp-text-3', 'jp-accent', 'jp-success', 'jp-warning', 'jp-danger']) {
      for (const surface of SURFACES) expect(contrast(tokens[color], tokens[surface]), `${color} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('status badge text reaches 4.5:1 on its tinted background', () => {
    const soft = Object.fromEntries([...css
      .matchAll(/--(jp-[a-z]+-soft):\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)].map((m) => [m[1], m.slice(2).map(Number)]));
    const over = (rgba: number[], hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const base = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      return `#${base.map((b, i) => Math.round(rgba[i] * rgba[3] + b * (1 - rgba[3])).toString(16).padStart(2, '0')).join('')}`;
    };
    for (const tone of ['success', 'warning', 'danger', 'accent']) {
      for (const surface of ['jp-surface-1', 'jp-surface-2']) {
        const background = over(soft[`jp-${tone}-soft`], tokens[surface]);
        expect(contrast(tokens[`jp-${tone}`], background), `${tone} on ${tone}-soft over ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('text on the accent (primary buttons, selected tabs) reaches 4.5:1', () => {
    expect(contrast(tokens['jp-on-accent'], tokens['jp-accent'])).toBeGreaterThanOrEqual(4.5);
  });

  it('borders that outline controls reach 3:1 where they are the only boundary (focus ring)', () => {
    expect(contrast(tokens['jp-accent'], tokens['jp-bg'])).toBeGreaterThanOrEqual(3);
  });
});
