import { useState, type ReactNode, type SelectHTMLAttributes } from 'react';

/** What a long list draws: every item while it is open, else only the item it shows (if any). */
export function drawnItems<T>(items: readonly T[], optionValue: (item: T) => string, value: string, open: boolean): readonly T[] {
  if (open) return items;
  const shown = value ? items.find((item) => optionValue(item) === value) : undefined;
  return shown === undefined ? [] : [shown];
}

interface LongSelectProps<T> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  /** The choices always drawn: the first ("All…", "No change"), a value missing from items. */
  children?: ReactNode;
  /** Every value of the library (tags, titles, designers): thousands in a large one. */
  items: readonly T[];
  optionValue?: (item: T) => string;
  optionLabel?: (item: T) => string;
}

/**
 * A <select> over a list that can be thousands long. It draws its items only while it has the
 * focus (a click or Tab gives it the focus before the list opens): a large library's tags,
 * titles and designers would otherwise put tens of thousands of <option> elements in the page
 * whenever a details or Multi-edit panel fills in.
 */
export function LongSelect<T = string>({
  children,
  items,
  optionValue = String,
  optionLabel = optionValue,
  onFocus,
  onBlur,
  onPointerDown,
  ...rest
}: LongSelectProps<T>) {
  const [open, setOpen] = useState(false);
  // Disabling the focused select (a filter is disabled while its search runs) takes the focus
  // away during React's commit, when React drops events: onBlur never comes, and the whole list
  // would stay drawn. A disabled select cannot have the focus, so it closes.
  if (open && rest.disabled) setOpen(false);
  const value = typeof rest.value === 'string' ? rest.value : '';
  return (
    <select
      {...rest}
      onPointerDown={(event) => {
        setOpen(true);
        onPointerDown?.(event);
      }}
      onFocus={(event) => {
        setOpen(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setOpen(false);
        onBlur?.(event);
      }}
    >
      {children}
      {drawnItems(items, optionValue, value, open).map((item) => {
        const v = optionValue(item);
        return (
          <option key={v} value={v}>
            {optionLabel(item)}
          </option>
        );
      })}
    </select>
  );
}
