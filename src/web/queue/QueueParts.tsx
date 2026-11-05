import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Play, Send, X } from 'lucide-react';
import { printQueue, type FilamentCheckResult, type Printer, type QueueItem } from '../api';
import { Button, IconButton } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { FitBadge, type FilamentNeed } from '../components/Filament';
import { cardTitle } from '../grid/ModelCard';
import { showMessage } from '../page';
import { loadSlicers, sendToSlicer } from '../slicer';

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

/**
 * Start an item: open its model in the slicer (OrcaSlicer when set up, else the first slicer), and
 * move it to Printing now. Without a slicer, it asks first.
 */
async function startInSlicer(item: QueueItem) {
  const slicers = await loadSlicers();
  const slicer = slicers.find((s) => /orca/i.test(s.name)) || slicers[0];
  if (slicer) await sendToSlicer([item.model.filePath], slicer);
  else {
    const answer = await showMessage('Start', 'No slicer is set up, so Start cannot open the model in one. Start it anyway?', [
      'Start',
      'Set Up a Slicer',
      'Cancel'
    ]);
    if (answer === 'Set Up a Slicer') window.openSlicerSettings?.();
    if (answer !== 'Start') return;
  }
  await printQueue.start(item.id);
}

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
        <Button
          size="sm"
          icon={Play}
          disabled={busy}
          title={`Open ${name} in the slicer and move it to Printing now`}
          onClick={() => void run(() => startInSlicer(item))}
        >
          Start
        </Button>
        {printers.some((printer) => printer.connection_type === 'bambu') && (
          <Button
            size="sm"
            icon={Send}
            disabled={busy}
            title={`Send ${name}'s sliced file to a Bambu Lab printer and start it`}
            onClick={() => window.openSendToPrinter?.(item)}
          >
            Send
          </Button>
        )}
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
