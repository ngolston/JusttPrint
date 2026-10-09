import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { parts as partApi, type Part, type PartInput } from './api';
import { Minus, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Badge, StatusBadge } from './components/Badge';
import { Button, IconButton, cx } from './components/Button';
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
    const reloadIfOpen = () => {
      if (dialogRef.current?.open) void load();
    };
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
    const answer = await showMessage('Remove Part', `Remove "${part.name}" from Parts Stock? Older print logs keep the part name. Stock is not restored.`, [
      'Remove',
      'Cancel'
    ]);
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
      if (event.key === 'Enter') {
        event.preventDefault();
        void saveForm();
      }
    }
  });

  const term = search.trim().toLowerCase();
  const shown = allParts
    .filter((part) => !term || `${part.name || ''} ${part.category || ''} ${part.notes || ''} ${part.unit || ''}`.toLowerCase().includes(term))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const editing = form.id !== undefined;

  return (
    <ModalDialog
      id="parts-stock-dialog"
      title="Parts Manager"
      dialogRef={dialogRef}
      fullscreenToggle
      plain
      className="jp-mgr"
      headerClassName="jp-mgr__header"
      headerRowClassName="jp-mgr__header-row"
      footerClassName="jp-mgr__footer"
      description={
        <p className="jp-meta">Screws, bearings, inserts and other hardware. When you log a print, choose the parts it used and they come off the stock.</p>
      }
      footer={
        <Button id="parts-stock-close" onClick={() => dialogRef.current?.close()}>
          Close
        </Button>
      }
    >
      <div className="jp-mgr__body">
        <section className="jp-mgr__section" id="parts-stock-form-section">
          <div className="jp-mgr__section-head">
            <h4 id="parts-stock-form-label" className="jp-mgr__section-title">
              {editing ? `Edit ${form.name}` : formOpen ? 'Add a part' : 'Parts'}
            </h4>
            <Button
              id="parts-stock-toggle-add-btn"
              size="sm"
              variant={formOpen ? 'ghost' : 'primary'}
              icon={formOpen ? X : Plus}
              aria-expanded={formOpen}
              onClick={() => (formOpen ? closeForm() : setFormOpen(true))}
            >
              {formOpen ? 'Cancel' : 'Add Part'}
            </Button>
          </div>
          <div id="parts-stock-form-body" className="jp-mgr__form" hidden={!formOpen}>
            <div className="jp-mgr__grid">
              <label className="jp-mgr__field is-wide">
                <span className="jp-label">
                  Name <span className="jp-mgr__required">*</span>
                </span>
                <input
                  type="text"
                  id="parts-stock-name"
                  className="jp-input"
                  ref={nameRef}
                  placeholder="e.g. M3×8 screw, 608 bearing"
                  autoComplete="off"
                  {...field('name')}
                />
              </label>
              <label className="jp-mgr__field">
                <span className="jp-label">Category</span>
                <input
                  type="text"
                  id="parts-stock-category"
                  className="jp-input"
                  list="parts-stock-categories"
                  placeholder="e.g. Screws"
                  autoComplete="off"
                  {...field('category')}
                />
              </label>
              <label className="jp-mgr__field">
                <span className="jp-label">Unit</span>
                <input type="text" id="parts-stock-unit" className="jp-input" placeholder="pcs" autoComplete="off" {...field('unit')} />
              </label>
              <label className="jp-mgr__field">
                <span className="jp-label">Quantity on hand</span>
                <input type="number" id="parts-stock-quantity" className="jp-input" min="0" max="1000000" step="1" {...field('quantity')} />
              </label>
              <label className="jp-mgr__field">
                <span className="jp-label">Warn at or below</span>
                <input
                  type="number"
                  id="parts-stock-low"
                  className="jp-input"
                  min="0"
                  max="1000000"
                  step="1"
                  title="Show Low stock when the quantity is at or below this number"
                  {...field('lowStock')}
                />
              </label>
              <label className="jp-mgr__field is-wide">
                <span className="jp-label">Notes</span>
                <input type="text" id="parts-stock-notes" className="jp-input" placeholder="e.g. bin number or size" autoComplete="off" {...field('notes')} />
              </label>
            </div>
            <datalist id="parts-stock-categories">
              {CATEGORIES.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
            <div className="jp-mgr__actions">
              <Button id="parts-stock-add" variant="primary" onClick={saveForm}>
                {editing ? 'Save' : 'Add'}
              </Button>
              <Button
                id="parts-stock-cancel-edit"
                variant="ghost"
                onClick={() => {
                  closeForm();
                  setStatus({ text: '', error: false });
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
          <div id="parts-stock-status" className={cx('jp-mgr__status', status.error && 'is-error')} role="status">
            {status.text}
          </div>
        </section>
        <section className="jp-mgr__section">
          <div className="jp-mgr__toolbar">
            <div className="input-with-icon jp-mgr__search">
              <input
                type="text"
                id="parts-stock-search"
                className="jp-input"
                placeholder="Search parts"
                aria-label="Search parts"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" id="parts-stock-clear-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>
                ×
              </button>
            </div>
            <span id="parts-stock-count-badge" className="jp-meta">
              {shown.length ? `${shown.length} part${shown.length === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          <div id="parts-stock-list" className="jp-mgr__list">
            {loadError ? (
              <div className="jp-mgr__empty">Failed to load parts: {loadError}</div>
            ) : shown.length === 0 ? (
              <div className="jp-mgr__empty">
                <Package size={28} aria-hidden="true" />
                <span>{term ? 'No parts match that search.' : 'No parts yet. Add screws, bearings, inserts and anything else a print uses up.'}</span>
              </div>
            ) : (
              shown.map((part) => (
                <PartRow
                  key={part.id}
                  part={part}
                  onQuantity={(quantity) => setQuantity(part, quantity)}
                  onEdit={() => editPart(part)}
                  onRemove={() => removePart(part)}
                />
              ))
            )}
          </div>
        </section>
      </div>
    </ModalDialog>
  );
}

function PartRow({ part, onQuantity, onEdit, onRemove }: { part: Part; onQuantity: (quantity: number) => void; onEdit: () => void; onRemove: () => void }) {
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
    <div className={cx('jp-mgr__row parts-stock-item', isLow && 'is-low')} data-part-id={part.id}>
      <div className="jp-mgr__row-main">
        <span className="jp-mgr__name" title={part.name}>
          {part.name}
        </span>
        <div className="jp-mgr__tags">
          {part.category && <Badge>{part.category}</Badge>}
          <span className="jp-meta">{part.unit || 'pcs'}</span>
          {isLow && (
            <span title={`Low stock (warns at ${lowAt})`}>
              <StatusBadge tone="warning">Low stock</StatusBadge>
            </span>
          )}
          {part.notes && (
            <span className="jp-meta" title={part.notes}>
              {part.notes}
            </span>
          )}
        </div>
      </div>
      <div className="jp-mgr__qty">
        <IconButton size="sm" icon={Minus} className="parts-stock-step" label="Decrease quantity" onClick={() => onQuantity(Math.max(0, quantity - 1))} />
        <input
          type="number"
          className="jp-input parts-stock-qty-input"
          min="0"
          max="1000000"
          step="1"
          aria-label="Quantity on hand"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={commitTyped}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitTyped();
            }
          }}
        />
        <IconButton size="sm" icon={Plus} className="parts-stock-step" label="Increase quantity" onClick={() => onQuantity(quantity + 1)} />
      </div>
      <div className="jp-mgr__row-actions">
        <Button size="sm" icon={Pencil} className="parts-stock-edit" title="Edit part details" onClick={onEdit}>
          Edit
        </Button>
        <IconButton size="sm" icon={Trash2} className="parts-stock-remove" label="Delete part" onClick={onRemove} />
      </div>
    </div>
  );
}
