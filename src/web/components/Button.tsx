import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Lucide icon before the label. */
  icon?: LucideIcon;
  /** Lucide icon after the label (e.g. a chevron). */
  iconEnd?: LucideIcon;
  children?: ReactNode;
}

/**
 * Primary (cyan), secondary (graphite with a border), ghost (quiet until hovered) or danger
 * (red, only for destructive actions). Spec §30.
 */
export function Button({ variant = 'secondary', size = 'md', icon: Icon, iconEnd: IconEnd, className, children, type = 'button', ...rest }: ButtonProps) {
  const iconSize = size === 'lg' ? 18 : 16;
  return (
    <button type={type} className={cx('jp-btn', `jp-btn--${variant}`, `jp-btn--${size}`, className)} {...rest}>
      {Icon && <Icon size={iconSize} aria-hidden="true" />}
      {children !== undefined && <span>{children}</span>}
      {IconEnd && <IconEnd size={iconSize} aria-hidden="true" />}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Required: the button has no visible text (spec §37). */
  label: string;
  size?: ButtonSize;
  /** A toggle that is on (e.g. Favorite). */
  pressed?: boolean;
}

/** A square icon-only button with an accessible name and a matching tooltip. */
export function IconButton({ icon: Icon, label, size = 'md', pressed, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('jp-icon-btn', `jp-icon-btn--${size}`, pressed && 'is-pressed', className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      {...rest}
    >
      <Icon size={size === 'sm' ? 16 : 18} aria-hidden="true" />
    </button>
  );
}

export { cx };
