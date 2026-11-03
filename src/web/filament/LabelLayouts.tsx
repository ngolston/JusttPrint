import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import type { Spool } from '../api';
import { formatTemperatureRange } from '../units';

/*
 * The layouts of a spool's QR label, per size (QR Labels on the Filament page). 1em is 1 mm on a
 * label, so the sizes below read as millimetres. Black on white, for label printers that print
 * black only; the color swatch prints as a shade of grey there.
 */

export const LABEL_SIZES = [
  { id: 'badge', name: 'Badge', mmW: 40, mmH: 30 },
  { id: 'card', name: 'Wide card', mmW: 50, mmH: 30 },
  { id: 'strip', name: 'Strip', mmW: 40, mmH: 12 }
] as const;
export type LabelSize = (typeof LABEL_SIZES)[number]['id'];

/** The layouts each size offers, the first being the one it starts with. */
export const LABEL_LAYOUTS: Record<LabelSize, { id: string; name: string }[]> = {
  badge: [
    { id: 'brand', name: 'Brand with settings' },
    { id: 'split', name: 'Split' },
    { id: 'number', name: 'Big number' }
  ],
  card: [
    { id: 'brand', name: 'Brand with settings' },
    { id: 'brand-qr', name: 'Brand, QR on the left' },
    { id: 'biggest-qr', name: 'Biggest QR' },
    { id: 'brand-header', name: 'Brand header' },
    { id: 'number', name: 'Giant number' }
  ],
  strip: [
    { id: 'brand', name: 'Brand' },
    { id: 'two-lines', name: 'Two lines' },
    { id: 'material-tab', name: 'Material tab' }
  ]
};

export const layoutOf = (size: LabelSize, id: string | null | undefined) =>
  (LABEL_LAYOUTS[size].find((layout) => layout.id === id) || LABEL_LAYOUTS[size][0]).id;

/** What a spool's label says. */
export interface SpoolLabelData {
  number: string;
  brand: string;
  /** "PLA Basic": the material with its kind. */
  material: string;
  /** "PLA": the material alone, for the tabs. */
  base: string;
  color: string;
  hex: string | null;
  specs: [string, string][];
}

/** The material with its kind, without saying the material twice ("PLA" and "PLA Basic" give "PLA Basic"). */
function materialText(material: string, kind: string | null): string {
  const m = String(material || '').trim();
  const k = String(kind || '').trim();
  if (!k) return m;
  return k.toLowerCase().startsWith(m.toLowerCase()) ? k : `${m} ${k}`;
}

/** Trims 0.9810 to 0.981. */
const plain = (value: number) => String(Number(value.toFixed(3)));

export function spoolLabelData(spool: Spool): SpoolLabelData {
  const specs: [string, string][] = [];
  // "195–220°C", without the space, as filament makers print it.
  const nozzle = formatTemperatureRange(spool.profile_print_temp_min ?? null, spool.profile_print_temp_max ?? null).replace(' °', '°');
  const bed = formatTemperatureRange(spool.profile_bed_temp_min ?? null, spool.profile_bed_temp_max ?? null).replace(' °', '°');
  if (nozzle) specs.push(['Nozzle', nozzle]);
  if (bed) specs.push(['Bed Temp', bed]);
  if (spool.profile_flow_ratio != null) specs.push(['Flow Ratio', plain(spool.profile_flow_ratio)]);
  if (spool.profile_td != null) specs.push(['TD', plain(spool.profile_td)]);
  return {
    number: `#${spool.id}`,
    brand: spool.brand_name || '',
    material: materialText(spool.material, spool.material_type),
    base: spool.material,
    // Without a color name, the spool's own name, unless that is just its material again.
    color:
      spool.color_name ||
      (spool.display_name !== spool.material && spool.display_name !== materialText(spool.material, spool.material_type) ? spool.display_name : ''),
    hex: spool.color_hex ? spool.color_hex.toUpperCase() : null,
    specs
  };
}

function useQr(url: string): string {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(
      (markup) => alive && setSvg(markup),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [url]);
  return svg;
}

/** One line of text made smaller until it fits its box (brand names and materials vary in length). */
function Fit({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = '';
      const base = parseFloat(getComputedStyle(el).fontSize);
      let size = base;
      for (let i = 0; i < 30 && el.scrollWidth > el.clientWidth + 0.5 && size > base * 0.4; i++) {
        size *= 0.94;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    // Again on the next frame, once the fonts are in (the brand face is wider than the fallback),
    // and whenever its box changes size. Fitting changes only the font, never the box, so this
    // does not loop.
    let alive = true;
    const frame = requestAnimationFrame(() => alive && fit());
    document.fonts?.ready.then(() => alive && fit()).catch(() => {});
    const observer = new ResizeObserver(() => alive && fit());
    observer.observe(el);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [children]);
  return (
    <span ref={ref} className={`jp-lbl__fit ${className}`}>
      {children}
    </span>
  );
}

const Swatch = ({ hex }: { hex: string | null }) => (hex ? <span className="jp-lbl__dot" style={{ background: hex }} /> : null);

/** The specs table: Nozzle, Bed Temp, Flow Ratio, TD (those the filament has). */
const Specs = ({ data }: { data: SpoolLabelData }) =>
  data.specs.length ? (
    <span className="jp-lbl__specs">
      {data.specs.map(([name, value]) => (
        <span key={name} className="jp-lbl__spec">
          <span>{name}:</span>
          <span>{value}</span>
        </span>
      ))}
    </span>
  ) : (
    <span className="jp-lbl__specs" />
  );

export function SpoolLabel({ data, url, size, layout }: { data: SpoolLabelData; url: string; size: (typeof LABEL_SIZES)[number]; layout: string }) {
  const svg = useQr(url);
  const qr = <span className="jp-lbl__qr" dangerouslySetInnerHTML={{ __html: svg }} />;
  const brand = data.brand || data.base;
  let body: ReactNode;
  const key = `${size.id}:${layoutOf(size.id, layout)}`;
  switch (key) {
    case 'badge:brand':
    case 'card:brand':
      body = (
        <>
          <Fit className="jp-lbl__brand">{brand}</Fit>
          <span className="jp-lbl__bar-row">
            <Fit className="jp-lbl__bar">{data.material}</Fit>
            {data.hex && <span className="jp-lbl__hex">{data.hex}</span>}
          </span>
          <Fit className="jp-lbl__color">{data.color}</Fit>
          <span className="jp-lbl__bottom">
            <Specs data={data} />
            {qr}
          </span>
        </>
      );
      break;
    case 'card:brand-qr':
      body = (
        <>
          <Fit className="jp-lbl__brand">{brand}</Fit>
          <span className="jp-lbl__bottom">
            {qr}
            <span className="jp-lbl__col">
              <Fit className="jp-lbl__bar">{data.material}</Fit>
              <Fit className="jp-lbl__color">{data.color}</Fit>
              <span className="jp-lbl__push" />
              {data.hex && <span className="jp-lbl__hex">{data.hex}</span>}
            </span>
          </span>
        </>
      );
      break;
    case 'strip:brand':
      body = (
        <>
          {qr}
          <span className="jp-lbl__col">
            <Fit className="jp-lbl__brand">{brand}</Fit>
            <Fit className="jp-lbl__bar">{data.material}</Fit>
            <Fit className="jp-lbl__color">{data.color}</Fit>
          </span>
        </>
      );
      break;
    case 'badge:number':
      body = (
        <>
          {qr}
          <span className="jp-lbl__id">{data.number}</span>
          <Fit className="jp-lbl__mat">{data.material}</Fit>
          <span className="jp-lbl__foot">
            <Fit className="jp-lbl__name">
              <Swatch hex={data.hex} />
              {data.color}
            </Fit>
            <Fit className="jp-lbl__dim">{data.brand}</Fit>
          </span>
        </>
      );
      break;
    case 'card:brand-header':
      body = (
        <>
          <span className="jp-lbl__top">
            <Fit className="jp-lbl__head-brand">{brand}</Fit>
            <span className="jp-lbl__id">{data.number}</span>
          </span>
          <span className="jp-lbl__bottom">
            {qr}
            <span className="jp-lbl__col">
              <span className="jp-lbl__name jp-lbl__clamp">
                <Swatch hex={data.hex} />
                {data.color}
              </span>
              <Fit className="jp-lbl__dim">{data.material}</Fit>
            </span>
          </span>
        </>
      );
      break;
    case 'strip:two-lines':
      body = (
        <>
          {qr}
          <span className="jp-lbl__col">
            <Fit className="jp-lbl__name">
              {data.number} {data.color}
            </Fit>
            <Fit className="jp-lbl__dim">{[data.brand, data.material].filter(Boolean).join(' · ')}</Fit>
          </span>
        </>
      );
      break;
    case 'strip:material-tab':
      body = (
        <>
          <span className="jp-lbl__tab">
            <Fit className="jp-lbl__tab-text">{data.base}</Fit>
          </span>
          <span className="jp-lbl__col">
            <Fit className="jp-lbl__name">
              {data.number} {data.color}
            </Fit>
            <Fit className="jp-lbl__dim">{[data.brand, data.material].filter(Boolean).join(' · ')}</Fit>
          </span>
          {qr}
        </>
      );
      break;
    default:
      // badge:split, card:biggest-qr and card:number: the QR, then the number, color, brand and material.
      body = (
        <>
          {qr}
          <span className="jp-lbl__col">
            <span className="jp-lbl__id">{data.number}</span>
            <span className="jp-lbl__name jp-lbl__clamp">
              <Swatch hex={data.hex} />
              {data.color}
            </span>
            <Fit className="jp-lbl__dim">{data.brand}</Fit>
            <Fit className="jp-lbl__dim">{data.material}</Fit>
          </span>
        </>
      );
  }
  return (
    <div
      className={`jp-label-card jp-lbl jp-lbl--${size.id} jp-lbl--${size.id}-${layoutOf(size.id, layout)}`}
      style={{ width: `${size.mmW}mm`, height: `${size.mmH}mm` }}
      data-url={url}
    >
      {body}
    </div>
  );
}

/** The layouts of a place's label, per size, in the same looks as a spool's. */
export const PLACE_LAYOUTS: Record<LabelSize, { id: string; name: string }[]> = {
  badge: [
    { id: 'name', name: 'Name' },
    { id: 'big-qr', name: 'Big QR' }
  ],
  card: [
    { id: 'name', name: 'Name' },
    { id: 'big-qr', name: 'Big QR' }
  ],
  strip: [
    { id: 'name', name: 'Name' },
    { id: 'two-lines', name: 'Two lines' }
  ]
};

export const placeLayoutOf = (size: LabelSize, id: string | null | undefined) =>
  (PLACE_LAYOUTS[size].find((layout) => layout.id === id) || PLACE_LAYOUTS[size][0]).id;

/** What a place's label says: its name, whether it is a dry box, its description. */
export interface PlaceLabelData {
  name: string;
  kind: string;
  description: string;
}

export function placeLabelData(place: { name: string; is_dry_box: number | boolean; description?: string | null }): PlaceLabelData {
  return { name: place.name, kind: place.is_dry_box ? 'Dry box' : 'Place', description: String(place.description || '').trim() };
}

const SCAN = 'Scan for its spools';

export function PlaceLabel({ data, url, size, layout }: { data: PlaceLabelData; url: string; size: (typeof LABEL_SIZES)[number]; layout: string }) {
  const svg = useQr(url);
  const qr = <span className="jp-lbl__qr" dangerouslySetInnerHTML={{ __html: svg }} />;
  const chosen = placeLayoutOf(size.id, layout);
  let body: ReactNode;
  let looks: string;
  if (size.id === 'strip') {
    looks = chosen === 'name' ? 'strip-brand' : 'strip-two-lines';
    body =
      chosen === 'name' ? (
        <>
          {qr}
          <span className="jp-lbl__col">
            <Fit className="jp-lbl__brand">{data.name}</Fit>
            <Fit className="jp-lbl__bar">{data.kind}</Fit>
            <Fit className="jp-lbl__color">{data.description || SCAN}</Fit>
          </span>
        </>
      ) : (
        <>
          {qr}
          <span className="jp-lbl__col">
            <Fit className="jp-lbl__name">{data.name}</Fit>
            <Fit className="jp-lbl__dim">{[data.kind, data.description || SCAN].join(' · ')}</Fit>
          </span>
        </>
      );
  } else if (chosen === 'name') {
    looks = size.id === 'badge' ? 'badge-brand' : 'card-brand-qr';
    body =
      size.id === 'badge' ? (
        <>
          <Fit className="jp-lbl__brand">{data.name}</Fit>
          <span className="jp-lbl__bar-row">
            <Fit className="jp-lbl__bar">{data.kind}</Fit>
          </span>
          {data.description && <Fit className="jp-lbl__color">{data.description}</Fit>}
          <span className="jp-lbl__bottom">
            <span className="jp-lbl__scan">{SCAN}</span>
            {qr}
          </span>
        </>
      ) : (
        <>
          <Fit className="jp-lbl__brand">{data.name}</Fit>
          <span className="jp-lbl__bottom">
            {qr}
            <span className="jp-lbl__col">
              <Fit className="jp-lbl__bar">{data.kind}</Fit>
              {data.description && <span className="jp-lbl__color jp-lbl__clamp">{data.description}</span>}
              <span className="jp-lbl__push" />
              <span className="jp-lbl__scan">{SCAN}</span>
            </span>
          </span>
        </>
      );
  } else {
    looks = size.id === 'badge' ? 'badge-split' : 'card-biggest-qr';
    body = (
      <>
        {qr}
        <span className="jp-lbl__col">
          <span className="jp-lbl__name jp-lbl__clamp jp-lbl__place-name">{data.name}</span>
          <Fit className="jp-lbl__dim">{data.kind}</Fit>
          {data.description && <span className="jp-lbl__dim jp-lbl__clamp">{data.description}</span>}
          <span className="jp-lbl__scan">{SCAN}</span>
        </span>
      </>
    );
  }
  return (
    <div
      className={`jp-label-card jp-lbl jp-lbl--${size.id} jp-lbl--${looks} jp-lbl--place`}
      style={{ width: `${size.mmW}mm`, height: `${size.mmH}mm` }}
      data-url={url}
    >
      {body}
    </div>
  );
}
