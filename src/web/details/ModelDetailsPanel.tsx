import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { cx } from '../components/Button';
import { Menu } from '../components/Menu';
import { normalizeRating, parseThumbnails } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { exposeGlobal } from '../page';
import { useAdopt } from '../shell/adopt';
import { offerSlicerSettings, sendToSlicer, type Slicer } from '../slicer';
import { ModelView } from '../pages/ModelPage';
import { useRoute } from '../shell/routes';

/** The model the panel shows, as get-model returns it (with its images). */
export interface PanelModel extends GridModel {
  fileName?: string | null;
  designer?: string | null;
  size?: number | null;
  dateAdded?: string | null;
  favorite?: number | boolean | null;
  rating?: number | null;
  thumbnail?: string | null;
  source?: string | null;
  notes?: string | null;
  categories?: string[];
}

declare global {
  interface Window {
    /** The JusttPrint 5 top of the details panel (library/details.ts drives it). */
    detailsHero?: { show: (model: PanelModel) => void; clear: () => void };
  }
}

/** "Oct 6, 2026"; '' for a missing or bad date. */
export function formatAdded(value: unknown): string {
  if (!value) return '';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The panel's images: the stored ones, or the 3D placeholder. */
export function panelImages(model: PanelModel | null): string[] {
  const images = parseThumbnails(model?.thumbnail);
  return images.length ? images : ['3d.png'];
}

/** A property row of the Details list: muted label, brighter value (spec §26). */
export function Prop({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="jp-prop">
      <span className="jp-prop__label">{label}</span>
      <span className="jp-prop__value" title={title}>
        {children}
      </span>
    </div>
  );
}

/** Save a card field (favorite, rating) of the shown model and redraw its card. */
export async function saveCardField(filePath: string, field: 'favorite' | 'rating', value: boolean | number): Promise<boolean> {
  const ok = await window.gridHost?.saveField(filePath, field, value);
  if (ok) await window.updateModelElement?.(filePath);
  return !!ok;
}

export function Rating({ model, readOnly, onSaved }: { model: PanelModel; readOnly?: boolean; onSaved: (rating: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const rating = normalizeRating(model.rating);
  const shown = hover ?? rating;
  if (readOnly) {
    return (
      <span className="jp-rating" role="img" aria-label={rating ? `Rated ${rating} of 5` : 'Not rated'}>
        {[1, 2, 3, 4, 5].map((star) => (
          <span key={star} className={cx('jp-rating__star', star <= rating && 'is-filled')} aria-hidden="true">
            {star <= rating ? '★' : '☆'}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="jp-rating" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={star === rating}
          aria-label={`${star} star${star === 1 ? '' : 's'}`}
          className={cx('jp-rating__star', star <= shown && 'is-filled')}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(null)}
          onClick={async () => {
            const next = rating === star ? 0 : star;
            if (await saveCardField(model.filePath, 'rating', next)) onSaved(next);
          }}
        >
          {star <= shown ? '★' : '☆'}
        </button>
      ))}
    </span>
  );
}

/** Open in Slicer with its dropdown of the configured slicers (spec §25). */
export function SlicerButton({ filePath, slicers }: { filePath: string; slicers: Slicer[] }) {
  const send = (slicer?: Slicer) => {
    if (!slicer) return offerSlicerSettings();
    return sendToSlicer([filePath], slicer);
  };
  return (
    <div className="jp-split">
      <button
        type="button"
        id="jp-details-open-slicer"
        className="jp-btn jp-btn--primary jp-btn--lg jp-split__main"
        title={slicers[0] ? `Open in ${slicers[0].name}` : 'Set up a slicer first'}
        onClick={() => send(slicers[0])}
      >
        <span>Open in Slicer</span>
      </button>
      <Menu
        label="Slicers"
        align="start"
        items={
          slicers.length
            ? slicers.map((slicer, index) => ({
                id: `${slicer.id ?? index}`,
                label: slicer.name,
                onSelect: () => {
                  void send(slicer);
                }
              }))
            : [{ id: 'setup', label: 'Set up a slicer…', onSelect: () => window.openSlicerSettings?.() }]
        }
        trigger={(props) => (
          <button type="button" className="jp-btn jp-btn--primary jp-btn--lg jp-split__more" aria-label="Choose a slicer" title="Choose a slicer" {...props}>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
        )}
      />
    </div>
  );
}

/**
 * The JusttPrint 5 details panel (spec §20-§28) on the desktop: large preview with Favorite and
 * More, the thumbnail strip, name and designer, tags, Open in Slicer and Log Print, then the
 * Details list, Notes and Print History. The editors are the existing details
 * components (DetailsFields, DetailsNotes, PrintHistory, DetailsPath), moved
 * into this layout while it is shown (shell/adopt.ts); the phone keeps the old panel.
 * Now: the model page's sections in one column (ModelView compact); the older editors are kept,
 * hidden, for the code that fills them.
 */
export function ModelDetailsPanel() {
  const [slot] = useState(() => document.getElementById('details-hero-slot'));
  const route = useRoute();
  /** The model shown; the view loads it, and follows changes made elsewhere. */
  const [filePath, setFilePath] = useState<string | null>(null);

  const [tagsHost, setTagsHost] = useState<HTMLDivElement | null>(null);
  const [statusHost, setStatusHost] = useState<HTMLDivElement | null>(null);
  const [fieldsHost, setFieldsHost] = useState<HTMLDivElement | null>(null);
  const [pathHost, setPathHost] = useState<HTMLDivElement | null>(null);
  const [notesHost, setNotesHost] = useState<HTMLDivElement | null>(null);
  const [historyHost, setHistoryHost] = useState<HTMLDivElement | null>(null);
  useAdopt('#details-tags-slot', tagsHost);
  /** In the view: the print status picker and the print history list (with delete). */
  const [statusSlot, setStatusSlot] = useState<HTMLDivElement | null>(null);
  const [historySlot, setHistorySlot] = useState<HTMLDivElement | null>(null);
  const [pathSlot, setPathSlot] = useState<HTMLDivElement | null>(null);
  useAdopt('#details-print-slot', statusSlot ?? statusHost);
  useAdopt('#details-fields-slot', fieldsHost);
  useAdopt('#details-path-group', pathSlot ?? pathHost);
  useAdopt('#details-notes-slot', notesHost);
  useAdopt('#details-history-slot', historySlot ?? historyHost);

  useEffect(
    () =>
      exposeGlobal('detailsHero', {
        show: (next: PanelModel) => setFilePath(next.filePath),
        clear: () => setFilePath(null)
      }),
    []
  );

  if (!slot) return null;
  return createPortal(
    <div className="jp jp-details">
      {/* The page's sections, in one column (pages/ModelPage.tsx); not while a page covers the library. */}
      {filePath && route.page === 'models' && (
        <ModelView key={filePath} filePath={filePath} compact statusSlot={setStatusSlot} historySlot={setHistorySlot} pathSlot={setPathSlot} />
      )}
      {/* The older editors stay loaded for the code that fills them, out of sight. */}
      <div hidden>
        <div ref={setTagsHost} />
        <div ref={setStatusHost} />
        <div ref={setFieldsHost} />
        <div ref={setPathHost} />
        <div ref={setNotesHost} />
        <div ref={setHistoryHost} />
      </div>
    </div>,
    slot
  );
}
