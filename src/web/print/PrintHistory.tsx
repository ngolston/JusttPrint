import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { filament, models, parts as partApi, printers as printerApi, prints, type Part, type PrintEvent, type Printer, type Spool } from '../api';
import { ColorDot } from '../components/Filament';
import { shrinkImage } from '../filament/photos';
import { PrintPhotos } from './PrintPhotos';
import { exposeGlobal, showMessage } from '../page';
import { getKit } from '../kits/kits';
import { getCurrentUser, roleAllows, useCan } from '../session';
import {
  OUTCOME_LABELS,
  STATUSES,
  STATUS_LABELS,
  badgeClassNames,
  badgeText,
  badgeTitle,
  bundleSummary,
  detailsHint,
  effectiveStatus,
  filterLabel,
  formatDuration,
  formatPrintDate,
  friendlyError,
  modelMatchesPrintFilter,
  partOptionLabel,
  printerOptionLabel,
  toDatetimeLocalValue,
  type PrintModel
} from './printStatus';

/** A model as the details panel and the grid pass it in. */
export interface PrintDetailsModel extends PrintModel {
  id?: number;
  filePath: string;
}

declare global {
  interface Window {
    /** Print status, badges and the Log Print dialog, for the grid cards and the search labels. */
    PrintHistory?: typeof printHistory;
    /** The details panel's print status and print history (PrintHistory.populateDetails drives it). */
    detailsPrint?: { show: (model: PrintDetailsModel) => void; clear: () => void };
    /** library/hosts.ts: reload one model's grid card. */
    updateModelElement?: (filePath: string) => Promise<void>;
    /** library/hosts.ts: the model the details panel shows. */
    getCurrentModelFilePath?: () => string | null;
  }
}

let openLogDialogImpl: ((filePaths: string[]) => Promise<void>) | null = null;
let openStatusMenuImpl: ((anchor: HTMLElement, filePath: string) => void) | null = null;

async function refreshAfterChange(filePaths: string | string[]) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const filePath of paths) {
    try {
      await window.updateModelElement?.(filePath);
    } catch {
      /* keep going */
    }
  }
  const current = window.getCurrentModelFilePath?.();
  if (current && paths.includes(current)) {
    try {
      const model = await models.get<PrintDetailsModel>(current);
      if (model) window.detailsPrint?.show(model);
    } catch {
      /* ignore */
    }
  }
}

async function setStatusForPaths(filePaths: string[], status: string) {
  if (!filePaths.length) return;
  try {
    await prints.setStatus(filePaths, status);
    await refreshAfterChange(filePaths);
  } catch (error) {
    console.error('Error setting print status:', error);
  }
}

async function openLogDialog({ filePaths }: { filePaths?: string[] } = {}) {
  if (!roleAllows(getCurrentUser()?.role, 'editor')) return;
  const paths = (filePaths || []).filter(Boolean);
  if (paths.length) await openLogDialogImpl?.(paths);
}

function applyBadge(el: HTMLElement | null, model: PrintModel) {
  if (!el) return;
  el.className = badgeClassNames(model);
  el.textContent = badgeText(model);
  el.title = badgeTitle(model);
  el.style.cursor = 'pointer';
}

/** Click logs a print; Shift-click picks a status. */
function bindBadge(el: HTMLElement | null, filePath: string) {
  if (!el || el.dataset.printHistoryBound === '1') return;
  el.dataset.printHistoryBound = '1';
  el.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) openStatusMenuImpl?.(el, filePath);
    else await openLogDialog({ filePaths: [filePath] });
  });
}

const printHistory = {
  STATUSES,
  STATUS_LABELS,
  applyBadge,
  bindBadge,
  badgeText,
  badgeClassNames,
  badgeTitle,
  openLogDialog,
  /** Set the print status of several models and refresh their cards. */
  setStatus: setStatusForPaths,
  openStatusMenu: (anchor: HTMLElement, filePath: string) => openStatusMenuImpl?.(anchor, filePath),
  populateDetails: async (model: PrintDetailsModel) => {
    window.detailsPrint?.show(model);
  },
  modelMatchesPrintFilter,
  filterLabel,
  bundleSummary,
  effectiveStatus,
  refreshAfterChange
};

// Set when the bundle loads, before the grid draws cards with it.
window.PrintHistory = printHistory;

interface ChosenPart {
  part: Part;
  quantity: number;
}

const clampQuantity = (value: unknown) => Math.max(1, Math.min(9999, Math.floor(Number(value) || 1)));

/** A spool in Log Print's Filament used: the needed color (when known), the spool and grams per copy. */
interface FilamentRow {
  key: number;
  color: string | null;
  need: string;
  spoolId: string;
  perCopy: string;
}
let nextFilamentRow = 1;

/** "PLA Blue · 640 g left" for the spool picker. */
const spoolOptionLabel = (spool: Spool) =>
  `${spool.display_name}${spool.brand_name ? ` (${spool.brand_name})` : ''} · ${Math.round(spool.remaining)} g left${spool.loaded.length ? ` · ${spool.loaded[0].label}` : ''}`;

/** Log a print on one or more models (#log-print-dialog). */
function LogPrintDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [when, setWhen] = useState('');
  const [outcome, setOutcome] = useState('printed');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  /** How long it took (one model; docs/plan-10.1.md Phase 3): filled from the plates' estimates until edited. */
  const [timeHours, setTimeHours] = useState('');
  const [timeMinutes, setTimeMinutes] = useState('');
  const [timeEdited, setTimeEdited] = useState(false);
  const [plateSeconds, setPlateSeconds] = useState<Map<number, number>>(new Map());
  /** Photos of the print (one model; docs/plan-10.1.md Phase 2), sent after it is logged. */
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [printerList, setPrinterList] = useState<Printer[]>([]);
  const [printerId, setPrinterId] = useState('');
  const [partList, setPartList] = useState<Part[]>([]);
  const [chosenParts, setChosenParts] = useState<ChosenPart[]>([]);
  const [partId, setPartId] = useState('');
  const [partQuantity, setPartQuantity] = useState('1');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  /** A 3MF's plates (one model only): which were printed. */
  const [plates, setPlates] = useState<{ plate: number; label: string }[]>([]);
  const [chosenPlates, setChosenPlates] = useState<Set<number>>(new Set());
  /** Filament used (one model, when the library has spools; docs/merge-10.md Phase 4). */
  const [spoolList, setSpoolList] = useState<Spool[]>([]);
  const [filamentRows, setFilamentRows] = useState<FilamentRow[]>([]);
  const [filamentTracked, setFilamentTracked] = useState(false);
  const [filamentEdited, setFilamentEdited] = useState(false);

  const loadPrinters = () =>
    printerApi
      .list()
      .then(setPrinterList)
      .catch(() => setPrinterList([]));

  async function open(paths: string[]) {
    setFilePaths(paths);
    setWhen(toDatetimeLocalValue(new Date()));
    setOutcome('printed');
    setQuantity('1');
    setNotes('');
    setPhotoFiles([]);
    setTimeHours('');
    setTimeMinutes('');
    setTimeEdited(false);
    setPlateSeconds(new Map());
    setPrinterId('');
    setPartId('');
    setPartQuantity('1');
    setChosenParts([]);
    setStatus('');
    setPlates([]);
    setChosenPlates(new Set());
    setFilamentRows([]);
    setFilamentTracked(false);
    setFilamentEdited(false);
    setSpoolList([]);
    if (paths.length === 1) {
      filament.spools(false).then(
        (list) => {
          setSpoolList(list);
          setFilamentTracked(list.length > 0);
        },
        () => {}
      );
    }
    const [allParts, kit] = await Promise.all([
      partApi.list().catch(() => [] as Part[]),
      paths.length === 1 && /\.3mf$/i.test(paths[0]) ? getKit(paths[0]).catch(() => null) : Promise.resolve(null),
      loadPrinters()
    ]);
    setPartList(allParts);
    const found = (kit?.parts || []).filter((part) => part.plate > 0).map((part) => ({ plate: part.plate, label: part.label }));
    setPlateSeconds(new Map((kit?.parts || []).filter((part) => Number(part.seconds) > 0).map((part) => [part.plate, Number(part.seconds)])));
    if (found.length > 1) {
      setPlates(found);
      setChosenPlates(new Set(found.map((p) => p.plate)));
    }
    dialogRef.current?.showModal();
  }

  useEffect(() => {
    openLogDialogImpl = open;
    return () => {
      if (openLogDialogImpl === open) openLogDialogImpl = null;
    };
  });

  // Fill Print time from the slicer's estimate for the plates chosen, times the quantity.
  useEffect(() => {
    if (timeEdited || !plateSeconds.size) return;
    const plateList = plates.length ? [...chosenPlates] : [...plateSeconds.keys()];
    const seconds = plateList.reduce((sum, plate) => sum + (plateSeconds.get(plate) || 0), 0) * clampQuantity(quantity);
    const minutes = Math.round(seconds / 60);
    setTimeHours(minutes ? String(Math.floor(minutes / 60)) : '');
    setTimeMinutes(minutes ? String(minutes % 60) : '');
  }, [plateSeconds, plates, chosenPlates, quantity, timeEdited]);

  // Fill Filament used from the filament check for the plates chosen (and the printer, whose loaded
  // spools come first), until the rows are edited by hand.
  useEffect(() => {
    if (filePaths.length !== 1 || !filamentTracked || filamentEdited) return;
    let alive = true;
    const chosen = plates.length ? [...chosenPlates] : null;
    filament.forModel(filePaths[0], { plates: chosen, printerId: Number(printerId) > 0 ? Number(printerId) : null }).then(
      (found) => {
        if (!alive || !found.check) return;
        setFilamentRows(
          found.check.needs.map((need) => ({
            key: nextFilamentRow++,
            color: need.color,
            need: [need.material, need.colorName].filter(Boolean).join(' '),
            spoolId: need.spool ? String(need.spool.id) : '',
            perCopy: need.grams === null ? '' : String(Math.round(need.grams * 10) / 10)
          }))
        );
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [filePaths, filamentTracked, filamentEdited, chosenPlates, plates.length, printerId]);

  const editFilament = (rows: FilamentRow[]) => {
    setFilamentEdited(true);
    setFilamentRows(rows);
  };

  useEffect(() => {
    const onPrintersChanged = () => {
      if (dialogRef.current?.open) loadPrinters();
    };
    document.addEventListener('printers-changed', onPrintersChanged);
    return () => document.removeEventListener('printers-changed', onPrintersChanged);
  }, []);

  function addPart() {
    const part = partList.find((p) => p.id === Number(partId));
    if (!part) return;
    const qty = clampQuantity(partQuantity);
    const existing = chosenParts.find((c) => c.part.id === part.id);
    setChosenParts(
      existing ? chosenParts.map((c) => (c === existing ? { ...c, quantity: Math.min(9999, c.quantity + qty) } : c)) : [...chosenParts, { part, quantity: qty }]
    );
    setPartId('');
    setPartQuantity('1');
  }

  const copies = Math.max(1, Number(quantity) || 1);
  const filamentUsed = filamentRows
    .map((row) => ({ spoolId: Number(row.spoolId), grams: (Number(String(row.perCopy).replace(',', '.')) || 0) * copies }))
    .filter((use) => use.spoolId > 0 && use.grams > 0);
  const filamentSummary = filamentUsed.length
    ? `Takes ${Math.round(filamentUsed.reduce((sum, use) => sum + use.grams, 0) * 10) / 10} g off your spools${copies > 1 ? ` (${copies} copies)` : ''}.`
    : '';
  const partsSummary = chosenParts.length
    ? `Removes ${chosenParts.map((c) => `${c.part.name || 'Part'} ×${c.quantity * copies * Math.max(1, filePaths.length)}`).join(', ')} from Parts Stock.`
    : '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !filePaths.length) return;
    const pickedPrinter = Number(printerId);
    if (plates.length && !chosenPlates.size) return setStatus('Choose at least one plate.');
    const some = plates.length > 0 && chosenPlates.size < plates.length;
    // Only some plates: say which in the history row too.
    const plateNote = some
      ? `Plates: ${plates
          .filter((p) => chosenPlates.has(p.plate))
          .map((p) => p.label)
          .join(', ')}`
      : '';
    const durationSeconds = (Math.max(0, Number(timeHours) || 0) * 60 + Math.max(0, Number(timeMinutes) || 0)) * 60;
    const input = {
      printedAt: when ? new Date(when).toISOString() : new Date().toISOString(),
      outcome,
      quantity: Number(quantity) || 1,
      notes: [notes.trim(), plateNote].filter(Boolean).join('\n'),
      printerId: pickedPrinter > 0 ? pickedPrinter : null,
      parts: chosenParts.map((c) => ({ id: c.part.id, quantity: c.quantity })),
      ...(plates.length ? { plates: [...chosenPlates] } : {}),
      ...(filePaths.length === 1 && durationSeconds > 0 ? { durationSeconds } : {}),
      ...(filePaths.length === 1 && filamentUsed.length ? { spools: filamentUsed, plateIndex: chosenPlates.size === 1 ? [...chosenPlates][0] : null } : {})
    };
    setSaving(true);
    try {
      let photoError = '';
      if (filePaths.length === 1) {
        const logged = await prints.log(filePaths[0], input);
        const eventId = logged?.eventId;
        for (const file of eventId ? photoFiles : []) {
          try {
            await prints.addPhoto(eventId as number, { dataUrl: await shrinkImage(file) });
          } catch (error) {
            photoError = `${file.name}: ${friendlyError(error)}`;
          }
        }
      } else await prints.logMany(filePaths, input);
      dialogRef.current?.close();
      if (photoError) void showMessage('Photo not added', `The print was logged, but a photo was not added. ${photoError}`);
      document.dispatchEvent(new CustomEvent('parts-stock-changed'));
      await refreshAfterChange(filePaths);
    } catch (error) {
      console.error('Error logging print:', error);
      setStatus(friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog id="log-print-dialog" className="modal" ref={dialogRef}>
      <form id="log-print-form" onSubmit={submit}>
        <h3 id="log-print-title">{filePaths.length > 1 ? `Log a print on ${filePaths.length} models` : 'Log a print'}</h3>
        <p className="setting-description">Adds a print to the model's history (and ticks its kit's plates when printed).</p>
        <div className="log-print-row">
          <div className="form-group">
            <label htmlFor="log-print-when">When</label>
            <input type="datetime-local" id="log-print-when" required value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="log-print-outcome">Outcome</label>
            <select id="log-print-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {plates.length > 0 && (
          <div className="form-group" id="log-print-plates">
            <div className="log-print-plates__head">
              <label>Plates printed</label>
              <span className="log-print-plates__all">
                <button type="button" className="jp-link-button" onClick={() => setChosenPlates(new Set(plates.map((p) => p.plate)))}>
                  All
                </button>
                <button type="button" className="jp-link-button" onClick={() => setChosenPlates(new Set())}>
                  None
                </button>
              </span>
            </div>
            <div className="log-print-plates">
              {plates.map((p) => (
                <label key={p.plate} className="checkbox-container">
                  <input
                    type="checkbox"
                    data-plate={p.plate}
                    checked={chosenPlates.has(p.plate)}
                    onChange={(e) =>
                      setChosenPlates((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(p.plate);
                        else next.delete(p.plate);
                        return next;
                      })
                    }
                  />
                  <span>{p.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="log-print-row">
          <div className="form-group">
            <label htmlFor="log-print-quantity">Quantity</label>
            <input type="number" id="log-print-quantity" min="1" max="9999" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="log-print-printer-select">Printer used</label>
            <select id="log-print-printer-select" value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
              <option value="">Select printer (optional)…</option>
              {printerList.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {printerOptionLabel(p)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {filePaths.length === 1 && (
          <div className="form-group">
            <label htmlFor="log-print-hours">Print time</label>
            <div className="log-print-time">
              <input
                type="number"
                id="log-print-hours"
                min="0"
                max="720"
                aria-label="Hours"
                value={timeHours}
                onChange={(e) => {
                  setTimeEdited(true);
                  setTimeHours(e.target.value);
                }}
              />
              <span>h</span>
              <input
                type="number"
                id="log-print-minutes"
                min="0"
                max="59"
                aria-label="Minutes"
                value={timeMinutes}
                onChange={(e) => {
                  setTimeEdited(true);
                  setTimeMinutes(e.target.value);
                }}
              />
              <span>min</span>
            </div>
            {plateSeconds.size > 0 && !timeEdited && (
              <p className="print-history-hint">The slicer&apos;s estimate for the plates and quantity; change it to the real time.</p>
            )}
          </div>
        )}
        {filePaths.length === 1 && filamentTracked && (
          <details className="form-group log-print-parts-details" id="log-print-filament" open>
            <summary>
              Filament used <span className="setting-description">(per copy; leave a spool empty to skip it)</span>
            </summary>
            <div className="log-print-filament">
              {filamentRows.map((row) => (
                <div className="log-print-filament__row" key={row.key} data-filament-row={row.key}>
                  {row.color ? <ColorDot color={row.color} size={18} name={row.need || undefined} /> : <span className="log-print-filament__nodot" />}
                  <select
                    aria-label={row.need ? `Spool for ${row.need}` : 'Spool'}
                    value={row.spoolId}
                    onChange={(e) => editFilament(filamentRows.map((r) => (r === row ? { ...r, spoolId: e.target.value } : r)))}
                  >
                    <option value="">{row.need ? `No spool (${row.need})` : 'Choose a spool…'}</option>
                    {spoolList.map((spool) => (
                      <option key={spool.id} value={String(spool.id)}>
                        {spoolOptionLabel(spool)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="log-print-filament__grams"
                    aria-label={row.need ? `Grams of ${row.need} per copy` : 'Grams per copy'}
                    placeholder="g"
                    value={row.perCopy}
                    onChange={(e) => editFilament(filamentRows.map((r) => (r === row ? { ...r, perCopy: e.target.value } : r)))}
                  />
                  <span className="setting-description">g</span>
                  <button
                    type="button"
                    className="log-print-filament__remove"
                    aria-label="Remove this spool"
                    title="Remove"
                    onClick={() => editFilament(filamentRows.filter((r) => r !== row))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                id="log-print-filament-add"
                className="log-print-filament__add"
                onClick={() => editFilament([...filamentRows, { key: nextFilamentRow++, color: null, need: '', spoolId: '', perCopy: '' }])}
              >
                Add a spool
              </button>
            </div>
            <p id="log-print-filament-summary" className="setting-description">
              {filamentSummary || (filamentRows.length ? '' : 'The file does not say what it needs: add the spools you used.')}
            </p>
          </details>
        )}
        <details className="form-group log-print-parts-details" open={chosenParts.length > 0 || undefined}>
          <summary>
            Spare parts used <span className="setting-description">(optional)</span>
          </summary>
          <div className="log-print-parts-add">
            <select id="log-print-part-select" aria-label="Part used" value={partId} onChange={(e) => setPartId(e.target.value)}>
              <option value="">Add part…</option>
              {partList.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {partOptionLabel(p)}
                </option>
              ))}
            </select>
            <input
              type="number"
              id="log-print-part-qty"
              min="1"
              max="9999"
              value={partQuantity}
              title="Quantity of this part per copy"
              aria-label="Quantity per copy"
              onChange={(e) => setPartQuantity(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addPart();
                }
              }}
            />
            <button type="button" id="log-print-part-add" onClick={addPart}>
              Add
            </button>
          </div>
          <p className="setting-description">Quantity is per copy. Saving removes that many from Parts Stock for every copy and every model in this log.</p>
          <div
            id="log-print-parts"
            className="tags-list"
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
          >
            {chosenParts.map((c) => (
              <span
                key={c.part.id}
                className="item-chip part-chip"
                data-part-id={String(c.part.id)}
                data-part-name={c.part.name || 'Part'}
                data-stock={String(Number(c.part.quantity) || 0)}
              >
                {c.part.name} ×{' '}
                <input
                  type="number"
                  className="part-chip-qty"
                  min="1"
                  max="9999"
                  value={c.quantity}
                  aria-label="Quantity per copy"
                  onChange={(e) => setChosenParts(chosenParts.map((d) => (d === c ? { ...d, quantity: clampQuantity(e.target.value) } : d)))}
                />
                <span className="part-chip-stock">
                  {Number(c.part.quantity) || 0}
                  {c.part.unit ? ` ${c.part.unit}` : ''} in stock
                </span>
                <span
                  className="item-chip-remove"
                  title="Remove"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setChosenParts(chosenParts.filter((d) => d !== c));
                  }}
                >
                  ×
                </span>
              </span>
            ))}
          </div>
          <p id="log-print-parts-summary" className="setting-description">
            {partsSummary}
          </p>
        </details>
        <div className="form-group">
          <label htmlFor="log-print-notes">Notes</label>
          <textarea
            id="log-print-notes"
            placeholder="Optional — layer height, what failed, who it was for"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        {filePaths.length === 1 && (
          <div className="form-group">
            <label htmlFor="log-print-photos">Photos</label>
            <input id="log-print-photos" type="file" accept="image/*" multiple onChange={(e) => setPhotoFiles([...(e.target.files || [])].slice(0, 12))} />
            {photoFiles.length > 0 && (
              <p className="print-history-hint">
                {photoFiles.length} {photoFiles.length === 1 ? 'photo' : 'photos'} to add
              </p>
            )}
          </div>
        )}
        <p id="log-print-status" className="print-history-hint">
          {status}
        </p>
        <div className="dialog-buttons">
          <button type="submit" id="log-print-save" disabled={saving}>
            Save
          </button>
          <button type="button" id="log-print-cancel" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Shift-click on a card's badge: pick a print status. */
function StatusMenu() {
  const [menu, setMenu] = useState<{ anchor: HTMLElement; filePath: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Viewers cannot change the print status.
    const open = (anchor: HTMLElement, filePath: string) => {
      if (roleAllows(getCurrentUser()?.role, 'editor')) setMenu({ anchor, filePath });
    };
    openStatusMenuImpl = open;
    return () => {
      if (openStatusMenuImpl === open) openStatusMenuImpl = null;
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const rect = menu.anchor.getBoundingClientRect();
    el.style.left = `${Math.min(rect.left, window.innerWidth - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - el.offsetHeight - 8)}px`;
    const onOutside = (event: MouseEvent) => {
      if (!el.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div className="print-status-menu" role="menu" ref={ref}>
      {STATUSES.map((status) => (
        <button
          key={status}
          type="button"
          className={`print-status-menu-item print-status-${status}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu(null);
            setStatusForPaths([menu.filePath], status);
          }}
        >
          {STATUS_LABELS[status]}
        </button>
      ))}
    </div>,
    document.body
  );
}

const LOG_PRINT_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      d="M9.992 11h3.5m-3.5-4h7m-11-1h-3m3 6h-3m3 6h-3m6 3.939c-1.581-.103-2.595-.377-3.328-1.11C4.492 19.656 4.492 17.77 4.492 14v-4c0-3.771 0-5.657 1.172-6.828S8.72 2 12.492 2h.5c3.771 0 5.657 0 6.829 1.172S20.992 6.229 20.992 10v.5m-1.136 3.94l.695.692a1.496 1.496 0 0 1 0 2.12L16.91 20.95a2 2 0 0 1-1.05.551l-2.258.488a.5.5 0 0 1-.597-.593l.48-2.235c.074-.397.268-.762.554-1.047l3.688-3.674a1.51 1.51 0 0 1 2.13 0"
    />
  </svg>
);

function HistoryItem({ event, onDelete }: { event: PrintEvent; onDelete?: () => void }) {
  const canEdit = useCan('editor');
  const parts = (event.parts || []).map((part) => `${part.name || 'Part'} ×${Number(part.quantity) || 0}`).join(', ');
  const filamentUsed = (event.spools || []).map((spool) => `${spool.name} ${Math.round(spool.grams * 10) / 10} g`).join(', ');
  const printerName = event.printer_nickname || event.printer_name;
  return (
    <li className={`print-history-item outcome-${event.outcome}`}>
      <div className="print-history-item-main">
        <span className="print-history-outcome">
          {OUTCOME_LABELS[event.outcome] || event.outcome}
          {Number(event.quantity) > 1 ? ` ×${event.quantity}` : ''}
        </span>
        <span className="print-history-when">
          {formatPrintDate(event.printed_at)}
          {event.duration_seconds ? ` · ${formatDuration(event.duration_seconds)}` : ''}
        </span>
      </div>
      {printerName && (
        <div className="print-history-printer">
          🖨️ {event.printer_type && <span className="print-history-printer-type">{event.printer_type}</span>}
          {printerName}
          {event.printer_model && (
            <>
              {' '}
              <span className="print-history-printer-model">({event.printer_model})</span>
            </>
          )}
        </div>
      )}
      {parts && <div className="print-history-parts">{parts}</div>}
      {filamentUsed && <div className="print-history-parts print-history-filament">{filamentUsed}</div>}
      {event.notes && <div className="print-history-notes">{event.notes}</div>}
      <PrintPhotos eventId={event.id} photos={event.photos} canEdit={canEdit} />
      {onDelete && (
        <button
          type="button"
          className="print-history-delete icon-button"
          title="Delete this log entry"
          aria-label="Delete print log"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      )}
    </li>
  );
}

type HistoryState = { model: PrintDetailsModel; events: PrintEvent[] | null; failed: boolean };

/**
 * The details panel's print status picker (top of the panel) and print history list (bottom),
 * rendered into #details-print-slot and #details-history-slot. Registers window.detailsPrint.
 */
function DetailsPrint() {
  const canEdit = useCan('editor');
  const [statusSlot] = useState(() => document.getElementById('details-print-slot'));
  const [historySlot] = useState(() => document.getElementById('details-history-slot'));
  const [model, setModel] = useState<PrintDetailsModel | null>(null);
  const [status, setStatus] = useState('unprinted');
  const [history, setHistory] = useState<HistoryState | null>(null);

  useEffect(
    () =>
      exposeGlobal('detailsPrint', {
        show: (next: PrintDetailsModel) => {
          setModel(next);
          setStatus(effectiveStatus(next));
        },
        clear: () => {
          setModel(null);
          setStatus('unprinted');
        }
      }),
    []
  );

  useEffect(() => {
    if (!model?.id) {
      setHistory(null);
      return;
    }
    let current = true;
    prints.events(model.id).then(
      (events) => {
        if (current) setHistory({ model, events: events || [], failed: false });
      },
      (error) => {
        console.error('Error loading print history:', error);
        if (current) setHistory({ model, events: null, failed: true });
      }
    );
    return () => {
      current = false;
    };
  }, [model]);

  const logPrint = () => {
    const filePath = window.getCurrentModelFilePath?.();
    if (filePath) openLogDialog({ filePaths: [filePath] });
  };

  async function deleteEvent(event: PrintEvent) {
    if (!model) return;
    const answer = await showMessage('Delete print log', 'Delete this print log entry?', ['Delete', 'Cancel']);
    if (answer !== 'Delete') return;
    try {
      await prints.removeEvent(event.id);
      document.dispatchEvent(new CustomEvent('parts-stock-changed'));
      await refreshAfterChange(model.filePath);
    } catch (error) {
      console.error('Error deleting print event:', error);
    }
  }

  const shown = history && history.model === model ? history : null;
  let historyItems: ReactNode = null;
  if (shown?.failed) {
    historyItems = <li className="print-history-empty">Could not load print history.</li>;
  } else if (shown?.events && !shown.events.length) {
    historyItems = <li className="print-history-empty">{effectiveStatus(shown.model) === 'printed' ? 'No logged prints yet' : 'No print history yet'}</li>;
  } else if (shown?.events) {
    historyItems = shown.events.map((event) => <HistoryItem key={event.id} event={event} onDelete={canEdit ? () => deleteEvent(event) : undefined} />);
  }

  return (
    <>
      {statusSlot &&
        createPortal(
          <div className="form-group print-lifecycle-group">
            <label htmlFor="model-print-status">Print status</label>
            <div className="print-lifecycle-controls">
              <select
                id="model-print-status"
                value={status}
                disabled={!canEdit}
                onChange={(e) => {
                  const filePath = window.getCurrentModelFilePath?.();
                  setStatus(e.target.value);
                  if (filePath && e.target.value) setStatusForPaths([filePath], e.target.value);
                }}
              >
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
              {canEdit && (
                <button
                  type="button"
                  id="log-print-button"
                  className="icon-button log-print-icon-button"
                  title="Log a print"
                  aria-label="Log a print"
                  onClick={logPrint}
                >
                  {LOG_PRINT_ICON}
                </button>
              )}
            </div>
            <p id="print-history-hint" className="print-history-hint">
              {model ? detailsHint(model) : ''}
            </p>
          </div>,
          statusSlot
        )}
      {historySlot &&
        createPortal(
          <div className="form-group print-history-group">
            <div className="print-history-label-row">
              <label>Print history</label>
              {canEdit && (
                <button
                  type="button"
                  id="log-print-history-button"
                  className="icon-button log-print-icon-button"
                  title="Log a print"
                  aria-label="Log a print"
                  onClick={logPrint}
                >
                  {LOG_PRINT_ICON}
                </button>
              )}
            </div>
            <ul id="print-history-list" className="print-history-list" aria-label="Print history">
              {historyItems}
            </ul>
          </div>,
          historySlot
        )}
    </>
  );
}

/** Everything print-related on the page: the Log Print dialog, the badge status menu and the details section. */
export function PrintHistory() {
  return (
    <>
      <LogPrintDialog />
      <StatusMenu />
      <DetailsPrint />
    </>
  );
}
