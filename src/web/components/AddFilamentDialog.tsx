import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { filaments as filamentApi, type Filament } from '../api';
import { normalizeColorHex } from '../filaments';
import { refreshFilamentPickers } from '../page';
import { Button } from './Button';
import { Modal } from './Overlay';

const EMPTY = { name: '', vendor: '', material: '', color: '', diameter: '1.75' };

let open: ((resolve: (filament: Filament | null) => void) => void) | null = null;

/** Add a filament to the catalog. Resolves to the new filament, or null when cancelled. */
export function addFilament(): Promise<Filament | null> {
  return new Promise((resolve) => {
    if (open) open(resolve);
    else resolve(null);
  });
}

/** The Add Filament dialog (#add-filament-dialog). Mounted once in main.tsx. */
export function AddFilamentDialog() {
  const [isOpen, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef<((filament: Filament | null) => void) | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    open = (resolve) => {
      pending.current?.(null);
      pending.current = resolve;
      setForm(EMPTY);
      setError('');
      setOpen(true);
      requestAnimationFrame(() => nameRef.current?.focus());
    };
    return () => { open = null; };
  }, []);

  const finish = (filament: Filament | null) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(filament);
  };

  async function save(event?: FormEvent | KeyboardEvent) {
    event?.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setError('Enter a name.');
      nameRef.current?.focus();
      return;
    }
    const typedColor = form.color.trim();
    if (typedColor && !normalizeColorHex(typedColor)) {
      setError('Enter the color as a hex code, such as 1A2B3C, or pick it.');
      return;
    }
    const diameter = form.diameter.trim() === '' ? 1.75 : Number(form.diameter);
    setSaving(true);
    try {
      const saved = await filamentApi.save({
        name,
        vendor: form.vendor.trim(),
        material: form.material.trim(),
        color_hex: normalizeColorHex(typedColor),
        diameter: Number.isFinite(diameter) && diameter > 0 ? diameter : 1.75
      });
      await refreshFilamentPickers();
      finish(saved);
    } catch (saveError) {
      setError((saveError as Error)?.message || 'Could not add the filament.');
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof typeof EMPTY) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [key]: event.target.value }))
  });
  const swatch = normalizeColorHex(form.color);

  return (
    <Modal open={isOpen} onClose={() => finish(null)} title="Add Filament" className="jp-add-filament"
      footer={(
        <>
          <Button variant="secondary" onClick={() => finish(null)}>Cancel</Button>
          <Button id="add-filament-save" variant="primary" disabled={saving} onClick={() => save()}>{saving ? 'Adding…' : 'Add Filament'}</Button>
        </>
      )}>
      <form id="add-filament-dialog" className="jp-add-filament__form" onSubmit={save} noValidate
        onKeyDown={(event) => {
          // Enter in a text field adds the filament.
          if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') void save(event);
        }}>
        <label className="jp-add-filament__field jp-add-filament__wide">
          <span>Name</span>
          <input ref={nameRef} id="add-filament-name" className="jp-input" autoComplete="off" placeholder="PolyTerra Charcoal Black" {...field('name')} />
        </label>
        <label className="jp-add-filament__field">
          <span>Vendor</span>
          <input id="add-filament-vendor" className="jp-input" autoComplete="off" placeholder="Polymaker" {...field('vendor')} />
        </label>
        <label className="jp-add-filament__field">
          <span>Material</span>
          <input id="add-filament-material" className="jp-input" autoComplete="off" placeholder="PLA" {...field('material')} />
        </label>
        <div className="jp-add-filament__field">
          <label htmlFor="add-filament-color">Color</label>
          <div className="jp-add-filament__color">
            <input type="color" id="add-filament-color-picker" aria-label="Pick a color" value={`#${swatch || '808080'}`}
              onChange={(event) => setForm((previous) => ({ ...previous, color: event.target.value.replace('#', '').toUpperCase() }))} />
            <input id="add-filament-color" className="jp-input" autoComplete="off" spellCheck={false} placeholder="Hex, such as 1A2B3C" {...field('color')} />
          </div>
        </div>
        <label className="jp-add-filament__field">
          <span>Diameter (mm)</span>
          <input id="add-filament-diameter" className="jp-input" type="number" min="0.1" step="0.05" {...field('diameter')} />
        </label>
        {error && <p id="add-filament-error" className="jp-add-filament__error jp-add-filament__wide" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
