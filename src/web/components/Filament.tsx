import type { CSSProperties } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { formatGrams } from '../format';
import { cx } from './Button';

/*
 * Filament pieces of the Bento look (docs/design-bento.md): spool rings, color dots, the
 * placeholder art, the "Ready to print" badge and the per-color filament check. Filament colors
 * are data (a spool's or a plate's own color), so they are the only raw colors here, set inline.
 */

/** Under this many grams a spool is nearly empty (coral ring). */
export const SPOOL_EMPTY_G = 50;
/** Under this many grams a spool is running low (light coral ring). */
export const SPOOL_LOW_G = 300;

export type SpoolLevel = 'empty' | 'low' | 'ok';

/** How full a spool reads: coral under 50 g, light coral under 300 g. */
export function spoolLevel(remaining: number): SpoolLevel {
  if (remaining < SPOOL_EMPTY_G) return 'empty';
  if (remaining < SPOOL_LOW_G) return 'low';
  return 'ok';
}

/** The share of the spool left, 0 to 1. */
export function spoolShare(remaining: number, capacity: number): number {
  if (!(capacity > 0)) return 0;
  return Math.min(1, Math.max(0, remaining / capacity));
}

/**
 * A spool as a ring filled to its remaining share, its color in the middle (sizes 28–84 px).
 * `onInk` draws the track for a dark tile.
 */
export function SpoolRing({
  color,
  remaining,
  capacity = 1000,
  size = 40,
  name,
  onInk = false
}: {
  color: string;
  remaining: number;
  capacity?: number;
  size?: number;
  /** "PLA Blue": with it the ring has a spoken name; without it, it is decoration. */
  name?: string;
  onInk?: boolean;
}) {
  const share = spoolShare(remaining, capacity);
  const label = name ? `${name}, ${formatGrams(remaining)} left of ${formatGrams(capacity)}` : undefined;
  return (
    <span
      className={cx('jp-spool-ring', `jp-spool-ring--${spoolLevel(remaining)}`, onInk && 'jp-spool-ring--on-ink')}
      style={{ '--jp-ring-size': `${size}px`, '--jp-ring-share': `${Math.round(share * 360)}deg`, '--jp-ring-color': color } as CSSProperties}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span className="jp-spool-ring__core" />
    </span>
  );
}

/** A filament color dot; ringed in coral when that color is short. */
export function ColorDot({ color, short = false, size = 13, name }: { color: string; short?: boolean; size?: number; name?: string }) {
  const label = name ? (short ? `${name}, short` : name) : undefined;
  return (
    <span
      className={cx('jp-color-dot', short && 'is-short')}
      style={{ '--jp-dot-size': `${size}px`, background: color } as CSSProperties}
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

const hexToRgb = (hex: string): [number, number, number] => {
  const clean = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? '8b8f96';
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (rgb: number[]) =>
  `#${rgb
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
/** `hex` moved toward `target` by `amount` (0 to 1). */
const mix = (hex: string, target: [number, number, number], amount: number) => rgbToHex(hexToRgb(hex).map((c, i) => c + (target[i] - c) * amount));

/** The four shades of the placeholder art for a color: ground, top, left and right faces. */
export function isoShades(hex: string) {
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  return { ground: mix(hex, white, 0.84), top: mix(hex, white, 0.4), left: rgbToHex(hexToRgb(hex)), right: mix(hex, black, 0.25) };
}

function IsoBlock({ color, transform }: { color: string; transform: string }) {
  const s = isoShades(color);
  return (
    <g transform={transform}>
      <path d="M40 0 80 22 40 44 0 22z" fill={s.top} />
      <path d="M0 22 40 44v40L0 62z" fill={s.left} />
      <path d="M80 22 40 44v40l40-22z" fill={s.right} />
    </g>
  );
}

/**
 * Placeholder art when a model has no picture: an isometric block in the model's first filament
 * color, optionally a second one. Real thumbnails always win; this is only for when there is none.
 */
export function IsoThumb({
  color,
  second,
  tall = false,
  size = 120,
  ground = true
}: {
  color: string;
  second?: string;
  tall?: boolean;
  size?: number;
  ground?: boolean;
}) {
  const style = ground ? { background: isoShades(color).ground } : undefined;
  return (
    <span className="jp-iso" style={style} aria-hidden="true">
      <svg width={size} height={(size * 110) / 120} viewBox="0 0 120 110">
        <IsoBlock color={color} transform={tall ? 'translate(20 24)' : second ? 'translate(20 14)' : 'translate(20 20)'} />
        {second && <IsoBlock color={second} transform={tall ? 'translate(28 0) scale(.8)' : 'translate(64 54) scale(.55)'} />}
      </svg>
    </span>
  );
}

/** "Ready to print", or "Need black, white" for the colors that are short. */
export function fitLabel(missing: string[]): string {
  return missing.length ? `Need ${missing.join(', ')}` : 'Ready to print';
}

/** The filament check's verdict on a card or a list row. */
export function FitBadge({ missing, className }: { missing: string[]; className?: string }) {
  const ready = missing.length === 0;
  const Icon = ready ? Check : CircleAlert;
  return (
    <span className={cx('jp-fit', ready ? 'jp-fit--ready' : 'jp-fit--short', className)}>
      <Icon size={12} aria-hidden="true" />
      <span>{fitLabel(missing)}</span>
    </span>
  );
}

/** One color a plate needs, and the spool matched to it (if any). */
export interface FilamentNeed {
  /** "Gray PETG" */
  label: string;
  color: string;
  grams: number;
  spool?: {
    name: string;
    /** "AMS A1", a storage location, … */
    where?: string;
    remaining: number;
  } | null;
}

/** What a need comes to: grams left on the spool afterwards, or grams short. */
export function checkNeed(need: FilamentNeed): { ok: boolean; grams: number; text: string } {
  const left = (need.spool?.remaining ?? 0) - need.grams;
  if (left >= 0) return { ok: true, grams: left, text: `✓ ${formatGrams(left)} left` };
  return { ok: false, grams: -left, text: `${formatGrams(-left)} short` };
}

/** One row per needed color: dot, color and grams, the matched spool and slot, and the result. */
export function FilamentCheck({ needs, label = 'Filament check' }: { needs: FilamentNeed[]; label?: string }) {
  return (
    <ul className="jp-filament-check" aria-label={label}>
      {needs.map((need, index) => {
        const result = checkNeed(need);
        const spool = need.spool ? [need.spool.name, need.spool.where, formatGrams(need.spool.remaining)].filter(Boolean).join(' · ') : 'No matching spool';
        return (
          <li key={`${need.label}-${index}`} className={cx('jp-filament-check__row', !result.ok && 'is-short')}>
            <ColorDot color={need.color} short={!result.ok} size={30} />
            <span className="jp-filament-check__what">
              <span className="jp-filament-check__need">
                {need.label} · {formatGrams(need.grams)}
              </span>
              <span className="jp-filament-check__spool">{spool}</span>
            </span>
            <span className={cx('jp-filament-check__result', result.ok ? 'is-ok' : 'is-short')}>{result.text}</span>
          </li>
        );
      })}
    </ul>
  );
}
