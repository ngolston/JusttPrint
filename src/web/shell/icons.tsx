/** The phone layout's icons (24×24, currentColor). */
const PATHS = {
  grid: 'M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z',
  list: 'M4 5.5h16v2.6H4V5.5zm0 5.2h16v2.6H4v-2.6zm0 5.2h16v2.6H4v-2.6z',
  folder: 'M2 6.5A2.5 2.5 0 0 1 4.5 4H9l2 2.2h8.5A2.5 2.5 0 0 1 22 8.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5v-11z',
  filter: 'M3 4.5h18v2.4l-6.2 6.8V20l-5.6 2.2v-8.5L3 6.9V4.5z',
  filament: 'M12 2a10 10 0 1 0 .01 20.01A10 10 0 0 0 12 2zm0 4.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6z',
  printer: 'M6 3h12v5H6V3zm-2 7h16a2 2 0 0 1 2 2v5h-4v4H6v-4H2v-5a2 2 0 0 1 2-2zm6 7v2h4v-2h-4z',
  parts: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a5 5 0 0 1-6.6 6.6L8.4 18.6a2 2 0 1 1-2.8-2.8l6.5-6.5a5 5 0 0 1 6.6-6.6l-3.8 3.8z',
  tag: 'M3 12.5V4h8.5l9.2 9.2a2 2 0 0 1 0 2.8l-5.7 5.7a2 2 0 0 1-2.8 0L3 12.5zM7.5 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  dedup: 'M7 3h10a2 2 0 0 1 2 2v10h-2V5H7V3zm-2 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  organize: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 2h7v5h-7v-5z',
  roulette: 'M12 2a10 10 0 1 0 .01 20.01A10 10 0 0 0 12 2zm0 4a1.4 1.4 0 1 1 0 2.8A1.4 1.4 0 0 1 12 6zm5 7.5a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8zM12 16.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zM7 13.5a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8z',
  cube: 'M12 2.2 20.5 7v10L12 21.8 3.5 17V7L12 2.2zm0 2.3L6 8.2v6.3l6 3.4 6-3.4V8.2L12 4.5z',
  heart: 'M12 20.2s-6.8-4.3-9.2-8.2C1 9.2 2.2 5.8 5.6 5.2 7.6 4.8 9.4 5.8 12 8.2c2.6-2.4 4.4-3.4 6.4-3 3.4.6 4.6 4 2.8 6.8-2.4 3.9-9.2 8.2-9.2 8.2z',
  log: 'M6 3h9l3 3v15H6V3zm8 1.5V7h2.5L14 4.5zM8 11h8v1.8H8V11zm0 3.2h8v1.8H8v-1.8zM8 17.4h5.2V19H8v-1.6z'
};

export type IconName = keyof typeof PATHS | 'more';

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {name === 'more'
        ? [5, 12, 19].map((cx) => <circle key={cx} cx={cx} cy="12" r="2.35" fill="currentColor" />)
        : <path fill="currentColor" d={PATHS[name]} />}
    </svg>
  );
}
