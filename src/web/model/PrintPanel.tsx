import { useCallback, useEffect, useState } from 'react';
import { ClipboardPen, ListPlus } from 'lucide-react';
import { filament, printCost, printQueue, printers as printerApi, type FilamentCheckResult, type PrintCost, type Printer, type PrinterLoads } from '../api';
import { Button, cx } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { FilamentCheck, FitBadge } from '../components/Filament';
import { ProfilePicker, type PrintProfile } from '../components/ModelParts';
import { loadedSpools } from '../printers/LoadedFilament';
import { checkRows } from '../queue/QueueParts';
import { showMessage } from '../page';
import { useLibraryData } from '../shell/libraryData';
import { formatMoney, formatWeight } from '../filament/format';
import { formatDuration } from '../print/printStatus';

/*
 * The model page's "Print this model" (docs/design-bento.md, J2 · Model page; docs/merge-10.md,
 * Phase 7): choose the plates and the printer, see whether the spools cover it (spools loaded in
 * that printer first), then queue it or log a print. Shown when the model's filament is known and
 * the library has spools.
 */

interface PanelData {
  plates: number[];
  check: FilamentCheckResult | null;
  tracked: boolean;
  /** Grams per plate (null when not known), for the profile buttons. */
  plateGrams: Map<number, number | null>;
  allGrams: number | null;
}

const sumGrams = (check: FilamentCheckResult | null) => {
  if (!check || !check.needs.length || check.needs.some((need) => need.grams === null)) return null;
  return Math.round(check.needs.reduce((sum, need) => sum + Number(need.grams), 0) * 10) / 10;
};

/** How a printer does for this print: every spool loaded in it, or how many to swap in. */
function printerFit(check: FilamentCheckResult | null, loads: PrinterLoads | undefined) {
  if (!check) return null;
  const inPrinter = new Set(
    loadedSpools(loads)
      .map((slot) => slot.spool?.id)
      .filter((id): id is number => typeof id === 'number')
  );
  const swaps = check.needs.filter((need) => !need.spool || !inPrinter.has(need.spool.id)).length;
  return swaps === 0 ? 'colors loaded' : `${swaps} ${swaps === 1 ? 'swap' : 'swaps'}`;
}

/** The estimate: the total, then filament and electricity, and what is missing for a better one. */
function CostPart({ cost }: { cost: PrintCost }) {
  const money = (n: number) => formatMoney(n, cost.currency);
  const priced = cost.lines.length - cost.unpriced;
  const fromAverage = cost.lines.filter((line) => line.basis === 'material').length;
  return (
    <div className="jp-print-panel__part" id="jp-print-cost">
      <span className="jp-label">Cost</span>
      <div className="jp-print-cost">
        <span className="jp-print-cost__total">{priced || cost.electricityCost !== null ? money(cost.total) : '—'}</span>
        <ul className="jp-print-cost__lines">
          <li>
            Filament: {priced ? money(cost.filamentCost) : 'no prices'} for {formatWeight(cost.grams)}
            {fromAverage ? ` (${fromAverage} at the material's average price)` : ''}
            {cost.unpriced ? ` · ${cost.unpriced} ${cost.unpriced === 1 ? 'color has' : 'colors have'} no price` : ''}
          </li>
          <li>
            Electricity:{' '}
            {cost.electricityCost !== null
              ? `${money(cost.electricityCost)} (${formatDuration(cost.seconds)} at ${cost.watts} W)`
              : cost.seconds === null
                ? 'no print time in the file'
                : cost.watts === null
                  ? 'choose a printer with its power (watts) set, under Printers'
                  : 'set the price per kWh in Filament settings'}
          </li>
        </ul>
      </div>
    </div>
  );
}

export function PrintPanel({ filePath }: { filePath: string }) {
  const [plate, setPlate] = useState<string>('all');
  const [printerId, setPrinterId] = useState<number | null>(null);
  const load = useCallback(async (): Promise<PanelData> => {
    const whole = await filament.forModel(filePath, {});
    const plateGrams = new Map<number, number | null>();
    for (const p of whole.plates) plateGrams.set(p, sumGrams((await filament.forModel(filePath, { plates: [p] })).check));
    return { plates: whole.plates, check: whole.check, tracked: whole.tracked, plateGrams, allGrams: sumGrams(whole.check) };
  }, [filePath]);
  const data = useLibraryData(load);
  const printerList = useLibraryData(useCallback(() => printerApi.list().catch(() => [] as Printer[]), []));
  const loads = useLibraryData(useCallback(() => printerApi.loads().catch(() => [] as PrinterLoads[]), []));
  const [check, setCheck] = useState<FilamentCheckResult | null>(null);
  const [cost, setCost] = useState<PrintCost | null>(null);

  // The check for the chosen plate and printer.
  useEffect(() => {
    let alive = true;
    if (!data?.tracked || !data.check) return;
    filament.forModel(filePath, { plates: plate === 'all' ? null : [Number(plate)], printerId }).then(
      (found) => alive && setCheck(found.check),
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [filePath, plate, printerId, data]);

  // What it costs for the chosen plate and printer (docs/plan-10.1.md, Phase 8).
  useEffect(() => {
    let alive = true;
    if (!data?.tracked || !data.check) return;
    printCost.estimate({ filePath, plates: plate === 'all' ? null : [Number(plate)], printerId }).then(
      (found) => alive && setCost(found),
      () => alive && setCost(null)
    );
    return () => {
      alive = false;
    };
  }, [filePath, plate, printerId, data]);

  if (!data || !data.tracked || !data.check) return null;
  const shown = check || data.check;
  const profiles: PrintProfile[] = [
    { id: 'all', name: data.plates.length > 1 ? 'All plates' : 'Whole model', meta: data.allGrams !== null ? formatWeight(data.allGrams) : undefined },
    ...(data.plates.length > 1
      ? data.plates.map((p) => {
          const grams = data.plateGrams.get(p);
          return { id: String(p), name: `Plate ${p}`, meta: grams !== null && grams !== undefined ? formatWeight(grams) : undefined };
        })
      : [])
  ];
  const plateNumber = plate === 'all' ? null : Number(plate);

  const queue = async () => {
    try {
      await printQueue.add(filePath, { plate: plateNumber, printerId });
      await showMessage('Print queue', `Added to the queue${plateNumber ? ` (plate ${plateNumber})` : ''}.`);
    } catch (error) {
      await showMessage('Print queue', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="jp-card jp-print-panel" aria-labelledby="jp-print-panel-title" id="jp-print-panel">
      <header className="jp-print-panel__head">
        <h2 className="jp-panel-title" id="jp-print-panel-title">
          Print this model
        </h2>
        <FitBadge missing={shown.missing} />
      </header>
      {profiles.length > 1 && (
        <div className="jp-print-panel__part">
          <span className="jp-label">Print profile</span>
          <ProfilePicker profiles={profiles} value={plate} onChange={setPlate} label="Plates to print" />
        </div>
      )}
      <div className="jp-print-panel__part">
        <span className="jp-label">Filament</span>
        <FilamentCheck needs={checkRows(shown)} label="Filament for this print" />
      </div>
      {cost && <CostPart cost={cost} />}
      {(printerList || []).length > 0 && (
        <div className="jp-print-panel__part">
          <span className="jp-label">Printer</span>
          <div className="jp-print-panel__printers" role="group" aria-label="Printer">
            {(printerList || []).map((printer) => {
              const on = printerId === printer.id;
              const fit = printerFit(
                data.check,
                loads?.find((l) => l.printerId === printer.id)
              );
              return (
                <button
                  key={printer.id}
                  type="button"
                  className={cx('jp-print-panel__printer', on && 'is-on')}
                  aria-pressed={on}
                  onClick={() => setPrinterId(on ? null : printer.id)}
                >
                  {printer.nickname}
                  {fit ? ` · ${fit}` : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <EditOnly>
        <div className="jp-print-panel__actions">
          <Button variant="primary" icon={ListPlus} onClick={() => void queue()} id="jp-print-panel-queue">
            Add to queue
          </Button>
          <Button icon={ClipboardPen} onClick={() => void window.PrintHistory?.openLogDialog({ filePaths: [filePath] })}>
            Log a print
          </Button>
        </div>
      </EditOnly>
    </section>
  );
}
