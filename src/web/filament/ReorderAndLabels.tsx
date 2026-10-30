import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Copy, ExternalLink, Printer as PrinterIcon } from 'lucide-react';
import { type ReorderItem, type Spool } from '../api';
import { Tile } from '../components/Bento';
import { Button } from '../components/Button';
import { ColorDot } from '../components/Filament';
import { Modal } from '../components/Overlay';
import { formatWeight } from './format';

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
export function shoppingText(items: ReorderItem[]): string {
  return items
    .map((item) =>
      [
        `${[item.brand, item.name].filter(Boolean).join(' ')} (${Math.round(item.remaining)} g left${item.severity === 'critical' ? ', critical' : ''})`,
        item.supplier,
        item.productUrl
      ]
        .filter(Boolean)
        .join(' · ')
    )
    .join('\n');
}

export function ShoppingListDialog({ items, onClose }: { items: ReorderItem[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(shoppingText(items)).catch(() => {});
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
                {item.price !== null ? ` · last paid ${item.price.toLocaleString()}` : ''}
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

/** The address a spool's QR code opens: its panel on the Filament page. */
export const spoolLink = (origin: string, id: number) => `${origin}/#/filament/${id}`;

function Label({ spool, size, origin }: { spool: Spool; size: (typeof LABEL_SIZES)[number]; origin: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(spoolLink(origin, spool.id), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then(
      (markup) => alive && setSvg(markup),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [spool.id, origin]);
  return (
    <div className={`jp-label-card jp-label-card--${size.id}`} style={{ width: `${size.mmW}mm`, height: `${size.mmH}mm` }}>
      <span className="jp-label-card__qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="jp-label-card__text">
        <span className="jp-label-card__name">{spool.display_name}</span>
        {size.id !== 'strip' && (
          <span className="jp-label-card__meta">{[spool.brand_name, spool.material_type || spool.material].filter(Boolean).join(' · ')}</span>
        )}
        {size.id !== 'strip' && (
          <span className="jp-label-card__meta">
            <span className="jp-label-card__swatch" style={{ background: spool.color_hex || 'transparent' }} />
            {spool.color_hex || ''} · #{spool.id}
          </span>
        )}
      </span>
    </div>
  );
}

/** Choose spools and a size, preview the labels, print them (the browser's print dialog). */
export function LabelsDialog({ spools, onClose }: { spools: Spool[]; onClose: () => void }) {
  const usable = useMemo(() => spools.filter((spool) => spool.status !== 'archived'), [spools]);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(usable.map((spool) => spool.id)));
  const [sizeId, setSizeId] = useState<LabelSize>('badge');
  const [printing, setPrinting] = useState(false);
  const size = LABEL_SIZES.find((s) => s.id === sizeId) || LABEL_SIZES[0];
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const picked = usable.filter((spool) => chosen.has(spool.id));

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

  const toggle = (id: number) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      open
      onClose={onClose}
      title="Spool labels"
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
      <p className="jp-meta">The QR code opens the spool on the Filament page (log in first on the phone that scans it).</p>
      <div className="jp-labels__sizes" role="group" aria-label="Label size">
        {LABEL_SIZES.map((s) => (
          <label key={s.id} className="jp-filament-form__check">
            <input type="radio" name="jp-label-size" checked={sizeId === s.id} onChange={() => setSizeId(s.id)} /> {s.name} ({s.mmW} × {s.mmH} mm)
          </label>
        ))}
      </div>
      <div className="jp-labels__pick">
        <Button size="sm" onClick={() => setChosen(new Set(usable.map((spool) => spool.id)))}>
          All
        </Button>
        <Button size="sm" onClick={() => setChosen(new Set())}>
          None
        </Button>
      </div>
      <ul className="jp-labels__list">
        {usable.map((spool) => (
          <li key={spool.id}>
            <label className="jp-filament-form__check">
              <input type="checkbox" checked={chosen.has(spool.id)} onChange={() => toggle(spool.id)} />
              <ColorDot color={spool.color_hex || '#9aa4b4'} size={14} /> {spool.display_name}
              {spool.brand_name ? <span className="jp-meta"> · {spool.brand_name}</span> : null}
            </label>
          </li>
        ))}
      </ul>
      <div className="jp-labels__preview" aria-label="Preview">
        {picked.slice(0, 4).map((spool) => (
          <Label key={spool.id} spool={spool} size={size} origin={origin} />
        ))}
        {picked.length > 4 && <span className="jp-meta">and {picked.length - 4} more</span>}
      </div>
      {printing &&
        createPortal(
          <div className="jp-labels-sheet" id="jp-labels-sheet">
            {picked.map((spool) => (
              <Label key={spool.id} spool={spool} size={size} origin={origin} />
            ))}
          </div>,
          document.body
        )}
    </Modal>
  );
}
