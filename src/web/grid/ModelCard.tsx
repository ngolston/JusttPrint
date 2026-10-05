import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { GridModel, GridView } from './layout';

/** What a model card asks of renderer.js (thumbnail queue, selection, menus, filters, saving). */
export interface CardHost {
  isSelected(filePath: string): boolean;
  isMobile(): boolean;
  isNew(model: GridModel): boolean;
  directoryLabel(filePath: string): string;
  directoryFullPath(filePath: string): string;
  formatSize(bytes: number): string;

  /** Stored primary thumbnail (cached), or null. */
  fetchPrimaryThumbnail(filePath: string): Promise<string | null>;
  /** The primary thumbnail if it is already cached (no request). */
  cachedPrimaryThumbnail(filePath: string): string | null;
  /** Render a thumbnail in this browser (priority queue); on success the model is updated and the grid refreshed. */
  ensureThumbnailQueued(model: GridModel, container: HTMLElement, priority: number): void;
  /** Load every image of a model with several; updates model.thumbnail and refreshes. */
  loadAllThumbnails(model: GridModel): void;
  /** Make image `index` the default; updates model.thumbnail (now first) and refreshes. */
  setDefaultThumbnail(model: GridModel, index: number): Promise<void>;
  isFailurePlaceholder(thumbnail: string): boolean;
  imageOnlyMiss(filePath: string): boolean;
  typedPlaceholder(filePath: string): string;
  bulkThumbnailJobActive(): boolean;

  /** Click on a card: selection, details, multi-edit (renderer.js handleFileClick / toggleModelSelection). */
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
  /** The print-status badge (print-history.js): class, text and click. */
  printBadge(element: HTMLElement, model: GridModel): void;
  /** List view: column widths and order from the user's column settings. */
  applyListColumns(fileInfo: HTMLElement): void;
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

const isZipEntry = (model: GridModel) => (model.filePath || '').includes('::');
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
  const all = parseThumbnails(model.thumbnail);
  const imageOnlyMiss = host.imageOnlyMiss(model.filePath);
  let current: string | null = all[0] ?? null;
  let flagged = !!model.hasThumbnail;
  let multiple = all.length > 1 || !!model.hasMultipleThumbnails;
  // Stuck failure art must not block regenerating; typed placeholders for image-only misses stay.
  if (current && host.isFailurePlaceholder(current) && !imageOnlyMiss) {
    current = null;
    flagged = false;
    multiple = false;
  }
  if (imageOnlyMiss && !current) {
    current = host.typedPlaceholder(model.filePath);
    flagged = true;
  }
  // Already cached: show it at once instead of a placeholder frame while the fetch resolves.
  if (!current && flagged) {
    const cached = host.cachedPrimaryThumbnail(model.filePath);
    if (cached && !host.isFailurePlaceholder(cached)) current = cached;
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
      host.fetchPrimaryThumbnail(model.filePath).then((thumbnail) => {
        if (thumbnail && !host.isFailurePlaceholder(thumbnail)) {
          model.thumbnail = thumbnail;
          model.hasThumbnail = true;
          if (carouselView && multiple) host.loadAllThumbnails(model);
          else window.libraryGrid?.refresh();
        } else if (carouselView && !imageOnlyMiss) {
          // Flagged as having one, but it is empty: render it again.
          model.hasThumbnail = false;
          host.ensureThumbnailQueued(model, container, priority);
        }
      }).catch(() => {});
    } else if (current && multiple && all.length < 2 && carouselView) {
      if (alreadyAsked('all')) return;
      requested.current = { model, kind: 'all' };
      host.loadAllThumbnails(model);
    }
  });

  // No image at all: queue a render in this browser (deduplicated, reprioritized on scroll).
  useEffect(() => {
    if (!container || current || flagged || imageOnlyMiss || host.bulkThumbnailJobActive()) return;
    host.ensureThumbnailQueued(model, container, priority);
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

function Carousel({ host, model, images, style, children }: {
  host: CardHost; model: GridModel; images: string[]; style: CSSProperties; children: (src: string) => React.ReactNode;
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
      host.setDefaultThumbnail(model, next).then(() => setIndex(0)).catch((error) => console.error('Error saving default thumbnail:', error));
    };
    pendingDefaultSaves.set(model.filePath, save);
    saveTimer.current = setTimeout(save, 2000);
  }

  return (
    <div className="thumbnail-wrapper" style={{ position: 'relative', ...style }} data-file-path={model.filePath}
      data-thumbnails-count={images.length} data-current-index={position}>
      <div className="thumbnail-nav-left" title="Previous image" onClick={(event) => step(-1, event)}
        style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: '100%', cursor: 'pointer', zIndex: 10 }} />
      <div className="thumbnail-nav-right" title="Next image" onClick={(event) => step(1, event)}
        style={{ position: 'absolute', right: 0, top: 0, width: '50%', height: '100%', cursor: 'pointer', zIndex: 10 }} />
      <div className="thumbnail-count-badge" title={`Image ${position + 1} of ${images.length} - Click left/right to navigate`}
        style={{ position: 'absolute', bottom: 8, right: 8, background: 'rgba(0, 0, 0, 0.7)', color: '#fff', padding: '4px 8px', borderRadius: 12, fontSize: 12, fontWeight: 'bold', zIndex: 11, pointerEvents: 'none' }}>
        {position + 1}/{images.length}
      </div>
      {children(images[position])}
    </div>
  );
}

function EngagementBar({ host, model }: { host: CardHost; model: GridModel }) {
  const [hover, setHover] = useState<number | null>(null);
  const rating = normalizeRating(model.rating);
  const favorite = !!model.favorite;
  const shown = hover ?? rating;

  async function save(field: 'rating' | 'favorite', value: number | boolean, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (await host.saveField(model.filePath, field, value)) {
      (model as Record<string, unknown>)[field] = value;
      window.libraryGrid?.refresh();
    }
  }

  return (
    <div className="model-engagement-bar" data-rating={rating} data-favorite={favorite ? '1' : '0'}>
      <div className="model-rating" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((star) => (
          <button key={star} type="button" className={`model-star${star <= shown ? ' is-filled' : ''}`} data-star={star}
            aria-label={`${star} star${star === 1 ? '' : 's'}`}
            onMouseEnter={() => setHover(star)} onMouseLeave={() => setHover(null)}
            onClick={(event) => save('rating', rating === star ? 0 : star, event)}>
            {star <= shown ? '★' : '☆'}
          </button>
        ))}
      </div>
      <button type="button" className={`model-favorite-btn${favorite ? ' is-favorited' : ''}`} aria-pressed={favorite} title="Favorite"
        onClick={(event) => save('favorite', !favorite, event)}>
        {favorite ? '♥' : '♡'}
      </button>
    </div>
  );
}

/** The print-status badge; print-history.js owns its class, text and click. */
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
          <span className="tag-filter-link" title={`Filter by tag: ${name}`}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); host.filterByTag(name); }}>{name}</span>
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
    host.tagNames(model).then((names) => { if (live) setLoaded({ path: model.filePath, names }); }).catch(() => {});
    return () => { live = false; };
  });
  if (known) return known;
  return loaded?.path === model.filePath ? loaded.names : undefined;
}

/** A setter that marks a style !important (the list view's name colour overrides a stylesheet rule). */
const importantColor = (color: string) => (element: HTMLElement | null) => element?.style.setProperty('color', color, 'important');

const FOLDER_ICON = 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z';
const ARCHIVE_ICON = 'M640-480v-80h80v80h-80Zm0 80h-80v-80h80v80Zm0 80v-80h80v80h-80ZM447-640l-80-80H160v480h400v-80h80v80h160v-400H640v80h-80v-80H447ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80v-480 480Z';
const DESIGNER_ICON = 'm352-522 86-87-56-57-44 44-56-56 43-44-45-45-87 87 159 158Zm328 329 87-87-45-45-44 43-56-56 43-44-57-56-86 86 158 159Zm24-567 57 57-57-57ZM290-120H120v-170l175-175L80-680l200-200 216 216 151-152q12-12 27-18t31-6q16 0 31 6t27 18l53 54q12 12 18 27t6 31q0 16-6 30.5T816-647L665-495l215 215L680-80 465-295 290-120Zm-90-80h56l392-391-57-57-391 392v56Zm420-419-29-29 57 57-28-28Z';

function Icon({ path, fill }: { path: string; fill: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, flexShrink: 0, marginRight: 6 }}>
      <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill={fill}><path d={path} /></svg>
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
}

/** A model in the library grid, in the detailed, preview or list view. */
export function ModelCard({ host, model, view, layoutKey, index, parentGroupKey, bandClasses, position, fixedHeight, priority }: ModelCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // The thumbnail queue renders into this empty, hidden slot (renderModelToPNG writes into its
  // container); React never puts children in it, so the two cannot collide.
  const [renderSlot, setRenderSlot] = useState<HTMLDivElement | null>(null);
  const fileInfoRef = useRef<HTMLDivElement>(null);
  const { current, images } = useThumbnail(host, model, view, priority, renderSlot);
  const tags = useTagNames(host, model);
  const name = displayFileName(model);
  const mobile = host.isMobile();
  const zipEntry = isZipEntry(model);
  const zipFile = isZipFile(model);

  useEffect(() => {
    if (cardRef.current) host.bindCardMenu(cardRef.current, model.filePath);
    // Bound once per card element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (view === 'list' && fileInfoRef.current) host.applyListColumns(fileInfoRef.current);
  });

  const classes = ['file-item', `file-item-${view}`, view === 'preview' && 'preview-tile', host.isSelected(model.filePath) && 'selected', ...bandClasses]
    .filter(Boolean).join(' ');

  const cardStyle: CSSProperties = {
    position: 'absolute', top: position.top, left: position.left, pointerEvents: 'auto',
    width: view === 'list' ? `calc(100% - ${position.left * 2}px)` : position.width
  };
  if (fixedHeight) Object.assign(cardStyle, { height: position.height, minHeight: position.height, maxHeight: position.height });
  if (view === 'list') {
    Object.assign(cardStyle, { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, padding: '6px 12px', height: 52 });
  } else if (view === 'preview') {
    Object.assign(cardStyle, { padding: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden' });
  } else {
    Object.assign(cardStyle, { boxSizing: 'border-box', display: 'flex', flexDirection: 'column' });
    if (mobile) Object.assign(cardStyle, { padding: '6px 6px 8px', overflow: 'hidden' });
    else Object.assign(cardStyle, { width: 300, height: 490, minHeight: 490, maxHeight: 490, padding: '16px 16px 0' });
  }

  const thumbSize: CSSProperties = view === 'list'
    ? { width: 48, height: 48, flexShrink: 0, position: 'relative' }
    : view === 'preview'
      ? { width: '100%', height: '100%', flex: 1, minHeight: 0, marginBottom: 0 }
      : mobile ? { width: '100%', height: 'auto', aspectRatio: '1', flexShrink: 0 } : { width: 276, height: 276, flexShrink: 0 };
  const imageSize: CSSProperties = view === 'list' ? { width: 48, height: 48 } : view === 'preview' || mobile ? { width: '100%', height: '100%' } : { width: 276, height: 276 };

  const thumbnail = (src: string | null) => (
    <div className="thumbnail-container" style={{ position: 'relative', ...thumbSize }}>
      <div className="thumbnail-render-slot" ref={setRenderSlot} aria-hidden="true"
        style={{ position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden' }} />
      <button type="button" className="thumbnail-menu-button" title="Menu" onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        host.showCardMenu(model.filePath, rect.left, rect.bottom);
      }}>...</button>
      <img src={src || '3d.png'} alt="" style={imageSize} />
      {host.isNew(model) && <div className="new-status" title="New model — clears once you edit it">New</div>}
    </div>
  );
  const thumbnailBlock = images
    ? <Carousel host={host} model={model} images={images} style={view === 'preview' ? { width: '100%', height: '100%' } : thumbSize}>{(src) => thumbnail(src)}</Carousel>
    : thumbnail(current);

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (view === 'preview' && (event.target as HTMLElement).closest('.preview-tile-open-btn')) return;
    host.cardClick(event.nativeEvent, event.currentTarget, model.filePath, view);
  };

  const common = {
    ref: cardRef, className: classes, style: cardStyle, onClick,
    'data-filepath': model.filePath, 'data-index': index, 'data-layout-key': layoutKey,
    'data-parent-group-key': bandClasses.length ? parentGroupKey : undefined
  };

  if (view === 'preview') {
    return (
      <div {...common} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); host.openPreview(null, model.filePath, false); }}>
        {thumbnailBlock}
        <div className="preview-tile-check" aria-hidden="true" />
        <div className="preview-tile-overlay">
          <div className={`preview-tile-name${zipFile ? ' zip-file' : ''}`}>{name}</div>
          <div className="preview-tile-actions">
            <button type="button" className="preview-tile-open-btn" title="Open preview" onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              host.openPreview(cardRef.current, model.filePath, true);
            }}>Preview</button>
          </div>
        </div>
        <PrintBadge host={host} model={model} />
        {zipEntry && <div className="archive-status">Archive</div>}
      </div>
    );
  }

  if (view === 'list') {
    const directory = host.directoryLabel(model.filePath);
    const designer = text(model.designer);
    const parentModel = text(model.parentModel);
    const added = model.dateAdded ? new Date(String(model.dateAdded)) : null;
    const badgeStyle: CSSProperties = { position: 'static', top: 'auto', right: 'auto', left: 'auto', fontSize: 11, padding: '2px 6px', borderRadius: 3, display: 'inline-block', zIndex: 'auto', margin: 0 };
    const column: CSSProperties = { display: 'flex', alignItems: 'center', flexShrink: 0 };
    const small: CSSProperties = { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
    return (
      <div {...common}>
        {thumbnailBlock}
        <div className="file-info" ref={fileInfoRef} style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div className={`file-name${zipFile ? ' zip-file' : ''}`} data-list-col="name" title={name} ref={importantColor(zipFile ? '#4ade80' : '#fff')}
            style={{ flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{name}</div>
          <div className="file-size-column" data-list-col="size" style={{ ...column, justifyContent: 'center' }}>
            {!!model.size && <span style={{ fontSize: 12, color: '#aaa', fontFamily: 'monospace' }}>{host.formatSize(Number(model.size))}</span>}
          </div>
          <div className="date-added-column" data-list-col="dateadded" style={{ ...column, justifyContent: 'center' }}>
            {added
              ? <span title={added.toLocaleString()} style={{ fontSize: 12, color: '#aaa', fontFamily: 'monospace' }}>{added.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })}</span>
              : <span style={{ fontSize: 12, color: '#666' }}>—</span>}
          </div>
          <div className="directory-info-column" data-list-col="directory" style={{ ...column, overflow: 'hidden', cursor: directory ? 'pointer' : undefined }}
            onClick={directory ? (event) => { event.preventDefault(); event.stopPropagation(); host.filterByDirectory(model.filePath); } : undefined}>
            <Icon path={zipEntry ? ARCHIVE_ICON : FOLDER_ICON} fill={zipEntry ? '#22c55e' : '#e3e3e3'} />
            <span className="directory-info" title={directory ? host.directoryFullPath(model.filePath) || directory : undefined}
              style={{ ...small, color: directory ? '#4a9eff' : '#888', cursor: directory ? 'pointer' : 'default', fontWeight: directory ? 500 : 400, flex: 1, minWidth: 0 }}>{directory}</span>
          </div>
          <div className="designer-info-column" data-list-col="designer" style={{ ...column, overflow: 'hidden' }}>
            <Icon path={DESIGNER_ICON} fill="#a855f7" />
            <span className="designer-info" title={designer || undefined} style={{ ...small, color: designer ? '#aaa' : '#666', flex: 1, minWidth: 0 }}>{model.designer ? String(model.designer) : ''}</span>
          </div>
          <div className="parent-model-column" data-list-col="parentmodel" style={{ ...column, overflow: 'hidden' }}>
            <span className="parent-model-info" title={parentModel || undefined} style={{ ...small, color: parentModel ? '#aaa' : '#666' }}>{model.parentModel ? String(model.parentModel) : ''}</span>
          </div>
          <div className="print-status-column" data-list-col="printed" style={{ ...column, justifyContent: 'center' }}>
            <PrintBadge host={host} model={model} style={badgeStyle} />
          </div>
          <div className="tags-info-column" data-list-col="tags" style={{ display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
            <span className="tags-info" title={tags?.length ? tags.join(', ') : undefined} style={{ ...small, color: tags?.length ? '#aaa' : '#666' }}>
              {tags?.length ? <TagLinks host={host} names={tags} /> : '—'}
            </span>
          </div>
          <div className="archive-status-column" data-list-col="archive" style={{ ...column, justifyContent: 'center', gap: 6 }}>
            {zipEntry && (
              <>
                <Icon path={ARCHIVE_ICON} fill="#e3e3e3" />
                <div className="archive-status" style={badgeStyle}>Archive</div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Detailed
  const directory = host.directoryLabel(model.filePath);
  const designer = text(model.designer);
  const source = text(model.source);
  const parentModel = text(model.parentModel);
  const license = text(model.license);
  const filterLink = (selectId: string, value: string) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    host.filterBySelect(selectId, value);
  };
  return (
    <div {...common}>
      <PrintBadge host={host} model={model} />
      {zipEntry && <div className="archive-status">Archive</div>}
      {thumbnailBlock}
      <div className={`file-name${zipFile ? ' zip-file' : ''}`} style={{
        display: 'block', fontSize: 13, fontWeight: 500, color: '#fff', marginTop: 8, marginBottom: 8, padding: '5px 8px', textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%', boxSizing: 'border-box', minHeight: 28, lineHeight: 1.4,
        backgroundColor: 'rgba(255, 255, 255, 0.05)', borderRadius: 4, flexShrink: 0
      }}>{name}</div>
      <div className="file-info" style={{ minHeight: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', gap: 4, overflow: 'visible', padding: 0, margin: 0 }}>
        <div className="file-details" style={{ padding: 0, margin: 0 }}>
          <div className="metadata-container" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', padding: 0 }}>
            {(directory || !!model.size) && (
              <div className="metadata-item dir-size-row" style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                {directory && (
                  <div className="directory-part" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                    onClick={(event) => { event.preventDefault(); event.stopPropagation(); host.filterByDirectory(model.filePath); }}>
                    <span className="metadata-icon">📁</span>
                    <span className="metadata-value directory-link" title={host.directoryFullPath(model.filePath) || directory}>{directory}</span>
                  </div>
                )}
                {!!model.size && (
                  <div className="size-part" style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                    <span className="metadata-icon">💾</span>
                    <span className="metadata-value file-size">{host.formatSize(Number(model.size))}</span>
                  </div>
                )}
              </div>
            )}
            {designer && (
              <div className="metadata-item designer-item clickable-metadata" style={{ cursor: 'pointer' }} onClick={filterLink('designer-select', designer)}>
                <span className="metadata-icon">👤</span>
                <span className="metadata-value designer-info" style={{ color: '#ccc', display: 'inline-block' }} title={designer}>{designer}</span>
              </div>
            )}
            {source && (
              <div className="metadata-item source-item">
                <span className="metadata-icon">🔗</span>
                <span className="metadata-value source-info" style={{ color: '#ccc' }} title={source}>{source}</span>
              </div>
            )}
            {parentModel && (
              <div className="metadata-item parent-item clickable-metadata" style={{ cursor: 'pointer' }} onClick={filterLink('parent-select', parentModel)}>
                <span className="metadata-icon">📦</span>
                <span className="metadata-value parent-info" style={{ color: '#ccc' }} title={parentModel}>{parentModel}</span>
              </div>
            )}
            {license && (
              <div className="metadata-item license-item clickable-metadata" style={{ cursor: 'pointer' }} onClick={filterLink('license-select', license)}>
                <span className="metadata-icon">📜</span>
                <span className="metadata-value license-info" style={{ color: '#ccc' }} title={license}>{license}</span>
              </div>
            )}
            {tags !== null && (tags === undefined || tags.length > 0) && (
              <div className="metadata-item tags-item" style={{ gridColumn: '1 / -1' }}>
                <span className="metadata-icon">🏷️</span>
                <span className="metadata-value tags-info" style={{ color: tags ? '#ccc' : '#666' }} title={tags ? tags.join(', ') : ''}>
                  {tags && <TagLinks host={host} names={tags} />}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      <EngagementBar host={host} model={model} />
    </div>
  );
}
