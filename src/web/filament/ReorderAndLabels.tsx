import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Copy, ExternalLink, Printer as PrinterIcon } from 'lucide-react';
import { filament, settings, type ReorderItem, type Spool, type StorageLocation } from '../api';
import { Tile } from '../components/Bento';
import { Button } from '../components/Button';
import { ColorDot } from '../components/Filament';
import { Modal } from '../components/Overlay';
import { Tabs } from '../components/Tabs';
import { useCan } from '../session';
import { useCurrency } from './currency';
import { formatMoney, formatWeight } from './format';

/*
 * The Filament page's Reorder tile and shopping list, and QR labels for spools (docs/merge-10.md,
 * Phase 8; after FilamentHub's reorder list and features/qr-labels).
 */

/** The coral Reorder tile: how many spools to buy again and the first few. */
export function ReorderTile({ items, onOpen }: { items: ReorderItem[] | null; onOpen: () => void }) {
  if (!items?.length) return null;
  return (
    <Tile variant="accent" title="Reorder" className="jp-filament-reorder" action={<span className="jp-home-needs__count">{items.length}</span>}>
      <ul className="jp-filament-reorder__list">
        {items.slice(0, 3).map((item) => (
          <li key={item.id}>
            <ColorDot color={item.color || '#9aa4b4'} size={18} />
            <span className="jp-filament-reorder__name">{item.name}</span>
            <span>{formatWeight(item.remaining)}</span>
          </li>
        ))}
      </ul>
      <Button className="jp-filament-reorder__open" onClick={onOpen} id="jp-open-shopping-list">
        Open shopping list
      </Button>
    </Tile>
  );
}

/** "Bambu Lab PLA Basic Black (18 g left, critical) · Amazon · https://…" per line, for copying. */
export function shoppingText(items: ReorderItem[], currency = 'USD'): string {
  return items
    .map((item) =>
      [
        `${[item.brand, item.name].filter(Boolean).join(' ')} (${Math.round(item.remaining)} g left${item.severity === 'critical' ? ', critical' : ''})`,
        item.supplier,
        item.price !== null ? `last paid ${formatMoney(item.price, currency)}` : '',
        item.productUrl
      ]
        .filter(Boolean)
        .join(' · ')
    )
    .join('\n');
}

export function ShoppingListDialog({ items, onClose }: { items: ReorderItem[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const currency = useCurrency();
  const copy = async () => {
    await navigator.clipboard?.writeText(shoppingText(items, currency)).catch(() => {});
    setCopied(true);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Shopping list"
      id="jp-shopping-list"
      className="jp-filament-form jp-filament-form--wide"
      footer={
        <>
          {copied && <span className="jp-meta">Copied.</span>}
          <Button icon={Copy} onClick={() => void copy()}>
            Copy the list
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className="jp-meta">Spools a low-stock rule finds low (Settings → Printers → Alerts & webhooks), most urgent first.</p>
      <ul className="jp-shopping">
        {items.map((item) => (
          <li key={item.id} className={item.severity === 'critical' ? 'is-critical' : undefined}>
            <ColorDot color={item.color || '#9aa4b4'} size={22} />
            <span className="jp-shopping__what">
              <span className="jp-shopping__name">{[item.brand, item.name].filter(Boolean).join(' ')}</span>
              <span className="jp-meta">
                {formatWeight(item.remaining)} left ({item.pct}%){item.severity === 'critical' ? ' · critical' : ''}
                {item.supplier ? ` · ${item.supplier}` : ''}
                {item.price !== null ? ` · last paid ${formatMoney(item.price, currency)}` : ''}
              </span>
            </span>
            {item.productUrl && (
              <a className="jp-link" href={item.productUrl} target="_blank" rel="noopener noreferrer">
                Buy again <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export const LABEL_SIZES = [
  { id: 'badge', name: 'Badge', mmW: 40, mmH: 30 },
  { id: 'card', name: 'Wide card', mmW: 50, mmH: 30 },
  { id: 'strip', name: 'Strip', mmW: 40, mmH: 12 }
] as const;
export type LabelSize = (typeof LABEL_SIZES)[number]['id'];

/** What a label shows: its QR address, a title, up to two lines and a color swatch. */
interface LabelContent {
  key: string;
  url: string;
  title: string;
  meta: string;
  color: string | null;
  colorText: string;
}

function Label({ label, size }: { label: LabelContent; size: (typeof LABEL_SIZES)[number] }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(label.url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(
      (markup) => alive && setSvg(markup),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [label.url]);
  return (
    <div className={`jp-label-card jp-label-card--${size.id}`} style={{ width: `${size.mmW}mm`, height: `${size.mmH}mm` }} data-url={label.url}>
      <span className="jp-label-card__qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="jp-label-card__text">
        <span className="jp-label-card__name">{label.title}</span>
        {size.id !== 'strip' && label.meta && <span className="jp-label-card__meta">{label.meta}</span>}
        {size.id !== 'strip' && label.colorText && (
          <span className="jp-label-card__meta">
            {label.color && <span className="jp-label-card__swatch" style={{ background: label.color }} />}
            {label.colorText}
          </span>
        )}
      </span>
    </div>
  );
}

type LabelKind = 'spools' | 'places';
type Links = { public: boolean; spools: Record<string, string | null>; places: Record<string, string | null> };

/**
 * Choose spools or places and a size, preview the labels, print them (the browser's print dialog).
 * The QR codes open the spool in the app (sign in first), or, when an admin lets anyone scan
 * labels, a read-only page for the spool or the place (docs/plan-10.1.md, Phase 5).
 */
export function LabelsDialog({ spools, onClose }: { spools: Spool[]; onClose: () => void }) {
  const isAdmin = useCan('admin');
  const usable = useMemo(() => spools.filter((spool) => spool.status !== 'archived'), [spools]);
  const [kind, setKind] = useState<LabelKind>('spools');
  const [places, setPlaces] = useState<StorageLocation[]>([]);
  const [chosenSpools, setChosenSpools] = useState<Set<number>>(() => new Set(usable.map((spool) => spool.id)));
  const [chosenPlaces, setChosenPlaces] = useState<Set<number>>(new Set());
  const [links, setLinks] = useState<Links | null>(null);
  const [sizeId, setSizeId] = useState<LabelSize>('badge');
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');
  const size = LABEL_SIZES.find((s) => s.id === sizeId) || LABEL_SIZES[0];
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const loadLinks = async (placeList: StorageLocation[]) => {
    try {
      setLinks(await filament.labelLinks({ spoolIds: usable.map((spool) => spool.id), placeIds: placeList.map((place) => place.id) }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const [placesLoaded, setPlacesLoaded] = useState(false);
  useEffect(() => {
    filament.locations().then(
      (list) => {
        setPlaces(list);
        setChosenPlaces(new Set(list.map((place) => place.id)));
        setPlacesLoaded(true);
      },
      () => setPlacesLoaded(true)
    );
  }, []);
  // The links, again whenever the spools change while the dialog is open (one added elsewhere).
  const spoolKey = usable.map((spool) => spool.id).join(',');
  useEffect(() => {
    if (placesLoaded) void loadLinks(places);
    // loadLinks reads `usable` and `places`, which spoolKey and placesLoaded follow.
  }, [spoolKey, placesLoaded]);

  /** The admin's checkbox: shown ticked at once, while the setting saves and the links reload. */
  const [publicOn, setPublicOn] = useState<boolean | null>(null);
  const setPublic = async (on: boolean) => {
    setError('');
    setPublicOn(on);
    try {
      await settings.save('publicLabels', on ? 'true' : 'false');
      await loadLinks(places);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPublicOn(null);
    }
  };

  const spoolLabels: LabelContent[] = usable
    .filter((spool) => chosenSpools.has(spool.id) && links?.spools[spool.id])
    .map((spool) => ({
      key: `spool-${spool.id}`,
      url: `${origin}${links?.spools[spool.id]}`,
      title: spool.display_name,
      meta: [spool.brand_name, spool.material_type || spool.material].filter(Boolean).join(' · '),
      color: spool.color_hex,
      colorText: `${spool.color_hex || ''} · #${spool.id}`
    }));
  const placeLabels: LabelContent[] = places
    .filter((place) => chosenPlaces.has(place.id) && links?.places[place.id])
    .map((place) => ({
      key: `place-${place.id}`,
      url: `${origin}${links?.places[place.id]}`,
      title: place.name,
      meta: place.is_dry_box ? 'Dry box' : 'Place',
      color: null,
      colorText: 'Scan for its spools'
    }));
  const picked = kind === 'spools' ? spoolLabels : placeLabels;

  useEffect(() => {
    if (!printing) return;
    document.body.classList.add('jp-printing-labels');
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    // Let the QR codes draw, then print.
    const timer = setTimeout(() => window.print(), 300);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('afterprint', done);
      document.body.classList.remove('jp-printing-labels');
    };
  }, [printing]);

  const toggle = (setter: typeof setChosenSpools, id: number) =>
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      open
      onClose={onClose}
      title="Labels"
      id="jp-labels-dialog"
      className="jp-filament-form jp-filament-form--wide"
      footer={
        <>
          <span className="jp-meta">
            {picked.length} {picked.length === 1 ? 'label' : 'labels'}
          </span>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={PrinterIcon} disabled={!picked.length} onClick={() => setPrinting(true)} id="jp-labels-print">
            Print
          </Button>
        </>
      }
    >
      <Tabs<LabelKind>
        label="Labels for"
        items={[
          { id: 'spools', label: 'Spools' },
          { id: 'places', label: 'Places' }
        ]}
        value={kind}
        onChange={setKind}
      />
      {isAdmin ? (
        <label className="jp-filament-form__check jp-labels__public">
          <input
            type="checkbox"
            id="jp-labels-public"
            checked={publicOn ?? !!links?.public}
            disabled={!links || publicOn !== null}
            onChange={(event) => void setPublic(event.target.checked)}
          />
          Anyone who scans a label sees the spool or place (read-only, without signing in)
        </label>
      ) : null}
      <p className="jp-meta" id="jp-labels-how">
        {links?.public
          ? 'The QR code opens a read-only page for the spool or the place (no price, shop or notes), for anyone who scans it. Sign in from there to change things.'
          : 'The QR code opens the spool on the Filament page: sign in first on the phone that scans it.'}
      </p>
      {error && (
        <p className="jp-filament-form__error" role="alert">
          {error}
        </p>
      )}
      <div className="jp-labels__sizes" role="group" aria-label="Label size">
        {LABEL_SIZES.map((s) => (
          <label key={s.id} className="jp-filament-form__check">
            <input type="radio" name="jp-label-size" checked={sizeId === s.id} onChange={() => setSizeId(s.id)} /> {s.name} ({s.mmW} × {s.mmH} mm)
          </label>
        ))}
      </div>
      {kind === 'spools' ? (
        <>
          <div className="jp-labels__pick">
            <Button size="sm" onClick={() => setChosenSpools(new Set(usable.map((spool) => spool.id)))}>
              All
            </Button>
            <Button size="sm" onClick={() => setChosenSpools(new Set())}>
              None
            </Button>
          </div>
          <ul className="jp-labels__list">
            {usable.map((spool) => (
              <li key={spool.id}>
                <label className="jp-filament-form__check">
                  <input type="checkbox" checked={chosenSpools.has(spool.id)} onChange={() => toggle(setChosenSpools, spool.id)} />
                  <ColorDot color={spool.color_hex || '#9aa4b4'} size={14} /> {spool.display_name}
                  {spool.brand_name ? <span className="jp-meta"> · {spool.brand_name}</span> : null}
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : !links?.public ? (
        <p className="jp-meta" id="jp-labels-places-off">
          A place&apos;s label opens a page listing the spools in it, which needs labels anyone can scan
          {isAdmin ? ': turn that on above.' : ' (an admin turns that on).'}
        </p>
      ) : !places.length ? (
        <p className="jp-meta">No places yet: add them with Places on the Filament page.</p>
      ) : (
        <ul className="jp-labels__list">
          {places.map((place) => (
            <li key={place.id}>
              <label className="jp-filament-form__check">
                <input type="checkbox" checked={chosenPlaces.has(place.id)} onChange={() => toggle(setChosenPlaces, place.id)} />
                {place.name}
                <span className="jp-meta">
                  {' '}
                  · {place.spool_count || 0} {place.spool_count === 1 ? 'spool' : 'spools'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="jp-labels__preview" aria-label="Preview">
        {picked.slice(0, 4).map((label) => (
          <Label key={label.key} label={label} size={size} />
        ))}
        {picked.length > 4 && <span className="jp-meta">and {picked.length - 4} more</span>}
      </div>
      {printing &&
        createPortal(
          <div className="jp-labels-sheet" id="jp-labels-sheet">
            {picked.map((label) => (
              <Label key={label.key} label={label} size={size} />
            ))}
          </div>,
          document.body
        )}
    </Modal>
  );
}
