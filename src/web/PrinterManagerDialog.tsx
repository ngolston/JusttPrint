import { useEffect, useRef, useState, type FormEvent } from 'react';
import { printers as printerApi, type MaintenanceLog, type Printer, type PrinterReminder } from './api';
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

const muted = { fontSize: '12px', color: '#94a3b8' } as const;
const fieldStack = { display: 'flex', flexDirection: 'column', gap: '10px' } as const;
const twoColumns = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } as const;
const formHeading = { fontSize: '12px', fontWeight: 600, color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase' } as const;
const smallButton = { padding: '7px 16px', fontSize: '12.5px' } as const;

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
    <div id={id} className={`printer-status-msg ${status.error ? 'error' : 'success'}`} role="status">
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
      title="🖨️ Printer Manager"
      dialogRef={dialogRef}
      fullscreenToggle
      plain
      headerClassName="printer-management-header"
      headerRowClassName="printer-management-header-row"
      footerClassName="printer-dialog-footer"
      footer={
        <button type="button" id="printer-management-close" className="printer-btn-close" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      }
      onClose={resetForm}
      description={
        <>
          <p className="setting-description">
            Onboard your 3D printers, launch Klipper/OctoPrint web interfaces, track maintenance logs, and schedule reminders.
          </p>
          <div className="printer-management-tabs">
            <button
              type="button"
              id="printer-tab-printers"
              className={`printer-tab-btn${tab === 'printers' ? ' active' : ''}`}
              onClick={() => setTab('printers')}
            >
              <span>🖨️ My Printers</span>
              <span id="printer-tab-printers-count" className="printer-tab-badge">
                {all.length}
              </span>
            </button>
            <button
              type="button"
              id="printer-tab-maintenance"
              className={`printer-tab-btn${tab === 'maintenance' ? ' active' : ''}`}
              onClick={() => setTab('maintenance')}
            >
              <span>📋 Maintenance &amp; Reminders</span>
              <span id="printer-tab-due-badge" className="printer-tab-badge due" hidden={totalDue === 0}>
                {totalDue > 0 ? `${totalDue} due` : ''}
              </span>
            </button>
          </div>
        </>
      }
    >
      <div className="printer-management-scroll-content" ref={scrollRef}>
        <div id="printer-view-printers" hidden={tab !== 'printers'}>
          <div className={`form-group printer-form-section${formOpen ? '' : ' collapsed'}`} id="printer-form-section">
            <div className="printer-section-header">
              <label id="printer-form-title" className="printer-section-title">
                {form.id ? `Edit Printer: ${form.nickname}` : 'Onboard a Printer'}
              </label>
              <button
                type="button"
                id="printer-toggle-add-btn"
                className={`printer-toggle-add-btn${formOpen ? ' active' : ''}`}
                aria-expanded={formOpen}
                onClick={() => (formOpen ? resetForm() : setFormOpen(true))}
              >
                {formOpen ? '− Cancel' : '+ Add Printer'}
              </button>
            </div>
            <div id="printer-form-body" hidden={!formOpen}>
              <form id="printer-form" onSubmit={savePrinter}>
                <div className="printer-add-grid">
                  <div className="printer-field printer-span">
                    <label className="printer-field-label" htmlFor="printer-form-nickname">
                      Nickname <span className="required">*</span>
                    </label>
                    <input
                      type="text"
                      id="printer-form-nickname"
                      ref={nicknameRef}
                      placeholder="e.g. Voron 2.4, Bambu X1C, Living Room Ender"
                      autoComplete="off"
                      {...field('nickname')}
                    />
                  </div>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="printer-form-manufacturer">
                      Manufacturer
                    </label>
                    <input
                      type="text"
                      id="printer-form-manufacturer"
                      list="printer-manufacturers-list"
                      placeholder="e.g. Bambu Lab, Prusa, Creality, Voron"
                      autoComplete="off"
                      {...field('manufacturer')}
                    />
                  </div>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="printer-form-model">
                      Model
                    </label>
                    <input type="text" id="printer-form-model" placeholder="e.g. X1-Carbon, MK4, Ender 3 V2, 2.4r2" autoComplete="off" {...field('model')} />
                  </div>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="printer-form-type">
                      Printer Type
                    </label>
                    <select id="printer-form-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                      {PRINTER_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="printer-form-firmware">
                      Firmware Type
                    </label>
                    <select
                      id="printer-form-firmware"
                      value={form.firmware}
                      onChange={(event) => setForm({ ...form, firmware: event.target.value, klipper: event.target.value === 'Klipper' })}
                    >
                      {FIRMWARES.map((firmware) => (
                        <option key={firmware} value={firmware}>
                          {firmware}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="printer-field printer-span">
                    <label className="printer-klipper-toggle-row">
                      <input
                        type="checkbox"
                        id="printer-form-klipper"
                        checked={form.klipper}
                        onChange={(event) => setForm({ ...form, klipper: event.target.checked })}
                      />
                      <span className="printer-klipper-toggle-label">
                        <span>Running Klipper</span>
                        <span className="klipper-tag-badge">Klipper</span>
                        <span style={{ ...muted, marginLeft: '4px' }}>(Shows a Klipper badge on the printer)</span>
                      </span>
                    </label>
                  </div>
                  <div className="printer-field printer-span">
                    <label className="printer-field-label" htmlFor="printer-form-web-url">
                      Web Interface Address (Mainsail, Fluidd, OctoPrint, etc.)
                    </label>
                    <div className="printer-url-group">
                      <input
                        type="text"
                        id="printer-form-web-url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={form.firmware === 'Klipper' ? 'http://mainsail.local or http://fluidd.local' : 'http://192.168.1.100'}
                        {...field('webUrl')}
                      />
                      <button
                        type="button"
                        id="printer-form-test-url"
                        className="printer-url-open-btn"
                        title="Open URL in browser"
                        onClick={() => (form.webUrl.trim() ? openWebUrl(form.webUrl) : flashForm('Enter a web address first', true))}
                      >
                        🌐 Open ↗
                      </button>
                    </div>
                  </div>
                  <div className="printer-field printer-span">
                    <label className="printer-field-label" htmlFor="printer-form-notes">
                      Notes / Location (Optional)
                    </label>
                    <input
                      type="text"
                      id="printer-form-notes"
                      placeholder="e.g. Workshop rack, 0.4mm hardened nozzle installed"
                      autoComplete="off"
                      {...field('notes')}
                    />
                  </div>
                </div>
                <div className="printer-form-actions">
                  <button type="submit" id="printer-form-submit" className="printer-btn-primary">
                    {form.id ? 'Save Changes' : 'Add Printer'}
                  </button>
                  <button type="button" id="printer-form-cancel" className="printer-btn-cancel" onClick={resetForm}>
                    {form.id ? 'Cancel Edit' : 'Cancel'}
                  </button>
                </div>
              </form>
            </div>
            {/* Outside the form body, so "Printer added" stays visible after the form closes. */}
            <StatusLine id="printer-form-status" status={formStatus} hideWhenEmpty />
          </div>

          <div className="form-group printer-list-section">
            <div className="printer-section-header">
              <label className="printer-section-title">Onboarded Printers</label>
              <span id="printer-count-badge" className="printer-tab-badge">{`${shown.length} printer${shown.length === 1 ? '' : 's'}`}</span>
            </div>
            <div className="printer-search-filter-row">
              <div className="input-with-icon" style={{ flex: 1 }}>
                <input
                  type="text"
                  id="printer-search-input"
                  placeholder="Search printers by nickname, type, model..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <button type="button" id="printer-clear-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>
                  ×
                </button>
              </div>
              <select
                id="printer-type-filter"
                className="printer-type-filter-select"
                title="Filter by printer type"
                aria-label="Filter by printer type"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
              >
                <option value="">All Types</option>
                {PRINTER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div id="printer-cards-list" className="printer-cards-grid">
              {shown.length === 0 ? (
                <div className="printer-empty-state">
                  <div className="printer-empty-icon">🖨️</div>
                  <div>{term || typeFilter ? 'No printers match your search or filter.' : 'No printers onboarded yet. Add your first printer above!'}</div>
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
          </div>
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
    <div className="printer-card" data-printer-id={printer.id}>
      <div className="printer-card-main">
        <div className="printer-card-info">
          <div className="printer-card-name-row">
            <span className="printer-card-name">{printer.nickname}</span>
            {makeModel && <span className="printer-card-model">({makeModel})</span>}
          </div>
          <div className="printer-card-meta">
            {printer.printer_type && <span className="printer-badge printer-type">{printer.printer_type}</span>}
            {printer.firmware_type && <span className={`printer-badge${klipper ? ' klipper' : ''}`}>{printer.firmware_type}</span>}
            {klipper && printer.firmware_type?.toLowerCase() !== 'klipper' && <span className="printer-badge klipper">Klipper</span>}
            <span className="printer-badge prints-count">
              🖨️ {prints} print{prints === 1 ? '' : 's'}
            </span>
            {due > 0 && (
              <span className="printer-badge reminder-due" title={`${due} maintenance reminder(s) due soon or overdue`}>
                ⚠️ {due} reminder{due === 1 ? '' : 's'} due
              </span>
            )}
          </div>
          {printer.notes && <div style={{ ...muted, marginTop: '2px' }}>{printer.notes}</div>}
        </div>
        <div className="printer-card-actions">
          {printer.web_url && (
            <button
              type="button"
              className="printer-action-btn web-ui"
              title={`Open web interface in browser (${printer.web_url})`}
              onClick={() => openWebUrl(printer.web_url)}
            >
              🌐 Web UI ↗
            </button>
          )}
          <button type="button" className="printer-action-btn maintenance" title="View maintenance log and schedule reminders" onClick={onMaintenance}>
            📋 Maintenance
          </button>
          <button type="button" className="printer-action-btn" title="Edit printer details" onClick={onEdit}>
            ✏️ Edit
          </button>
          <button type="button" className="printer-action-btn danger" title="Delete printer" aria-label="Delete printer" onClick={onDelete}>
            🗑️
          </button>
        </div>
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
      <div className="maintenance-active-printer-row">
        <div className="maintenance-printer-selector">
          <span style={{ fontWeight: 600, fontSize: '13px', color: '#cbd5e1' }}>Active Printer:</span>
          <select id="maintenance-printer-select" value={printerId ?? ''} onChange={(event) => onSelect(Number(event.target.value))}>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>{`${p.printer_type ? `[${p.printer_type}] ` : ''}${p.nickname}${p.model ? ` (${p.model})` : ''}`}</option>
            ))}
          </select>
        </div>
        <div style={muted}>Manage preventative maintenance and upcoming service alerts</div>
      </div>

      <div className="maintenance-split">
        <div className="maintenance-column">
          <div className="form-group printer-maintenance-form-section">
            <div className="printer-section-header">
              <label className="printer-section-title">⏰ Scheduled Reminders</label>
            </div>
            <div id="maintenance-reminders-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
              {reminders.length === 0 ? (
                <div style={{ ...muted, fontSize: '12.5px', padding: '8px 0' }}>No scheduled reminders for this printer. Add one below!</div>
              ) : (
                reminders.map((item) => (
                  <ReminderItem key={item.id} reminder={item} onDone={() => completeReminder(item)} onDelete={() => deleteReminder(item)} />
                ))
              )}
            </div>
            <form id="reminder-form" onSubmit={scheduleReminder}>
              <div style={formHeading}>Schedule New Reminder</div>
              <div style={fieldStack}>
                <div className="printer-field">
                  <label className="printer-field-label" htmlFor="reminder-form-title">
                    Task Title <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    id="reminder-form-title"
                    list="reminder-presets-list"
                    placeholder="e.g. Lubricate linear rails"
                    autoComplete="off"
                    value={reminder.title}
                    onChange={(event) => setReminder({ ...reminder, title: event.target.value })}
                  />
                </div>
                <div style={twoColumns}>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="reminder-form-due-date">
                      Due Date
                    </label>
                    <input
                      type="date"
                      id="reminder-form-due-date"
                      required
                      value={reminder.dueDate}
                      onChange={(event) => setReminder({ ...reminder, dueDate: event.target.value })}
                    />
                  </div>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="reminder-form-interval">
                      Recurrence
                    </label>
                    <select
                      id="reminder-form-interval"
                      value={reminder.interval}
                      onChange={(event) => setReminder({ ...reminder, interval: event.target.value })}
                    >
                      {RECURRENCES.map(([days, label]) => (
                        <option key={days} value={days}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="printer-field">
                  <label className="printer-field-label" htmlFor="reminder-form-notes">
                    Notes (Optional)
                  </label>
                  <input
                    type="text"
                    id="reminder-form-notes"
                    placeholder="e.g. Use Mobilux EP2 grease"
                    autoComplete="off"
                    value={reminder.notes}
                    onChange={(event) => setReminder({ ...reminder, notes: event.target.value })}
                  />
                </div>
                <div>
                  <button type="submit" className="printer-btn-primary" style={smallButton}>
                    Schedule Reminder
                  </button>
                </div>
                <StatusLine id="reminder-form-status" status={reminderStatus} />
              </div>
            </form>
          </div>
        </div>

        <div className="maintenance-column">
          <div className="form-group printer-maintenance-form-section">
            <div className="printer-section-header">
              <label className="printer-section-title">📝 Maintenance History Log</label>
            </div>
            <div
              id="maintenance-logs-list"
              style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '220px', overflowY: 'auto', marginBottom: '14px' }}
            >
              {logs.length === 0 ? (
                <div style={{ ...muted, fontSize: '12.5px', padding: '8px 0' }}>No maintenance performed yet.</div>
              ) : (
                logs.map((item) => <LogItem key={item.id} log={item} onDelete={() => deleteLog(item)} />)
              )}
            </div>
            <form id="log-maintenance-form" onSubmit={logMaintenance}>
              <div style={formHeading}>Record Maintenance Performed</div>
              <div style={fieldStack}>
                <div style={twoColumns}>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="log-form-type">
                      Type
                    </label>
                    <select id="log-form-type" value={log.type} onChange={(event) => setLog({ ...log, type: event.target.value })}>
                      {LOG_TYPES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="printer-field">
                    <label className="printer-field-label" htmlFor="log-form-performed-at">
                      Date
                    </label>
                    <input
                      type="date"
                      id="log-form-performed-at"
                      required
                      value={log.date}
                      onChange={(event) => setLog({ ...log, date: event.target.value })}
                    />
                  </div>
                </div>
                <div className="printer-field">
                  <label className="printer-field-label" htmlFor="log-form-title">
                    Summary / Action
                  </label>
                  <input
                    type="text"
                    id="log-form-title"
                    placeholder="e.g. Swapped to 0.6mm CHT nozzle"
                    autoComplete="off"
                    value={log.title}
                    onChange={(event) => setLog({ ...log, title: event.target.value })}
                  />
                </div>
                <div className="printer-field">
                  <label className="printer-field-label" htmlFor="log-form-description">
                    Details / Notes
                  </label>
                  <textarea
                    id="log-form-description"
                    placeholder="Notes, observations, torque specs, brand of replacement parts..."
                    rows={2}
                    value={log.description}
                    onChange={(event) => setLog({ ...log, description: event.target.value })}
                  />
                </div>
                <div>
                  <button type="submit" className="printer-btn-primary" style={smallButton}>
                    Log Maintenance
                  </button>
                </div>
                <StatusLine id="log-form-status" status={logStatus} />
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReminderItem({ reminder, onDone, onDelete }: { reminder: PrinterReminder; onDone: () => void; onDelete: () => void }) {
  const due = new Date(reminder.due_date);
  const completed = reminder.status === 'completed';
  const days = Math.ceil((due.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  let pill = { className: 'upcoming', text: `Due in ${plural(days)}` };
  if (completed) pill = { className: 'completed', text: 'Completed' };
  else if (days < 0) pill = { className: 'overdue', text: `Overdue by ${plural(Math.abs(days))}` };
  else if (days <= 7) pill = { className: 'due-soon', text: days === 0 ? 'Due today!' : `Due in ${plural(days)}` };
  const state = completed ? 'is-completed' : days < 0 ? 'is-overdue' : days <= 7 ? 'is-due-soon' : '';

  return (
    <div className={`reminder-item ${state}`} data-reminder-id={reminder.id}>
      <div className="reminder-item-main">
        <span className="reminder-title">{reminder.title}</span>
        <div className="reminder-meta">
          <span className={`due-pill ${pill.className}`}>{pill.text}</span>
          <span>📅 {due.toLocaleDateString()}</span>
          <span>🔄 {reminder.interval_days > 0 ? `Repeats every ${reminder.interval_days} days` : 'One-time'}</span>
        </div>
        {reminder.notes && <div style={muted}>{reminder.notes}</div>}
      </div>
      <div className="reminder-actions">
        {!completed && (
          <button type="button" className="reminder-done-btn" title="Mark completed and record in maintenance log" onClick={onDone}>
            ✓ Done
          </button>
        )}
        <button type="button" className="printer-action-btn danger" title="Delete reminder" onClick={onDelete}>
          🗑️
        </button>
      </div>
    </div>
  );
}

function LogItem({ log, onDelete }: { log: MaintenanceLog; onDelete: () => void }) {
  return (
    <div className="log-item" data-log-id={log.id}>
      <div className="log-item-main">
        <span className="log-title">{log.title || log.maintenance_type}</span>
        <div className="log-meta">
          <span className="printer-badge">{log.maintenance_type}</span>
          <span>📅 {new Date(log.performed_at).toLocaleDateString()}</span>
        </div>
        {log.description && <div style={{ ...muted, marginTop: '2px' }}>{log.description}</div>}
      </div>
      <div className="log-actions">
        <button type="button" className="printer-action-btn danger" title="Delete log entry" onClick={onDelete}>
          🗑️
        </button>
      </div>
    </div>
  );
}
