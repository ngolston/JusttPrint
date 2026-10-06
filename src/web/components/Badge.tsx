import type { ReactNode } from 'react';
import { CheckCircle2, CircleDashed, Clock, Heart, LoaderCircle, Plus, X, XCircle, type LucideIcon } from 'lucide-react';
import { cx } from './Button';

/** A compact neutral label: file format, material (spec §19). */
export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span className={cx('jp-badge', className)} title={title}>{children}</span>;
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

const TONE_ICONS: Record<StatusTone, LucideIcon> = {
  success: CheckCircle2,
  warning: Clock,
  danger: XCircle,
  accent: LoaderCircle,
  neutral: CircleDashed
};

/** Status with an icon and a word, never color alone (spec §37). */
export function StatusBadge({ tone, children, icon, className }: { tone: StatusTone; children: ReactNode; icon?: LucideIcon; className?: string }) {
  const Icon = icon ?? TONE_ICONS[tone];
  return (
    <span className={cx('jp-status', `jp-status--${tone}`, className)}>
      <Icon size={12} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

export type PrintStatus = 'unprinted' | 'want' | 'queued' | 'printing' | 'printed' | 'failed';

const PRINT_STATUS: Record<PrintStatus, { tone: StatusTone; label: string; icon?: LucideIcon }> = {
  unprinted: { tone: 'neutral', label: 'Unprinted' },
  want: { tone: 'neutral', label: 'Want', icon: Heart },
  queued: { tone: 'warning', label: 'In Queue' },
  printing: { tone: 'accent', label: 'Printing' },
  printed: { tone: 'success', label: 'Printed' },
  failed: { tone: 'danger', label: 'Failed' }
};

/** The print-state badge of a model card or details panel. Unknown values read as Unprinted. */
export function printStatusInfo(status: string | null | undefined) {
  const key = String(status || 'unprinted').toLowerCase() as PrintStatus;
  return PRINT_STATUS[key] ?? PRINT_STATUS.unprinted;
}

export function PrintStatusBadge({ status }: { status: string | null | undefined }) {
  const info = printStatusInfo(status);
  return <StatusBadge tone={info.tone} icon={info.icon}>{info.label}</StatusBadge>;
}

/** A tag pill; removable when onRemove is given (spec §24). */
export function Tag({ children, onClick, onRemove }: { children: ReactNode; onClick?: () => void; onRemove?: () => void }) {
  const label = typeof children === 'string' ? children : 'tag';
  return (
    <span className="jp-tag">
      {onClick
        ? <button type="button" className="jp-tag__label" onClick={onClick}>{children}</button>
        : <span className="jp-tag__label">{children}</span>}
      {onRemove && (
        <button type="button" className="jp-tag__remove" aria-label={`Remove ${label}`} title={`Remove ${label}`} onClick={onRemove}>
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** The round "+" after a tag list. */
export function AddTagButton({ onClick, label = 'Add tag' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="jp-tag jp-tag--add" aria-label={label} title={label} onClick={onClick}>
      <Plus size={14} aria-hidden="true" />
    </button>
  );
}
