import { forwardRef, type InputHTMLAttributes } from 'react';
import { Search } from 'lucide-react';

/** "⌘ K" on Apple devices, "Ctrl K" elsewhere. */
export function shortcutLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘ K' : 'Ctrl K';
}

interface SearchBoxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Shows the keyboard shortcut hint on the right (spec §9). */
  shortcut?: string;
  label: string;
}

/** The global search field: icon, placeholder, shortcut hint. */
export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(function SearchBox({ shortcut, label, className, ...rest }, ref) {
  return (
    <label className={['jp-search', className].filter(Boolean).join(' ')}>
      <Search size={18} aria-hidden="true" className="jp-search__icon" />
      <input ref={ref} type="search" aria-label={label} autoComplete="off" spellCheck={false} {...rest} />
      {shortcut && (
        <kbd className="jp-search__kbd" aria-hidden="true">
          {shortcut}
        </kbd>
      )}
    </label>
  );
});
