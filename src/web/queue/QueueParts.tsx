import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Play, X } from 'lucide-react';
import { printQueue, type FilamentCheckResult, type Printer, type QueueItem } from '../api';
import { Button, IconButton } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { FilamentCheck, FitBadge, type FilamentNeed } from '../components/Filament';
import { Panel } from '../components/Panel';
import { cardTitle } from '../grid/ModelCard';
import { showMessage } from '../page';
import { navigate } from '../shell/routes';

/*
 * The print queue's rows (docs/merge-10.md, Phase 6): order, plate, printer and the filament
 * check of each item, counting what the items before it set aside.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The filament check as the FilamentCheck rows show it. */
export function checkRows(check: FilamentCheckResult | null): FilamentNeed[] {
  if (!check) return [];
  return check.needs.map((need) => ({
    label: [need.material, need.colorName].filter(Boolean).join(' '),
    color: need.color || '#9aa4b4',
    grams: need.grams,
    spool: need.spool ? { name: need.spool.name, where: need.spool.where || undefined, remaining: need.spool.available } : null
  }));
}

/** "Plate 2", "All plates", or nothing for a model of one plate. */
export const plateLabel = (item: QueueItem) => (item.plate ? `Plate ${item.plate}` : item.plates.length > 1 ? 'All plates' : '');

export const itemName = (item: QueueItem) => cardTitle({ filePath: item.model.filePath, fileName: item.model.fileName, title: item.model.title });

/** One item of Up next: plate and printer pickers, its check, and what to do with it. */
export function QueueRowControls({ item, index, count, printers }: { item: QueueItem; index: number; count: number; printers: Printer[] }) {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      await showMessage('Print queue', errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const name = itemName(item);
  return (
    <>
      <span className="jp-queue__pickers">
        {item.plates.length > 1 && (
          <select
            className="jp-input jp-queue__picker"
            aria-label={`Plate of ${name}`}
            value={item.plate ?? ''}
            disabled={busy}
            onChange={(event) => void run(() => printQueue.update(item.id, { plate: event.target.value ? Number(event.target.value) : null }))}
          >
            <option value="">All plates</option>
            {item.plates.map((plate) => (
              <option key={plate} value={plate}>
                Plate {plate}
              </option>
            ))}
          </select>
        )}
        {printers.length > 0 && (
          <select
            className="jp-input jp-queue__picker"
            aria-label={`Printer for ${name}`}
            value={item.printerId ?? ''}
            disabled={busy}
            onChange={(event) => void run(() => printQueue.update(item.id, { printerId: event.target.value ? Number(event.target.value) : null }))}
          >
            <option value="">Any printer</option>
            {printers.map((printer) => (
              <option key={printer.id} value={printer.id}>
                {printer.nickname}
              </option>
            ))}
          </select>
        )}
      </span>
      {item.check && <FitBadge missing={item.check.missing} className="jp-queue__fit" />}
      <EditOnly>
        <span className="jp-queue__order">
          <IconButton
            size="sm"
            icon={ArrowUp}
            label={`Move ${name} up`}
            disabled={busy || index === 0}
            onClick={() => void run(() => printQueue.move(item.id, index - 1))}
          />
          <IconButton
            size="sm"
            icon={ArrowDown}
            label={`Move ${name} down`}
            disabled={busy || index === count - 1}
            onClick={() => void run(() => printQueue.move(item.id, index + 1))}
          />
        </span>
        <Button size="sm" icon={Play} disabled={busy} onClick={() => void run(() => printQueue.start(item.id))}>
          Start
        </Button>
        <IconButton
          size="sm"
          icon={Copy}
          label={`Queue another ${name}`}
          disabled={busy}
          onClick={() => void run(() => printQueue.add(item.model.filePath, { plate: item.plate, printerId: item.printerId }))}
        />
        <IconButton size="sm" icon={X} label={`Remove ${name} from the queue`} disabled={busy} onClick={() => void run(() => printQueue.remove(item.id))} />
      </EditOnly>
    </>
  );
}

/** Home's Up next (Phase 6): the first queued print and whether the spools on hand cover it. */
export function UpNextPanel({ items }: { items: QueueItem[] | null }) {
  const first = items?.[0];
  if (!first) return null;
  const rows = checkRows(first.check);
  const more = (items?.length || 1) - 1;
  return (
    <Panel title="Up next" labelledBy="jp-home-upnext" className="jp-home__panel jp-home__upnext" action={{ label: 'Queue', onClick: () => navigate('queue') }}>
      <div className="jp-home__upnext-head">
        <span className="jp-model-title">{itemName(first)}</span>
        <span className="jp-meta">{[plateLabel(first), first.printerName, more ? `then ${more} more` : ''].filter(Boolean).join(' · ')}</span>
        {first.check && <FitBadge missing={first.check.missing} />}
      </div>
      {rows.length > 0 ? (
        <FilamentCheck needs={rows} label={`Filament for ${itemName(first)}`} />
      ) : (
        <p className="jp-meta">{first.check === null ? 'Its filament is not known yet, or there are no spools to check.' : ''}</p>
      )}
    </Panel>
  );
}
