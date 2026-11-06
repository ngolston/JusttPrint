import { useCallback, useEffect, useState, type DragEvent, type ReactNode } from 'react';
import { CheckCircle2, ClipboardPen, GripVertical, Library, ListChecks, LoaderCircle, RotateCcw, Undo2 } from 'lucide-react';
import {
  library,
  printQueue,
  printers as printerApi,
  prints,
  type PrintActivity,
  type Printer,
  type PrintingItem,
  type QueueItem,
  type QueueNeed
} from '../api';
import { checkRows, plateLabel, itemName, QueueRowControls } from '../queue/QueueParts';
import { ColorDot, FilamentCheck } from '../components/Filament';
import { StatusBadge } from '../components/Badge';
import { Button, IconButton, cx } from '../components/Button';
import { EmptyState, Skeleton } from '../components/Panel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { formatDuration, formatGrams } from '../format';
import { cardTitle } from '../grid/ModelCard';
import { timeAgo } from '../home/format';
import { showModelDetails } from '../library/details';
import { selection } from '../selection';
import { fetchPrimaryThumbnail } from '../thumbnails/cache';
import { useLibraryData } from '../shell/libraryData';
import { navigate } from '../shell/routes';
import { EditOnly } from '../components/EditOnly';
import { useCan } from '../session';
import { SlicedInbox } from '../queue/SlicedInbox';

// What is printing (with when it started), the print queue in its order (plates, printers, print
// times and each item's filament check), the printers, and the latest successful prints.
const loadPrinting = () => printQueue.printing();
const loadQueued = () => printQueue.list();
const loadPrinters = () => printerApi.list().catch(() => [] as Printer[]);
const loadCompleted = () => library.recentPrints(10, 'printed');

/** Show a model in the library with its details. */
function openModel(filePath: string) {
  navigate('models');
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

/** Grams added up, or null when any filament's are not known. */
const totalGrams = (needs: QueueNeed[]) =>
  needs.length && needs.every((n) => Number(n.grams) > 0) ? needs.reduce((sum, n) => sum + Number(n.grams), 0) : null;

/** The filaments a print needs: a dot for each color, and the grams. */
function Needs({ needs }: { needs: QueueNeed[] }) {
  if (!needs.length) return null;
  const grams = totalGrams(needs);
  const names = needs.map((n) => [n.material, n.grams ? formatGrams(n.grams) : ''].filter(Boolean).join(' ')).join(', ');
  return (
    <span className="jp-queue__needs" title={names}>
      <span className="jp-queue__dots" aria-hidden="true">
        {needs.slice(0, 6).map((need, index) => (
          <ColorDot key={index} color={need.color || '#9aa4b4'} size={12} />
        ))}
      </span>
      <span className="jp-sr-only">Filament: {names}.</span>
      {grams !== null && <span aria-hidden="true">{formatGrams(grams)}</span>}
    </span>
  );
}

/** "Plate 2 · X1C · 1 h 20 min", the parts known. */
const details = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');

/** When a print should be done: "done about 3:40 PM" (or "should be done" once past). */
function doneAt(startedAt: string | null, seconds: number | null): string {
  if (!startedAt || !seconds) return '';
  const end = new Date(startedAt).getTime() + seconds * 1000;
  if (!Number.isFinite(end)) return '';
  if (end < Date.now()) return 'should be done';
  const sameDay = new Date(end).toDateString() === new Date().toDateString();
  const time = new Date(end).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `done about ${sameDay ? time : `${new Date(end).toLocaleDateString(undefined, { weekday: 'short' })} ${time}`}`;
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
  meta: ReactNode;
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

function Section({ id, title, count, summary, children }: { id: string; title: string; count?: number; summary?: string; children: ReactNode }) {
  return (
    <section className="jp-card jp-queue__section" aria-labelledby={id}>
      <header className="jp-card__header">
        <h2 className="jp-panel-title" id={id}>
          {title}
          {count ? <span className="jp-queue__count">{count}</span> : null}
        </h2>
        {summary && <span className="jp-meta jp-queue__summary">{summary}</span>}
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

/** "4 h 10 min · 85 g" for the whole queue, or "… for 2 of 3" when some items do not say. */
function queueTotals(items: QueueItem[]): string {
  const timed = items.filter((item) => item.seconds);
  const weighed = items.filter((item) => totalGrams(item.needs) !== null);
  if (!timed.length && !weighed.length) return '';
  const seconds = timed.reduce((sum, item) => sum + (item.seconds || 0), 0);
  const grams = weighed.reduce((sum, item) => sum + (totalGrams(item.needs) || 0), 0);
  const known = Math.max(timed.length, weighed.length);
  return details(
    seconds ? formatDuration(seconds) : null,
    weighed.length ? formatGrams(grams) : null,
    known < items.length ? `for ${known} of ${items.length}` : null
  );
}

/**
 * Up next, in order. Editors drag a row by its handle to move it (the arrows do the same from the
 * keyboard); the line shows where it goes.
 */
function UpNext({ queued, printers }: { queued: QueueItem[]; printers: Printer[] }) {
  const canEdit = useCan('editor');
  const [openCheck, setOpenCheck] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  const endDrag = () => {
    setArmed(null);
    setDragging(null);
    setDropAt(null);
  };
  const over = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (dragging === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const box = event.currentTarget.getBoundingClientRect();
    setDropAt(event.clientY < box.top + box.height / 2 ? index : index + 1);
  };
  const drop = async (event: DragEvent) => {
    event.preventDefault();
    const from = queued.findIndex((item) => item.id === dragging);
    const at = dropAt;
    endDrag();
    if (from < 0 || at === null) return;
    const to = at > from ? at - 1 : at;
    if (to !== from) await printQueue.move(queued[from].id, to).catch(() => {});
  };

  return (
    <ol className="jp-queue__list" aria-label="Up next" onDrop={(event) => void drop(event)}>
      {queued.map((item, index) => (
        <li
          key={item.id}
          className={cx(
            'jp-queue__item',
            dragging === item.id && 'is-dragging',
            dropAt === index && dragging !== null && 'is-drop-before',
            dropAt === index + 1 && index === queued.length - 1 && dragging !== null && 'is-drop-after'
          )}
          data-queue-id={item.id}
          draggable={canEdit && armed === item.id}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(item.id));
            setDragging(item.id);
          }}
          onDragOver={(event) => over(event, index)}
          onDragEnd={endDrag}
        >
          <div className="jp-queue__row">
            {canEdit && (
              <span
                className="jp-queue__grip"
                title="Drag to move"
                aria-hidden="true"
                onPointerDown={() => setArmed(item.id)}
                onPointerUp={() => dragging === null && setArmed(null)}
              >
                <GripVertical size={16} />
              </span>
            )}
            <span className="jp-queue__index" aria-hidden="true">
              {index + 1}
            </span>
            <Thumb filePath={item.model.filePath} />
            <button type="button" className="jp-queue__name" onClick={() => openModel(item.model.filePath)} title={`Show ${itemName(item)} in the library`}>
              <span className="jp-queue__title">{itemName(item)}</span>
              <span className="jp-queue__meta">
                {details(plateLabel(item), item.printerName, item.seconds ? formatDuration(item.seconds) : null, item.model.designer)}
                <Needs needs={item.needs} />
              </span>
            </button>
            <span className="jp-queue__actions">
              <QueueRowControls item={item} index={index} count={queued.length} printers={printers} />
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
  );
}

/**
 * The Print Queue (spec §43): Printing now (since when, until about when), Up next (queued, in
 * order, with print time and filament; Start opens the model in the slicer) and Completed
 * (recent successful prints). Logging a print finishes one.
 */
export function QueuePage() {
  const printing = useLibraryData<PrintingItem[]>(loadPrinting);
  const queued = useLibraryData(loadQueued);
  const printerList = useLibraryData(loadPrinters) || [];
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
    navigate('models');
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
          Show in Models
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
            {printing.map((item) => (
              <Row
                key={item.model.filePath}
                filePath={item.model.filePath}
                name={cardTitle(item.model)}
                meta={
                  <>
                    {details(
                      item.plate ? `Plate ${item.plate}` : null,
                      item.printerName,
                      item.startedAt ? `started ${timeAgo(item.startedAt)}` : null,
                      doneAt(item.startedAt, item.seconds) || (item.seconds ? formatDuration(item.seconds) : null)
                    )}
                    <Needs needs={item.needs} />
                  </>
                }
                status={<StatusBadge tone="accent">Printing</StatusBadge>}
                actions={
                  <>
                    <EditOnly>
                      <Button size="sm" variant="primary" icon={ClipboardPen} onClick={() => logPrint(item.model.filePath)}>
                        Log Print
                      </Button>
                    </EditOnly>
                    <EditOnly>
                      <IconButton
                        size="sm"
                        icon={Undo2}
                        label="Back to the queue"
                        disabled={busy === item.model.filePath}
                        onClick={() => run(item.model.filePath, 'queued')}
                      />
                    </EditOnly>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </Section>

      <Section id="jp-queue-next" title="Up next" count={queued?.length} summary={queued ? queueTotals(queued) : undefined}>
        {!queued ? (
          loading
        ) : !queued.length ? (
          <EmptyState
            icon={ListChecks}
            title="The queue is empty"
            action={
              <Button icon={Library} onClick={() => navigate('models')}>
                Browse Models
              </Button>
            }
          >
            Set a model's print status to Queued (on its card or in its details) to line it up here. Each print then says whether your spools cover it, counting
            what the prints before it will use.
          </EmptyState>
        ) : (
          <UpNext queued={queued} printers={printerList} />
        )}
      </Section>

      <SlicedInbox />

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
                meta={details(timeAgo(event.at), event.printer)}
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
