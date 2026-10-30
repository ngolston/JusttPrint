import type { CSSProperties, ReactNode } from 'react';
import { cx } from './Button';

/** A dashboard of tiles: four columns, rows at least 210 px, one column under 900 px. */
export function BentoGrid({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <div className={cx('jp-bento', className)} role={label ? 'region' : undefined} aria-label={label}>
      {children}
    </div>
  );
}

export type TileVariant = 'white' | 'ink' | 'accent' | 'quiet';

/**
 * One tile, answering one question. `white` is the usual card, `ink` the dark feature tile, `accent`
 * the coral "needs you" tile, `quiet` the grey one for secondary things ("Other printers").
 * `col` and `row` are where it starts (1-based) and `cols`/`rows` how far it spans.
 */
export function Tile({
  variant = 'white',
  title,
  action,
  col,
  row,
  cols = 1,
  rows = 1,
  children,
  className
}: {
  variant?: TileVariant;
  /** The tile heading, also its name for screen readers. */
  title?: string;
  /** Right of the heading: a link or a count. */
  action?: ReactNode;
  col?: number;
  row?: number;
  cols?: number;
  rows?: number;
  children?: ReactNode;
  className?: string;
}) {
  const style: CSSProperties = {
    gridColumn: col ? `${col} / span ${cols}` : cols > 1 ? `span ${cols}` : undefined,
    gridRow: row ? `${row} / span ${rows}` : rows > 1 ? `span ${rows}` : undefined
  };
  return (
    <section className={cx('jp-tile', `jp-tile--${variant}`, className)} style={style} aria-label={title}>
      {(title || action) && (
        <div className="jp-tile__head">
          {title && <h2 className="jp-tile__heading">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A tile's big figure ("18.6 kg") with a word under it. */
export function TileFigure({ value, label, size = 'md' }: { value: ReactNode; label?: ReactNode; size?: 'md' | 'lg' }) {
  return (
    <div className="jp-tile-figure">
      <div className={cx('jp-tile-figure__value', size === 'lg' && 'jp-tile-figure__value--lg')}>{value}</div>
      {label && <div className="jp-tile-figure__label">{label}</div>}
    </div>
  );
}
