import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Box, ClipboardPen, Download, FileBox, Heart, MoreHorizontal, Pencil } from 'lucide-react';
import { callAction, downloadUrl, LIBRARY_CHANGED, models as modelApi, prints, type PrintEvent } from '../api';
import { Button, IconButton, cx } from '../components/Button';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { formatAdded, panelImages, Prop, Rating, saveCardField, SlicerButton, type PanelModel } from '../details/ModelDetailsPanel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { cardTitle, displayFileName, formatOf } from '../grid/ModelCard';
import { directoryLabel, folderFilterFor, formatFileSize } from '../library/paths';
import { MakerWorldSection } from '../makerworld/MakerWorldSection';
import { siteModelUrl } from '../makerworld/makerworld';
import { render as renderMarkdown } from '../notes/markdown';
import { onServerEvent } from '../page';
import { effectiveStatus, formatPrintDate, OUTCOME_LABELS, STATUS_LABELS, type PrintModel, type PrintStatus } from '../print/printStatus';
import { isPreviewablePath } from '../preview/studio';
import { useCan } from '../session';
import { loadSlicers, type Slicer } from '../slicer';
import { navigate } from '../shell/routes';
import { showCategory } from './CategoriesPage';

/** What the page shows of a model (get-model). */
type PageModel = PanelModel &
  PrintModel & {
    id?: number;
    notes?: string | null;
    license?: string | null;
    parentModel?: string | null;
    tags?: unknown[];
  };

/** A library file next to the model (get-folder-models). */
interface FolderFile {
  filePath: string;
  fileName: string | null;
  size: number | null;
  image: string | null;
}

const tagNames = (list: unknown[] | undefined) =>
  (list || []).map((tag) => (typeof tag === 'string' ? tag : String((tag as { name?: string })?.name ?? ''))).filter(Boolean);

/** Back to the library, as it was left (its filters, scroll and selection stay under the page). */
const goBack = () => navigate('library');

function showInLibrary(change: () => void) {
  navigate('library');
  applyFilterChange(() => {
    filterActions.clearAll();
    change();
  });
}

/** The pictures: a large one and the strip under it. */
function Gallery({ model, online }: { model: PageModel; online: boolean }) {
  const images = panelImages(model);
  const [index, setIndex] = useState(0);
  const shown = images[index < images.length ? index : 0];
  return (
    <div className="jp-model-page__gallery">
      <div className="jp-model-page__stage">
        <img src={shown} alt="" draggable={false} />
        {!online && (
          <button
            type="button"
            className="jp-details__overlay-btn jp-model-page__3d"
            title="Open the 3D preview"
            onClick={() => void window.openPreview?.(model.filePath)}
          >
            <Box size={16} aria-hidden="true" />
            <span>3D</span>
          </button>
        )}
      </div>
      {images.length > 1 && (
        <div className="jp-details__strip" role="listbox" aria-label="Images" aria-orientation="horizontal">
          {images.map((src, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={i === index}
              aria-label={`Image ${i + 1} of ${images.length}`}
              className={cx('jp-details__thumb', i === index && 'is-selected')}
              onClick={() => setIndex(i)}
            >
              <img src={src} alt="" draggable={false} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A file drawn in 3D in place of its picture (the 3D preview's engine, without its tools). */
function InlineViewer({ filePath }: { filePath: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Loading…');
  const [picture, setPicture] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let engine: { dispose(): void; showModel(object: unknown): void } | null = null;
    (async () => {
      const [{ PreviewEngine, loadPreviewObject }, { loadStudioSettings }] = await Promise.all([import('../preview/engine'), import('../preview/studio')]);
      if (!alive || !canvasRef.current || !containerRef.current) return;
      const created = new PreviewEngine(canvasRef.current, containerRef.current, loadStudioSettings(), {
        dimensions: () => {},
        parts: () => {},
        sitOnFace: () => {}
      });
      engine = created;
      const loaded = await loadPreviewObject(filePath, { isCurrent: () => alive, status: setStatus, set3mfRequest: () => {} });
      if (!alive) return;
      if ('imageOnly' in loaded) setPicture(loaded.dataUrl);
      else created.showModel(loaded.object);
      setStatus('');
    })().catch((error) => {
      if (alive) setStatus(error instanceof Error ? error.message : String(error));
    });
    return () => {
      alive = false;
      engine?.dispose();
    };
  }, [filePath]);

  return (
    <div className="jp-model-file__viewer" ref={containerRef}>
      <canvas ref={canvasRef} />
      {picture && <img className="jp-model-file__viewer-image" src={picture} alt="" />}
      {status && <p className="jp-meta jp-model-file__viewer-status">{status}</p>}
    </div>
  );
}

/** One file of the folder: its picture (or 3D), its names, and Open, Load 3D and Download. */
function FileCard({ file, current }: { file: FolderFile; current: boolean }) {
  const [live, setLive] = useState(false);
  const online = file.filePath.startsWith('url::');
  const name = file.fileName || file.filePath.split(/[\\/]/).pop() || '';
  const title = name.replace(/\.[a-z0-9]{2,6}$/i, '');
  const canLoad = !online && isPreviewablePath(file.filePath);
  return (
    <li className={cx('jp-card jp-model-file', current && 'is-current')} data-filepath={file.filePath}>
      <div className="jp-model-file__picture">
        {live ? (
          <InlineViewer filePath={file.filePath} />
        ) : (
          <>
            <img src={file.image || 'assets/3d.png'} alt="" draggable={false} />
            {canLoad && (
              <button type="button" className="jp-model-file__load" onClick={() => setLive(true)}>
                <Box size={14} aria-hidden="true" />
                Load 3D{file.size ? ` (${formatFileSize(file.size)})` : ''}
              </button>
            )}
          </>
        )}
      </div>
      <div className="jp-model-file__body">
        <span className="jp-model-file__title" title={title}>
          {title}
          {current && <span className="jp-badge jp-model-file__this">This model</span>}
        </span>
        <code className="jp-model-file__name" title={name}>
          {name}
        </code>
        <div className="jp-model-file__buttons">
          <Button size="sm" variant="primary" disabled={current} onClick={() => navigate('model', file.filePath)}>
            Open
          </Button>
          {!online && (
            <IconButton
              size="sm"
              icon={Download}
              label={`Download ${name}`}
              onClick={() => {
                const link = document.createElement('a');
                link.href = downloadUrl(file.filePath);
                link.download = '';
                link.click();
              }}
            />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * A model's page (#/model/<path>): everything the details sidebar shows, on a page of its own,
 * like a model page on a model site. The pictures, notes, the site's details and the other files
 * of its folder on the left; details and actions on the right. Changes go through the Edit dialog.
 */
export function ModelPage({ filePath }: { filePath: string }) {
  const canEdit = useCan('editor');
  const [model, setModel] = useState<PageModel | null | undefined>(undefined);
  const [files, setFiles] = useState<FolderFile[]>([]);
  const [events, setEvents] = useState<PrintEvent[]>([]);
  const [slicers, setSlicers] = useState<Slicer[]>([]);

  const load = useCallback(async () => {
    const next = await modelApi.get<PageModel>(filePath).catch(() => null);
    setModel(next);
    if (!next) return;
    callAction<FolderFile[]>('get-folder-models', filePath).then(setFiles, () => setFiles([]));
    if (next.id) prints.events(next.id).then(setEvents, () => setEvents([]));
  }, [filePath]);

  useEffect(() => {
    setModel(undefined);
    setFiles([]);
    setEvents([]);
    void load();
    loadSlicers().then(setSlicers, () => {});
    window.scrollTo(0, 0);
    document.getElementById('jp-content')?.scrollTo(0, 0);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    const offs = [onServerEvent('refresh-grid', soon), onServerEvent('categories-changed', soon), onServerEvent('models-changed', soon)];
    window.addEventListener(LIBRARY_CHANGED, soon);
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
      window.removeEventListener(LIBRARY_CHANGED, soon);
    };
  }, [load]);

  if (model === undefined) {
    return (
      <div className="jp-page__inner jp-model-page">
        <Skeleton height={420} />
      </div>
    );
  }
  if (!model) {
    return (
      <div className="jp-page__inner jp-model-page">
        <Panel>
          <EmptyState icon={FileBox} title="This model is not in the library" action={<Button onClick={() => navigate('library')}>Back to the Library</Button>}>
            It may have been moved, renamed or removed.
          </EmptyState>
        </Panel>
      </div>
    );
  }

  const online = model.filePath.startsWith('url::');
  const designer = typeof model.designer === 'string' ? model.designer.trim() : '';
  const tags = tagNames(model.tags);
  const status = effectiveStatus(model);
  const folderPath = online ? '' : directoryLabel(model.filePath);
  // The folder's own name (the whole path is its tooltip).
  const folder = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
  const fromSite = !!siteModelUrl(model);
  const favorite = !!model.favorite;
  const source = typeof model.source === 'string' ? model.source.trim() : '';
  const sourceIsLink = /^https?:\/\//i.test(source);

  return (
    <div className="jp-page__inner jp-model-page" data-filepath={model.filePath}>
      <nav className="jp-model-page__crumbs" aria-label="Where this model is">
        <button type="button" className="jp-model-page__back" onClick={goBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          Library
        </button>
        {folder && (
          <>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              className="jp-link-button"
              title={`Show the folder ${folderPath}`}
              onClick={() => showInLibrary(() => filterActions.setDirectory(folderFilterFor(model.filePath)))}
            >
              {folder}
            </button>
          </>
        )}
        <span aria-hidden="true">/</span>
        <span className="jp-model-page__crumb-here">{cardTitle(model)}</span>
      </nav>

      <header className="jp-model-page__header">
        <h1 className="jp-page-title" id="jp-model-page-title">
          {cardTitle(model)}
        </h1>
        {designer && (
          <p className="jp-model-page__byline">
            <button type="button" className="jp-link-button" onClick={() => showInLibrary(() => filterActions.setValue('designer', designer))}>
              By {designer}
            </button>
          </p>
        )}
      </header>

      <div className="jp-model-page__grid">
        <div className="jp-model-page__main">
          <Gallery key={model.filePath} model={model} online={online} />

          {model.notes && String(model.notes).trim() && (
            <section className="jp-card jp-model-page__notes">
              <h2 className="jp-panel-title">Notes</h2>
              <div className="jp-model-page__markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(model.notes)) }} />
            </section>
          )}

          {fromSite && (
            <div className="jp-card jp-model-page__site">
              <MakerWorldSection model={model} />
            </div>
          )}

          <section className="jp-model-page__files" aria-labelledby="jp-model-page-files">
            <h2 className="jp-panel-title" id="jp-model-page-files">
              Files{folder ? <span className="jp-meta"> in {folder}</span> : null}
            </h2>
            <ul className="jp-model-page__file-grid" id="jp-model-page-file-grid">
              {(files.length ? files : [{ filePath: model.filePath, fileName: model.fileName || null, size: model.size || null, image: null }]).map((file) => (
                <FileCard key={file.filePath} file={file} current={file.filePath === model.filePath} />
              ))}
            </ul>
          </section>
        </div>

        <aside className="jp-model-page__side">
          <section className="jp-card jp-model-page__panel" aria-labelledby="jp-model-page-details">
            <h2 className="jp-panel-title" id="jp-model-page-details">
              Model Details
            </h2>
            <div className="jp-model-page__actions">
              <SlicerButton filePath={model.filePath} slicers={slicers} />
              {canEdit && (
                <Button icon={ClipboardPen} onClick={() => void window.PrintHistory?.openLogDialog({ filePaths: [model.filePath] })}>
                  Log Print
                </Button>
              )}
              {canEdit && (
                <Button icon={Pencil} id="jp-model-page-edit" onClick={() => window.openEditModel?.(model.filePath)}>
                  Edit
                </Button>
              )}
              <span className="jp-model-page__icons">
                {canEdit && (
                  <IconButton
                    icon={Heart}
                    label={favorite ? 'Remove from favorites' : 'Add to favorites'}
                    className={cx(favorite && 'is-favorited')}
                    onClick={async () => {
                      if (await saveCardField(model.filePath, 'favorite', !favorite)) setModel({ ...model, favorite: !favorite });
                    }}
                  />
                )}
                <IconButton
                  icon={MoreHorizontal}
                  label="More actions"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void window.contextMenu?.show(model.filePath, rect.left, rect.bottom);
                  }}
                />
              </span>
            </div>
            <div className="jp-props">
              <Prop label="File" title={displayFileName(model)}>
                {displayFileName(model)}
              </Prop>
              <Prop label="Format">{formatOf(model) || '—'}</Prop>
              <Prop label="Size">{model.size ? formatFileSize(Number(model.size)) : '—'}</Prop>
              <Prop label="Print status">{STATUS_LABELS[status as PrintStatus] || status}</Prop>
              <Prop label="Rating">
                <Rating model={model} readOnly={!canEdit} onSaved={(rating) => setModel({ ...model, rating })} />
              </Prop>
              <Prop label="Designer">{designer || '—'}</Prop>
              <Prop label="Source" title={source || undefined}>
                {sourceIsLink ? (
                  <a href={source} target="_blank" rel="noopener noreferrer">
                    {source.replace(/^https?:\/\/(www\.)?/i, '')}
                  </a>
                ) : (
                  source || '—'
                )}
              </Prop>
              <Prop label="Parent model">{model.parentModel || '—'}</Prop>
              <Prop label="License">{model.license || '—'}</Prop>
              <Prop label="Tags">
                {tags.length ? (
                  <span className="jp-details__categories">
                    {tags.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="jp-chip"
                        title={`Show models tagged ${name}`}
                        onClick={() => showInLibrary(() => filterActions.setTags([name]))}
                      >
                        {name}
                      </button>
                    ))}
                  </span>
                ) : (
                  '—'
                )}
              </Prop>
              <Prop label="Categories">
                {model.categories?.length ? (
                  <span className="jp-details__categories" id="jp-model-page-categories">
                    {model.categories.map((name) => (
                      <button key={name} type="button" className="jp-chip" title={`Show the models in ${name}`} onClick={() => showCategory(name)}>
                        {name}
                      </button>
                    ))}
                  </span>
                ) : (
                  '—'
                )}
              </Prop>
              <Prop label="Location" title={online ? undefined : model.filePath}>
                {online ? 'Online model' : folderPath || '—'}
              </Prop>
              <Prop label="Added">{formatAdded(model.dateAdded) || '—'}</Prop>
            </div>
          </section>

          {files.length > 1 && (
            <section className="jp-card jp-model-page__panel" aria-labelledby="jp-model-page-file-list">
              <h2 className="jp-panel-title" id="jp-model-page-file-list">
                Files ({files.length})
              </h2>
              <ul className="jp-model-page__file-list">
                {files.map((file) => (
                  <li key={file.filePath}>
                    {file.filePath === model.filePath ? (
                      <strong>{file.fileName}</strong>
                    ) : (
                      <button type="button" className="jp-link-button" onClick={() => navigate('model', file.filePath)}>
                        {file.fileName}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="jp-card jp-model-page__panel" aria-labelledby="jp-model-page-history">
            <h2 className="jp-panel-title" id="jp-model-page-history">
              Print History
            </h2>
            {events.length ? (
              <ul className="jp-model-page__history">
                {events.map((entry) => (
                  <li key={entry.id}>
                    <span>{formatPrintDate(entry.printed_at)}</span>
                    <span>
                      {OUTCOME_LABELS[entry.outcome] || entry.outcome}
                      {entry.quantity > 1 ? ` ×${entry.quantity}` : ''}
                    </span>
                    {entry.notes && <span className="jp-meta">{entry.notes}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="jp-meta">Not printed yet.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
