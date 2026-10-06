import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { filaments as filamentApi, settings, type Filament } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, refreshAfterFilamentManagerClose, refreshFilamentPickers, showMessage } from './page';

declare global {
  interface Window {
    /** Open the Filament Manager; 'add' opens the Add form, 'spoolman' the Spoolman setup (the Filament page uses these). */
    openFilamentManager?: (options?: { action?: 'add' | 'spoolman' }) => void;
  }
}

interface Status {
  text: string;
  error: boolean;
}

const NO_STATUS: Status = { text: '', error: false };
const EMPTY_FORM = { name: '', vendor: '', material: '', color: '', diameter: '1.75' };

/** "Vendor Name (Material)", as on model cards and pickers. */
export function formatFilamentLabel(filament: Pick<Filament, 'vendor' | 'name' | 'material'>): string {
  const base = [filament.vendor, filament.name].map((part) => String(part || '').trim()).filter(Boolean).join(' ') || 'Unnamed filament';
  const material = String(filament.material || '').trim();
  return material ? `${base} (${material})` : base;
}

/** "abc", "#AABBCC", "aabbccdd" or "aabbcc,ddeeff" → "AABBCC"; anything else → "". */
export function normalizeColorHex(value: string | null | undefined): string {
  let hex = String(value || '').replace(/^#/, '').trim();
  if (hex.includes(',')) hex = hex.split(',')[0].trim();
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length === 8) hex = hex.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : '';
}

function errorText(error: unknown, fallback: string): string {
  return (error instanceof Error && error.message) || fallback;
}

/**
 * Settings → Filament Manager: the filament catalog (manual entries and Spoolman spools) and
 * Spoolman setup.
 * Registers window.openFilamentManager.
 */
export function FilamentManagerDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [all, setAll] = useState<Filament[]>([]);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [status, setStatus] = useState<Status>(NO_STATUS);
  const [spoolmanOpen, setSpoolmanOpen] = useState(false);
  const [spoolman, setSpoolman] = useState({ url: '', token: '' });
  const [spoolmanStatus, setSpoolmanStatus] = useState<Status>(NO_STATUS);
  // The Spoolman fields are saved when the dialog closes; read them from a ref there.
  const spoolmanRef = useRef(spoolman);
  spoolmanRef.current = spoolman;

  async function load() {
    try {
      setAll(await filamentApi.list());
      setLoadError('');
    } catch (error) {
      console.error('Error loading filaments:', error);
      setLoadError(errorText(error, 'Failed to load filaments'));
    }
  }

  useEffect(() => exposeGlobal('openFilamentManager', ({ action }: { action?: 'add' | 'spoolman' } = {}) => {
    setSearch('');
    setForm(EMPTY_FORM);
    setFormOpen(action === 'add');
    setStatus(NO_STATUS);
    setSpoolmanOpen(action === 'spoolman');
    setSpoolmanStatus(NO_STATUS);
    void Promise.all([settings.get('spoolmanUrl'), settings.get('spoolmanApiToken')])
      .then(([url, token]) => setSpoolman({ url: url ?? '', token: token ?? '' }))
      .catch((error) => console.error('Error loading Spoolman settings:', error));
    void load();
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }), []);

  useEffect(() => {
    if (formOpen) nameRef.current?.focus();
  }, [formOpen]);

  async function afterCatalogChange() {
    await load();
    await refreshFilamentPickers();
  }

  async function saveSpoolmanSettings() {
    const url = spoolmanRef.current.url.trim();
    const token = spoolmanRef.current.token.trim();
    await settings.save('spoolmanUrl', url);
    await settings.save('spoolmanApiToken', token);
    return { url, token };
  }

  function closeForm() {
    setForm(EMPTY_FORM);
    setFormOpen(false);
  }

  async function addFilament() {
    const name = form.name.trim();
    if (!name) {
      setStatus({ text: 'Name is required to add a filament.', error: true });
      return;
    }
    const diameter = form.diameter === '' ? 1.75 : Number(form.diameter);
    try {
      await filamentApi.save({
        name,
        vendor: form.vendor.trim(),
        material: form.material.trim(),
        color_hex: normalizeColorHex(form.color),
        diameter: Number.isFinite(diameter) ? diameter : 1.75,
        source: 'manual'
      });
      closeForm();
      setStatus({ text: `Added ${name}`, error: false });
      await afterCatalogChange();
    } catch (error) {
      console.error('Error saving filament:', error);
      setStatus({ text: errorText(error, 'Failed to add filament'), error: true });
    }
  }

  async function removeFilament(filament: Filament) {
    const answer = await showMessage('Remove Filament',
      `Remove "${formatFilamentLabel(filament)}" from JusttPrint? Model assignments will be cleared. Synced filaments return on the next Spoolman sync.`,
      ['Remove', 'Cancel']);
    if (answer !== 'Remove') return;
    try {
      await filamentApi.remove(filament.id);
      await afterCatalogChange();
    } catch (error) {
      console.error('Error deleting filament:', error);
      setStatus({ text: errorText(error, 'Failed to delete filament'), error: true });
    }
  }

  async function testSpoolman() {
    try {
      const { url, token } = await saveSpoolmanSettings();
      if (!url) {
        setSpoolmanStatus({ text: 'Enter a Spoolman URL first.', error: true });
        return;
      }
      setSpoolmanStatus({ text: 'Testing connection…', error: false });
      const result = await filamentApi.testSpoolman(url, token);
      setSpoolmanStatus({ text: `Connected${result?.version ? ` (v${result.version})` : ''}.`, error: false });
    } catch (error) {
      console.error('Spoolman test failed:', error);
      setSpoolmanStatus({ text: errorText(error, 'Connection failed'), error: true });
    }
  }

  async function syncSpoolman() {
    try {
      const { url, token } = await saveSpoolmanSettings();
      if (!url) {
        setSpoolmanStatus({ text: 'Enter a Spoolman URL first.', error: true });
        return;
      }
      setSpoolmanStatus({ text: 'Syncing filaments from Spoolman…', error: false });
      const result = await filamentApi.syncSpoolman(url, token);
      setSpoolmanStatus({
        text: `Synced ${result?.total || 0} filaments (${result?.created || 0} new, ${result?.updated || 0} updated).`,
        error: false
      });
      await afterCatalogChange();
    } catch (error) {
      console.error('Spoolman sync failed:', error);
      setSpoolmanStatus({ text: errorText(error, 'Sync failed'), error: true });
    }
  }

  async function onClose() {
    try {
      await saveSpoolmanSettings();
    } catch (error) {
      console.error('Error saving Spoolman settings:', error);
    }
    await refreshAfterFilamentManagerClose();
  }

  const formField = (key: keyof typeof EMPTY_FORM) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [key]: event.target.value })),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') { event.preventDefault(); void addFilament(); }
    }
  });

  const term = search.trim().toLowerCase();
  const shown = all
    .filter((f) => !term || `${formatFilamentLabel(f)} ${f.vendor || ''} ${f.material || ''} ${f.source || ''}`.toLowerCase().includes(term))
    .sort((a, b) => formatFilamentLabel(a).localeCompare(formatFilamentLabel(b)));
  const pickerColor = `#${normalizeColorHex(form.color) || '808080'}`;

  return (
    <ModalDialog id="filament-manager-dialog" title="🧵 Filament Manager" dialogRef={dialogRef} fullscreenToggle
      headerClassName="filament-manager-header" headerRowClassName="filament-manager-header-row"
      headerActionsClassName="filament-header-actions"
      headerActions={
        <button type="button" id="spoolman-setup-toggle" className="filament-header-btn" aria-expanded={spoolmanOpen}
          aria-controls="spoolman-setup-panel"
          onClick={() => { setSpoolmanOpen(!spoolmanOpen); setSpoolmanStatus(NO_STATUS); }}>
          {spoolmanOpen ? 'Hide Spoolman' : 'Spoolman Setup'}
        </button>
      }
      description={<p className="setting-description">Manage your 3D printing filament library, assign spools to models, or sync with Spoolman.</p>}
      footer={<button type="button" id="filament-manager-close" className="filament-btn-close" onClick={() => dialogRef.current?.close()}>Close</button>}
      onClose={() => void onClose()}>
      <div id="spoolman-setup-panel" className="form-group spoolman-setup-panel" hidden={!spoolmanOpen}>
        <div className="spoolman-section-header">
          <label>Spoolman Integration</label>
        </div>
        <div className="spoolman-grid">
          <div className="filament-field">
            <label className="filament-field-label" htmlFor="spoolman-url">Instance URL</label>
            <input type="text" id="spoolman-url" placeholder="http://localhost:7912" autoComplete="off" spellCheck={false}
              value={spoolman.url} onChange={(event) => setSpoolman({ ...spoolman, url: event.target.value })} />
          </div>
          <div className="filament-field">
            <label className="filament-field-label" htmlFor="spoolman-api-token">API Token (Optional)</label>
            <input type="password" id="spoolman-api-token" placeholder="Optional token" autoComplete="off"
              value={spoolman.token} onChange={(event) => setSpoolman({ ...spoolman, token: event.target.value })} />
          </div>
        </div>
        <div className="filament-spoolman-actions">
          <button type="button" id="spoolman-test-button" className="spoolman-btn" onClick={testSpoolman}>Test Connection</button>
          <button type="button" id="spoolman-sync-button" className="spoolman-btn spoolman-btn-primary" onClick={syncSpoolman}>Sync Now</button>
        </div>
        <div id="spoolman-setup-status" className={`filament-manager-status${spoolmanStatus.error ? ' error' : ''}`} role="status">{spoolmanStatus.text}</div>
      </div>

      <div className={`form-group filament-form-section${formOpen ? '' : ' collapsed'}`} id="filament-form-section">
        <div className="filament-section-header">
          <label id="filament-form-label" htmlFor="new-filament-name">Add a filament</label>
          <button type="button" id="filament-toggle-add-btn" className={`filament-toggle-add-btn${formOpen ? ' active' : ''}`}
            aria-expanded={formOpen} onClick={() => { if (formOpen) closeForm(); else { setFormOpen(true); setStatus(NO_STATUS); } }}>
            {formOpen ? '− Cancel' : '+ Add Filament'}
          </button>
        </div>
        <div id="filament-form-body" hidden={!formOpen}>
          <div className="filament-add-grid">
            <div className="filament-field filament-span">
              <label className="filament-field-label" htmlFor="new-filament-name">Filament Name <span className="required">*</span></label>
              <input type="text" id="new-filament-name" ref={nameRef} autoComplete="off"
                placeholder="Name (e.g. PolyLite PLA Black, Prusament Galaxy Silver…)" {...formField('name')} />
            </div>
            <div className="filament-field">
              <label className="filament-field-label" htmlFor="new-filament-vendor">Vendor / Brand</label>
              <input type="text" id="new-filament-vendor" placeholder="e.g. Polymaker, Bambu Lab, eSUN" autoComplete="off" {...formField('vendor')} />
            </div>
            <div className="filament-field">
              <label className="filament-field-label" htmlFor="new-filament-material">Material</label>
              <input type="text" id="new-filament-material" placeholder="e.g. PLA, PETG, ABS, TPU" autoComplete="off" {...formField('material')} />
            </div>
            <div className="filament-field">
              <label className="filament-field-label" htmlFor="new-filament-color">Color</label>
              <div className="filament-color-row">
                <input type="color" id="new-filament-color-picker" title="Click to pick color" value={pickerColor}
                  onChange={(event) => setForm({ ...form, color: event.target.value.replace('#', '').toUpperCase() })} />
                <input type="text" id="new-filament-color" placeholder="Hex (e.g. 808080)" autoComplete="off" {...formField('color')} />
              </div>
            </div>
            <div className="filament-field">
              <label className="filament-field-label" htmlFor="new-filament-diameter">Diameter (mm)</label>
              <input type="number" id="new-filament-diameter" placeholder="1.75" step="0.05" min="0" {...formField('diameter')} />
            </div>
          </div>
          <div className="filament-form-actions">
            <button type="button" id="add-filament-manager-button" className="filament-btn-primary" onClick={addFilament}>Add Filament</button>
            <button type="button" id="cancel-filament-manager-button" className="filament-btn-cancel" onClick={closeForm}>Cancel</button>
          </div>
        </div>
        <div id="filament-manager-status" className={`filament-manager-status${status.error ? ' error' : ''}`} role="status">{status.text}</div>
      </div>

      <div className="form-group filament-list-section">
        <div className="filament-section-header">
          <label htmlFor="filament-manager-search">Filaments Inventory</label>
          <span id="filament-count-badge" className="filament-count-badge">
            {shown.length ? `${shown.length} filament${shown.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <div className="input-with-icon">
          <input type="text" id="filament-manager-search" placeholder="Search filaments by name, vendor, material..."
            value={search} onChange={(event) => setSearch(event.target.value)} />
          <button type="button" id="clear-filament-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>×</button>
        </div>
        <div id="filament-manager-list" className="filament-manager-list">
          {loadError ? (
            <div className="filament-manager-empty">Failed to load filaments: {loadError}</div>
          ) : shown.length === 0 ? (
            <div className="filament-manager-empty">
              <span className="filament-manager-empty-icon">{term ? '🔍' : '🧵'}</span>
              <span>{term ? 'No filaments match that search.' : 'No filaments yet. Add one above or sync from Spoolman.'}</span>
            </div>
          ) : shown.map((filament) => (
            <FilamentRow key={filament.id} filament={filament} onRemove={() => removeFilament(filament)} />
          ))}
        </div>
      </div>
    </ModalDialog>
  );
}

function FilamentRow({ filament, onRemove }: { filament: Filament; onRemove: () => void }) {
  const label = formatFilamentLabel(filament);
  const color = normalizeColorHex(filament.color_hex);
  const count = Number(filament.model_count) || 0;
  return (
    <div className="filament-manager-item" data-filament-id={filament.id}>
      <span className="filament-swatch" style={{ background: color ? `#${color}` : 'transparent' }} title={filament.color_hex || 'No color'} />
      <div className="filament-manager-item-body">
        <div className="filament-manager-item-name" title={label}>{label}</div>
        <div className="filament-manager-item-meta">
          {filament.diameter ? <span className="filament-tag">{filament.diameter} mm</span> : null}
          {filament.material ? <span className="filament-tag material">{filament.material}</span> : null}
          {filament.vendor ? <span className="filament-tag">{filament.vendor}</span> : null}
        </div>
      </div>
      {filament.source === 'spoolman'
        ? <span className="filament-source-badge">Spoolman</span>
        : <span className="filament-source-badge manual">Manual</span>}
      <span className="filament-count">{count === 1 ? '1 model' : `${count} models`}</span>
      <button type="button" className="filament-remove" title="Remove from JusttPrint" aria-label="Delete filament" onClick={onRemove}>×</button>
    </div>
  );
}
