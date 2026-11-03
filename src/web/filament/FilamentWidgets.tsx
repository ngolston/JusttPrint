import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Shuffle } from 'lucide-react';
import type { Spool } from '../api';
import { Tile } from '../components/Bento';
import { Button, cx } from '../components/Button';
import { SpoolRing } from '../components/Filament';
import { Modal } from '../components/Overlay';
import { timeAgo } from '../home/format';
import { formatTemperatureRange } from '../units';
import { fieldFilter, formatWeight, spoolNumber, type SpoolFilter } from './format';

/*
 * The Filament page's widgets: which show and in what order is each person's choice (Widgets on
 * the page), kept in the per-person setting filamentWidgets. Color wall, Material guide, Brand
 * shelf and Spool of the day live here; the older tiles stay in FilamentPage.tsx.
 */

export const WIDGETS = [
  { id: 'on-hand', name: 'On hand', description: 'Grams on hand, by material and color.' },
  { id: 'add', name: 'Add a spool', description: 'The ways to add spools.' },
  { id: 'reorder', name: 'Reorder', description: 'Filaments running low, for the shopping list.' },
  { id: 'loaded', name: 'Loaded in printers', description: 'What each printer has loaded.' },
  { id: 'dryer', name: 'Dryer', description: 'What is drying and how long it has left (only while something dries).' },
  { id: 'color-wall', name: 'Color wall', description: 'Every color you have, by hue; find the closest to one you need.' },
  { id: 'material-guide', name: 'Material guide', description: 'Typical settings and how each material prints.' },
  { id: 'brand-shelf', name: 'Brand shelf', description: 'Your brands with their spools and grams.' },
  { id: 'spool-of-the-day', name: 'Spool of the day', description: 'A spool you have not used in a while.' }
] as const;
export type WidgetId = (typeof WIDGETS)[number]['id'];
const IDS = WIDGETS.map((w) => w.id) as WidgetId[];

export interface WidgetPrefs {
  order: WidgetId[];
  hidden: WidgetId[];
}

/** The stored choice, with widgets it does not know dropped and new ones added at the end, shown. */
export function parseWidgetPrefs(raw: string | null | undefined): WidgetPrefs {
  let value: { order?: unknown; hidden?: unknown } = {};
  try {
    value = JSON.parse(raw || '{}') || {};
  } catch {
    value = {};
  }
  const known = (list: unknown) => (Array.isArray(list) ? [...new Set(list.map(String))].filter((id): id is WidgetId => IDS.includes(id as WidgetId)) : []);
  const order = known(value.order);
  return { order: [...order, ...IDS.filter((id) => !order.includes(id))], hidden: known(value.hidden) };
}

/** The widgets to show, in order. */
export const shownWidgets = (prefs: WidgetPrefs) => prefs.order.filter((id) => !prefs.hidden.includes(id));

/** Choose the widgets and their order. */
export function WidgetsDialog({ prefs, onChange, onClose }: { prefs: WidgetPrefs; onChange: (next: WidgetPrefs) => void; onClose: () => void }) {
  const move = (index: number, by: number) => {
    const order = prefs.order.slice();
    const [item] = order.splice(index, 1);
    order.splice(index + by, 0, item);
    onChange({ ...prefs, order });
  };
  const toggle = (id: WidgetId) => onChange({ ...prefs, hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id] });
  return (
    <Modal
      open
      onClose={onClose}
      title="Widgets"
      id="jp-filament-widgets-dialog"
      className="jp-filament-form"
      footer={
        <>
          <Button variant="ghost" onClick={() => onChange(parseWidgetPrefs(null))} id="jp-widgets-reset">
            Show all, first order
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className="jp-meta">Tick the widgets to show on the Filament page and move them into the order you like. Your choice is yours alone.</p>
      <ol className="jp-widgets__list">
        {prefs.order.map((id, index) => {
          const widget = WIDGETS.find((w) => w.id === id)!;
          return (
            <li key={id} className="jp-widgets__item">
              <label className="jp-filament-form__check jp-widgets__check">
                <input type="checkbox" checked={!prefs.hidden.includes(id)} onChange={() => toggle(id)} data-widget={id} />
                <span>
                  <span className="jp-widgets__name">{widget.name}</span>
                  <span className="jp-meta">{widget.description}</span>
                </span>
              </label>
              <span className="jp-widgets__move">
                <button type="button" className="jp-icon-btn" aria-label={`Move ${widget.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="jp-icon-btn"
                  aria-label={`Move ${widget.name} down`}
                  disabled={index === prefs.order.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </Modal>
  );
}

// ---- Color wall ----

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Hue (0–360), saturation and lightness (0–1). */
export function hsl(hex: string): [number, number, number] {
  const c = rgb(hex) || [128, 128, 128];
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return [h, s, l];
}

/** Spools by hue around the wheel, greys, blacks and whites after them from dark to light. */
export function byHue<T extends { color_hex: string | null }>(spools: T[]): T[] {
  const key = (spool: T) => {
    const [h, s, l] = hsl(spool.color_hex || '');
    return s < 0.12 || l < 0.08 || l > 0.94 ? 1000 + l : h + l / 10;
  };
  return spools.slice().sort((a, b) => key(a) - key(b));
}

export function colorDistance(a: string, b: string): number {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return Infinity;
  // Weighted for how eyes see it (red mean).
  const rm = (x[0] + y[0]) / 2;
  const [dr, dg, db] = [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

const onHand = (spools: Spool[]) => spools.filter((spool) => spool.status !== 'archived');

export function ColorWall({ spools, onOpen }: { spools: Spool[]; onOpen: (spool: Spool) => void }) {
  const colored = useMemo(() => byHue(onHand(spools).filter((spool) => rgb(spool.color_hex || ''))), [spools]);
  const [wanted, setWanted] = useState('');
  const closest = useMemo(
    () =>
      wanted
        ? colored
            .slice()
            .sort((a, b) => colorDistance(a.color_hex!, wanted) - colorDistance(b.color_hex!, wanted))
            .slice(0, 3)
        : [],
    [colored, wanted]
  );
  if (!colored.length) return null;
  return (
    <Tile title="Color wall" cols={2} className="jp-color-wall" action={<span className="jp-meta">{colored.length} colors</span>}>
      <div className="jp-color-wall__swatches" role="list" aria-label="Your colors">
        {colored.map((spool) => (
          <button
            key={spool.id}
            type="button"
            role="listitem"
            className={cx('jp-color-wall__swatch', closest.includes(spool) && 'is-close')}
            style={{ background: spool.color_hex! }}
            title={`${spool.display_name}${spool.brand_name ? ` · ${spool.brand_name}` : ''} · ${formatWeight(spool.remaining)} left`}
            aria-label={`${spoolNumber(spool)} ${spool.display_name}, ${formatWeight(spool.remaining)} left`}
            onClick={() => onOpen(spool)}
          />
        ))}
      </div>
      <div className="jp-color-wall__find">
        <label className="jp-color-wall__pick">
          <span className="jp-meta">Closest to</span>
          <input
            type="color"
            id="jp-color-wall-wanted"
            value={wanted || '#2f6fdf'}
            onChange={(event) => setWanted(event.target.value)}
            aria-label="A color you need"
          />
        </label>
        {closest.length > 0 ? (
          <span className="jp-color-wall__closest" id="jp-color-wall-closest">
            {closest.map((spool) => (
              <button key={spool.id} type="button" className="jp-link" onClick={() => onOpen(spool)}>
                {spool.display_name}
              </button>
            ))}
          </span>
        ) : (
          <span className="jp-meta">Pick a color to find your nearest spools.</span>
        )}
      </div>
    </Tile>
  );
}

// ---- Material guide ----

export interface MaterialInfo {
  id: string;
  name: string;
  nozzle: [number, number];
  bed: [number, number];
  enclosure: string;
  moisture: string;
  difficulty: string;
  dry: string;
  notes: string;
}

/** Typical values from filament makers; a filament's own settings come first. */
export const MATERIAL_GUIDE: MaterialInfo[] = [
  {
    id: 'PLA',
    name: 'PLA',
    nozzle: [190, 220],
    bed: [50, 60],
    enclosure: 'No; keep it open or the door ajar',
    moisture: 'Low',
    difficulty: 'Easy',
    dry: '45–55 °C, 4–6 h',
    notes: 'Stiff and detailed; softens around 55 °C, so not for hot cars.'
  },
  {
    id: 'PETG',
    name: 'PETG',
    nozzle: [230, 250],
    bed: [70, 85],
    enclosure: 'No',
    moisture: 'Medium',
    difficulty: 'Easy to medium',
    dry: '60–65 °C, 4–6 h',
    notes: 'Tougher than PLA and takes heat to about 70 °C; strings when wet or too hot. Use glue or a textured plate on smooth PEI.'
  },
  {
    id: 'ABS',
    name: 'ABS',
    nozzle: [240, 260],
    bed: [90, 110],
    enclosure: 'Yes',
    moisture: 'Low to medium',
    difficulty: 'Medium',
    dry: '70–80 °C, 4 h',
    notes: 'Strong and heat-resistant; warps and cracks in drafts. Gives off fumes: ventilate.'
  },
  {
    id: 'ASA',
    name: 'ASA',
    nozzle: [240, 260],
    bed: [90, 110],
    enclosure: 'Yes',
    moisture: 'Low to medium',
    difficulty: 'Medium',
    dry: '70–80 °C, 4 h',
    notes: 'Like ABS but stands up to sun and weather: the one for outdoor parts.'
  },
  {
    id: 'TPU',
    name: 'TPU',
    nozzle: [210, 230],
    bed: [40, 60],
    enclosure: 'No',
    moisture: 'High',
    difficulty: 'Hard',
    dry: '50–55 °C, 4–8 h',
    notes: 'Flexible. Print slowly, with little retraction; direct drive works best and most AMS units cannot feed soft grades.'
  },
  {
    id: 'PA',
    name: 'PA (Nylon)',
    nozzle: [250, 280],
    bed: [70, 100],
    enclosure: 'Yes',
    moisture: 'Very high',
    difficulty: 'Hard',
    dry: '70–80 °C, 8–12 h',
    notes: 'Very tough and wear-resistant. Dry it before every print. Carbon or glass fiber grades (PA-CF) need a hardened nozzle.'
  },
  {
    id: 'PC',
    name: 'PC',
    nozzle: [260, 300],
    bed: [100, 120],
    enclosure: 'Yes',
    moisture: 'High',
    difficulty: 'Hard',
    dry: '70–80 °C, 6 h',
    notes: 'Strong, clear grades exist, takes heat over 100 °C; needs a hot bed and an enclosure.'
  },
  {
    id: 'PVA',
    name: 'PVA',
    nozzle: [190, 220],
    bed: [45, 60],
    enclosure: 'No',
    moisture: 'Very high',
    difficulty: 'Medium',
    dry: '45–55 °C, 6–8 h',
    notes: 'Support that dissolves in water, for PLA. Keep it sealed with desiccant.'
  },
  {
    id: 'HIPS',
    name: 'HIPS',
    nozzle: [230, 250],
    bed: [90, 110],
    enclosure: 'Yes',
    moisture: 'Low',
    difficulty: 'Medium',
    dry: '60–70 °C, 4 h',
    notes: 'Support for ABS that dissolves in limonene; light and easy to sand.'
  }
];

/** The guide entry for a spool's material: PLA+ and PLA Silk are PLA, PA6-CF is PA, PETG HF is PETG. */
export function guideFor(material: string | null | undefined): MaterialInfo | null {
  const m = String(material || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (!m) return null;
  if (m.startsWith('PETG') || m.startsWith('PET') || m.startsWith('PCTG')) return MATERIAL_GUIDE.find((g) => g.id === 'PETG')!;
  if (m.startsWith('PA')) return MATERIAL_GUIDE.find((g) => g.id === 'PA')!;
  return MATERIAL_GUIDE.find((g) => m.startsWith(g.id)) || null;
}

export function MaterialGuide({ spools, onShow }: { spools: Spool[]; onShow: (filter: SpoolFilter) => void }) {
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const spool of onHand(spools)) {
      const guide = guideFor(spool.material);
      if (guide) map.set(guide.id, (map.get(guide.id) || 0) + 1);
    }
    return map;
  }, [spools]);
  const ordered = useMemo(() => MATERIAL_GUIDE.slice().sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)), [counts]);
  const [chosen, setChosen] = useState('');
  const info = ordered.find((g) => g.id === chosen) || ordered[0];
  const mine = onHand(spools).filter((spool) => guideFor(spool.material)?.id === info.id);
  const rows: [string, string][] = [
    ['Nozzle', formatTemperatureRange(info.nozzle[0], info.nozzle[1])],
    ['Bed', formatTemperatureRange(info.bed[0], info.bed[1])],
    ['Enclosure', info.enclosure],
    ['Moisture', info.moisture],
    ['Printing', info.difficulty],
    ['Drying', info.dry]
  ];
  return (
    <Tile title="Material guide" cols={2} className="jp-material-guide">
      <label className="jp-material-guide__pick">
        <span className="jp-sr-only">Material</span>
        <select id="jp-material-guide-select" className="jp-input" value={info.id} onChange={(event) => setChosen(event.target.value)}>
          {ordered.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
              {counts.get(g.id) ? ` (${counts.get(g.id)} ${counts.get(g.id) === 1 ? 'spool' : 'spools'})` : ''}
            </option>
          ))}
        </select>
      </label>
      <dl className="jp-material-guide__facts">
        {rows.map(([name, value]) => (
          <div key={name} className="jp-material-guide__fact">
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="jp-material-guide__notes">{info.notes}</p>
      <p className="jp-meta jp-material-guide__foot">
        Typical values: your filament&apos;s own settings come first.
        {mine.length > 0 && (
          <>
            {' '}
            <button type="button" className="jp-link" onClick={() => onShow(`material:${mine[0].material}`)} id="jp-material-guide-show">
              Show your {info.name} spools
            </button>
          </>
        )}
      </p>
    </Tile>
  );
}

// ---- Brand shelf ----

export function brandShelf(spools: Spool[]): { name: string; count: number; grams: number; colors: string[] }[] {
  const map = new Map<string, { name: string; count: number; grams: number; colors: string[] }>();
  for (const spool of onHand(spools)) {
    const name = String(spool.brand_name || '').trim();
    if (!name) continue;
    const entry = map.get(name.toLowerCase()) || { name, count: 0, grams: 0, colors: [] };
    entry.count++;
    entry.grams += spool.remaining;
    if (spool.color_hex && entry.colors.length < 6 && !entry.colors.includes(spool.color_hex)) entry.colors.push(spool.color_hex);
    map.set(name.toLowerCase(), entry);
  }
  return [...map.values()].sort((a, b) => b.grams - a.grams || a.name.localeCompare(b.name));
}

export function BrandShelf({ spools, onShow }: { spools: Spool[]; onShow: (filter: SpoolFilter) => void }) {
  const brands = useMemo(() => brandShelf(spools), [spools]);
  if (!brands.length) return null;
  return (
    <Tile
      title="Brand shelf"
      cols={2}
      className="jp-brand-shelf"
      action={<span className="jp-meta">{brands.length === 1 ? '1 brand' : `${brands.length} brands`}</span>}
    >
      <ul className="jp-brand-shelf__list">
        {brands.map((brand) => (
          <li key={brand.name}>
            <button
              type="button"
              className="jp-brand-shelf__brand"
              onClick={() => onShow(fieldFilter('brand', brand.name))}
              title={`Show the ${brand.name} spools`}
            >
              <span className="jp-brand-shelf__name">{brand.name}</span>
              <span className="jp-brand-shelf__dots" aria-hidden="true">
                {brand.colors.map((color) => (
                  <span key={color} className="jp-brand-shelf__dot" style={{ background: color }} />
                ))}
              </span>
              <span className="jp-meta">
                {brand.count === 1 ? '1 spool' : `${brand.count} spools`} · {formatWeight(brand.grams)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

// ---- Spool of the day ----

const DAY_MS = 24 * 3600 * 1000;

/** A spool not used for 30 days (or never), the same one all day; `skip` moves on to the next. */
export function spoolOfTheDay(spools: Spool[], today: Date, skip = 0): Spool | null {
  const usable = onHand(spools).filter((spool) => spool.remaining > 0);
  if (!usable.length) return null;
  const idle = usable.filter((spool) => !spool.last_used_at || today.getTime() - Date.parse(spool.last_used_at) > 30 * DAY_MS);
  const pool = (idle.length ? idle : usable).slice().sort((a, b) => a.id - b.id);
  const day = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / DAY_MS);
  // A fixed shuffle of the day number, so the pick looks random but stays put all day.
  const seed = (day * 2654435761) >>> 0;
  return pool[(seed + skip) % pool.length];
}

export function SpoolOfTheDay({ spools, onOpen }: { spools: Spool[]; onOpen: (spool: Spool) => void }) {
  const [skip, setSkip] = useState(0);
  const spool = spoolOfTheDay(spools, new Date(), skip);
  if (!spool) return null;
  return (
    <Tile title="Spool of the day" cols={2} className="jp-spool-of-day">
      <div className="jp-spool-of-day__body">
        <SpoolRing color={spool.color_hex || '#9aa4b4'} remaining={spool.remaining} capacity={spool.initial_weight} size={72} />
        <span className="jp-spool-of-day__text">
          <span className="jp-spool-of-day__name" id="jp-spool-of-day-name">
            {spool.display_name}
          </span>
          <span className="jp-meta">
            {spoolNumber(spool)}
            {spool.brand_name ? ` · ${spool.brand_name}` : ''} · {formatWeight(spool.remaining)} left
          </span>
          <span className="jp-meta">{spool.last_used_at ? `Last used ${timeAgo(spool.last_used_at)}` : 'Not used yet'}</span>
        </span>
      </div>
      <div className="jp-spool-of-day__actions">
        <Button size="sm" variant="primary" onClick={() => onOpen(spool)}>
          Open
        </Button>
        <Button size="sm" icon={Shuffle} onClick={() => setSkip((n) => n + 1)} id="jp-spool-of-day-another">
          Another
        </Button>
      </div>
    </Tile>
  );
}
