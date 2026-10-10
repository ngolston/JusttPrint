import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react';
import { cachedThumbnail, fetchPrimaryThumbnail, isImageOnlyMiss } from '../thumbnails/cache';
import { loadAllThumbnails, queueCardThumbnail, setDefaultThumbnail, thumbnailQueue } from '../thumbnails/cards';
import { extensionOf, isFailurePlaceholder, typedPlaceholder } from '../thumbnails/formats';
import { cardPreviewHeight, type GridModel, type GridView } from './layout';
import { applyColumns } from './columns';
import { Heart, MoreHorizontal } from 'lucide-react';
import { navigate } from '../shell/routes';
import { TONE_ICONS, printStatusInfo } from '../components/Badge';
import { cx } from '../components/Button';
import { badgeTitle, effectiveStatus, type PrintModel } from '../print/printStatus';

/** Card and preview height of a JusttPrint 5 card, as CSS variables (library.css). */
export function tileStyle(position: { width: number; height: number }): CSSProperties {
  return { '--jp-card-height': `${position.height}px`, '--jp-card-preview': `${cardPreviewHeight(position.width)}px` } as CSSProperties;
}

/** What a model card asks of the library (library/hosts.ts: selection, menus, filters, saving). */
export interface CardHost {
  isSelected(filePath: string): boolean;
  isNew(model: GridModel): boolean;
  directoryLabel(filePath: string): string;
  directoryFullPath(filePath: string): string;
  formatSize(bytes: number): string;

  /** Click on a card: selection, details, multi-edit (library/details.ts cardClick). */
  cardClick(event: MouseEvent, card: HTMLElement, filePath: string, view: GridView): void;
  /** Preview wall: open the 3D preview. */
  openPreview(card: HTMLElement | null, filePath: string, select: boolean): void;
  /** Right-click and long-press menu on the card. */
  bindCardMenu(card: HTMLElement, filePath: string): void;
  showCardMenu(filePath: string, x: number, y: number): void;
  filterByDirectory(filePath: string): void;
  /** Set a sidebar filter (designer-select, parent-select, license-select) and search. */
  filterBySelect(selectId: string, value: string): void;
  filterByTag(name: string): void;
  /** Save one field of one model; resolves false when it failed. */
  saveField(filePath: string, field: 'rating' | 'favorite', value: number | boolean): Promise<boolean>;
  tagNames(model: GridModel): Promise<string[]>;
  /** The print-status badge (PrintHistory.applyBadge/bindBadge): class, text and click. */
  printBadge(element: HTMLElement, model: GridModel): void;
}

const FAILURE_FREE = (thumbnail: unknown): thumbnail is string =>
  typeof thumbnail === 'string' && thumbnail.length > 0 && thumbnail !== '3d.png' && thumbnail.startsWith('data:image');

/** model.thumbnail holds one data URL, or several joined with '::'. */
export function parseThumbnails(value: unknown): string[] {
  if (typeof value !== 'string' || !value || value === '3d.png') return [];
  if (!value.includes('::')) return [value];
  return value.split('::').filter(FAILURE_FREE);
}

export function displayFileName(model: GridModel): string {
  if (typeof model.fileName === 'string' && model.fileName) return model.fileName;
  const path = model.filePath || '';
  const inner = path.includes('::') ? path.split('::')[1] || '' : path;
  return inner.split(/[/\\]/).pop() || 'Unknown';
}

const isZipEntry = (model: GridModel) => (model.filePath || '').includes('::') && !(model.filePath || '').startsWith('url::');
const isZipFile = (model: GridModel) => !isZipEntry(model) && displayFileName(model).toLowerCase().endsWith('.zip');
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export const normalizeRating = (value: unknown) => {
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) || n < 0 ? 0 : Math.min(n, 5);
};

function tagNamesOf(model: GridModel): string[] | null {
  if (!Array.isArray(model.tags) || !model.tags.length) return null;
  return (model.tags as unknown[])
    .map((tag) => (typeof tag === 'string' ? tag : String((tag as { name?: string })?.name ?? '')).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** Image to show, whether to fetch or render one, and the carousel images. */
function useThumbnail(host: CardHost, model: GridModel, view: GridView, priority: number, container: HTMLElement | null) {
  // Its own image arrived: redraw this card only (a grid refresh regroups the whole library).
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const all = parseThumbnails(model.thumbnail);
  const imageOnlyMiss = isImageOnlyMiss(model.filePath);
  let current: string | null = all[0] ?? null;
  let flagged = !!model.hasThumbnail;
  let multiple = all.length > 1 || !!model.hasMultipleThumbnails;
  // Stuck failure art must not block regenerating; typed placeholders for image-only misses stay.
  if (current && isFailurePlaceholder(current) && !imageOnlyMiss) {
    current = null;
    flagged = false;
    multiple = false;
  }
  if (imageOnlyMiss && !current) {
    current = typedPlaceholder(extensionOf(model.filePath));
    flagged = true;
  }
  // Already cached: show it at once instead of a placeholder frame while the fetch resolves.
  if (!current && flagged) {
    const cached = cachedThumbnail(model.filePath);
    if (cached && !isFailurePlaceholder(cached)) current = cached;
  }
  // A render that failed shows its failure art here only (it is not saved); no retry until reloaded.
  const failed = !current && typeof model._failedThumbnail === 'string' ? model._failedThumbnail : null;
  if (failed) {
    current = failed;
    flagged = true;
  }
  const carouselView = view === 'detailed' || view === 'preview';
  // What was already asked for this model object. A refresh hands the card a new object
  // (the list query leaves the image out), which needs its own fetch (cached, so cheap).
  const requested = useRef<{ model: GridModel; kind: string } | null>(null);
  const alreadyAsked = (kind: string) => requested.current?.model === model && requested.current.kind === kind;

  useEffect(() => {
    if (!container) return;
    if (!current && flagged) {
      // The list query leaves the blob out: fetch the stored primary image.
      if (alreadyAsked('primary')) return;
      requested.current = { model, kind: 'primary' };
      fetchPrimaryThumbnail(model.filePath)
        .then((thumbnail) => {
          if (thumbnail && !isFailurePlaceholder(thumbnail)) {
            model.thumbnail = thumbnail;
            model.hasThumbnail = true;
            if (carouselView && multiple) loadAllThumbnails(model);
            else redraw();
          } else if (carouselView && !imageOnlyMiss) {
            // Flagged as having one, but it is empty: render it again.
            model.hasThumbnail = false;
            queueCardThumbnail(model, container, priority);
          }
        })
        .catch(() => {});
    } else if (current && multiple && all.length < 2 && carouselView) {
      if (alreadyAsked('all')) return;
      requested.current = { model, kind: 'all' };
      loadAllThumbnails(model);
    }
  });

  // No image at all: queue a render in this browser (deduplicated, reprioritized on scroll).
  useEffect(() => {
    if (!container || current || flagged || imageOnlyMiss || thumbnailQueue.paused) return;
    queueCardThumbnail(model, container, priority);
  });

  return { current, images: carouselView && all.length > 1 ? all : null };
}

/** Default-image saves waiting on the 2-second delay, sent at once when the card goes or the page closes. */
const pendingDefaultSaves = new Map<string, () => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const save of [...pendingDefaultSaves.values()]) save();
  });
}

function Carousel({
  host,
  model,
  images,
  style,
  children
}: {
  host: CardHost;
  model: GridModel;
  images: string[];
  style: CSSProperties;
  children: (src: string) => React.ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const position = index < images.length ? index : 0;

  // Leaving the card (scrolling away, switching views) saves a pending choice right away.
  useEffect(() => () => pendingDefaultSaves.get(model.filePath)?.(), [model.filePath]);

  function step(by: number, event: ReactMouseEvent) {
    event.stopPropagation();
    const next = (position + by + images.length) % images.length;
    setIndex(next);
    // The image left showing becomes the default (for preview and list) after 2 seconds.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const save = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      pendingDefaultSaves.delete(model.filePath);
      setDefaultThumbnail(model, next)
        .then(() => setIndex(0))
        .catch((error) => console.error('Error saving default thumbnail:', error));
    };
    pendingDefaultSaves.set(model.filePath, save);
    saveTimer.current = setTimeout(save, 2000);
  }

  return (
    <div
      className="thumbnail-wrapper"
      style={{ position: 'relative', ...style }}
      data-file-path={model.filePath}
      data-thumbnails-count={images.length}
      data-current-index={position}
    >
      <div
        className="thumbnail-nav-left"
        title="Previous image"
        onClick={(event) => step(-1, event)}
        style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: '100%', cursor: 'pointer', zIndex: 10 }}
      />
      <div
        className="thumbnail-nav-right"
        title="Next image"
        onClick={(event) => step(1, event)}
        style={{ position: 'absolute', right: 0, top: 0, width: '50%', height: '100%', cursor: 'pointer', zIndex: 10 }}
      />
      <div
        className="thumbnail-count-badge"
        title={`Image ${position + 1} of ${images.length} - Click left/right to navigate`}
        style={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          background: 'rgba(0, 0, 0, 0.7)',
          color: '#fff',
          padding: '4px 8px',
          borderRadius: 12,
          fontSize: 12,
          fontWeight: 'bold',
          zIndex: 11,
          pointerEvents: 'none'
        }}
      >
        {position + 1}/{images.length}
      </div>
      {children(images[position])}
    </div>
  );
}

/** Rating and favorite of one model, saved on click. */
function useEngagement(host: CardHost, model: GridModel) {
  const [hover, setHover] = useState<number | null>(null);
  const rating = normalizeRating(model.rating);
  const favorite = !!model.favorite;

  async function save(field: 'rating' | 'favorite', value: number | boolean, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (await host.saveField(model.filePath, field, value)) {
      (model as Record<string, unknown>)[field] = value;
      window.libraryGrid?.refresh();
    }
  }

  return { rating, favorite, shown: hover ?? rating, setHover, save };
}

function RatingStars({ engagement, label = 'Rating' }: { engagement: ReturnType<typeof useEngagement>; label?: string }) {
  const { rating, shown, setHover, save } = engagement;
  return (
    <div className="model-rating" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          tabIndex={-1}
          className={`model-star${star <= shown ? ' is-filled' : ''}`}
          data-star={star}
          role="radio"
          aria-checked={star === rating}
          aria-label={`${star} star${star === 1 ? '' : 's'}`}
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(null)}
          onClick={(event) => save('rating', rating === star ? 0 : star, event)}
        >
          {star <= shown ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}

/** What a screen reader says for a card: name, designer, print status, and whether it is selected. */
export function cardLabel(model: GridModel, selected: boolean): string {
  const designer = typeof model.designer === 'string' && model.designer.trim() ? `by ${model.designer.trim()}` : '';
  const status = printStatusInfo(effectiveStatus(model as PrintModel)).label;
  return [cardTitle(model), designer, status, selected ? 'selected' : ''].filter(Boolean).join(', ');
}

/** The model's file type for the format badge ("STL", "3MF"). */
export function formatOf(model: GridModel): string {
  const name = displayFileName(model);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '';
}

/** The card title: the file name without its type, which the format badge shows. */
export function cardTitle(model: GridModel): string {
  const name = displayFileName(model);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The card's print status: click logs a print, Shift-click picks a status (window.PrintHistory). */
function CardPrintStatus({ model }: { model: GridModel }) {
  const info = printStatusInfo(effectiveStatus(model as PrintModel));
  const Icon = info.icon ?? TONE_ICONS[info.tone];
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`print-status jp-status jp-status--${info.tone}`}
      title={`${badgeTitle(model as PrintModel)}\nClick to log a print; Shift-click to set the status.`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) window.PrintHistory?.openStatusMenu(event.currentTarget, model.filePath);
        else void window.PrintHistory?.openLogDialog({ filePaths: [model.filePath] });
      }}
    >
      <Icon size={12} aria-hidden="true" />
      <span>{info.label}</span>
    </button>
  );
}

/** The print-status badge; window.PrintHistory sets its class, text and click. */
function PrintBadge({ host, model, style }: { host: CardHost; model: GridModel; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) host.printBadge(ref.current, model);
  });
  return <div ref={ref} style={style} />;
}

function TagLinks({ host, names }: { host: CardHost; names: string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          <span
            className="tag-filter-link"
            title={`Filter by tag: ${name}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              host.filterByTag(name);
            }}
          >
            {name}
          </span>
          {index < names.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  );
}

/** Tags from the model, or loaded once when the list query left them out. */
function useTagNames(host: CardHost, model: GridModel): string[] | null | undefined {
  const known = tagNamesOf(model);
  const [loaded, setLoaded] = useState<{ path: string; names: string[] } | null>(null);
  useEffect(() => {
    if (known || loaded?.path === model.filePath) return;
    let live = true;
    host
      .tagNames(model)
      .then((names) => {
        if (live) setLoaded({ path: model.filePath, names });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });
  if (known) return known;
  return loaded?.path === model.filePath ? loaded.names : undefined;
}

/** A setter that marks a style !important (the list view's name colour overrides a stylesheet rule). */
const importantColor = (color: string) => (element: HTMLElement | null) => element?.style.setProperty('color', color, 'important');

const FOLDER_ICON =
  'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z';
const ARCHIVE_ICON =
  'M640-480v-80h80v80h-80Zm0 80h-80v-80h80v80Zm0 80v-80h80v80h-80ZM447-640l-80-80H160v480h400v-80h80v80h160v-400H640v80h-80v-80H447ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80v-480 480Z';
const DESIGNER_ICON =
  'm352-522 86-87-56-57-44 44-56-56 43-44-45-45-87 87 159 158Zm328 329 87-87-45-45-44 43-56-56 43-44-57-56-86 86 158 159Zm24-567 57 57-57-57ZM290-120H120v-170l175-175L80-680l200-200 216 216 151-152q12-12 27-18t31-6q16 0 31 6t27 18l53 54q12 12 18 27t6 31q0 16-6 30.5T816-647L665-495l215 215L680-80 465-295 290-120Zm-90-80h56l392-391-57-57-391 392v56Zm420-419-29-29 57 57-28-28Z';

function Icon({ path, fill }: { path: string; fill: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, marginRight: 6 }}>
      <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" style={{ fill }}>
        <path d={path} />
      </svg>
    </div>
  );
}

export interface ModelCardProps {
  host: CardHost;
  model: GridModel;
  view: GridView;
  layoutKey: string;
  index: number;
  parentGroupKey?: string;
  bandClasses: string[];
  position: { top: number; left: number; width: number; height: number };
  /** Preview tiles and phone cards take the row height. */
  fixedHeight: boolean;
  priority: number;
  /** The JusttPrint 5 card (desktop grid view, spec §16) instead of the older detailed card. */
}

/** A model in the library grid, in the detailed, preview or list view. */
export function ModelCard({ host, model, view, layoutKey, index, parentGroupKey, bandClasses, position, fixedHeight, priority }: ModelCardProps) {
  const tile = view === 'detailed';
  const cardRef = useRef<HTMLDivElement>(null);
  // The thumbnail queue renders into this empty, hidden slot (renderModelToPNG writes into its
  // container); React never puts children in it, so the two cannot collide.
  const [renderSlot, setRenderSlot] = useState<HTMLDivElement | null>(null);
  const fileInfoRef = useRef<HTMLDivElement>(null);
  const { current, images } = useThumbnail(host, model, view, priority, renderSlot);
  const tags = useTagNames(host, model);
  const name = displayFileName(model);
  const zipEntry = isZipEntry(model);
  const zipFile = isZipFile(model);

  useEffect(() => {
    if (cardRef.current) host.bindCardMenu(cardRef.current, model.filePath);
    // Bound once per card element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (view === 'list' && fileInfoRef.current) applyColumns(fileInfoRef.current);
  });

  const classes = [
    'file-item',
    `file-item-${view}`,
    view === 'preview' && 'preview-tile',
    tile && 'jp-model-card',
    host.isSelected(model.filePath) && 'selected',
    ...bandClasses
  ]
    .filter(Boolean)
    .join(' ');

  const cardStyle: CSSProperties = {
    position: 'absolute',
    top: position.top,
    left: position.left,
    pointerEvents: 'auto',
    width: view === 'list' ? `calc(100% - ${position.left * 2}px)` : position.width
  };
  if (fixedHeight) Object.assign(cardStyle, { height: position.height, minHeight: position.height, maxHeight: position.height });
  if (view === 'list') {
    Object.assign(cardStyle, { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, padding: '6px 12px', height: 52 });
  } else if (view === 'preview') {
    Object.assign(cardStyle, { padding: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden' });
  } else if (tile) {
    Object.assign(cardStyle, tileStyle(position));
  }

  const thumbSize: CSSProperties =
    view === 'list'
      ? { width: 48, height: 48, flexShrink: 0, position: 'relative' }
      : view === 'preview'
        ? { width: '100%', height: '100%', flex: 1, minHeight: 0, marginBottom: 0 }
        : {};
  const imageSize: CSSProperties = view === 'list' ? { width: 48, height: 48 } : { width: '100%', height: '100%' };

  const thumbnail = (src: string | null) => (
    <div className="thumbnail-container" style={{ position: 'relative', ...thumbSize }}>
      <div
        className="thumbnail-render-slot"
        ref={setRenderSlot}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden' }}
      />
      <button
        type="button"
        className="thumbnail-menu-button"
        title="Menu"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          host.showCardMenu(model.filePath, rect.left, rect.bottom);
        }}
      >
        ...
      </button>
      <img src={src || 'assets/3d.png'} alt="" style={imageSize} />
      {host.isNew(model) && (
        <div className="new-status" title="New model — clears once you edit it">
          New
        </div>
      )}
    </div>
  );
  const thumbnailBlock = images ? (
    <Carousel host={host} model={model} images={images} style={view === 'preview' ? { width: '100%', height: '100%' } : thumbSize}>
      {(src) => thumbnail(src)}
    </Carousel>
  ) : (
    thumbnail(current)
  );

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (view === 'preview' && (event.target as HTMLElement).closest('.preview-tile-open-btn')) return;
    host.cardClick(event.nativeEvent, event.currentTarget, model.filePath, view);
  };

  const selected = host.isSelected(model.filePath);
  /**
   * Keyboard (spec §37): a card is one Tab stop. Enter or Space selects it (with Ctrl/Cmd or
   * Shift as with a click), the Menu key or Shift+F10 opens its menu.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const click = new MouseEvent('click', { ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey });
      host.cardClick(click, event.currentTarget, model.filePath, view);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      host.showCardMenu(model.filePath, rect.left + 16, rect.top + 16);
    }
  };
  const common = {
    ref: cardRef,
    className: classes,
    style: cardStyle,
    onClick,
    onKeyDown,
    tabIndex: 0,
    role: 'group',
    'aria-label': cardLabel(model, selected),
    'data-filepath': model.filePath,
    'data-index': index,
    'data-layout-key': layoutKey,
    'data-parent-group-key': bandClasses.length ? parentGroupKey : undefined
  };

  // Arrow keys move the selection; the keyboard focus follows it to this card.
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (selected && focused && focused !== cardRef.current && focused.closest('.file-grid') && focused.matches('.file-item')) {
      cardRef.current?.focus();
    }
  }, [selected]);

  if (view === 'preview') {
    return (
      <div
        {...common}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          host.openPreview(null, model.filePath, false);
        }}
      >
        {thumbnailBlock}
        <button
          type="button"
          className="preview-tile-open-btn preview-tile-page-btn"
          tabIndex={-1}
          title="Open the model's page"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            navigate('model', model.filePath);
          }}
        >
          Open
        </button>
        <div className="preview-tile-check" aria-hidden="true" />
        <div className="preview-tile-overlay">
          {/* Archive sits in the name row, so it never covers the name (it used to sit on top of it). */}
          <div className="preview-tile-name-row">
            {zipEntry && <span className="archive-status preview-tile-archive">Archive</span>}
            <div className={`preview-tile-name${zipFile ? ' zip-file' : ''}`}>{name}</div>
          </div>
          <div className="preview-tile-actions">
            <button
              type="button"
              className="preview-tile-open-btn"
              title="Open preview"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                host.openPreview(cardRef.current, model.filePath, true);
              }}
            >
              Preview
            </button>
          </div>
        </div>
        <PrintBadge host={host} model={model} />
      </div>
    );
  }

  if (view === 'list') {
    const directory = host.directoryLabel(model.filePath);
    const designer = text(model.designer);
    const parentModel = text(model.parentModel);
    const added = model.dateAdded ? new Date(String(model.dateAdded)) : null;
    const badgeStyle: CSSProperties = {
      position: 'static',
      top: 'auto',
      right: 'auto',
      left: 'auto',
      fontSize: 11,
      padding: '2px 6px',
      borderRadius: 3,
      display: 'inline-block',
      zIndex: 'auto',
      margin: 0
    };
    const column: CSSProperties = { display: 'flex', alignItems: 'center', flexShrink: 0 };
    const small: CSSProperties = { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    return (
      <div {...common}>
        {thumbnailBlock}
        <div className="file-info" ref={fileInfoRef} style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div
            className={`file-name${zipFile ? ' zip-file' : ''}`}
            data-list-col="name"
            title={name}
            ref={importantColor(zipFile ? 'var(--jp-success)' : 'var(--jp-text)')}
            style={{ flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}
          >
            {name}
          </div>
          <div className="file-size-column" data-list-col="size" style={{ ...column, justifyContent: 'center' }}>
            {!!model.size && <span style={{ fontSize: 12, color: 'var(--jp-text-2)', fontFamily: 'monospace' }}>{host.formatSize(Number(model.size))}</span>}
          </div>
          <div className="date-added-column" data-list-col="dateadded" style={{ ...column, justifyContent: 'center' }}>
            {added ? (
              <span title={added.toLocaleString()} style={{ fontSize: 12, color: 'var(--jp-text-2)', fontFamily: 'monospace' }}>
                {added.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })}
              </span>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--jp-text-3)' }}>—</span>
            )}
          </div>
          <div
            className="directory-info-column"
            data-list-col="directory"
            style={{ ...column, overflow: 'hidden', cursor: directory ? 'pointer' : undefined }}
            onClick={
              directory
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    host.filterByDirectory(model.filePath);
                  }
                : undefined
            }
          >
            <Icon path={zipEntry ? ARCHIVE_ICON : FOLDER_ICON} fill={zipEntry ? 'var(--jp-success)' : 'var(--jp-text-2)'} />
            <span
              className="directory-info"
              title={directory ? host.directoryFullPath(model.filePath) || directory : undefined}
              style={{
                ...small,
                color: directory ? 'var(--jp-accent)' : 'var(--jp-text-3)',
                cursor: directory ? 'pointer' : 'default',
                fontWeight: directory ? 500 : 400,
                flex: 1,
                minWidth: 0
              }}
            >
              {directory}
            </span>
          </div>
          <div className="designer-info-column" data-list-col="designer" style={{ ...column, overflow: 'hidden' }}>
            <Icon path={DESIGNER_ICON} fill="#a855f7" />
            <span
              className="designer-info"
              title={designer || undefined}
              style={{ ...small, color: designer ? 'var(--jp-text-2)' : 'var(--jp-text-3)', flex: 1, minWidth: 0 }}
            >
              {model.designer ? String(model.designer) : ''}
            </span>
          </div>
          <div className="parent-model-column" data-list-col="parentmodel" style={{ ...column, overflow: 'hidden' }}>
            <span
              className="parent-model-info"
              title={parentModel || undefined}
              style={{ ...small, color: parentModel ? 'var(--jp-text-2)' : 'var(--jp-text-3)' }}
            >
              {model.parentModel ? String(model.parentModel) : ''}
            </span>
          </div>
          <div className="print-status-column" data-list-col="printed" style={{ ...column, justifyContent: 'center' }}>
            <PrintBadge host={host} model={model} style={badgeStyle} />
          </div>
          <div className="tags-info-column" data-list-col="tags" style={{ display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
            <span
              className="tags-info"
              title={tags?.length ? tags.join(', ') : undefined}
              style={{ ...small, color: tags?.length ? 'var(--jp-text-2)' : 'var(--jp-text-3)' }}
            >
              {tags?.length ? <TagLinks host={host} names={tags} /> : '—'}
            </span>
          </div>
          <div className="archive-status-column" data-list-col="archive" style={{ ...column, justifyContent: 'center', gap: 6 }}>
            {zipEntry && (
              <>
                <Icon path={ARCHIVE_ICON} fill="var(--jp-text-2)" />
                <div className="archive-status" style={badgeStyle}>
                  Archive
                </div>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          tabIndex={-1}
          className="jp-btn jp-btn--secondary jp-btn--sm list-open-btn"
          aria-label={`Open ${name}`}
          title="Open the model's page"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            navigate('model', model.filePath);
          }}
        >
          Open
        </button>
      </div>
    );
  }

  return <ModelTile host={host} model={model} common={common} images={images} current={current} setRenderSlot={setRenderSlot} />;
}

interface TileProps {
  host: CardHost;
  model: GridModel;
  common: Record<string, unknown>;
  images: string[] | null;
  current: string | null;
  setRenderSlot: (element: HTMLDivElement | null) => void;
}

/**
 * The JusttPrint 5 model card (spec §16-19): the preview fills the top with Favorite and More
 * at its top-right (and the rating, shown on hover or once set); the footer has the title, the
 * designer (else the folder), the format badge and the print status.
 */
function ModelTile({ host, model, common, images, current, setRenderSlot }: TileProps) {
  const engagement = useEngagement(host, model);
  const { rating, favorite, save } = engagement;
  const designer = text(model.designer);
  const directory = host.directoryLabel(model.filePath).split(/[/\\]/).filter(Boolean).pop() || '';
  const format = formatOf(model);
  const title = cardTitle(model);
  const zipEntry = isZipEntry(model);

  const preview = (src: string | null) => (
    <div className="thumbnail-container jp-model-card__image">
      <div
        className="thumbnail-render-slot"
        ref={setRenderSlot}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden' }}
      />
      <img src={src || 'assets/3d.png'} alt="" loading="lazy" draggable={false} />
    </div>
  );

  const stop = (run: () => void) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  };

  return (
    <div
      {...common}
      data-rating={rating}
      data-favorite={favorite ? '1' : '0'}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        host.openPreview(null, model.filePath, false);
      }}
    >
      <div className="jp-model-card__preview">
        {images ? (
          <Carousel host={host} model={model} images={images} style={{ width: '100%', height: '100%' }}>
            {(src) => preview(src)}
          </Carousel>
        ) : (
          preview(current)
        )}
        <div className="jp-model-card__flags">
          {host.isNew(model) && (
            <span className="new-status jp-model-card__flag" title="New model — clears once you edit it">
              New
            </span>
          )}
          {zipEntry && <span className="archive-status jp-model-card__flag">Archive</span>}
        </div>
        <div className="jp-model-card__actions">
          <button
            type="button"
            tabIndex={-1}
            className="jp-model-card__action jp-model-card__open"
            aria-label={`Open ${displayFileName(model)}`}
            title="Open the model's page"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              navigate('model', model.filePath);
            }}
          >
            Open
          </button>
          <button
            type="button"
            tabIndex={-1}
            className={cx('model-favorite-btn jp-model-card__action', favorite && 'is-favorited')}
            aria-pressed={favorite}
            aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
            title={favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={(event) => save('favorite', !favorite, event)}
          >
            <Heart size={16} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="thumbnail-menu-button jp-model-card__action"
            aria-label="More actions"
            title="More actions"
            aria-haspopup="menu"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              host.showCardMenu(model.filePath, rect.left, rect.bottom);
            }}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </div>
        <div className={cx('model-engagement-bar jp-model-card__rating', rating > 0 && 'is-rated')} data-rating={rating}>
          <RatingStars engagement={engagement} />
        </div>
      </div>
      <div className="jp-model-card__body">
        <div className="file-name jp-model-card__title" title={displayFileName(model)}>
          {title}
        </div>
        {designer ? (
          <button
            type="button"
            tabIndex={-1}
            className="jp-model-card__byline designer-info"
            title={`Show models by ${designer}`}
            onClick={stop(() => host.filterBySelect('designer-select', designer))}
          >
            {designer}
          </button>
        ) : directory ? (
          <button
            type="button"
            tabIndex={-1}
            className="jp-model-card__byline directory-link"
            title={`Show the folder ${host.directoryFullPath(model.filePath) || directory}`}
            onClick={stop(() => host.filterByDirectory(model.filePath))}
          >
            {directory}
          </button>
        ) : (
          <span className="jp-model-card__byline" />
        )}
        <div className="jp-model-card__badges">
          {format && (
            <span className="jp-badge" title="File type">
              {format}
            </span>
          )}
          <CardPrintStatus model={model} />
        </div>
      </div>
    </div>
  );
}
