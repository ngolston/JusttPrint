import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { normalizeRating, tileStyle } from './ModelCard';
import type { GridModel, GridView, GroupRecord } from './layout';
import { applyColumns } from './columns';

/** What a group card asks of the library (library/hosts.ts). */
export interface GroupCardHost {
  /** Goes up when group images change (cache cleared, preferred image picked). */
  groupThumbnailVersion(): number;
  /** Load a group's images (one per child, the preferred one first); calls back as more arrive. Returns a cancel function. */
  loadGroupThumbnails(record: GroupRecord, onImages: (images: string[]) => void): () => void;
  groupListColumns(record: GroupRecord): {
    size: string;
    dateAdded: string;
    dateAddedTitle: string;
    directory: string;
    directoryFull: string;
    designer: string;
    parentModel: string;
  };
  groupPrintSummary(children: GridModel[]): { printedCount: number; label: string };
  groupTagNames(record: GroupRecord): Promise<string[]>;
  /** Click on the card: expand (and show bundle details) or collapse. */
  groupClick(record: GroupRecord, view: GridView, card: HTMLElement): void;
  /** The chevron: expand or collapse only. */
  toggleGroup(record: GroupRecord): void;
  bindGroupMenu(card: HTMLElement, record: GroupRecord): void;
  isBundleDetailsGroup(groupKey: string): boolean;
  openBundlePreview(record: GroupRecord): void;
  /** Rate or favorite every model in the group. */
  saveGroupField(filePaths: string[], field: 'rating' | 'favorite', value: number | boolean): Promise<boolean>;
  filterBySelect(selectId: string, value: string): void;
  filterByTag(name: string): void;
}

function GroupEngagement({ host, record, className }: { host: GroupCardHost; record: GroupRecord; className?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const children = record.children;
  const rating = children.length ? Math.round(children.reduce((sum, child) => sum + normalizeRating(child.rating), 0) / children.length) : 0;
  const favorite = children.some((child) => !!child.favorite);
  const shown = hover ?? rating;
  const paths = children.map((child) => child.filePath).filter(Boolean);

  async function save(field: 'rating' | 'favorite', value: number | boolean, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (await host.saveGroupField(paths, field, value)) {
      for (const child of children) (child as Record<string, unknown>)[field] = value;
      window.libraryGrid?.refresh();
    }
  }

  return (
    <div
      className={['model-engagement-bar is-group', className, rating > 0 && 'is-rated'].filter(Boolean).join(' ')}
      data-rating={rating}
      data-favorite={favorite ? '1' : '0'}
    >
      <div className="model-rating" role="radiogroup" aria-label="Group rating">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            className={`model-star${star <= shown ? ' is-filled' : ''}`}
            data-star={star}
            aria-label={`${star} star${star === 1 ? '' : 's'}`}
            onMouseEnter={() => setHover(star)}
            onMouseLeave={() => setHover(null)}
            onClick={(event) => save('rating', rating === star ? 0 : star, event)}
          >
            {star <= shown ? '★' : '☆'}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`model-favorite-btn${favorite ? ' is-favorited' : ''}`}
        aria-pressed={favorite}
        title="Favorite all models in group"
        onClick={(event) => save('favorite', !favorite, event)}
      >
        {favorite ? '♥' : '♡'}
      </button>
    </div>
  );
}

function GroupTags({ host, record }: { host: GroupCardHost; record: GroupRecord }) {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    host
      .groupTagNames(record)
      .then((loaded) => {
        if (live) setNames(loaded);
      })
      .catch((error) => console.error('Error loading group tags:', error));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.groupKey, record.children.length]);
  return (
    <div className="parent-model-group-tags tags-info" style={names.length ? undefined : { display: 'none' }} title={names.join(', ')}>
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
    </div>
  );
}

export interface GroupCardProps {
  host: GroupCardHost;
  record: GroupRecord;
  view: GridView;
  index: number;
  position: { top: number; left: number; width: number; height: number };
  fixedHeight: boolean;
  /** The JusttPrint 5 card (desktop grid view), sized like the model cards. */
}

/** A ZIP bundle or parent-model group in the library grid. */
export function GroupCard({ host, record, view, index, position, fixedHeight }: GroupCardProps) {
  const tile = view === 'detailed';
  const cardRef = useRef<HTMLDivElement>(null);
  const fileInfoRef = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const [imageIndex, setImageIndex] = useState(0);
  const version = host.groupThumbnailVersion();
  const label = record.groupLabel || 'Group';
  const kind = record.groupKind;
  const bundleKind = kind === 'bundle' ? String(record.children[0]?.bundleKind || 'folder') : '';
  const isBundle = kind === 'bundle';
  const kindLabel = bundleKind === 'zip' ? 'zip archive' : isBundle ? 'folder' : '';
  const count = record.children.length;
  const print = host.groupPrintSummary(record.children);

  useEffect(() => {
    setImageIndex(0);
    return host.loadGroupThumbnails(record, (loaded) => setImages(loaded));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.groupKey, count, version]);

  useEffect(() => {
    if (cardRef.current) host.bindGroupMenu(cardRef.current, record);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (view === 'list' && fileInfoRef.current) applyColumns(fileInfoRef.current);
  });

  const classes = [
    'parent-model-group',
    `parent-model-group-${view}`,
    view !== 'list' && 'file-item',
    view !== 'list' && `file-item-${view}`,
    tile && 'jp-model-card jp-group-card',
    record.expanded && 'expanded',
    host.isBundleDetailsGroup(record.groupKey) && 'bundle-details-active'
  ]
    .filter(Boolean)
    .join(' ');

  const style: CSSProperties = {
    position: 'absolute',
    top: position.top,
    left: position.left,
    pointerEvents: 'auto',
    width: view === 'list' ? `calc(100% - ${position.left * 2}px)` : position.width
  };
  if (fixedHeight || view === 'list') style.height = position.height;
  if (fixedHeight) Object.assign(style, { minHeight: position.height, maxHeight: position.height });
  if (tile) Object.assign(style, tileStyle(position));

  const shownIndex = imageIndex < images.length ? imageIndex : 0;
  const step = (by: number) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setImageIndex((shownIndex + by + images.length) % images.length);
  };

  const chevron = (
    <span
      className="parent-model-group-chevron"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        host.toggleGroup(record);
      }}
    >
      {record.expanded ? '▾' : '▸'}
    </span>
  );
  const titleRow = (
    <div className="parent-model-group-title-row">
      {chevron}
      <span
        className={`parent-model-group-title${kind === 'parentModel' ? ' parent-model-filter-link' : ''}`}
        title={label}
        onClick={
          kind === 'parentModel'
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                host.filterBySelect('parent-select', label);
              }
            : undefined
        }
      >
        {label}
      </span>
    </div>
  );

  const thumbnail = (
    <div className="parent-model-group-thumbnail" style={{ position: 'relative' }}>
      <img src={images[shownIndex] || 'assets/3d.png'} alt="" />
      {view !== 'list' && (
        <div
          className={`parent-model-group-corner-badge ${record.expanded ? 'is-expanded' : 'is-collapsed'}`}
          title={
            isBundle
              ? `${bundleKind === 'zip' ? 'ZIP bundle' : 'Folder bundle'} (${record.expanded ? 'expanded' : 'collapsed'})`
              : `Parent model group (${record.expanded ? 'expanded' : 'collapsed'})`
          }
        >
          <span />
          <span />
          <span />
        </div>
      )}
      {images.length > 1 && (
        <>
          <div
            className="thumbnail-nav-left"
            title="Previous group thumbnail"
            onClick={step(-1)}
            style={{ position: 'absolute', left: 0, top: 0, width: '50%', height: '100%', cursor: 'pointer', zIndex: 10 }}
          />
          <div
            className="thumbnail-nav-right"
            title="Next group thumbnail"
            onClick={step(1)}
            style={{ position: 'absolute', right: 0, top: 0, width: '50%', height: '100%', cursor: 'pointer', zIndex: 10 }}
          />
          {view !== 'list' && (
            <div
              className="thumbnail-count-badge"
              title={`Group thumbnail ${shownIndex + 1} of ${images.length}`}
              style={{
                position: 'absolute',
                bottom: 8,
                right: 8,
                background: 'rgba(0,0,0,0.7)',
                color: '#fff',
                padding: '4px 8px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 'bold',
                zIndex: 11,
                pointerEvents: 'none'
              }}
            >
              {shownIndex + 1}/{images.length}
            </div>
          )}
        </>
      )}
    </div>
  );

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        '.parent-model-group-chevron, .model-engagement-bar, .tag-filter-link, .preview-tile-open-btn, .thumbnail-nav-left, .thumbnail-nav-right, .thumbnail-menu-button'
      )
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    host.groupClick(record, view, event.currentTarget);
  };

  const cell = (col: string, className: string, text: string, title?: string) => (
    <div className={className} data-list-col={col} title={title}>
      <span style={{ fontSize: 12, color: text === '—' ? '#666' : '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
    </div>
  );

  let body;
  if (tile) {
    const kindBadge = isBundle ? (bundleKind === 'zip' ? 'ZIP' : 'Folder') : 'Group';
    body = (
      <>
        <div className="jp-model-card__preview">
          {thumbnail}
          <GroupEngagement host={host} record={record} className="jp-model-card__rating" />
        </div>
        <div className="jp-model-card__body parent-model-group-details">
          {titleRow}
          <div className="parent-model-group-meta jp-model-card__byline" title={isBundle ? 'Right-click for Preview and more options' : undefined}>
            {isBundle ? `${count} part${count === 1 ? '' : 's'}` : `${count} model${count === 1 ? '' : 's'}`}
          </div>
          <div className="jp-model-card__badges">
            <span className="jp-badge" title={isBundle ? `${kindLabel || 'folder'} bundle` : 'Models with the same parent model'}>
              {kindBadge}
            </span>
            <span className={`jp-status jp-status--${print.printedCount > 0 ? 'success' : 'neutral'}`}>{print.label}</span>
          </div>
        </div>
      </>
    );
  } else if (view === 'list') {
    const cols = host.groupListColumns(record);
    const archiveText = isBundle ? `${count} part${count === 1 ? '' : 's'}${kindLabel ? ` • ${kindLabel}` : ''}` : `${count} model${count === 1 ? '' : 's'}`;
    body = (
      <>
        {thumbnail}
        <div className="file-info" ref={fileInfoRef} style={{ flex: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div className="file-name" data-list-col="name" style={{ alignItems: 'center', gap: 8 }}>
            {titleRow}
          </div>
          {cell('size', 'file-size-column', cols.size || '—')}
          {cell('dateadded', 'date-added-column', cols.dateAdded || '—', cols.dateAddedTitle || undefined)}
          {cell('directory', 'directory-info-column', cols.directory || '—', cols.directoryFull || cols.directory || undefined)}
          {cell('designer', 'designer-info-column', cols.designer || '—', cols.designer || undefined)}
          {cell('parentmodel', 'parent-model-column', cols.parentModel || '—', cols.parentModel || undefined)}
          <div className="print-status-column" data-list-col="printed">
            <span className={print.printedCount > 0 ? 'print-status printed' : 'print-status'}>{print.label}</span>
          </div>
          <div className="tags-info-column" data-list-col="tags">
            <GroupTags host={host} record={record} />
          </div>
          {cell('archive', 'archive-status-column', archiveText, isBundle ? 'Right-click for Preview and more options' : archiveText)}
        </div>
      </>
    );
  } else {
    body = (
      <>
        {thumbnail}
        <div className="parent-model-group-details">
          {titleRow}
          <div className="parent-model-group-meta" title={isBundle ? 'Right-click for Preview and more options' : undefined}>
            {isBundle
              ? `${count} part${count === 1 ? '' : 's'} • ${kindLabel || 'folder'} • ${print.label}`
              : `${count} model${count === 1 ? '' : 's'} • ${print.label}`}
          </div>
        </div>
        {view === 'preview' && (
          <div className="preview-tile-overlay">
            <div className="preview-tile-name">{label}</div>
            {isBundle && (
              <div className="preview-tile-actions">
                <button
                  type="button"
                  className="preview-tile-open-btn"
                  title="Open preview"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    host.openBundlePreview(record);
                  }}
                >
                  Preview
                </button>
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div
      ref={cardRef}
      className={classes}
      style={style}
      tabIndex={0}
      role="button"
      aria-expanded={record.expanded}
      title={`${record.expanded ? 'Collapse' : 'Expand'} ${label}`}
      data-group-key={record.groupKey}
      data-group-kind={kind}
      data-child-count={count}
      data-expanded={record.expanded ? '1' : '0'}
      data-index={index}
      data-layout-key={record.key}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          host.groupClick(record, view, event.currentTarget);
        }
      }}
    >
      {body}
    </div>
  );
}
