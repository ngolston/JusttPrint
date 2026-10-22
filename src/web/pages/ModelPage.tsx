import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, Box, ClipboardPen, Download, ExternalLink, FileBox, Heart, MoreHorizontal, Pencil } from 'lucide-react';
import { callAction, dedup, downloadUrl, groups as groupsApi, LIBRARY_CHANGED, models as modelApi, prints, type ModelGroupRef, type PrintEvent } from '../api';
import { Button, IconButton, cx } from '../components/Button';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { formatAdded, panelImages, Prop, Rating, saveCardField, SlicerButton, type PanelModel } from '../details/ModelDetailsPanel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { cardTitle, displayFileName, formatOf } from '../grid/ModelCard';
import { directoryLabel, folderFilterFor, formatFileSize } from '../library/paths';
import { MakerWorldSection } from '../makerworld/MakerWorldSection';
import { onServerEvent } from '../page';
import { effectiveStatus, formatPrintDate, OUTCOME_LABELS, STATUS_LABELS, type PrintModel, type PrintStatus } from '../print/printStatus';
import { isPreviewablePath } from '../preview/studio';
import { useCan } from '../session';
import { loadSlicers, type Slicer } from '../slicer';
import { navigate } from '../shell/routes';
import { CategoryPlace } from './CategoriesPage';
import { KitChecklist } from '../kits/KitChecklist';
import { UploadVersionButton } from './ModelHistory';
import { ModelGallery } from '../media/ModelGallery';
import { ModelMediaSection, YoutubeVideo } from '../media/ModelMediaSection';
import { ModelUploadButton, useModelUpload } from '../media/ModelUpload';
import { DeletePrintButton, DescriptionSection, NotesPanel, PageStatus, PageTags } from './ModelPageParts';
import { getSiteDetails, siteModelUrl, type MakerWorldDetails } from '../makerworld/makerworld';
import { folderOf } from '../media/media';
import { extensionOf, isArchive } from '../thumbnails/formats';

/** What the page shows of a model (get-model). */
type PageModel = PanelModel &
  PrintModel & {
    id?: number;
    notes?: string | null;
    /** What the model is (its site's or its 3MF's description), apart from your notes. */
    description?: string | null;
    license?: string | null;
    tags?: unknown[];
    /** The model's Title (from its 3MF, or typed in Edit). */
    title?: string | null;
    /** The page's title: the Title, else the site's title, else its model folder's name (null: the file's name). */
    pageTitle?: string | null;
    /** Its model folder, when it is in one. */
    modelFolder?: string | null;
    /** In a model folder: the file's own pictures (its 3D renders), without the cover. */
    renders?: string[] | null;
    /** The id of the model it is a part of (a file uploaded on that model's page), else null. */
    partOf?: number | null;
  };

/** A library file next to the model (get-folder-models). */
export interface FolderFile {
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

/** An online model (no file): the videos and the PDF its site has. */
function SiteOnlyMedia({ videos, pdfUrl }: { videos: string[]; pdfUrl: string | null }) {
  return (
    <>
      {videos.length > 0 && (
        <section className="jp-card jp-media" id="jp-model-videos" aria-labelledby="jp-model-videos-title">
          <h2 className="jp-panel-title" id="jp-model-videos-title">
            Videos
          </h2>
          <ul className="jp-media__videos">
            {videos.map((id) => (
              <YoutubeVideo key={id} id={id} />
            ))}
          </ul>
        </section>
      )}
      {pdfUrl && (
        <section className="jp-card jp-media" id="jp-model-documents" aria-labelledby="jp-model-documents-title">
          <h2 className="jp-panel-title" id="jp-model-documents-title">
            Documents
          </h2>
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
            {decodeURIComponent(pdfUrl.split('/').pop() || 'Model PDF')} (on the site)
          </a>
        </section>
      )}
    </>
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
export function FileCard({ file, current }: { file: FolderFile; current: boolean }) {
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
            <img
              src={file.image || 'assets/3d.png'}
              alt=""
              draggable={false}
              onError={(event) => {
                // A picture that cannot be shown: the placeholder.
                if (!event.currentTarget.src.endsWith('assets/3d.png')) event.currentTarget.src = 'assets/3d.png';
              }}
            />
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

interface LookAlike {
  filePath: string;
  fileName: string | null;
  distance: number;
  image: string | null;
}

/** More like this: models shaped like this one at any size (geometry-job.js lookAlikes), found when asked. */
function MoreLikeThis({ filePath }: { filePath: string }) {
  const [result, setResult] = useState<{ models: LookAlike[]; unmeasured: number; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [measuring, setMeasuring] = useState(false);
  const canEdit = useCan('editor');

  // Measuring the library (the geometry scan Duplicates uses): compare again when it is done.
  useEffect(() => {
    if (!measuring) return undefined;
    return onServerEvent('geometry-complete', () => {
      setMeasuring(false);
      void find();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring]);

  async function measure() {
    setMeasuring(true);
    try {
      await dedup.startGeometry(null);
    } catch (failure) {
      setMeasuring(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function find() {
    setBusy(true);
    setError('');
    try {
      setResult(await callAction('look-alike-models', filePath));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="jp-model-page__alike" aria-labelledby="jp-model-page-alike">
      <h2 className="jp-panel-title" id="jp-model-page-alike">
        More like this
      </h2>
      {!result && (
        <p className="jp-meta">
          Models with a similar shape, at any size; sharing tags or categories brings them closer.{' '}
          <Button size="sm" id="jp-more-like-this" disabled={busy} onClick={() => void find()}>
            {busy ? 'Comparing…' : 'Find Models Shaped Like This'}
          </Button>
        </p>
      )}
      {error && <p className="jp-meta jp-mw__note">{error}</p>}
      {result?.reason && <p className="jp-meta">{result.reason}.</p>}
      {result && !result.reason && !result.models.length && <p className="jp-meta">No other model in the library has a similar shape.</p>}
      {result && result.models.length > 0 && (
        <ul className="jp-model-page__file-grid jp-model-page__alike-grid" id="jp-more-like-this-list">
          {result.models.map((m) => (
            <FileCard key={m.filePath} file={{ filePath: m.filePath, fileName: m.fileName, size: null, image: m.image }} current={false} />
          ))}
        </ul>
      )}
      {result && result.unmeasured > 0 && (
        <p className="jp-meta">
          {measuring
            ? 'Measuring the library… the list fills in when it is done.'
            : `${result.unmeasured.toLocaleString()} ${result.unmeasured === 1 ? 'model has' : 'models have'} not been measured yet, so ${result.unmeasured === 1 ? 'it is' : 'they are'} not compared.`}{' '}
          {canEdit && !measuring && (
            <Button size="sm" id="jp-measure-library" onClick={() => void measure()}>
              Measure Them Now
            </Button>
          )}
        </p>
      )}
    </section>
  );
}

/** A model's page (#/model/<path>). */
export function ModelPage({ filePath }: { filePath: string }) {
  return <ModelView filePath={filePath} />;
}

/**
 * A model, like a model page on a model site: the pictures, description, the site's print profile,
 * videos, documents and the other files of its folder on the left; details, actions, notes and the
 * print history on the right. `compact` (the details sidebar) puts the same sections in one column.
 * Changes go through the Edit dialog.
 */
export function ModelView({
  filePath,
  compact = false,
  statusSlot,
  historySlot,
  pathSlot
}: {
  filePath: string;
  compact?: boolean;
  /** The sidebar: where its print status picker goes (in place of the Print status row). */
  statusSlot?: (element: HTMLDivElement | null) => void;
  /** The sidebar: where its print history list goes (with delete, in place of the read-only list). */
  historySlot?: (element: HTMLDivElement | null) => void;
  /** The sidebar: its path row (folders to click, Reveal in folders) in place of the Location row. */
  pathSlot?: (element: HTMLDivElement | null) => void;
}) {
  const canEdit = useCan('editor');
  const [model, setModel] = useState<PageModel | null | undefined>(undefined);
  const [files, setFiles] = useState<FolderFile[]>([]);
  const [events, setEvents] = useState<PrintEvent[]>([]);
  const [slicers, setSlicers] = useState<Slicer[]>([]);
  /** The model's site's details (its description, videos and PDF), when it came from one. */
  const [site, setSite] = useState<MakerWorldDetails | null>(null);
  /** The group it is in (innermost) and the groups above it. */
  const [group, setGroup] = useState<ModelGroupRef | null>(null);
  /** The gallery's pictures, loaded after the details (null while they come). */
  const [pictures, setPictures] = useState<string[] | null>(null);
  /** Upload (and files dropped on the page): anything into the model's folder. */
  const modelUpload = useModelUpload(filePath);
  const [dropping, setDropping] = useState(false);

  const load = useCallback(async () => {
    // The details first (small); the pictures, which can be megabytes, after (the gallery fills in).
    const next = await modelApi.withoutPictures<PageModel>(filePath).catch(() => null);
    setModel(next);
    if (!next) return;
    modelApi.pictures(filePath).then(setPictures, () => setPictures([]));
    callAction<FolderFile[]>('get-folder-models', filePath).then(setFiles, () => setFiles([]));
    const link = siteModelUrl(next);
    if (link)
      getSiteDetails(link.url).then(
        (found) => setSite(found?.details || null),
        () => setSite(null)
      );
    else setSite(null);
    if (next.id) {
      prints.events(next.id).then(setEvents, () => setEvents([]));
      groupsApi.ofModel(next.id).then(setGroup, () => setGroup(null));
    } else setGroup(null);
  }, [filePath]);

  useEffect(() => {
    setModel(undefined);
    setPictures(null);
    setFiles([]);
    setEvents([]);
    setSite(null);
    setGroup(null);
    void load();
    loadSlicers().then(setSlicers, () => {});
    if (!compact) {
      window.scrollTo(0, 0);
      document.getElementById('jp-content')?.scrollTo(0, 0);
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    const offs = [
      onServerEvent('refresh-grid', soon),
      onServerEvent('categories-changed', soon),
      onServerEvent('models-changed', soon),
      onServerEvent('groups-changed', soon)
    ];
    window.addEventListener(LIBRARY_CHANGED, soon);
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
      window.removeEventListener(LIBRARY_CHANGED, soon);
    };
  }, [load, compact]);

  if (model === undefined) {
    return (
      <div className={compact ? 'jp-model-view--compact' : 'jp-page__inner jp-model-page'}>
        <Skeleton height={compact ? 240 : 420} />
      </div>
    );
  }
  if (!model) {
    if (compact) return <p className="jp-meta jp-model-view--compact">This model is not in the library any more.</p>;
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
  const inZip = model.filePath.includes('::');
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
  const title = model.pageTitle || cardTitle(model);
  const Heading = compact ? 'h2' : 'h1';

  const header = (
    <header className="jp-model-page__header">
      <Heading className={compact ? 'jp-details__title' : 'jp-page-title'} id={compact ? undefined : 'jp-model-page-title'} title={title}>
        {title}
      </Heading>
      {designer && (
        <p className="jp-model-page__byline">
          <button type="button" className="jp-link-button" onClick={() => showInLibrary(() => filterActions.setValue('designer', designer))}>
            By {designer}
          </button>
        </p>
      )}
      {group && (
        <p className="jp-model-page__in-group">
          In{' '}
          {group.crumbs.map((crumb, index) => (
            <span key={crumb.id}>
              {index > 0 && ' › '}
              <button type="button" className="jp-link-button" onClick={() => navigate('group', String(crumb.id))}>
                {crumb.name}
              </button>
            </span>
          ))}
        </p>
      )}
    </header>
  );

  // Until the pictures come: the small picture the folder's file list already has.
  const shownFile = files.find((file) => file.filePath === model.filePath);
  const placeholder = shownFile && shownFile.image ? [shownFile.image] : [];
  const gallery = (
    <ModelGallery
      key={`gallery:${model.filePath}`}
      filePath={model.filePath}
      folder={online || inZip ? null : model.modelFolder || folderOf(model.filePath)}
      renders={(pictures ?? placeholder).filter((src) => src !== '3d.png')}
      online={online}
      alone={files.length <= 1}
    />
  );

  const description = (
    <DescriptionSection
      filePath={model.filePath}
      description={model.description}
      siteDescription={site?.description}
      siteDescriptionEnglish={site?.descriptionEnglish}
    />
  );

  // The sidebar keeps the site's whole section (with Download to Library); the page its Print Profile.
  const siteSection = fromSite && (
    <div className="jp-card jp-model-page__site">
      <MakerWorldSection model={model} page={!compact} />
    </div>
  );

  const media =
    !online && !inZip ? (
      <>
        <ModelMediaSection
          key={`videos:${model.filePath}`}
          folder={folderOf(model.filePath)}
          alone={files.length <= 1}
          parts={['video']}
          title="Videos"
          sectionId="jp-model-videos"
          siteVideos={site?.videos || []}
        />
        <ModelMediaSection
          key={`documents:${model.filePath}`}
          folder={folderOf(model.filePath)}
          alone={files.length <= 1}
          parts={['document']}
          title="Documents"
          sectionId="jp-model-documents"
          siteDocuments={site?.pdfUrl ? [{ url: site.pdfUrl, name: decodeURIComponent(site.pdfUrl.split('/').pop() || 'Model PDF') }] : []}
        />
        <ModelMediaSection
          key={`other:${model.filePath}`}
          folder={folderOf(model.filePath)}
          alone={files.length <= 1}
          parts={['other']}
          title="Other Files"
          sectionId="jp-model-other"
        />
      </>
    ) : (
      <SiteOnlyMedia videos={site?.videos || []} pdfUrl={site?.pdfUrl || null} />
    );

  const details = (
    <section
      className="jp-card jp-model-page__panel"
      aria-labelledby={compact ? undefined : 'jp-model-page-details'}
      aria-label={compact ? 'Model Details' : undefined}
    >
      <h2 className="jp-panel-title" id={compact ? undefined : 'jp-model-page-details'}>
        Model Details
      </h2>
      <div className="jp-model-page__actions">
        {!isArchive(extensionOf(model.filePath)) && (
          <div className="jp-model-page__slicer">
            <SlicerButton filePath={model.filePath} slicers={slicers} />
          </div>
        )}
        {canEdit && (
          <Button icon={Pencil} id={compact ? 'jp-details-edit' : 'jp-model-page-edit'} onClick={() => window.openEditModel?.(model.filePath)}>
            Edit
          </Button>
        )}
        {canEdit && (
          <Button
            icon={ClipboardPen}
            id={compact ? 'jp-details-log-print' : undefined}
            onClick={() => void window.PrintHistory?.openLogDialog({ filePaths: [model.filePath] })}
          >
            Log Print
          </Button>
        )}
        {!online && !inZip && <ModelUploadButton upload={modelUpload.upload} busy={modelUpload.busy} id={compact ? 'jp-details-upload' : 'jp-model-upload'} />}
        {!compact && !online && !inZip && <UploadVersionButton filePath={model.filePath} folder={folderOf(model.filePath)} />}
        {compact && (
          <Button icon={ExternalLink} id="jp-details-open-page" onClick={() => navigate('model', model.filePath)}>
            Open Page
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
      {model.partOf ? (
        <p className="jp-meta" id="jp-model-part-note">
          A part of another model: listed with its files on that model's page, not in the library.{' '}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              id="jp-model-separate-part"
              onClick={async () => {
                await callAction('set-model-parts', null, [model.filePath]);
                await load();
              }}
            >
              Make It a Model of Its Own
            </Button>
          )}
        </p>
      ) : null}
      <div className="jp-props">
        <Prop label="File" title={displayFileName(model)}>
          {displayFileName(model)}
        </Prop>
        <Prop label="Format">{formatOf(model) || '—'}</Prop>
        <Prop label="Size">{model.size ? formatFileSize(Number(model.size)) : '—'}</Prop>
        {statusSlot ? (
          <div className="jp-props__group" ref={statusSlot} />
        ) : (
          <Prop label="Print status">
            {canEdit && !online ? (
              <PageStatus filePath={model.filePath} status={status} onSaved={() => void load()} />
            ) : (
              STATUS_LABELS[status as PrintStatus] || status
            )}
          </Prop>
        )}
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
        <Prop label="Group">
          {group ? (
            <button type="button" className="jp-link-button" onClick={() => navigate('group', String(group.id))}>
              {group.crumbs.map((crumb) => crumb.name).join(' › ')}
            </button>
          ) : (
            '—'
          )}
        </Prop>
        <Prop label="License">{model.license || '—'}</Prop>
        <Prop label="Tags">
          {canEdit && !compact ? (
            <PageTags filePath={model.filePath} tags={tags} onSaved={() => void load()} onShow={(name) => showInLibrary(() => filterActions.setTags([name]))} />
          ) : tags.length ? (
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
        <Prop label="Category">
          {model.categories?.[0] ? <CategoryPlace names={[model.categories[0]]} id={compact ? undefined : 'jp-model-page-categories'} /> : '—'}
        </Prop>
        <Prop label="Subcategory">
          {model.categories?.[1] ? <CategoryPlace names={[model.categories[1]]} id={compact ? undefined : 'jp-model-page-subcategory'} /> : '—'}
        </Prop>
        {pathSlot && !online ? (
          <div className="jp-prop jp-prop--path">
            <span className="jp-prop__label">Location</span>
            <div className="jp-prop__value" ref={pathSlot} />
          </div>
        ) : (
          <Prop label="Location" title={online ? undefined : model.filePath}>
            {online ? 'Online model' : folderPath || '—'}
          </Prop>
        )}
        <Prop label="Added">{formatAdded(model.dateAdded) || '—'}</Prop>
      </div>
    </section>
  );

  const notes = <NotesPanel filePath={model.filePath} notes={model.notes} onSaved={() => void load()} />;

  const fileList = files.length > 1 && (
    <section className="jp-card jp-model-page__panel" aria-label={`Files (${files.length})`}>
      <h2 className="jp-panel-title">Files ({files.length})</h2>
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
  );

  const history = historySlot ? (
    <section className="jp-card jp-model-page__panel" aria-label="Print History">
      <h2 className="jp-panel-title">Print History</h2>
      <div className="jp-details__editor" ref={historySlot} />
    </section>
  ) : (
    <section className="jp-card jp-model-page__panel" aria-label="Print History">
      <h2 className="jp-panel-title">Print History</h2>
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
              {canEdit && <DeletePrintButton id={entry.id} label={formatPrintDate(entry.printed_at)} onDeleted={() => void load()} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="jp-meta">Not printed yet.</p>
      )}
    </section>
  );

  if (compact) {
    // The details sidebar: the page's sections in one column.
    return (
      <div className="jp-model-view--compact" data-filepath={model.filePath}>
        {header}
        {gallery}
        {details}
        {description}
        {siteSection}
        {media}
        {notes}
        {fileList}
        {!online && <KitChecklist target={model.filePath} />}
        {history}
      </div>
    );
  }

  // Files dropped on the page go into the model's folder, as with Upload.
  const canDrop = canEdit && !online && !inZip;
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  return (
    <div
      className={cx('jp-page__inner jp-model-page', dropping && 'is-dropping')}
      data-filepath={model.filePath}
      onDragOver={(event) => {
        if (!canDrop || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(event) => {
        if (!canDrop || !hasFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        const dropped = Array.from(event.dataTransfer.files || []);
        if (dropped.length) void modelUpload.upload(dropped);
      }}
    >
      <nav className="jp-model-page__crumbs" aria-label="Where this model is">
        <button type="button" className="jp-model-page__back" onClick={goBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          Library
        </button>
        {group ? (
          group.crumbs.map((crumb) => (
            <span key={crumb.id} className="jp-model-page__crumb">
              <span aria-hidden="true">/</span>
              <button type="button" className="jp-link-button" onClick={() => navigate('group', String(crumb.id))}>
                {crumb.name}
              </button>
            </span>
          ))
        ) : folder ? (
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
        ) : null}
        <span aria-hidden="true">/</span>
        <span className="jp-model-page__crumb-here">{title}</span>
      </nav>

      {header}

      <div className="jp-model-page__grid">
        <div className="jp-model-page__main">
          {gallery}
          {description}
          {siteSection}
          {media}

          <section className="jp-model-page__files" aria-labelledby="jp-model-page-files">
            <h2 className="jp-panel-title" id="jp-model-page-files">
              Files{folder ? <span className="jp-meta"> in {folder}</span> : null}
            </h2>
            {!online && !inZip && files.length > 1 && (
              <p className="jp-meta">
                <button type="button" className="jp-link-button" id="jp-model-page-folder" onClick={() => navigate('folder', folderPath)}>
                  The folder as one model
                </button>{' '}
                (all its files, notes and kit progress) ·{' '}
                <button type="button" className="jp-link-button" id="jp-model-page-assembly" onClick={() => window.openAssembly?.(folderPath)}>
                  Assembly view
                </button>
              </p>
            )}
            <ul className="jp-model-page__file-grid" id="jp-model-page-file-grid">
              {(files.length ? files : [{ filePath: model.filePath, fileName: model.fileName || null, size: model.size || null, image: null }]).map((file) => (
                <FileCard key={file.filePath} file={file} current={file.filePath === model.filePath} />
              ))}
            </ul>
          </section>

          {!online && <MoreLikeThis key={`alike:${model.filePath}`} filePath={model.filePath} />}
        </div>

        <aside className="jp-model-page__side">
          {details}
          {notes}
          {fileList}
          {!online && <KitChecklist target={model.filePath} />}
          {history}
        </aside>
      </div>
    </div>
  );
}
