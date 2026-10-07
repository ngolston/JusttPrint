import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  filaments as filamentApi, models, parts as partApi, printers as printerApi, prints,
  type Filament, type Part, type PrintEvent, type Printer
} from '../api';
import { exposeGlobal, showMessage } from '../page';
import { getCurrentUser, roleAllows, useCan } from '../session';
import {
  OUTCOME_LABELS, STATUSES, STATUS_LABELS, badgeClassNames, badgeText, badgeTitle, bundleSummary, colorCss,
  detailsHint, effectiveStatus, filamentLabel, filterLabel, formatPrintDate, friendlyError, modelMatchesPrintFilter,
  partOptionLabel, printerOptionLabel, toDatetimeLocalValue, type FilamentLike, type PrintModel
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
    /** filters/Sidebar.tsx: display labels by filament id. */
    filamentLabelById?: Record<string, string>;
  }
}

const labelOf = (filament: FilamentLike) => filamentLabel(filament, window.filamentLabelById);

let openLogDialogImpl: ((filePaths: string[]) => Promise<void>) | null = null;
let openStatusMenuImpl: ((anchor: HTMLElement, filePath: string) => void) | null = null;

async function refreshAfterChange(filePaths: string | string[]) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const filePath of paths) {
    try { await window.updateModelElement?.(filePath); } catch { /* keep going */ }
  }
  const current = window.getCurrentModelFilePath?.();
  if (current && paths.includes(current)) {
    try {
      const model = await models.get<PrintDetailsModel>(current);
      if (model) window.detailsPrint?.show(model);
    } catch { /* ignore */ }
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
  populateDetails: async (model: PrintDetailsModel) => { window.detailsPrint?.show(model); },
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

/** Log a print on one or more models (#log-print-dialog). */
function LogPrintDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [when, setWhen] = useState('');
  const [outcome, setOutcome] = useState('printed');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [printerList, setPrinterList] = useState<Printer[]>([]);
  const [printerId, setPrinterId] = useState('');
  const [filamentList, setFilamentList] = useState<Filament[]>([]);
  const [chosenFilaments, setChosenFilaments] = useState<FilamentLike[]>([]);
  const [partList, setPartList] = useState<Part[]>([]);
  const [chosenParts, setChosenParts] = useState<ChosenPart[]>([]);
  const [partId, setPartId] = useState('');
  const [partQuantity, setPartQuantity] = useState('1');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const loadPrinters = () => printerApi.list().then(setPrinterList).catch(() => setPrinterList([]));

  async function open(paths: string[]) {
    setFilePaths(paths);
    setWhen(toDatetimeLocalValue(new Date()));
    setOutcome('printed');
    setQuantity('1');
    setNotes('');
    setPrinterId('');
    setPartId('');
    setPartQuantity('1');
    setChosenParts([]);
    setStatus('');
    let prefill: FilamentLike[] = [];
    if (paths.length === 1) {
      try {
        const model = await models.get<{ filaments?: FilamentLike[] }>(paths[0]);
        prefill = Array.isArray(model?.filaments) ? model.filaments : [];
      } catch { /* ignore */ }
    }
    const [allFilaments, allParts] = await Promise.all([
      filamentApi.list().catch(() => [] as Filament[]),
      partApi.list().catch(() => [] as Part[]),
      loadPrinters()
    ]);
    setFilamentList(allFilaments);
    setPartList(allParts);
    setChosenFilaments(prefill.filter((f, i) => prefill.findIndex((g) => Number(g.id) === Number(f.id)) === i));
    dialogRef.current?.showModal();
  }

  useEffect(() => {
    openLogDialogImpl = open;
    return () => { if (openLogDialogImpl === open) openLogDialogImpl = null; };
  });

  useEffect(() => {
    const onPrintersChanged = () => { if (dialogRef.current?.open) loadPrinters(); };
    document.addEventListener('printers-changed', onPrintersChanged);
    return () => document.removeEventListener('printers-changed', onPrintersChanged);
  }, []);

  function addFilament(id: number) {
    const filament = filamentList.find((f) => f.id === id);
    if (filament && !chosenFilaments.some((f) => Number(f.id) === id)) setChosenFilaments([...chosenFilaments, filament]);
  }

  function addPart() {
    const part = partList.find((p) => p.id === Number(partId));
    if (!part) return;
    const qty = clampQuantity(partQuantity);
    const existing = chosenParts.find((c) => c.part.id === part.id);
    setChosenParts(existing
      ? chosenParts.map((c) => (c === existing ? { ...c, quantity: Math.min(9999, c.quantity + qty) } : c))
      : [...chosenParts, { part, quantity: qty }]);
    setPartId('');
    setPartQuantity('1');
  }

  const copies = Math.max(1, Number(quantity) || 1);
  const partsSummary = chosenParts.length
    ? `Removes ${chosenParts.map((c) => `${c.part.name || 'Part'} ×${c.quantity * copies * Math.max(1, filePaths.length)}`).join(', ')} from Parts Stock.`
    : '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !filePaths.length) return;
    const pickedPrinter = Number(printerId);
    const input = {
      printedAt: when ? new Date(when).toISOString() : new Date().toISOString(),
      outcome,
      quantity: Number(quantity) || 1,
      notes,
      printerId: pickedPrinter > 0 ? pickedPrinter : null,
      filamentIds: chosenFilaments.map((f) => Number(f.id)).filter((id) => id > 0),
      parts: chosenParts.map((c) => ({ id: c.part.id, quantity: c.quantity }))
    };
    setSaving(true);
    try {
      if (filePaths.length === 1) await prints.log(filePaths[0], input);
      else await prints.logMany(filePaths, input);
      dialogRef.current?.close();
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
        <p className="setting-description">Creates a history row. Status-only changes use the dropdown or Shift-click on the card badge.</p>
        <div className="form-group">
          <label htmlFor="log-print-when">When</label>
          <input type="datetime-local" id="log-print-when" required value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="log-print-outcome">Outcome</label>
          <select id="log-print-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {Object.entries(OUTCOME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="log-print-quantity">Quantity</label>
          <input type="number" id="log-print-quantity" min="1" max="9999" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="log-print-printer-select">Printer used</label>
          <select id="log-print-printer-select" value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
            <option value="">Select printer (optional)…</option>
            {printerList.map((p) => <option key={p.id} value={String(p.id)}>{printerOptionLabel(p)}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="log-print-filament-select">Filament used</label>
          <select id="log-print-filament-select" value="" onChange={(e) => addFilament(Number(e.target.value))}>
            <option value="">Add filament…</option>
            {filamentList.map((f) => <option key={f.id} value={String(f.id)}>{labelOf(f)}</option>)}
          </select>
          <div id="log-print-filaments" className="tags-list">
            {chosenFilaments.map((f) => (
              <span key={String(f.id)} className="filament-chip" data-filament-id={String(f.id)}>
                <span className="filament-swatch" style={{ background: colorCss(f.color_hex) }} />
                {labelOf(f)}
                <span className="filament-chip-remove" title="Remove" onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setChosenFilaments(chosenFilaments.filter((g) => g !== f));
                }}>×</span>
              </span>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="log-print-part-select">Parts used</label>
          <div className="log-print-parts-add">
            <select id="log-print-part-select" value={partId} onChange={(e) => setPartId(e.target.value)}>
              <option value="">Add part…</option>
              {partList.map((p) => <option key={p.id} value={String(p.id)}>{partOptionLabel(p)}</option>)}
            </select>
            <input type="number" id="log-print-part-qty" min="1" max="9999" value={partQuantity} title="Quantity of this part per copy"
              aria-label="Quantity per copy" onChange={(e) => setPartQuantity(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPart(); } }} />
            <button type="button" id="log-print-part-add" onClick={addPart}>Add</button>
          </div>
          <p className="setting-description">Quantity is per copy. Saving removes that many from Parts Stock for every copy and every model in this log.</p>
          <div id="log-print-parts" className="tags-list" onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}>
            {chosenParts.map((c) => (
              <span key={c.part.id} className="filament-chip part-chip" data-part-id={String(c.part.id)} data-part-name={c.part.name || 'Part'}
                data-stock={String(Number(c.part.quantity) || 0)}>
                {c.part.name} × <input type="number" className="part-chip-qty" min="1" max="9999" value={c.quantity} aria-label="Quantity per copy"
                  onChange={(e) => setChosenParts(chosenParts.map((d) => (d === c ? { ...d, quantity: clampQuantity(e.target.value) } : d)))} />
                <span className="part-chip-stock">{Number(c.part.quantity) || 0}{c.part.unit ? ` ${c.part.unit}` : ''} in stock</span>
                <span className="filament-chip-remove" title="Remove" onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setChosenParts(chosenParts.filter((d) => d !== c));
                }}>×</span>
              </span>
            ))}
          </div>
          <p id="log-print-parts-summary" className="setting-description">{partsSummary}</p>
        </div>
        <div className="form-group">
          <label htmlFor="log-print-notes">Notes</label>
          <textarea id="log-print-notes" placeholder="Optional — layer height, what failed, who it was for" value={notes}
            onChange={(e) => setNotes(e.target.value)} />
        </div>
        <p id="log-print-status" className="print-history-hint">{status}</p>
        <div className="dialog-buttons">
          <button type="submit" id="log-print-save" disabled={saving}>Save</button>
          <button type="button" id="log-print-cancel" onClick={() => dialogRef.current?.close()}>Cancel</button>
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
    const open = (anchor: HTMLElement, filePath: string) => { if (roleAllows(getCurrentUser()?.role, 'editor')) setMenu({ anchor, filePath }); };
    openStatusMenuImpl = open;
    return () => { if (openStatusMenuImpl === open) openStatusMenuImpl = null; };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const rect = menu.anchor.getBoundingClientRect();
    el.style.left = `${Math.min(rect.left, window.innerWidth - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - el.offsetHeight - 8)}px`;
    const onOutside = (event: MouseEvent) => { if (!el.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div className="print-status-menu" role="menu" ref={ref}>
      {STATUSES.map((status) => (
        <button key={status} type="button" className={`print-status-menu-item print-status-${status}`} onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu(null);
          setStatusForPaths([menu.filePath], status);
        }}>{STATUS_LABELS[status]}</button>
      ))}
    </div>,
    document.body
  );
}

const LOG_PRINT_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.992 11h3.5m-3.5-4h7m-11-1h-3m3 6h-3m3 6h-3m6 3.939c-1.581-.103-2.595-.377-3.328-1.11C4.492 19.656 4.492 17.77 4.492 14v-4c0-3.771 0-5.657 1.172-6.828S8.72 2 12.492 2h.5c3.771 0 5.657 0 6.829 1.172S20.992 6.229 20.992 10v.5m-1.136 3.94l.695.692a1.496 1.496 0 0 1 0 2.12L16.91 20.95a2 2 0 0 1-1.05.551l-2.258.488a.5.5 0 0 1-.597-.593l.48-2.235c.074-.397.268-.762.554-1.047l3.688-3.674a1.51 1.51 0 0 1 2.13 0" />
  </svg>
);

function HistoryItem({ event, onDelete }: { event: PrintEvent; onDelete?: () => void }) {
  const filaments = (event.filaments || []).map(labelOf).join(', ');
  const parts = (event.parts || []).map((part) => `${part.name || 'Part'} ×${Number(part.quantity) || 0}`).join(', ');
  const printerName = event.printer_nickname || event.printer_name;
  return (
    <li className={`print-history-item outcome-${event.outcome}`}>
      <div className="print-history-item-main">
        <span className="print-history-outcome">{OUTCOME_LABELS[event.outcome] || event.outcome}{Number(event.quantity) > 1 ? ` ×${event.quantity}` : ''}</span>
        <span className="print-history-when">{formatPrintDate(event.printed_at)}</span>
      </div>
      {printerName && (
        <div className="print-history-printer">
          🖨️ {event.printer_type && <span className="print-history-printer-type">{event.printer_type}</span>}
          {printerName}
          {event.printer_model && <> <span className="print-history-printer-model">({event.printer_model})</span></>}
        </div>
      )}
      {filaments && <div className="print-history-filaments">{filaments}</div>}
      {parts && <div className="print-history-parts">{parts}</div>}
      {event.notes && <div className="print-history-notes">{event.notes}</div>}
      {onDelete && <button type="button" className="print-history-delete icon-button" title="Delete this log entry" aria-label="Delete print log"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}>×</button>}
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

  useEffect(() => exposeGlobal('detailsPrint', {
    show: (next: PrintDetailsModel) => {
      setModel(next);
      setStatus(effectiveStatus(next));
    },
    clear: () => {
      setModel(null);
      setStatus('unprinted');
    }
  }), []);

  useEffect(() => {
    if (!model?.id) {
      setHistory(null);
      return;
    }
    let current = true;
    prints.events(model.id).then(
      (events) => { if (current) setHistory({ model, events: events || [], failed: false }); },
      (error) => {
        console.error('Error loading print history:', error);
        if (current) setHistory({ model, events: null, failed: true });
      }
    );
    return () => { current = false; };
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
      {statusSlot && createPortal(
        <div className="form-group print-lifecycle-group">
          <label htmlFor="model-print-status">Print status</label>
          <div className="print-lifecycle-controls">
            <select id="model-print-status" value={status} disabled={!canEdit} onChange={(e) => {
              const filePath = window.getCurrentModelFilePath?.();
              setStatus(e.target.value);
              if (filePath && e.target.value) setStatusForPaths([filePath], e.target.value);
            }}>
              {STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}
            </select>
            {canEdit && <button type="button" id="log-print-button" className="icon-button log-print-icon-button" title="Log a print"
              aria-label="Log a print" onClick={logPrint}>{LOG_PRINT_ICON}</button>}
          </div>
          <p id="print-history-hint" className="print-history-hint">{model ? detailsHint(model) : ''}</p>
        </div>,
        statusSlot
      )}
      {historySlot && createPortal(
        <div className="form-group print-history-group">
          <div className="print-history-label-row">
            <label>Print history</label>
            {canEdit && <button type="button" id="log-print-history-button" className="icon-button log-print-icon-button" title="Log a print"
              aria-label="Log a print" onClick={logPrint}>{LOG_PRINT_ICON}</button>}
          </div>
          <ul id="print-history-list" className="print-history-list" aria-label="Print history">{historyItems}</ul>
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
