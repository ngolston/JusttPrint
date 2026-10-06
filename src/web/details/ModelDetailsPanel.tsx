import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Box, ChevronDown, ClipboardPen, Heart, MoreHorizontal } from 'lucide-react';
import { LIBRARY_CHANGED, models } from '../api';
import { cx } from '../components/Button';
import { Menu } from '../components/Menu';
import { cardTitle, displayFileName, formatOf, normalizeRating, parseThumbnails } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { formatFileSize } from '../library/paths';
import { exposeGlobal, onServerEvent } from '../page';
import { useAdopt } from '../shell/adopt';
import { loadSlicers, offerSlicerSettings, sendToSlicer, type Slicer } from '../slicer';

/** The model the panel shows, as get-model returns it (with its images). */
export interface PanelModel extends GridModel {
  fileName?: string | null;
  designer?: string | null;
  size?: number | null;
  dateAdded?: string | null;
  favorite?: number | boolean | null;
  rating?: number | null;
  thumbnail?: string | null;
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
function Prop({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="jp-prop">
      <span className="jp-prop__label">{label}</span>
      <span className="jp-prop__value" title={title}>{children}</span>
    </div>
  );
}

/** Save a card field (favorite, rating) of the shown model and redraw its card. */
async function saveCardField(filePath: string, field: 'favorite' | 'rating', value: boolean | number): Promise<boolean> {
  const ok = await window.gridHost?.saveField(filePath, field, value);
  if (ok) await window.updateModelElement?.(filePath);
  return !!ok;
}

function Rating({ model, onSaved }: { model: PanelModel; onSaved: (rating: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const rating = normalizeRating(model.rating);
  const shown = hover ?? rating;
  return (
    <span className="jp-rating" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((star) => (
        <button key={star} type="button" role="radio" aria-checked={star === rating} aria-label={`${star} star${star === 1 ? '' : 's'}`}
          className={cx('jp-rating__star', star <= shown && 'is-filled')}
          onMouseEnter={() => setHover(star)} onMouseLeave={() => setHover(null)}
          onClick={async () => {
            const next = rating === star ? 0 : star;
            if (await saveCardField(model.filePath, 'rating', next)) onSaved(next);
          }}>
          {star <= shown ? '★' : '☆'}
        </button>
      ))}
    </span>
  );
}

/** Open in Slicer with its dropdown of the configured slicers (spec §25). */
function SlicerButton({ filePath, slicers }: { filePath: string; slicers: Slicer[] }) {
  const send = (slicer?: Slicer) => {
    if (!slicer) return offerSlicerSettings();
    return sendToSlicer([filePath], slicer);
  };
  return (
    <div className="jp-split">
      <button type="button" id="jp-details-open-slicer" className="jp-btn jp-btn--primary jp-btn--lg jp-split__main"
        title={slicers[0] ? `Open in ${slicers[0].name}` : 'Set up a slicer first'} onClick={() => send(slicers[0])}>
        <span>Open in Slicer</span>
      </button>
      <Menu label="Slicers" align="start"
        items={slicers.length
          ? slicers.map((slicer, index) => ({ id: `${slicer.id ?? index}`, label: slicer.name, onSelect: () => { void send(slicer); } }))
          : [{ id: 'setup', label: 'Set up a slicer…', onSelect: () => window.openSlicerSettings?.() }]}
        trigger={(props) => (
          <button type="button" className="jp-btn jp-btn--primary jp-btn--lg jp-split__more" aria-label="Choose a slicer" title="Choose a slicer" {...props}>
            <ChevronDown size={18} aria-hidden="true" />
          </button>
        )} />
    </div>
  );
}

/**
 * The JusttPrint 5 details panel (spec §20-§28) on the desktop: large preview with Favorite and
 * More, the thumbnail strip, name and designer, tags, Open in Slicer and Log Print, then the
 * Details list, Filament, Notes and Print History. The editors are the existing details
 * components (DetailsFields, DetailsFilaments, DetailsNotes, PrintHistory, DetailsPath), moved
 * into this layout while it is shown (shell/adopt.ts); the phone keeps the old panel.
 */
export function ModelDetailsPanel() {
  const [slot] = useState(() => document.getElementById('details-hero-slot'));
  const [model, setModel] = useState<PanelModel | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [slicers, setSlicers] = useState<Slicer[]>([]);
  const shownPath = useRef<string | null>(null);

  const [tagsHost, setTagsHost] = useState<HTMLDivElement | null>(null);
  const [statusHost, setStatusHost] = useState<HTMLDivElement | null>(null);
  const [fieldsHost, setFieldsHost] = useState<HTMLDivElement | null>(null);
  const [pathHost, setPathHost] = useState<HTMLDivElement | null>(null);
  const [filamentsHost, setFilamentsHost] = useState<HTMLDivElement | null>(null);
  const [notesHost, setNotesHost] = useState<HTMLDivElement | null>(null);
  const [historyHost, setHistoryHost] = useState<HTMLDivElement | null>(null);
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  useAdopt('#details-tags-slot', tagsHost);
  useAdopt('#details-print-slot', statusHost);
  useAdopt('#details-fields-slot', fieldsHost);
  useAdopt('#details-path-group', pathHost);
  useAdopt('#details-filaments-slot', filamentsHost);
  useAdopt('#details-notes-slot', notesHost);
  useAdopt('#details-history-slot', historyHost);
  useAdopt('#enter-multi-edit-button', footerHost);

  useEffect(() => exposeGlobal('detailsHero', {
    show: (next: PanelModel) => {
      if (next.filePath !== shownPath.current) setImageIndex(0);
      shownPath.current = next.filePath;
      setModel(next);
    },
    clear: () => {
      shownPath.current = null;
      setModel(null);
    }
  }), []);

  // Follow changes made elsewhere (cards, menus, other browsers) and the slicer list.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        loadSlicers().then(setSlicers, () => {});
        const path = shownPath.current;
        if (!path) return;
        models.get<PanelModel>(path).then((fresh) => {
          if (fresh && shownPath.current === path) setModel(fresh);
        }, () => {});
      }, 400);
    };
    loadSlicers().then(setSlicers, () => {});
    const off = onServerEvent('refresh-grid', reload);
    window.addEventListener(LIBRARY_CHANGED, reload);
    return () => {
      if (timer) clearTimeout(timer);
      off();
      window.removeEventListener(LIBRARY_CHANGED, reload);
    };
  }, []);

  if (!slot) return null;
  const images = panelImages(model);
  const shown = images[imageIndex < images.length ? imageIndex : 0];
  const favorite = !!model?.favorite;
  const designer = typeof model?.designer === 'string' ? model.designer.trim() : '';
  const filePath = model?.filePath || '';

  return createPortal(
    <div className="jp jp-details">
      <div className="jp-details__preview">
        <button type="button" className="jp-details__image" title="Open the 3D preview" aria-label="Open the 3D preview"
          onClick={() => { if (filePath) void window.openPreview?.(filePath); }}>
          <img src={shown} alt="" draggable={false} />
        </button>
        <div className="jp-details__preview-actions">
          <button type="button" className={cx('jp-details__overlay-btn', favorite && 'is-favorited')} aria-pressed={favorite}
            aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'} title={favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={async () => {
              if (model && await saveCardField(model.filePath, 'favorite', !favorite)) setModel({ ...model, favorite: !favorite });
            }}>
            <Heart size={18} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
          </button>
          <button type="button" className="jp-details__overlay-btn" aria-label="More actions" title="More actions" aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              if (filePath) void window.contextMenu?.show(filePath, rect.left, rect.bottom);
            }}>
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="jp-details__overlay-btn jp-details__view-3d" title="Open the 3D preview"
          onClick={() => { if (filePath) void window.openPreview?.(filePath); }}>
          <Box size={16} aria-hidden="true" />
          <span>3D</span>
        </button>
      </div>

      {images.length > 1 && (
        <div className="jp-details__strip" role="listbox" aria-label="Images" aria-orientation="horizontal">
          {images.map((src, index) => (
            <button key={index} type="button" role="option" aria-selected={index === imageIndex} aria-label={`Image ${index + 1} of ${images.length}`}
              className={cx('jp-details__thumb', index === imageIndex && 'is-selected')} onClick={() => setImageIndex(index)}>
              <img src={src} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}

      <div className="jp-details__identity">
        <h2 className="jp-details__title" title={model ? displayFileName(model) : undefined}>{model ? cardTitle(model) : ''}</h2>
        <p className="jp-details__byline">{designer ? `By ${designer}` : ''}</p>
      </div>

      <div className="jp-details__tags" ref={setTagsHost} />

      <div className="jp-details__actions">
        <SlicerButton filePath={filePath} slicers={slicers} />
        <button type="button" id="jp-details-log-print" className="jp-btn jp-btn--secondary jp-btn--lg"
          onClick={() => { if (filePath) void window.PrintHistory?.openLogDialog({ filePaths: [filePath] }); }}>
          <ClipboardPen size={18} aria-hidden="true" />
          <span>Log Print</span>
        </button>
      </div>

      <section className="jp-details__section" aria-label="Details">
        <h3 className="jp-details__heading">Details</h3>
        <div className="jp-props">
          <Prop label="File" title={model ? displayFileName(model) : undefined}>{model ? displayFileName(model) : ''}</Prop>
          <Prop label="Format">{model ? formatOf(model) || '—' : ''}</Prop>
          <Prop label="Size">{model?.size ? formatFileSize(Number(model.size)) : '—'}</Prop>
          <div className="jp-props__group" ref={setStatusHost} />
          <div className="jp-props__group" ref={setFieldsHost} />
          <div className="jp-prop jp-prop--path">
            <span className="jp-prop__label">Location</span>
            <div className="jp-prop__value" ref={setPathHost} />
          </div>
          <Prop label="Added">{formatAdded(model?.dateAdded) || '—'}</Prop>
          <Prop label="Rating">{model && <Rating model={model} onSaved={(rating) => setModel({ ...model, rating })} />}</Prop>
        </div>
      </section>

      <section className="jp-details__section" aria-label="Filament">
        <h3 className="jp-details__heading">Filament</h3>
        <div className="jp-details__editor" ref={setFilamentsHost} />
      </section>

      <section className="jp-details__section" aria-label="Notes">
        <h3 className="jp-details__heading">Notes</h3>
        <div className="jp-details__editor" ref={setNotesHost} />
      </section>

      <section className="jp-details__section" aria-label="Print History">
        <h3 className="jp-details__heading">Print History</h3>
        <div className="jp-details__editor" ref={setHistoryHost} />
      </section>

      <div className="jp-details__footer" ref={setFooterHost} />
    </div>,
    slot
  );
}
