import { useEffect, useRef, useState, type FormEvent } from 'react';
import { printers as printerApi, type MaintenanceLog, type Printer, type PrinterReminder } from './api';
import { BellRing, Check, ClipboardList, ExternalLink, Pencil, Plus, Printer as PrinterIcon, Trash2, Wrench, X } from 'lucide-react';
import { Badge, StatusBadge, type StatusTone } from './components/Badge';
import { Button, IconButton, cx } from './components/Button';
import { ModalDialog } from './components/ModalDialog';
import { askText, exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    /** Open the Printer Manager: a tab, a printer's maintenance, or the Add / Edit form (the Printers page uses these). */
    openPrinterManagement?: (options?: { printerId?: number; tab?: Tab; action?: 'add' | 'edit' }) => void;
  }
}

type Tab = 'printers' | 'maintenance';

/** Print History listens for this to refresh its printer picker. */
const PRINTERS_CHANGED = 'printers-changed';

const PRINTER_TYPES = ['FDM', 'SLA', 'SLS', 'DLP', 'LCD', 'MJF', 'DMLS', 'SLM', 'Other'];
const FIRMWARES = ['Klipper', 'Marlin', 'Bambu OS', 'Prusa Buddy', 'RepRap', 'Other'];
const MANUFACTURERS = [
  'Bambu Lab',
  'Prusa Research',
  'Voron Design',
  'Creality',
  'Elegoo',
  'Anycubic',
  'RatRig',
  'Qidi Tech',
  'Flashforge',
  'Sovol',
  'Snapmaker',
  'Kingroon',
  'Artillery',
  'UltiMaker'
];
const REMINDER_PRESETS = [
  'Clean and grease Z-axis lead screws',
  'Lubricate X/Y linear rails and rods',
  'Check and tension belts',
  'Wash PEI print surface with warm soapy water',
  'Inspect and clean extruder drive gears',
  'Check PTFE reverse Bowden tube for wear',
  'Check hotend screws and nozzle tightness',
  'Bed tramming and auto-level mesh calibration',
  'Replace activated carbon / HEPA filter'
];
const RECURRENCES: Array<[number, string]> = [
  [0, 'One-time'],
  [14, 'Every 2 weeks (14 days)'],
  [30, 'Every month (30 days)'],
  [60, 'Every 2 months (60 days)'],
  [90, 'Every 3 months (90 days)'],
  [180, 'Every 6 months (180 days)']
];
const LOG_TYPES: Array<[string, string]> = [
  ['Lubrication', 'Lubrication'],
  ['Cleaning', 'Cleaning'],
  ['Belt Tensioning', 'Belt Tensioning'],
  ['Nozzle Replacement', 'Nozzle Replacement'],
  ['Bed Tramming / Leveling', 'Bed Tramming'],
  ['Extruder Service', 'Extruder Service'],
  ['PTFE Tube', 'PTFE Tube'],
  ['Firmware Update', 'Firmware Update'],
  ['General Service', 'General Service']
];

interface PrinterForm {
  id: number | null;
  nickname: string;
  manufacturer: string;
  model: string;
  type: string;
  firmware: string;
  klipper: boolean;
  webUrl: string;
  notes: string;
}

const EMPTY_PRINTER: PrinterForm = {
  id: null,
  nickname: '',
  manufacturer: '',
  model: '',
  type: 'FDM',
  firmware: 'Klipper',
  klipper: true,
  webUrl: '',
  notes: ''
};

function errorText(error: unknown, fallback: string): string {
  return (error instanceof Error && error.message) || fallback;
}

function dateInputValue(daysFromNow = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

/** A date input value at noon, so the stored day does not move with the time zone. */
function noonIso(value: string): string {
  return value ? new Date(`${value}T12:00:00`).toISOString() : new Date().toISOString();
}

function openWebUrl(url: string | null) {
  if (!url) return;
  const target = /^https?:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`;
  window.open(target, '_blank', 'noopener');
}

/** A status line that clears itself after 5 seconds. */
function useFlash() {
  const [status, setStatus] = useState({ text: '', error: false });
  useEffect(() => {
    if (!status.text) return;
    const timer = setTimeout(() => setStatus({ text: '', error: false }), 5000);
    return () => clearTimeout(timer);
  }, [status]);
  return [status, (text: string, error = false) => setStatus({ text, error })] as const;
}

function StatusLine({ id, status, hideWhenEmpty }: { id: string; status: { text: string; error: boolean }; hideWhenEmpty?: boolean }) {
  if (hideWhenEmpty && !status.text) return null;
  return (
    <div id={id} className={cx('jp-mgr__status', status.error && 'is-error')} role="status">
      {status.text}
    </div>
  );
}

/**
 * Settings → Printer Manager: onboard printers, open their web interfaces, and track maintenance
 * (scheduled reminders and a history log). Registers window.openPrinterManagement.
 */
export function PrinterManagerDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>('printers');
  const [all, setAll] = useState<Printer[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState<PrinterForm>(EMPTY_PRINTER);
  const [formOpen, setFormOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [formStatus, flashForm] = useFlash();
  const nicknameRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function load(): Promise<Printer[]> {
    try {
      const list = (await printerApi.list()) || [];
      setAll(list);
      return list;
    } catch (error) {
      console.error('Failed to load printers:', error);
      setAll([]);
      return [];
    }
  }

  function resetForm() {
    setForm(EMPTY_PRINTER);
    setFormOpen(false);
  }

  useEffect(
    () =>
      exposeGlobal('openPrinterManagement', ({ printerId, tab: requested, action } = {}) => {
        resetForm();
        setSearch('');
        setTypeFilter('');
        if (printerId) setSelectedId(Number(printerId));
        setTab(!action && (requested === 'maintenance' || (printerId && !requested)) ? 'maintenance' : 'printers');
        if (action === 'add') setFormOpen(true);
        void load().then((list) => {
          const printer = action === 'edit' && list.find((p) => p.id === Number(printerId));
          if (printer) editPrinter(printer);
        });
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  useEffect(() => {
    if (formOpen) nicknameRef.current?.focus();
  }, [formOpen, form.id]);

  async function savePrinter(event: FormEvent) {
    event.preventDefault();
    const nickname = form.nickname.trim();
    if (!nickname) {
      flashForm('Printer nickname is required', true);
      return;
    }
    let webUrl = form.webUrl.trim() || null;
    if (webUrl && !/^https?:\/\//i.test(webUrl)) webUrl = `http://${webUrl}`;
    try {
      await printerApi.save({
        id: form.id,
        nickname,
        manufacturer: form.manufacturer.trim() || null,
        model: form.model.trim() || null,
        printerType: form.type || null,
        firmwareType: form.firmware || null,
        isKlipper: form.klipper,
        webUrl,
        notes: form.notes.trim() || null
      });
      flashForm(form.id ? 'Printer updated successfully' : 'Printer added successfully');
      resetForm();
      await load();
      document.dispatchEvent(new CustomEvent(PRINTERS_CHANGED));
    } catch (error) {
      console.error('Error saving printer:', error);
      flashForm(errorText(error, 'Failed to save printer'), true);
    }
  }

  function editPrinter(printer: Printer) {
    setForm({
      id: printer.id,
      nickname: printer.nickname || '',
      manufacturer: printer.manufacturer || '',
      model: printer.model || '',
      type: printer.printer_type || 'FDM',
      firmware: printer.firmware_type || 'Other',
      klipper: Boolean(printer.is_klipper),
      webUrl: printer.web_url || '',
      notes: printer.notes || ''
    });
    setFormOpen(true);
    setTab('printers');
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deletePrinter(printer: Printer) {
    const answer = await showMessage('Delete Printer', `Delete printer "${printer.nickname}"? Past print logs will be preserved.`, ['Delete', 'Cancel']);
    if (answer !== 'Delete') return;
    try {
      await printerApi.remove(printer.id);
      if (form.id === printer.id) resetForm();
      await load();
      document.dispatchEvent(new CustomEvent(PRINTERS_CHANGED));
    } catch (error) {
      console.error('Error deleting printer:', error);
      await showMessage('Error', `Failed to delete printer: ${errorText(error, 'unknown error')}`);
    }
  }

  const term = search.trim().toLowerCase();
  const shown = all.filter((printer) => {
    if (typeFilter && (printer.printer_type || '').toLowerCase() !== typeFilter.toLowerCase()) return false;
    if (!term) return true;
    return `${printer.nickname} ${printer.manufacturer || ''} ${printer.model || ''} ${printer.printer_type || ''} ${printer.firmware_type || ''}`
      .toLowerCase()
      .includes(term);
  });
  const totalDue = all.reduce((sum, printer) => sum + (Number(printer.due_reminders_count) || 0), 0);
  const field = (key: 'nickname' | 'manufacturer' | 'model' | 'webUrl' | 'notes') => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [key]: event.target.value }))
  });

  return (
    <ModalDialog
      id="printer-management-dialog"
      title="Printer Manager"
      dialogRef={dialogRef}
      fullscreenToggle
      plain
      className="jp-mgr"
      headerClassName="jp-mgr__header"
      headerRowClassName="jp-mgr__header-row"
      footerClassName="jp-mgr__footer"
      footer={
        <Button id="printer-management-close" onClick={() => dialogRef.current?.close()}>
          Close
        </Button>
      }
      onClose={resetForm}
      description={
        <>
          <p className="jp-meta">Your printers, their web interfaces, and their maintenance: a log of what was done and reminders for what is due.</p>
          <div className="jp-tabs jp-mgr__tabs" role="tablist" aria-label="Printer Manager">
            <button
              type="button"
              role="tab"
              id="printer-tab-printers"
              aria-selected={tab === 'printers'}
              className={cx('jp-tab', tab === 'printers' && 'is-selected')}
              onClick={() => setTab('printers')}
            >
              <PrinterIcon size={16} aria-hidden="true" />
              <span>Printers</span>
              <span id="printer-tab-printers-count" className="jp-mgr__count">
                {all.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              id="printer-tab-maintenance"
              aria-selected={tab === 'maintenance'}
              className={cx('jp-tab', tab === 'maintenance' && 'is-selected')}
              onClick={() => setTab('maintenance')}
            >
              <Wrench size={16} aria-hidden="true" />
              <span>Maintenance</span>
              <span id="printer-tab-due-badge" className="jp-mgr__count is-due" hidden={totalDue === 0}>
                {totalDue > 0 ? `${totalDue} due` : ''}
              </span>
            </button>
          </div>
        </>
      }
    >
      <div className="jp-mgr__body" ref={scrollRef}>
        <div id="printer-view-printers" hidden={tab !== 'printers'}>
          <section className="jp-mgr__section" id="printer-form-section">
            <div className="jp-mgr__section-head">
              <h4 id="printer-form-title" className="jp-mgr__section-title">
                {form.id ? `Edit Printer: ${form.nickname}` : formOpen ? 'Add a printer' : 'Printers'}
              </h4>
              <Button
                id="printer-toggle-add-btn"
                size="sm"
                variant={formOpen ? 'ghost' : 'primary'}
                icon={formOpen ? X : Plus}
                aria-expanded={formOpen}
                onClick={() => (formOpen ? resetForm() : setFormOpen(true))}
              >
                {formOpen ? 'Cancel' : 'Add Printer'}
              </Button>
            </div>
            <div id="printer-form-body" hidden={!formOpen}>
              <form id="printer-form" className="jp-mgr__form" onSubmit={savePrinter}>
                <div className="jp-mgr__grid">
                  <label className="jp-mgr__field is-wide">
                    <span className="jp-label">
                      Nickname <span className="jp-mgr__required">*</span>
                    </span>
                    <input
                      type="text"
                      id="printer-form-nickname"
                      className="jp-input"
                      ref={nicknameRef}
                      placeholder="e.g. Voron 2.4, Bambu X1C, Living Room Ender"
                      autoComplete="off"
                      {...field('nickname')}
                    />
                  </label>
                  <label className="jp-mgr__field">
                    <span className="jp-label">Manufacturer</span>
                    <input
                      type="text"
                      id="printer-form-manufacturer"
                      className="jp-input"
                      list="printer-manufacturers-list"
                      placeholder="e.g. Bambu Lab, Prusa, Creality"
                      autoComplete="off"
                      {...field('manufacturer')}
                    />
                  </label>
                  <label className="jp-mgr__field">
                    <span className="jp-label">Model</span>
                    <input
                      type="text"
                      id="printer-form-model"
                      className="jp-input"
                      placeholder="e.g. X1-Carbon, MK4, Ender 3 V2"
                      autoComplete="off"
                      {...field('model')}
                    />
                  </label>
                  <label className="jp-mgr__field">
                    <span className="jp-label">Printer type</span>
                    <select id="printer-form-type" className="jp-input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                      {PRINTER_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="jp-mgr__field">
                    <span className="jp-label">Firmware</span>
                    <select
                      id="printer-form-firmware"
                      className="jp-input"
                      value={form.firmware}
                      onChange={(event) => setForm({ ...form, firmware: event.target.value, klipper: event.target.value === 'Klipper' })}
                    >
                      {FIRMWARES.map((firmware) => (
                        <option key={firmware} value={firmware}>
                          {firmware}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="jp-mgr__check is-wide">
                    <input
                      type="checkbox"
                      id="printer-form-klipper"
                      checked={form.klipper}
                      onChange={(event) => setForm({ ...form, klipper: event.target.checked })}
                    />
                    <span>Runs Klipper</span>
                    <span className="jp-meta">shows a Klipper badge on the printer</span>
                  </label>
                  <div className="jp-mgr__field is-wide">
                    <label className="jp-label" htmlFor="printer-form-web-url">
                      Web interface (Mainsail, Fluidd, OctoPrint…)
                    </label>
                    <div className="jp-mgr__inline">
                      <input
                        type="text"
                        id="printer-form-web-url"
                        className="jp-input"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={form.firmware === 'Klipper' ? 'http://mainsail.local or http://fluidd.local' : 'http://192.168.1.100'}
                        {...field('webUrl')}
                      />
                      <Button
                        id="printer-form-test-url"
                        iconEnd={ExternalLink}
                        title="Open the address in a new tab"
                        onClick={() => (form.webUrl.trim() ? openWebUrl(form.webUrl) : flashForm('Enter a web address first', true))}
                      >
                        Open
                      </Button>
                    </div>
                  </div>
                  <label className="jp-mgr__field is-wide">
                    <span className="jp-label">Notes or location</span>
                    <input
                      type="text"
                      id="printer-form-notes"
                      className="jp-input"
                      placeholder="e.g. Workshop rack, 0.4 mm hardened nozzle"
                      autoComplete="off"
                      {...field('notes')}
                    />
                  </label>
                </div>
                <div className="jp-mgr__actions">
                  <Button type="submit" id="printer-form-submit" variant="primary">
                    {form.id ? 'Save Changes' : 'Add Printer'}
                  </Button>
                  <Button id="printer-form-cancel" variant="ghost" onClick={resetForm}>
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
            {/* Outside the form body, so "Printer added" stays visible after the form closes. */}
            <StatusLine id="printer-form-status" status={formStatus} hideWhenEmpty />
          </section>

          <section className="jp-mgr__section">
            <div className="jp-mgr__toolbar">
              <div className="input-with-icon jp-mgr__search">
                <input
                  type="text"
                  id="printer-search-input"
                  className="jp-input"
                  placeholder="Search by nickname, type or model"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <button type="button" id="printer-clear-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>
                  ×
                </button>
              </div>
              <select
                id="printer-type-filter"
                className="jp-input jp-mgr__filter"
                title="Filter by printer type"
                aria-label="Filter by printer type"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
              >
                <option value="">All types</option>
                {PRINTER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <span id="printer-count-badge" className="jp-meta">{`${shown.length} printer${shown.length === 1 ? '' : 's'}`}</span>
            </div>
            <div id="printer-cards-list" className="jp-mgr__list">
              {shown.length === 0 ? (
                <div className="jp-mgr__empty">
                  <PrinterIcon size={28} aria-hidden="true" />
                  <span>{term || typeFilter ? 'No printers match the search or filter.' : 'No printers yet. Add your first one above.'}</span>
                </div>
              ) : (
                shown.map((printer) => (
                  <PrinterCard
                    key={printer.id}
                    printer={printer}
                    onMaintenance={() => {
                      setSelectedId(printer.id);
                      setTab('maintenance');
                    }}
                    onEdit={() => editPrinter(printer)}
                    onDelete={() => deletePrinter(printer)}
                  />
                ))
              )}
            </div>
          </section>
        </div>

        {tab === 'maintenance' && <MaintenanceView printers={all} selectedId={selectedId} onSelect={setSelectedId} onRemindersChanged={() => void load()} />}
      </div>

      <datalist id="printer-manufacturers-list">
        {MANUFACTURERS.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="reminder-presets-list">
        {REMINDER_PRESETS.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </ModalDialog>
  );
}

function PrinterCard({ printer, onMaintenance, onEdit, onDelete }: { printer: Printer; onMaintenance: () => void; onEdit: () => void; onDelete: () => void }) {
  const makeModel = [printer.manufacturer, printer.model].filter(Boolean).join(' ');
  const klipper = Boolean(printer.is_klipper);
  const prints = printer.total_prints || 0;
  const due = Number(printer.due_reminders_count) || 0;
  return (
    <div className="jp-mgr__row printer-card" data-printer-id={printer.id}>
      <div className="jp-mgr__row-main">
        <div className="jp-mgr__row-title">
          <span className="jp-mgr__name">{printer.nickname}</span>
          {makeModel && <span className="jp-meta">{makeModel}</span>}
        </div>
        <div className="jp-mgr__tags">
          {printer.printer_type && <Badge>{printer.printer_type}</Badge>}
          {printer.firmware_type && <Badge className={klipper ? 'jp-mgr__klipper' : undefined}>{printer.firmware_type}</Badge>}
          {klipper && printer.firmware_type?.toLowerCase() !== 'klipper' && <Badge className="jp-mgr__klipper">Klipper</Badge>}
          <span className="jp-meta">{`${prints} print${prints === 1 ? '' : 's'}`}</span>
          {due > 0 && (
            <span title={`${due} maintenance reminder(s) due soon or overdue`}>
              <StatusBadge tone="warning">{`${due} reminder${due === 1 ? '' : 's'} due`}</StatusBadge>
            </span>
          )}
        </div>
        {printer.notes && <div className="jp-meta">{printer.notes}</div>}
      </div>
      <div className="jp-mgr__row-actions">
        {printer.web_url && (
          <Button
            size="sm"
            iconEnd={ExternalLink}
            className="printer-action-btn web-ui"
            title={`Open the web interface (${printer.web_url})`}
            onClick={() => openWebUrl(printer.web_url)}
          >
            Web UI
          </Button>
        )}
        <Button size="sm" icon={Wrench} className="printer-action-btn maintenance" title="Maintenance log and reminders" onClick={onMaintenance}>
          Maintenance
        </Button>
        <Button size="sm" icon={Pencil} className="printer-action-btn" title="Edit printer details" onClick={onEdit}>
          Edit
        </Button>
        <IconButton size="sm" icon={Trash2} className="printer-action-btn danger" label="Delete printer" onClick={onDelete} />
      </div>
    </div>
  );
}

function MaintenanceView({
  printers,
  selectedId,
  onSelect,
  onRemindersChanged
}: {
  printers: Printer[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRemindersChanged: () => void;
}) {
  const printerId = selectedId && printers.some((p) => p.id === selectedId) ? selectedId : (printers[0]?.id ?? null);
  const [reminders, setReminders] = useState<PrinterReminder[]>([]);
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);
  const [reminder, setReminder] = useState({ title: '', dueDate: dateInputValue(30), interval: '0', notes: '' });
  const [log, setLog] = useState({ type: LOG_TYPES[0][0], date: dateInputValue(), title: '', description: '' });
  const [reminderStatus, flashReminder] = useFlash();
  const [logStatus, flashLog] = useFlash();

  async function loadData(id = printerId) {
    if (!id) return;
    try {
      const [nextReminders, nextLogs] = await Promise.all([printerApi.reminders(id), printerApi.logs(id)]);
      setReminders(nextReminders || []);
      setLogs(nextLogs || []);
    } catch (error) {
      console.error('Error loading maintenance data:', error);
    }
  }

  useEffect(() => {
    void loadData();
  }, [printerId]);

  async function afterReminderChange() {
    await loadData();
    onRemindersChanged();
  }

  async function scheduleReminder(event: FormEvent) {
    event.preventDefault();
    if (!printerId) return;
    const title = reminder.title.trim();
    if (!title) {
      flashReminder('Reminder title is required', true);
      return;
    }
    try {
      await printerApi.saveReminder({
        printerId,
        title,
        maintenanceType: 'General',
        dueDate: noonIso(reminder.dueDate),
        intervalDays: Number(reminder.interval) || 0,
        notes: reminder.notes.trim() || null
      });
      setReminder({ ...reminder, title: '', notes: '' });
      flashReminder('Reminder scheduled!');
      await afterReminderChange();
    } catch (error) {
      console.error('Error saving reminder:', error);
      flashReminder(errorText(error, 'Failed to save reminder'), true);
    }
  }

  async function logMaintenance(event: FormEvent) {
    event.preventDefault();
    if (!printerId) return;
    try {
      await printerApi.saveLog({
        printerId,
        maintenanceType: log.type || 'General',
        title: log.title.trim() || log.type,
        performedAt: noonIso(log.date),
        description: log.description.trim() || null
      });
      setLog({ ...log, title: '', description: '' });
      flashLog('Maintenance logged!');
      await loadData();
    } catch (error) {
      console.error('Error logging maintenance:', error);
      flashLog(errorText(error, 'Failed to log maintenance'), true);
    }
  }

  async function completeReminder(item: PrinterReminder) {
    const notes = await askText('Complete Reminder', `Mark "${item.title}" as completed? Optional notes for the maintenance log:`, item.notes || '');
    if (notes === null) return;
    try {
      await printerApi.completeReminder(item.id, notes);
      await afterReminderChange();
    } catch (error) {
      await showMessage('Error', `Failed to complete reminder: ${errorText(error, 'unknown error')}`);
    }
  }

  async function deleteReminder(item: PrinterReminder) {
    if ((await showMessage('Delete Reminder', `Delete reminder "${item.title}"?`, ['Delete', 'Cancel'])) !== 'Delete') return;
    try {
      await printerApi.removeReminder(item.id);
      await afterReminderChange();
    } catch (error) {
      await showMessage('Error', `Failed to delete reminder: ${errorText(error, 'unknown error')}`);
    }
  }

  async function deleteLog(item: MaintenanceLog) {
    if ((await showMessage('Delete Log Entry', 'Delete this maintenance log entry?', ['Delete', 'Cancel'])) !== 'Delete') return;
    try {
      await printerApi.removeLog(item.id);
      await loadData();
    } catch (error) {
      await showMessage('Error', `Failed to delete log entry: ${errorText(error, 'unknown error')}`);
    }
  }

  return (
    <div id="printer-view-maintenance">
      <div className="jp-mgr__toolbar">
        <label className="jp-mgr__inline">
          <span className="jp-label">Printer</span>
          <select id="maintenance-printer-select" className="jp-input" value={printerId ?? ''} onChange={(event) => onSelect(Number(event.target.value))}>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>{`${p.printer_type ? `[${p.printer_type}] ` : ''}${p.nickname}${p.model ? ` (${p.model})` : ''}`}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="jp-mgr__split">
        <section className="jp-mgr__section">
          <h4 className="jp-mgr__section-title">
            <BellRing size={16} aria-hidden="true" /> Reminders
          </h4>
          <div id="maintenance-reminders-list" className="jp-mgr__list">
            {reminders.length === 0 ? (
              <p className="jp-meta">No reminders for this printer yet.</p>
            ) : (
              reminders.map((item) => (
                <ReminderItem key={item.id} reminder={item} onDone={() => completeReminder(item)} onDelete={() => deleteReminder(item)} />
              ))
            )}
          </div>
          <form id="reminder-form" className="jp-mgr__form" onSubmit={scheduleReminder}>
            <h5 className="jp-label">New reminder</h5>
            <label className="jp-mgr__field">
              <span className="jp-label">
                Task <span className="jp-mgr__required">*</span>
              </span>
              <input
                type="text"
                id="reminder-form-title"
                className="jp-input"
                list="reminder-presets-list"
                placeholder="e.g. Lubricate linear rails"
                autoComplete="off"
                value={reminder.title}
                onChange={(event) => setReminder({ ...reminder, title: event.target.value })}
              />
            </label>
            <div className="jp-mgr__grid">
              <label className="jp-mgr__field">
                <span className="jp-label">Due</span>
                <input
                  type="date"
                  id="reminder-form-due-date"
                  className="jp-input"
                  required
                  value={reminder.dueDate}
                  onChange={(event) => setReminder({ ...reminder, dueDate: event.target.value })}
                />
              </label>
              <label className="jp-mgr__field">
                <span className="jp-label">Repeats</span>
                <select
                  id="reminder-form-interval"
                  className="jp-input"
                  value={reminder.interval}
                  onChange={(event) => setReminder({ ...reminder, interval: event.target.value })}
                >
                  {RECURRENCES.map(([days, label]) => (
                    <option key={days} value={days}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="jp-mgr__field">
              <span className="jp-label">Notes</span>
              <input
                type="text"
                id="reminder-form-notes"
                className="jp-input"
                placeholder="e.g. Use Mobilux EP2 grease"
                autoComplete="off"
                value={reminder.notes}
                onChange={(event) => setReminder({ ...reminder, notes: event.target.value })}
              />
            </label>
            <div className="jp-mgr__actions">
              <Button type="submit" size="sm" variant="primary" icon={Plus}>
                Add Reminder
              </Button>
              <StatusLine id="reminder-form-status" status={reminderStatus} />
            </div>
          </form>
        </section>

        <section className="jp-mgr__section">
          <h4 className="jp-mgr__section-title">
            <ClipboardList size={16} aria-hidden="true" /> Maintenance log
          </h4>
          <div id="maintenance-logs-list" className="jp-mgr__list jp-mgr__list--scroll">
            {logs.length === 0 ? (
              <p className="jp-meta">Nothing logged yet.</p>
            ) : (
              logs.map((item) => <LogItem key={item.id} log={item} onDelete={() => deleteLog(item)} />)
            )}
          </div>
          <form id="log-maintenance-form" className="jp-mgr__form" onSubmit={logMaintenance}>
            <h5 className="jp-label">Log maintenance</h5>
            <div className="jp-mgr__grid">
              <label className="jp-mgr__field">
                <span className="jp-label">Type</span>
                <select id="log-form-type" className="jp-input" value={log.type} onChange={(event) => setLog({ ...log, type: event.target.value })}>
                  {LOG_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="jp-mgr__field">
                <span className="jp-label">Date</span>
                <input
                  type="date"
                  id="log-form-performed-at"
                  className="jp-input"
                  required
                  value={log.date}
                  onChange={(event) => setLog({ ...log, date: event.target.value })}
                />
              </label>
            </div>
            <label className="jp-mgr__field">
              <span className="jp-label">What was done</span>
              <input
                type="text"
                id="log-form-title"
                className="jp-input"
                placeholder="e.g. Swapped to a 0.6 mm CHT nozzle"
                autoComplete="off"
                value={log.title}
                onChange={(event) => setLog({ ...log, title: event.target.value })}
              />
            </label>
            <label className="jp-mgr__field">
              <span className="jp-label">Details</span>
              <textarea
                id="log-form-description"
                className="jp-input"
                placeholder="Observations, torque specs, replacement part brands…"
                rows={2}
                value={log.description}
                onChange={(event) => setLog({ ...log, description: event.target.value })}
              />
            </label>
            <div className="jp-mgr__actions">
              <Button type="submit" size="sm" variant="primary" icon={Plus}>
                Log Maintenance
              </Button>
              <StatusLine id="log-form-status" status={logStatus} />
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

function ReminderItem({ reminder, onDone, onDelete }: { reminder: PrinterReminder; onDone: () => void; onDelete: () => void }) {
  const due = new Date(reminder.due_date);
  const completed = reminder.status === 'completed';
  const days = Math.ceil((due.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  let pill: { tone: StatusTone; text: string } = { tone: 'neutral', text: `Due in ${plural(days)}` };
  if (completed) pill = { tone: 'success', text: 'Completed' };
  else if (days < 0) pill = { tone: 'danger', text: `Overdue by ${plural(Math.abs(days))}` };
  else if (days <= 7) pill = { tone: 'warning', text: days === 0 ? 'Due today' : `Due in ${plural(days)}` };

  return (
    <div className={cx('jp-mgr__row reminder-item', completed && 'is-completed')} data-reminder-id={reminder.id}>
      <div className="jp-mgr__row-main">
        <span className="jp-mgr__name">{reminder.title}</span>
        <div className="jp-mgr__tags">
          <StatusBadge tone={pill.tone}>{pill.text}</StatusBadge>
          <span className="jp-meta">{due.toLocaleDateString()}</span>
          <span className="jp-meta">{reminder.interval_days > 0 ? `Repeats every ${reminder.interval_days} days` : 'One-time'}</span>
        </div>
        {reminder.notes && <div className="jp-meta">{reminder.notes}</div>}
      </div>
      <div className="jp-mgr__row-actions">
        {!completed && (
          <Button size="sm" icon={Check} className="reminder-done-btn" title="Mark done and add it to the maintenance log" onClick={onDone}>
            Done
          </Button>
        )}
        <IconButton size="sm" icon={Trash2} className="printer-action-btn danger" label="Delete reminder" onClick={onDelete} />
      </div>
    </div>
  );
}

function LogItem({ log, onDelete }: { log: MaintenanceLog; onDelete: () => void }) {
  return (
    <div className="jp-mgr__row log-item" data-log-id={log.id}>
      <div className="jp-mgr__row-main">
        <span className="jp-mgr__name">{log.title || log.maintenance_type}</span>
        <div className="jp-mgr__tags">
          <Badge>{log.maintenance_type}</Badge>
          <span className="jp-meta">{new Date(log.performed_at).toLocaleDateString()}</span>
        </div>
        {log.description && <div className="jp-meta">{log.description}</div>}
      </div>
      <div className="jp-mgr__row-actions">
        <IconButton size="sm" icon={Trash2} className="printer-action-btn danger" label="Delete log entry" onClick={onDelete} />
      </div>
    </div>
  );
}
