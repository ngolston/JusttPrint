import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './Button';
import type { StatusTone } from './Badge';

interface PanelProps {
  title?: ReactNode;
  /** A link-style action on the right of the title (e.g. "View All"). */
  action?: { label: string; onClick: () => void };
  children: ReactNode;
  className?: string;
  /** Padding inside the card; 'none' for content that runs to the edges. */
  padding?: 'md' | 'none';
  as?: 'section' | 'div' | 'article';
  labelledBy?: string;
}

/** The base card (spec §29): surface 1, 1px border, 12px radius. */
export function Panel({ title, action, children, className, padding = 'md', as: Tag = 'section', labelledBy }: PanelProps) {
  return (
    <Tag className={cx('jp-card', padding === 'none' && 'jp-card--flush', className)} aria-labelledby={labelledBy}>
      {(title || action) && (
        <header className="jp-card__header">
          {title && <h2 className="jp-panel-title" id={labelledBy}>{title}</h2>}
          {action && <button type="button" className="jp-link jp-card__action" onClick={action.onClick}>{action.label}</button>}
        </header>
      )}
      {children}
    </Tag>
  );
}

/** One figure of the dashboard hero (spec §10): tinted icon, number, label. */
export function StatCard({ icon: Icon, value, label, tone = 'accent', onClick }: { icon: LucideIcon; value: ReactNode; label: string; tone?: StatusTone | 'violet'; onClick?: () => void }) {
  const body = (
    <>
      <span className={cx('jp-stat__icon', `jp-tone--${tone}`)}><Icon size={20} aria-hidden="true" /></span>
      <span className="jp-stat__text">
        <span className="jp-stat__value">{value}</span>
        <span className="jp-stat__label">{label}</span>
      </span>
    </>
  );
  return onClick
    ? <button type="button" className="jp-stat jp-stat--button" onClick={onClick}>{body}</button>
    : <div className="jp-stat">{body}</div>;
}

/** A thin progress bar with an accessible value (spec §8, §14). */
export function ProgressBar({ value, max = 100, label, tone = 'accent', className }: { value: number; max?: number; label: string; tone?: StatusTone; className?: string }) {
  const safeMax = max > 0 ? max : 100;
  const percent = Math.max(0, Math.min(100, (value / safeMax) * 100));
  return (
    <div className={cx('jp-progress', `jp-progress--${tone}`, className)} role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={safeMax} aria-valuenow={Math.max(0, Math.min(value, safeMax))}>
      <div className="jp-progress__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A loading placeholder in the shape of the content (spec §50). */
export function Skeleton({ width, height = 14, radius = 'sm', className }: { width?: number | string; height?: number | string; radius?: 'sm' | 'md' | 'lg' | 'pill'; className?: string }) {
  return <span className={cx('jp-skeleton', `jp-skeleton--${radius}`, className)} style={{ width, height }} aria-hidden="true" />;
}

/** Never a blank panel: what is missing, and the next step (spec §49, §51). */
export function EmptyState({ icon: Icon, title, children, action, tone = 'neutral' }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode; tone?: 'neutral' | 'danger' }) {
  return (
    <div className={cx('jp-empty', tone === 'danger' && 'jp-empty--danger')} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="jp-empty__icon"><Icon size={22} aria-hidden="true" /></span>
      <p className="jp-empty__title">{title}</p>
      {children && <p className="jp-empty__text">{children}</p>}
      {action && <div className="jp-empty__action">{action}</div>}
    </div>
  );
}
