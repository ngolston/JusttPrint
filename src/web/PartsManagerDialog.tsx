import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { parts as partApi, type Part, type PartInput } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openPartsStock?: () => void;
  }
}

/** Print History fires this when logging a print uses up parts; the Parts Manager fires it after edits. */
const PARTS_CHANGED = 'parts-stock-changed';

const CATEGORIES = ['Screws', 'Nuts', 'Washers', 'Bearings', 'Inserts', 'Magnets', 'Springs', 'Electronics', 'Fasteners', 'Hardware'];

interface FormState {
  id?: number;
  name: string;
  category: string;
  quantity: string;
  unit: string;
  lowStock: string;
  notes: string;
}

const EMPTY_FORM: FormState = { name: '', category: '', quantity: '0', unit: 'pcs', lowStock: '0', notes: '' };

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Could not save part');
  return message.replace(/^Error:\s*/, '');
}

function toInput(part: Part, quantity = part.quantity): PartInput {
  return {
    id: part.id,
    name: part.name,
    category: part.category || '',
    quantity,
    unit: part.unit || 'pcs',
    notes: part.notes || '',
    lowStock: part.low_stock ?? 0
  };
}

/**
 * Settings → Parts Manager: hardware stock (screws, bearings, inserts) that logged prints use up.
 * Registers window.openPartsStock.
 */
export function PartsManagerDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [allParts, setAllParts] = useState<Part[]>([]);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false });

  async function load() {
    try {
      setAllParts(await partApi.list());
      setLoadError('');
    } catch (error) {
      console.error('Error loading parts:', error);
      setLoadError(friendlyError(error));
    }
  }

  useEffect(() => {
    const reloadIfOpen = () => { if (dialogRef.current?.open) void load(); };
    document.addEventListener(PARTS_CHANGED, reloadIfOpen);
    const unexpose = exposeGlobal('openPartsStock', () => {
      setSearch('');
      setForm(EMPTY_FORM);
      setFormOpen(false);
      setStatus({ text: '', error: false });
      void load();
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    });
    return () => {
      document.removeEventListener(PARTS_CHANGED, reloadIfOpen);
      unexpose();
    };
  }, []);

  useEffect(() => {
    if (formOpen) nameRef.current?.focus();
  }, [formOpen, form.id]);

  function closeForm() {
    setForm(EMPTY_FORM);
    setFormOpen(false);
  }

  /** Save one part; reload and tell the rest of the page. */
  async function persist(part: PartInput) {
    await partApi.save(part);
    await load();
    document.dispatchEvent(new CustomEvent(PARTS_CHANGED));
  }

  async function saveForm() {
    const name = form.name.trim();
    if (!name) {
      setStatus({ text: 'Name is required.', error: true });
      return;
    }
    const editing = form.id !== undefined;
    try {
      await persist({
        id: form.id,
        name,
        category: form.category.trim(),
        quantity: Math.max(0, Math.floor(Number(form.quantity) || 0)),
        unit: form.unit.trim() || 'pcs',
        notes: form.notes.trim(),
        lowStock: Math.max(0, Math.floor(Number(form.lowStock) || 0))
      });
      closeForm();
      setStatus({ text: editing ? '' : 'Part saved.', error: false });
    } catch (error) {
      console.error('Error saving part:', error);
      setStatus({ text: friendlyError(error), error: true });
    }
  }

  async function setQuantity(part: Part, quantity: number) {
    try {
      await persist(toInput(part, Math.max(0, Math.floor(quantity))));
    } catch (error) {
      setStatus({ text: friendlyError(error), error: true });
    }
  }

  async function removePart(part: Part) {
    const answer = await showMessage('Remove Part',
      `Remove "${part.name}" from Parts Stock? Older print logs keep the part name. Stock is not restored.`, ['Remove', 'Cancel']);
    if (answer !== 'Remove') return;
    try {
      await partApi.remove(part.id);
      if (form.id === part.id) closeForm();
      await load();
      document.dispatchEvent(new CustomEvent(PARTS_CHANGED));
    } catch (error) {
      setStatus({ text: friendlyError(error), error: true });
    }
  }

  function editPart(part: Part) {
    setForm({
      id: part.id,
      name: part.name || '',
      category: part.category || '',
      quantity: String(part.quantity ?? 0),
      unit: part.unit || 'pcs',
      lowStock: String(part.low_stock ?? 0),
      notes: part.notes || ''
    });
    setFormOpen(true);
    setStatus({ text: '', error: false });
  }

  const field = (key: keyof Omit<FormState, 'id'>) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [key]: event.target.value })),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') { event.preventDefault(); void saveForm(); }
    }
  });

  const term = search.trim().toLowerCase();
  const shown = allParts
    .filter((part) => !term || `${part.name || ''} ${part.category || ''} ${part.notes || ''} ${part.unit || ''}`.toLowerCase().includes(term))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const editing = form.id !== undefined;

  return (
    <ModalDialog id="parts-stock-dialog" title="🔩 Parts Manager" dialogRef={dialogRef} fullscreenToggle
      headerClassName="parts-stock-header" headerRowClassName="parts-stock-header-row"
      description={<p className="setting-description">Track screws, bearings, inserts, and other hardware. When you log a print, choose the parts it used and they are removed from stock.</p>}
      footer={<button type="button" id="parts-stock-close" onClick={() => dialogRef.current?.close()}>Close</button>}>
      <div className={`form-group parts-stock-form-section${formOpen ? '' : ' collapsed'}`} id="parts-stock-form-section">
        <div className="parts-stock-section-header">
          <label id="parts-stock-form-label" htmlFor="parts-stock-name">{editing ? 'Edit part' : 'Add a part'}</label>
          <button type="button" id="parts-stock-toggle-add-btn" className={`parts-stock-toggle-add-btn${formOpen ? ' active' : ''}`}
            aria-expanded={formOpen} onClick={() => (formOpen ? closeForm() : setFormOpen(true))}>
            {formOpen ? '− Cancel' : '+ Add Part'}
          </button>
        </div>
        <div id="parts-stock-form-body" hidden={!formOpen}>
          <div className="parts-stock-add-grid">
            <div className="parts-stock-field parts-stock-span">
              <label className="parts-stock-field-label" htmlFor="parts-stock-name">Part Name <span className="required">*</span></label>
              <input type="text" id="parts-stock-name" ref={nameRef} placeholder="Name (e.g. M3×8 screw, 608 bearing…)" autoComplete="off" {...field('name')} />
            </div>
            <div className="parts-stock-field">
              <label className="parts-stock-field-label" htmlFor="parts-stock-category">Category</label>
              <input type="text" id="parts-stock-category" list="parts-stock-categories" placeholder="Category (e.g. Screws)" autoComplete="off" {...field('category')} />
            </div>
            <div className="parts-stock-field">
              <label className="parts-stock-field-label" htmlFor="parts-stock-unit">Unit</label>
              <input type="text" id="parts-stock-unit" placeholder="Unit (pcs)" autoComplete="off" {...field('unit')} />
            </div>
            <div className="parts-stock-field">
              <label className="parts-stock-field-label" htmlFor="parts-stock-quantity">Quantity on hand</label>
              <input type="number" id="parts-stock-quantity" min="0" max="1000000" step="1" {...field('quantity')} />
            </div>
            <div className="parts-stock-field">
              <label className="parts-stock-field-label" htmlFor="parts-stock-low">Low stock alert threshold</label>
              <input type="number" id="parts-stock-low" min="0" max="1000000" step="1" title="Warn when quantity is at or below this number" {...field('lowStock')} />
            </div>
            <div className="parts-stock-field parts-stock-span">
              <label className="parts-stock-field-label" htmlFor="parts-stock-notes">Notes (optional)</label>
              <input type="text" id="parts-stock-notes" placeholder="Notes (optional, e.g. bin number or size specs)" autoComplete="off" {...field('notes')} />
            </div>
          </div>
          <datalist id="parts-stock-categories">
            {CATEGORIES.map((category) => <option key={category} value={category} />)}
          </datalist>
          <div className="parts-stock-form-actions">
            <button type="button" id="parts-stock-add" className="parts-stock-btn-primary" onClick={saveForm}>{editing ? 'Save' : 'Add'}</button>
            <button type="button" id="parts-stock-cancel-edit" className="parts-stock-btn-cancel"
              onClick={() => { closeForm(); setStatus({ text: '', error: false }); }}>{editing ? 'Cancel Edit' : 'Cancel'}</button>
          </div>
        </div>
        <div id="parts-stock-status" className={`parts-stock-status${status.error ? ' error' : ''}`} role="status">{status.text}</div>
      </div>
      <div className="form-group parts-stock-list-section">
        <div className="parts-stock-section-header">
          <label htmlFor="parts-stock-search">Parts Inventory</label>
          <span id="parts-stock-count-badge" className="parts-stock-count-badge">
            {shown.length ? `${shown.length} part${shown.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <div className="input-with-icon">
          <input type="text" id="parts-stock-search" placeholder="Search parts..." value={search}
            onChange={(event) => setSearch(event.target.value)} />
          <button type="button" id="parts-stock-clear-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>×</button>
        </div>
        <div id="parts-stock-list" className="parts-stock-list">
          {loadError ? (
            <div className="parts-stock-empty">Failed to load parts: {loadError}</div>
          ) : shown.length === 0 ? (
            <div className="parts-stock-empty">
              <span className="parts-stock-empty-icon">{term ? '🔍' : '🔩'}</span>
              <span>{term ? 'No parts match that search.' : 'No parts yet. Add screws, bearings, inserts, and anything else a print uses up.'}</span>
            </div>
          ) : shown.map((part) => (
            <PartRow key={part.id} part={part} onQuantity={(quantity) => setQuantity(part, quantity)}
              onEdit={() => editPart(part)} onRemove={() => removePart(part)} />
          ))}
        </div>
      </div>
    </ModalDialog>
  );
}

function PartRow({ part, onQuantity, onEdit, onRemove }: {
  part: Part;
  onQuantity: (quantity: number) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const quantity = Number(part.quantity) || 0;
  const lowAt = Number(part.low_stock) || 0;
  const isLow = quantity <= lowAt;
  // Typed quantities save on change (blur or Enter), like the stepper buttons.
  const [typed, setTyped] = useState(String(quantity));
  useEffect(() => setTyped(String(quantity)), [quantity]);
  const commitTyped = () => {
    const next = Math.max(0, Math.floor(Number(typed) || 0));
    if (next !== quantity) onQuantity(next);
    else setTyped(String(quantity));
  };

  return (
    <div className={`parts-stock-item${isLow ? ' is-low' : ''}`} data-part-id={part.id}>
      <div className="parts-stock-item-body">
        <div className="parts-stock-item-name" title={part.name}>{part.name}</div>
        <div className="parts-stock-item-meta">
          {part.category && <span className="parts-stock-tag category">{part.category}</span>}
          <span className="parts-stock-tag">{part.unit || 'pcs'}</span>
          {isLow && <span className="parts-stock-low-badge" title={`Low stock alert (threshold: ${lowAt})`}>⚠️ Low stock</span>}
          {part.notes && <span className="parts-stock-notes-text" title={part.notes}>{part.notes}</span>}
        </div>
      </div>
      <div className="parts-stock-qty">
        <button type="button" className="parts-stock-step" title="Remove one" aria-label="Decrease quantity"
          onClick={() => onQuantity(Math.max(0, quantity - 1))}>−</button>
        <input type="number" className="parts-stock-qty-input" min="0" max="1000000" step="1" aria-label="Quantity on hand"
          value={typed} onChange={(event) => setTyped(event.target.value)} onBlur={commitTyped}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTyped(); } }} />
        <button type="button" className="parts-stock-step" title="Add one" aria-label="Increase quantity"
          onClick={() => onQuantity(quantity + 1)}>+</button>
      </div>
      <button type="button" className="parts-stock-edit" title="Edit part details" onClick={onEdit}>Edit</button>
      <button type="button" className="parts-stock-remove" title="Remove from Parts Stock" aria-label="Delete part" onClick={onRemove}>×</button>
    </div>
  );
}
