import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, ClipboardPen, Library, ListChecks, LoaderCircle, RotateCcw, Undo2 } from 'lucide-react';
import { callAction, library, printQueue, printers as printerApi, prints, type PrintActivity, type Printer } from '../api';
import { checkRows, plateLabel, itemName, QueueRowControls } from '../queue/QueueParts';
import { FilamentCheck } from '../components/Filament';
import { StatusBadge } from '../components/Badge';
import { Button, IconButton } from '../components/Button';
import { EmptyState, Skeleton } from '../components/Panel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { cardTitle } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { timeAgo } from '../home/format';
import { showModelDetails } from '../library/details';
import { selection } from '../selection';
import { fetchPrimaryThumbnail } from '../thumbnails/cache';
import { useLibraryData } from '../shell/libraryData';
import { navigate } from '../shell/routes';
import { EditOnly } from '../components/EditOnly';

const LIMIT = 200;
const loadPrinting = () => callAction<GridModel[]>('get-models-filtered', { printed: 'printing', sortOption: 'name-asc', limit: LIMIT });
// The print queue in its order, with plates, printers and each item's filament check (Phase 6).
const loadQueued = () => printQueue.list();
const loadPrinters = () => printerApi.list().catch(() => [] as Printer[]);
const loadCompleted = () => library.recentPrints(10, 'printed');

/** Show a model in the library with its details. */
function openModel(filePath: string) {
  navigate('library');
  selection.set([filePath]);
  void showModelDetails(filePath);
}

async function setStatus(filePath: string, status: string) {
  await prints.setStatus([filePath], status);
  await window.updateModelElement?.(filePath);
}

function Thumb({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchPrimaryThumbnail(filePath).then(
      (thumb) => {
        if (live) setSrc(thumb);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, [filePath]);
  return <span className="jp-queue__thumb">{src ? <img src={src} alt="" loading="lazy" /> : <img src="assets/3d.png" alt="" />}</span>;
}

function Row({
  filePath,
  name,
  meta,
  lead,
  status,
  actions
}: {
  filePath: string;
  name: string;
  meta: string;
  lead?: ReactNode;
  status?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="jp-queue__row">
      {lead}
      <Thumb filePath={filePath} />
      <button type="button" className="jp-queue__name" onClick={() => openModel(filePath)} title={`Show ${name} in the library`}>
        <span className="jp-queue__title">{name}</span>
        <span className="jp-queue__meta">{meta}</span>
      </button>
      {status}
      <span className="jp-queue__actions">{actions}</span>
    </li>
  );
}

const modelMeta = (model: GridModel) => (typeof model.designer === 'string' ? model.designer : '');

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section className="jp-card jp-queue__section" aria-labelledby={id}>
      <header className="jp-card__header">
        <h2 className="jp-panel-title" id={id}>
          {title}
          {count ? <span className="jp-queue__count">{count}</span> : null}
        </h2>
      </header>
      {children}
    </section>
  );
}

const loading = (
  <div className="jp-home__skeleton">
    <Skeleton height={44} />
    <Skeleton height={44} />
  </div>
);

/**
 * The Print Queue (spec §43): Printing now, Up next (queued) and Completed (recent successful
 * prints). Models move with their print status; logging a print finishes one. No printer
 * connection, so no live progress (docs/redesign-5.md).
 */
export function QueuePage() {
  const printing = useLibraryData(loadPrinting);
  const queued = useLibraryData(loadQueued);
  const printerList = useLibraryData(loadPrinters) || [];
  const [openCheck, setOpenCheck] = useState<number | null>(null);
  const completed = useLibraryData(loadCompleted);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(async (filePath: string, status: string) => {
    setBusy(filePath);
    try {
      await setStatus(filePath, status);
    } finally {
      setBusy(null);
    }
  }, []);

  const logPrint = (filePath: string) => void window.PrintHistory?.openLogDialog({ filePaths: [filePath] });
  const showInLibrary = () => {
    navigate('library');
    applyFilterChange(() => filterActions.setTab('in-queue', 'all'));
  };

  return (
    <div className="jp-page__inner jp-queue">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-page-title">Print Queue</h1>
          <p className="jp-meta">
            {printing && queued ? `${printing.length} printing • ${queued.length} up next` : 'Models you are printing and want to print next.'}
          </p>
        </div>
        <Button icon={Library} onClick={showInLibrary}>
          Show in Library
        </Button>
      </header>

      <Section id="jp-queue-printing" title="Printing now" count={printing?.length}>
        {!printing ? (
          loading
        ) : !printing.length ? (
          <EmptyState icon={LoaderCircle} title="Nothing is printing">
            Start a model from Up next, or set a model's print status to Printing.
          </EmptyState>
        ) : (
          <ul className="jp-queue__list" aria-label="Printing now">
            {printing.map((model) => (
              <Row
                key={model.filePath}
                filePath={model.filePath}
                name={cardTitle(model)}
                meta={modelMeta(model)}
                status={<StatusBadge tone="accent">Printing</StatusBadge>}
                actions={
                  <>
                    <EditOnly>
                      <Button size="sm" variant="primary" icon={ClipboardPen} onClick={() => logPrint(model.filePath)}>
                        Log Print
                      </Button>
                    </EditOnly>
                    <EditOnly>
                      <IconButton
                        size="sm"
                        icon={Undo2}
                        label="Back to the queue"
                        disabled={busy === model.filePath}
                        onClick={() => run(model.filePath, 'queued')}
                      />
                    </EditOnly>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </Section>

      <Section id="jp-queue-next" title="Up next" count={queued?.length}>
        {!queued ? (
          loading
        ) : !queued.length ? (
          <EmptyState
            icon={ListChecks}
            title="The queue is empty"
            action={
              <Button icon={Library} onClick={() => navigate('library')}>
                Browse the Library
              </Button>
            }
          >
            Set a model's print status to Queued (on its card or in its details) to line it up here. Each print then says whether your spools cover it, counting
            what the prints before it will use.
          </EmptyState>
        ) : (
          <ol className="jp-queue__list" aria-label="Up next">
            {queued.map((item, index) => (
              <li key={item.id} className="jp-queue__item" data-queue-id={item.id}>
                <div className="jp-queue__row">
                  <span className="jp-queue__index" aria-hidden="true">
                    {index + 1}
                  </span>
                  <Thumb filePath={item.model.filePath} />
                  <button
                    type="button"
                    className="jp-queue__name"
                    onClick={() => openModel(item.model.filePath)}
                    title={`Show ${itemName(item)} in the library`}
                  >
                    <span className="jp-queue__title">{itemName(item)}</span>
                    <span className="jp-queue__meta">{[plateLabel(item), item.model.designer].filter(Boolean).join(' • ')}</span>
                  </button>
                  <span className="jp-queue__actions">
                    <QueueRowControls item={item} index={index} count={queued.length} printers={printerList} />
                    {item.check && item.check.needs.length > 0 && (
                      <button
                        type="button"
                        className="jp-link jp-queue__check-toggle"
                        aria-expanded={openCheck === item.id}
                        onClick={() => setOpenCheck(openCheck === item.id ? null : item.id)}
                      >
                        Filament
                      </button>
                    )}
                  </span>
                </div>
                {openCheck === item.id && item.check && (
                  <div className="jp-queue__check">
                    <FilamentCheck needs={checkRows(item.check)} label={`Filament for ${itemName(item)}`} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section id="jp-queue-completed" title="Completed">
        {!completed ? (
          loading
        ) : !completed.length ? (
          <EmptyState icon={CheckCircle2} title="No prints logged yet">
            Log a print when one finishes; the latest successful prints show here.
          </EmptyState>
        ) : (
          <ul className="jp-queue__list" aria-label="Completed">
            {completed.map((event: PrintActivity) => (
              <Row
                key={event.id}
                filePath={event.filePath}
                name={cardTitle({ filePath: event.filePath, fileName: event.fileName })}
                meta={[timeAgo(event.at), event.printer].filter(Boolean).join(' • ')}
                status={<StatusBadge tone="success">{event.quantity > 1 ? `Printed ×${event.quantity}` : 'Printed'}</StatusBadge>}
                actions={
                  <EditOnly>
                    <IconButton
                      size="sm"
                      icon={RotateCcw}
                      label="Queue it again"
                      disabled={busy === event.filePath}
                      onClick={() => void printQueue.add(event.filePath).catch(() => {})}
                    />
                  </EditOnly>
                }
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
