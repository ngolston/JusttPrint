import { useEffect, useMemo, useRef, useState } from 'react';
import { callAction, type QueueItem } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { ColorDot } from '../components/Filament';
import { exposeGlobal, showMessage } from '../page';
import { formatDuration, formatGrams } from '../format';
import { itemName } from './QueueParts';

declare global {
  interface Window {
    openSendToPrinter?: (item: QueueItem) => void;
  }
}

/** What get-send-options answers (src/server/bambu-send.js sendOptions). */
interface SlicedPlate {
  index: number;
  seconds: number | null;
  grams: number | null;
  filaments: { slot: number; material: string | null; color: string | null; grams: number | null }[];
}
interface SlicedFile {
  filePath: string;
  name: string;
  plates: SlicedPlate[];
}
interface Tray {
  index: number;
  type: string | null;
  color: string | null;
  name: string | null;
}
interface SendPrinter {
  id: number;
  name: string;
  model: string | null;
  state: string | null;
  ready: boolean;
  reason: string | null;
  /** Errors the printer shows (it may still print). */
  warning: string | null;
  ams: { id: number; trays: (Tray | null)[] }[];
  external: { type: string | null; color: string | null } | null;
}
interface SendOptions {
  files: SlicedFile[];
  printers: SendPrinter[];
}

/** The external spool holder in an AMS mapping (bambu-send.js HOLDER). */
const HOLDER = 254;

/** A tray the printer can print from: its number in an AMS mapping and how it reads. */
interface TrayChoice {
  value: number;
  label: string;
  type: string | null;
  color: string | null;
}

/** "A1", "B3" for AMS units 0–3; "HT1" for an AMS HT (ids from 128). */
const trayName = (unitId: number, index: number) => (unitId >= 128 ? `HT${unitId - 127}` : `${String.fromCharCode(65 + unitId)}${index + 1}`);

function trayChoices(printer: SendPrinter | undefined): TrayChoice[] {
  if (!printer) return [];
  const out: TrayChoice[] = [];
  for (const unit of printer.ams) {
    unit.trays.forEach((tray, index) => {
      if (!tray) return;
      out.push({
        value: unit.id >= 128 ? unit.id : unit.id * 4 + index,
        label: `${trayName(unit.id, index)} · ${[tray.name || tray.type, tray.color].filter(Boolean).join(' ') || 'empty'}`,
        type: tray.type,
        color: tray.color
      });
    });
  }
  out.push({
    value: HOLDER,
    label: `Spool holder${printer.external?.type ? ` · ${printer.external.type}` : ''}`,
    type: printer.external?.type ?? null,
    color: printer.external?.color ?? null
  });
  return out;
}

const rgb = (hex: string | null) => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The tray that suits a filament best: same material, nearest color; else the slot in order. */
function bestTray(filament: SlicedPlate['filaments'][number], choices: TrayChoice[], taken: Set<number>): number {
  const want = rgb(filament.color);
  let best: { value: number; score: number } | null = null;
  for (const choice of choices) {
    const have = rgb(choice.color);
    if (!have && choice.value !== HOLDER) continue;
    const distance = want && have ? Math.hypot(want[0] - have[0], want[1] - have[1], want[2] - have[2]) : 200;
    const sameType = filament.material && choice.type && filament.material.toUpperCase() === choice.type.toUpperCase() ? 0 : 150;
    const score = distance + sameType + (taken.has(choice.value) ? 60 : 0);
    if (!best || score < best.score) best = { value: choice.value, score };
  }
  return best ? best.value : Math.max(0, filament.slot - 1);
}

/**
 * Send to Printer (src/server/bambu-send.js): a queued model's sliced project, one plate, to a
 * Bambu Lab printer on the network, each filament from the tray chosen for it; then the item is
 * printing. Registers window.openSendToPrinter.
 */
export function SendToPrinterDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [item, setItem] = useState<QueueItem | null>(null);
  const [options, setOptions] = useState<SendOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [printerId, setPrinterId] = useState<number | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [plateIndex, setPlateIndex] = useState<number | null>(null);
  const [trays, setTrays] = useState<Record<number, number>>({});
  const [bedLeveling, setBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(false);
  const [flowCalibration, setFlowCalibration] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openSendToPrinter', (next: QueueItem) => {
        setItem(next);
        setOptions(null);
        setError(null);
        setSending(false);
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
        callAction<SendOptions>('get-send-options', next.model.filePath).then(
          (answer) => {
            setOptions(answer);
            const ready = answer.printers.filter((p) => p.ready);
            const preferred = answer.printers.find((p) => p.id === next.printerId && p.ready) || ready[0] || answer.printers[0];
            setPrinterId(preferred ? preferred.id : null);
            setFileIndex(0);
            const plates = answer.files[0]?.plates || [];
            setPlateIndex(plates.find((p) => p.index === next.plate)?.index ?? plates[0]?.index ?? null);
          },
          (failure) => setError(failure instanceof Error ? failure.message : String(failure))
        );
      }),
    []
  );

  const printer = options?.printers.find((p) => p.id === printerId);
  const file = options?.files[fileIndex];
  const plate = file?.plates.find((p) => p.index === plateIndex) || file?.plates[0];
  const choices = useMemo(() => trayChoices(printer), [printer]);

  // Each filament starts on the tray that suits it best (a new printer, file or plate starts again).
  useEffect(() => {
    if (!plate) return;
    const taken = new Set<number>();
    const next: Record<number, number> = {};
    for (const filament of plate.filaments) {
      const value = bestTray(filament, choices, taken);
      next[filament.slot] = value;
      taken.add(value);
    }
    setTrays(next);
  }, [plate, choices]);

  const close = () => dialogRef.current?.close();

  async function send() {
    if (!item || !printer || !file || !plate) return;
    setSending(true);
    setError(null);
    try {
      const sent = await callAction<{ printer: string; file: string; plate: number }>('send-to-printer', item.id, file.filePath, {
        printerId: printer.id,
        plate: plate.index,
        trays,
        useAms: printer.ams.length > 0,
        bedLeveling,
        timelapse,
        flowCalibration
      });
      close();
      await showMessage('Sent to the printer', `${itemName(item)} (plate ${sent.plate}) is on ${sent.printer} and starts in a moment.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  }

  const noFiles = options && !options.files.length;
  const noPrinters = options && !options.printers.length;
  return (
    <ModalDialog
      id="send-to-printer-dialog"
      className="jp-send"
      title={item ? `Send ${itemName(item)} to a printer` : 'Send to a printer'}
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" className="jp-btn jp-btn--secondary jp-btn--md" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            id="send-to-printer-confirm"
            className="jp-btn jp-btn--primary jp-btn--md"
            disabled={!printer?.ready || !plate || sending}
            onClick={() => void send()}
          >
            {sending ? 'Sending…' : 'Send and Start Printing'}
          </button>
        </>
      }
    >
      {!options && !error && <p className="jp-meta">Looking for sliced files and printers…</p>}
      {noFiles && (
        <div className="jp-send__note" role="status">
          <strong>No sliced file for this model yet.</strong> JusttPrint sends what OrcaSlicer sliced: slice the model, use{' '}
          <strong>Export → Export plate sliced file</strong>, and save the <code>.gcode.3mf</code> next to the model (or upload it to the model). Then send it
          from here.
        </div>
      )}
      {noPrinters && (
        <div className="jp-send__note" role="status">
          <strong>No Bambu Lab printer yet.</strong> Add one under <strong>Printers</strong> with its address, serial number and access code. The printer needs{' '}
          <strong>LAN Only mode</strong> and <strong>Developer Mode</strong> on (Settings → Network) to take prints from JusttPrint.
        </div>
      )}
      {options && !noFiles && !noPrinters && (
        <div className="jp-send__form">
          <label className="jp-send__field">
            <span>Printer</span>
            <select className="jp-input" value={printerId ?? ''} onChange={(event) => setPrinterId(Number(event.target.value))}>
              {options.printers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.ready}>
                  {p.name}
                  {p.ready ? '' : ` (${p.reason})`}
                </option>
              ))}
            </select>
          </label>
          {printer && !printer.ready && <p className="jp-send__warning">{printer.reason}</p>}
          {printer?.ready && printer.warning && <p className="jp-send__warning">{printer.warning}</p>}
          <label className="jp-send__field">
            <span>Sliced file</span>
            <select className="jp-input" value={fileIndex} onChange={(event) => setFileIndex(Number(event.target.value))}>
              {options.files.map((f, index) => (
                <option key={f.filePath} value={index}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {file && (
            <label className="jp-send__field">
              <span>Plate</span>
              <select className="jp-input" value={plate?.index ?? ''} onChange={(event) => setPlateIndex(Number(event.target.value))}>
                {file.plates.map((p) => (
                  <option key={p.index} value={p.index}>
                    {[`Plate ${p.index}`, p.seconds ? formatDuration(p.seconds) : null, p.grams ? formatGrams(p.grams) : null].filter(Boolean).join(' · ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          {plate && plate.filaments.length > 0 && printer && (
            <fieldset className="jp-send__trays">
              <legend>Filament</legend>
              {plate.filaments.map((filament) => (
                <label key={filament.slot} className="jp-send__tray">
                  <span className="jp-send__filament">
                    <ColorDot color={filament.color || '#9aa4b4'} size={14} />
                    {[filament.material, filament.grams ? formatGrams(filament.grams) : null].filter(Boolean).join(' · ') || `Filament ${filament.slot}`}
                  </span>
                  <select
                    className="jp-input"
                    aria-label={`Tray for filament ${filament.slot}`}
                    value={trays[filament.slot] ?? ''}
                    onChange={(event) => setTrays({ ...trays, [filament.slot]: Number(event.target.value) })}
                  >
                    {choices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          )}
          <div className="jp-send__checks">
            <label>
              <input type="checkbox" checked={bedLeveling} onChange={(event) => setBedLeveling(event.target.checked)} /> Bed leveling
            </label>
            <label>
              <input type="checkbox" checked={flowCalibration} onChange={(event) => setFlowCalibration(event.target.checked)} /> Flow calibration
            </label>
            <label>
              <input type="checkbox" checked={timelapse} onChange={(event) => setTimelapse(event.target.checked)} /> Timelapse
            </label>
          </div>
        </div>
      )}
      {error && (
        <p className="jp-send__error" role="alert">
          {error}
        </p>
      )}
    </ModalDialog>
  );
}
