import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { fromTemperatureInput, fromWeightInput, temperatureLabel, toTemperatureInput, toWeightInput, weightInputUnit, weightUnitName } from '../units';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  filament,
  type CatalogFilament,
  type FilamentBrand,
  type FilamentProfile,
  type Spool,
  type SpoolInput,
  type SpoolmanImport,
  type StorageLocation
} from '../api';
import { Button, IconButton, cx } from '../components/Button';
import { ColorDot } from '../components/Filament';
import { Modal } from '../components/Overlay';
import { showMessage } from '../page';
import { formatWeight, numberOrNull } from './format';

/*
 * The Filament page's forms (docs/merge-10.md, Phase 3): a spool, weighing, drying, moving, the
 * catalogue, the Spoolman import and the places. Each saves through the API, which tells the page
 * to reload (jp:library-changed), then closes.
 */

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function Field({ label, htmlFor, hint, wide, children }: { label: string; htmlFor?: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cx('jp-edit__field', wide && 'jp-edit__field--wide')}>
      <label className="jp-edit__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="jp-edit__hint">{hint}</p>}
    </div>
  );
}

/** A form inside a modal: Enter saves, the footer has Cancel and the save button, errors show above it. */
export function FormModal({
  id,
  title,
  onClose,
  onSubmit,
  saveLabel,
  busy,
  error,
  children,
  wide
}: {
  id: string;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  saveLabel: string;
  busy: boolean;
  error: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) onSubmit();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      id={id}
      className={cx('jp-filament-form', wide && 'jp-filament-form--wide')}
      footer={
        <>
          {error && (
            <p className="jp-filament-form__error" role="alert">
              {error}
            </p>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={`${id}-form`} disabled={busy}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} noValidate>
        {children}
      </form>
    </Modal>
  );
}

/** Runs a save: busy while it runs, its error shown, `onDone` after it worked. */
export function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (work: () => Promise<unknown>, onDone: () => void) => {
    setBusy(true);
    setError('');
    try {
      await work();
      onDone();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PCTG', 'HIPS', 'PVA', 'PET', 'PP'];
export const text = (value: string | number | null | undefined) => (value === null || value === undefined ? '' : String(value));
const dateInput = (value: string | null | undefined) => (value ? String(value).slice(0, 10) : '');

/** What the spool form starts from when it adds a spool from a catalogue entry. */
export interface SpoolPreset {
  profile: FilamentProfile;
  entry?: CatalogFilament;
  materialType?: string | null;
}

/** Add a spool (no `spool`) or edit one. */
export function SpoolFormDialog({ spool, preset, onClose }: { spool?: Spool | null; preset?: SpoolPreset | null; onClose: () => void }) {
  const [profiles, setProfiles] = useState<FilamentProfile[]>(preset ? [preset.profile] : []);
  const [brands, setBrands] = useState<FilamentBrand[]>([]);
  const [places, setPlaces] = useState<StorageLocation[]>([]);
  const start = preset?.profile;
  const holds = preset?.entry?.weight ?? 1000;
  const [form, setForm] = useState(() => ({
    profile_id: text(spool?.profile_id ?? start?.id),
    name: text(spool?.name),
    brand_name: text(spool?.brand_name ?? start?.brand_name),
    material: text(spool?.material ?? start?.material),
    material_type: text(spool?.material_type ?? preset?.materialType),
    color_hex: text(spool?.color_hex ?? start?.color_hex),
    // Weights in the library's unit (units.ts); grams again when saved.
    initial_weight: toWeightInput(spool?.initial_weight ?? holds),
    remaining: toWeightInput(spool ? Math.round(spool.remaining * 10) / 10 : holds),
    spool_weight: toWeightInput(spool?.spool_weight ?? preset?.entry?.spool_weight),
    location_id: text(spool?.location_id),
    status: spool?.status ?? 'storage',
    purchase_price: text(spool?.purchase_price),
    supplier: text(spool?.supplier),
    purchase_date: dateInput(spool?.purchase_date),
    lot_nr: text(spool?.lot_nr),
    product_url: text(spool?.product_url ?? start?.product_url),
    notes: text(spool?.notes)
  }));
  const { busy, error, run } = useSave();

  useEffect(() => {
    filament.profiles().then(setProfiles, () => {});
    filament.brands().then(setBrands, () => {});
    filament.locations().then(setPlaces, () => {});
  }, []);

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((previous) => ({ ...previous, [key]: event.target.value }));
  /** Adding: how many of the same spool (docs/plan-10.1.md, Phase 4). */
  const [copies, setCopies] = useState('1');
  const pickProfile = (id: string) => {
    const profile = profiles.find((p) => String(p.id) === id);
    setForm((previous) => ({
      ...previous,
      profile_id: id,
      brand_name: profile?.brand_name ?? previous.brand_name,
      material: profile?.material ?? previous.material,
      color_hex: profile?.color_hex ?? previous.color_hex,
      product_url: previous.product_url || profile?.product_url || ''
    }));
  };

  const save = () =>
    run(async () => {
      const input: SpoolInput = {
        id: spool?.id,
        profile_id: numberOrNull(form.profile_id),
        name: form.name,
        brand_name: form.brand_name,
        material: form.material,
        material_type: form.material_type,
        color_hex: form.color_hex,
        initial_weight: fromWeightInput(form.initial_weight) ?? undefined,
        remaining: fromWeightInput(form.remaining),
        spool_weight: fromWeightInput(form.spool_weight),
        location_id: numberOrNull(form.location_id),
        status: form.status,
        purchase_price: numberOrNull(form.purchase_price),
        supplier: form.supplier,
        purchase_date: form.purchase_date || null,
        lot_nr: form.lot_nr,
        product_url: form.product_url,
        notes: form.notes,
        ...(spool ? {} : { copies: Math.round(numberOrNull(copies) ?? 1) })
      };
      await filament.saveSpool(input);
    }, onClose);

  return (
    <FormModal
      id="jp-spool-form"
      title={spool ? `Edit ${spool.display_name}` : 'Add a spool'}
      onClose={onClose}
      onSubmit={save}
      saveLabel={spool ? 'Save' : Number(copies) > 1 ? `Add ${Math.round(Number(copies))} spools` : 'Add spool'}
      busy={busy}
      error={error}
      wide
    >
      <div className="jp-edit__grid">
        <Field label="Filament" htmlFor="jp-spool-profile" wide hint="Brand, material and color come from it. Add more with Add from catalogue.">
          <select id="jp-spool-profile" className="jp-input" value={form.profile_id} onChange={(event) => pickProfile(event.target.value)}>
            <option value="">None (type them below)</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {[profile.brand_name, profile.name].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Brand" htmlFor="jp-spool-brand">
          <input id="jp-spool-brand" className="jp-input" list="jp-spool-brands" value={form.brand_name} onChange={set('brand_name')} />
          <datalist id="jp-spool-brands">
            {brands.map((brand) => (
              <option key={brand.id} value={brand.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Name" htmlFor="jp-spool-name" hint="Optional: how you call this spool.">
          <input id="jp-spool-name" className="jp-input" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Material" htmlFor="jp-spool-material">
          <input id="jp-spool-material" className="jp-input" list="jp-spool-materials" value={form.material} onChange={set('material')} required />
          <datalist id="jp-spool-materials">
            {MATERIALS.map((material) => (
              <option key={material} value={material} />
            ))}
          </datalist>
        </Field>
        <Field label="Kind" htmlFor="jp-spool-type" hint="Silk, Matte, HF, 95A…">
          <input id="jp-spool-type" className="jp-input" value={form.material_type} onChange={set('material_type')} />
        </Field>
        <Field label="Color" htmlFor="jp-spool-color" hint="#rrggbb, or pick one.">
          <span className="jp-filament-form__color">
            <input
              type="color"
              aria-label="Pick a color"
              value={/^#[0-9a-f]{6}$/i.test(form.color_hex) ? form.color_hex : '#9aa4b4'}
              onChange={set('color_hex')}
            />
            <input id="jp-spool-color" className="jp-input" value={form.color_hex} onChange={set('color_hex')} placeholder="#2f6fdf" />
          </span>
        </Field>
        <Field label="Place" htmlFor="jp-spool-place">
          <select id="jp-spool-place" className="jp-input" value={form.location_id} onChange={set('location_id')}>
            <option value="">No place</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Holds (${weightInputUnit()})`} htmlFor="jp-spool-initial" hint="Filament on a full spool.">
          <input id="jp-spool-initial" className="jp-input" inputMode="decimal" value={form.initial_weight} onChange={set('initial_weight')} />
        </Field>
        <Field label={`Left (${weightInputUnit()})`} htmlFor="jp-spool-remaining" hint="Or weigh it later.">
          <input id="jp-spool-remaining" className="jp-input" inputMode="decimal" value={form.remaining} onChange={set('remaining')} />
        </Field>
        <Field label={`Empty spool (${weightInputUnit()})`} htmlFor="jp-spool-tare" hint="Lets you weigh it on the spool.">
          <input id="jp-spool-tare" className="jp-input" inputMode="decimal" value={form.spool_weight} onChange={set('spool_weight')} />
        </Field>
        {!spool && (
          <Field label="How many" htmlFor="jp-spool-copies" hint="Bought several of the same? Adds each as its own spool.">
            <input
              id="jp-spool-copies"
              className="jp-input"
              type="number"
              min="1"
              max="50"
              value={copies}
              onChange={(event) => setCopies(event.target.value)}
            />
          </Field>
        )}
        <Field label="Status" htmlFor="jp-spool-status">
          <select id="jp-spool-status" className="jp-input" value={form.status} onChange={set('status')}>
            <option value="active">In use</option>
            <option value="storage">In storage</option>
            {spool?.status === 'archived' && <option value="archived">Archived</option>}
          </select>
        </Field>
        <Field label="Price" htmlFor="jp-spool-price">
          <input id="jp-spool-price" className="jp-input" inputMode="decimal" value={form.purchase_price} onChange={set('purchase_price')} />
        </Field>
        <Field label="Bought" htmlFor="jp-spool-bought">
          <input id="jp-spool-bought" className="jp-input" type="date" value={form.purchase_date} onChange={set('purchase_date')} />
        </Field>
        <Field label="Shop" htmlFor="jp-spool-supplier">
          <input id="jp-spool-supplier" className="jp-input" value={form.supplier} onChange={set('supplier')} />
        </Field>
        <Field label="Lot" htmlFor="jp-spool-lot">
          <input id="jp-spool-lot" className="jp-input" value={form.lot_nr} onChange={set('lot_nr')} />
        </Field>
        <Field label="Product page" htmlFor="jp-spool-url" wide>
          <input id="jp-spool-url" className="jp-input" type="url" value={form.product_url} onChange={set('product_url')} placeholder="https://" />
        </Field>
        <Field label="Notes" htmlFor="jp-spool-notes" wide>
          <textarea id="jp-spool-notes" className="jp-input" rows={3} value={form.notes} onChange={set('notes')} />
        </Field>
      </div>
    </FormModal>
  );
}

/** Weigh a spool: on its spool (needs the empty spool's weight) or the filament alone. */
export function WeighDialog({ spool, onClose }: { spool: Spool; onClose: () => void }) {
  const tare = spool.spool_weight;
  const [weight, setWeight] = useState('');
  const [withSpool, setWithSpool] = useState(tare !== null);
  const [notes, setNotes] = useState('');
  const { busy, error, run } = useSave();
  const measured = fromWeightInput(weight);
  const left = measured === null ? null : Math.max(0, withSpool && tare !== null ? measured - tare : measured);
  const save = () =>
    run(async () => {
      if (measured === null) throw new Error(`Enter what the scale shows (${weightUnitName().toLowerCase()})`);
      await filament.weigh(spool.id, { weight: measured, withSpool, notes });
    }, onClose);
  return (
    <FormModal id="jp-weigh-form" title={`Weigh ${spool.display_name}`} onClose={onClose} onSubmit={save} saveLabel="Save weight" busy={busy} error={error}>
      <div className="jp-edit__grid">
        <Field label={`The scale shows (${weightInputUnit()})`} htmlFor="jp-weigh-weight" wide>
          <input id="jp-weigh-weight" className="jp-input" inputMode="decimal" autoFocus value={weight} onChange={(event) => setWeight(event.target.value)} />
        </Field>
        <label className="jp-filament-form__check jp-edit__field--wide">
          <input type="checkbox" checked={withSpool} disabled={tare === null} onChange={(event) => setWithSpool(event.target.checked)} />
          {tare === null ? 'With the spool (enter the empty spool’s weight under Edit first)' : `With the spool (the empty spool weighs ${formatWeight(tare)})`}
        </label>
        <Field label="Note" htmlFor="jp-weigh-notes" wide>
          <input id="jp-weigh-notes" className="jp-input" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <p className="jp-meta jp-edit__field--wide" aria-live="polite">
          {left === null ? `Now ${formatWeight(spool.remaining)} left.` : `That is ${formatWeight(left)} of filament (was ${formatWeight(spool.remaining)}).`}
        </p>
      </div>
    </FormModal>
  );
}

/** Start drying a spool, with its filament's drying settings filled in. */
export function DryDialog({ spool, onClose }: { spool: Spool; onClose: () => void }) {
  const [temp, setTemp] = useState(toTemperatureInput(spool.profile_drying_temp));
  const [hours, setHours] = useState(text(spool.profile_drying_hours));
  const [humidity, setHumidity] = useState('');
  const { busy, error, run } = useSave();
  const save = () =>
    run(
      () =>
        filament.startDrying(spool.id, { drying_temp: fromTemperatureInput(temp), target_hours: numberOrNull(hours), humidity_before: numberOrNull(humidity) }),
      onClose
    );
  return (
    <FormModal id="jp-dry-form" title={`Dry ${spool.display_name}`} onClose={onClose} onSubmit={save} saveLabel="Start drying" busy={busy} error={error}>
      <div className="jp-edit__grid">
        <Field label={`Temperature (${temperatureLabel()})`} htmlFor="jp-dry-temp">
          <input id="jp-dry-temp" className="jp-input" inputMode="numeric" autoFocus value={temp} onChange={(event) => setTemp(event.target.value)} />
        </Field>
        <Field label="Hours" htmlFor="jp-dry-hours">
          <input id="jp-dry-hours" className="jp-input" inputMode="decimal" value={hours} onChange={(event) => setHours(event.target.value)} />
        </Field>
        <Field label="Humidity before (%)" htmlFor="jp-dry-humidity" hint="Optional.">
          <input id="jp-dry-humidity" className="jp-input" inputMode="decimal" value={humidity} onChange={(event) => setHumidity(event.target.value)} />
        </Field>
      </div>
    </FormModal>
  );
}

/** Take a spool out of the dryer, with the humidity after if measured. */
export function FinishDryingDialog({ sessionId, name, onClose }: { sessionId: number; name: string; onClose: () => void }) {
  const [humidity, setHumidity] = useState('');
  const { busy, error, run } = useSave();
  const save = () => run(() => filament.finishDrying(sessionId, { humidity_after: numberOrNull(humidity) }), onClose);
  return (
    <FormModal id="jp-finish-dry-form" title={`${name} is dry`} onClose={onClose} onSubmit={save} saveLabel="Finish drying" busy={busy} error={error}>
      <Field label="Humidity after (%)" htmlFor="jp-finish-dry-humidity" hint="Optional.">
        <input
          id="jp-finish-dry-humidity"
          className="jp-input"
          inputMode="decimal"
          autoFocus
          value={humidity}
          onChange={(event) => setHumidity(event.target.value)}
        />
      </Field>
    </FormModal>
  );
}

/** Put a spool in a place, or a new place. */
export function MoveDialog({ spool, onClose }: { spool: Spool; onClose: () => void }) {
  const [places, setPlaces] = useState<StorageLocation[]>([]);
  const [placeId, setPlaceId] = useState(text(spool.location_id));
  const [newPlace, setNewPlace] = useState('');
  const { busy, error, run } = useSave();
  useEffect(() => {
    filament.locations().then(setPlaces, () => {});
  }, []);
  const save = () =>
    run(async () => {
      let target = numberOrNull(placeId);
      if (newPlace.trim()) target = (await filament.saveLocation({ name: newPlace })).id;
      await filament.move(spool.id, target);
    }, onClose);
  return (
    <FormModal id="jp-move-form" title={`Move ${spool.display_name}`} onClose={onClose} onSubmit={save} saveLabel="Move" busy={busy} error={error}>
      <div className="jp-edit__grid">
        <Field label="Place" htmlFor="jp-move-place" wide>
          <select id="jp-move-place" className="jp-input" value={placeId} onChange={(event) => setPlaceId(event.target.value)} disabled={!!newPlace.trim()}>
            <option value="">No place</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Or a new place" htmlFor="jp-move-new" wide hint="Shelf 2, Dry box A…">
          <input id="jp-move-new" className="jp-input" value={newPlace} onChange={(event) => setNewPlace(event.target.value)} />
        </Field>
      </div>
    </FormModal>
  );
}

/** Search the bundled catalogue; choosing a filament adds it as a profile and opens the spool form. */
export function CatalogDialog({ onClose, onPicked }: { onClose: () => void; onPicked: (preset: SpoolPreset) => void }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ total: number; items: CatalogFilament[]; source: string; fetchedAt: string | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const words = query.trim();
    if (!words) {
      setResult(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      filament.searchCatalog(words, 60).then(
        (found) => alive && setResult(found),
        (failure) => alive && setError(errorText(failure))
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);
  const pick = async (item: CatalogFilament) => {
    try {
      const added = await filament.addFromCatalog(item.id);
      onPicked({ profile: added.profile, entry: added.entry, materialType: added.materialType });
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const snapshot = result?.fetchedAt ? new Date(result.fetchedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '';
  return (
    <Modal open onClose={onClose} title="Add from catalogue" id="jp-catalog-dialog" className="jp-filament-form jp-filament-form--wide">
      <label className="jp-catalog__search">
        <Search size={16} aria-hidden="true" />
        <span className="jp-sr-only">Search the filament catalogue</span>
        <input
          id="jp-catalog-search"
          className="jp-input"
          type="search"
          autoFocus
          placeholder="Brand, material, color: bambu pla basic black"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error && (
        <p className="jp-filament-form__error" role="alert">
          {error}
        </p>
      )}
      <p className="jp-meta" aria-live="polite">
        {!result
          ? 'About 27,000 filaments from 3dfilamentprofiles.com.'
          : `${result.total.toLocaleString()} ${result.total === 1 ? 'filament' : 'filaments'}${result.total > result.items.length ? `, the first ${result.items.length} shown` : ''}`}
        {snapshot && ` · Catalogue from ${snapshot}`}
      </p>
      {result && result.items.length > 0 && (
        <ul className="jp-catalog__list" aria-label="Catalogue filaments">
          {result.items.map((item) => (
            <li key={item.id}>
              <button type="button" className="jp-catalog__item" onClick={() => void pick(item)}>
                <ColorDot color={item.color_hex || '#9aa4b4'} size={22} />
                <span className="jp-catalog__text">
                  <span className="jp-catalog__name">
                    {item.brand} · {item.name}
                  </span>
                  <span className="jp-catalog__meta">
                    {[item.material, item.diameter ? `${item.diameter} mm` : '', item.weight ? formatWeight(item.weight) : ''].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <Plus size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Upload a Spoolman export; shows what came in. */
export function SpoolmanDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [done, setDone] = useState<SpoolmanImport | null>(null);
  const { busy, error, run } = useSave();
  const save = () =>
    run(
      async () => {
        if (!file) throw new Error('Choose the file Spoolman exported');
        let data: unknown;
        try {
          data = JSON.parse(await file.text());
        } catch {
          throw new Error('That file is not JSON. Export the spools from Spoolman as JSON.');
        }
        setDone(await filament.importSpoolman(data));
      },
      () => {}
    );
  if (done) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Imported from Spoolman"
        id="jp-spoolman-dialog"
        className="jp-filament-form"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p id="jp-spoolman-result">
          {done.imported} {done.imported === 1 ? 'spool' : 'spools'} imported
          {done.alreadyHere ? `, ${done.alreadyHere} already here` : ''}
          {done.skipped ? `, ${done.skipped} could not be read` : ''}.
          {done.brands + done.profiles + done.locations > 0 && ` New: ${done.brands} brands, ${done.profiles} filaments, ${done.locations} places.`}
        </p>
        {done.problems.length > 0 && (
          <ul className="jp-meta">
            {done.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </Modal>
    );
  }
  return (
    <FormModal id="jp-spoolman" title="Import from Spoolman" onClose={onClose} onSubmit={save} saveLabel="Import" busy={busy} error={error}>
      <p className="jp-meta">
        In Spoolman, export the spools as JSON (or save what <code>/api/v1/spool</code> returns). Vendors become brands, filaments become filaments here,
        locations become places. Importing the same file again skips the spools already here.
      </p>
      <Field label="Spoolman file" htmlFor="jp-spoolman-file">
        <input id="jp-spoolman-file" type="file" accept=".json,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      </Field>
    </FormModal>
  );
}

/** The places spools are kept: add, rename, delete. */
export function PlacesDialog({ onClose }: { onClose: () => void }) {
  const [places, setPlaces] = useState<StorageLocation[] | null>(null);
  const [name, setName] = useState('');
  const [dryBox, setDryBox] = useState(false);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState('');
  const reload = () => filament.locations().then(setPlaces, (failure) => setError(errorText(failure)));
  useEffect(() => {
    void reload();
  }, []);
  const attempt = async (work: () => Promise<unknown>) => {
    setError('');
    try {
      await work();
      await reload();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      await filament.saveLocation({ name, is_dry_box: dryBox });
      setName('');
      setDryBox(false);
    });
  };
  const remove = async (place: StorageLocation) => {
    const count = place.spool_count || 0;
    const answer = await showMessage(
      'Delete place?',
      `Delete ${place.name}?${count ? ` Its ${count} ${count === 1 ? 'spool is' : 'spools are'} then in no place.` : ''}`,
      ['Delete', 'Cancel']
    );
    if (answer === 'Delete') await attempt(() => filament.removeLocation(place.id));
  };
  const sorted = useMemo(() => places || [], [places]);
  return (
    <Modal open onClose={onClose} title="Places" id="jp-places-dialog" className="jp-filament-form" footer={<Button onClick={onClose}>Done</Button>}>
      {error && (
        <p className="jp-filament-form__error" role="alert">
          {error}
        </p>
      )}
      {places && !places.length && <p className="jp-meta">No places yet. Add the shelves and dry boxes your spools live in.</p>}
      <ul className="jp-places" aria-label="Places">
        {sorted.map((place) => (
          <li key={place.id} className="jp-places__row">
            {editing?.id === place.id ? (
              <form
                className="jp-places__rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  void attempt(async () => {
                    await filament.saveLocation({ id: place.id, name: editing.name, description: place.description, is_dry_box: !!place.is_dry_box });
                    setEditing(null);
                  });
                }}
              >
                <input
                  className="jp-input"
                  aria-label={`New name for ${place.name}`}
                  autoFocus
                  value={editing.name}
                  onChange={(event) => setEditing({ id: place.id, name: event.target.value })}
                />
                <Button type="submit" size="sm" variant="primary">
                  Save
                </Button>
              </form>
            ) : (
              <>
                <span className="jp-places__name">
                  {place.name}
                  {place.is_dry_box ? <span className="jp-badge">Dry box</span> : null}
                </span>
                <span className="jp-meta">
                  {place.spool_count || 0} {place.spool_count === 1 ? 'spool' : 'spools'}
                </span>
                <IconButton size="sm" icon={Pencil} label={`Rename ${place.name}`} onClick={() => setEditing({ id: place.id, name: place.name })} />
                <IconButton size="sm" icon={Trash2} label={`Delete ${place.name}`} onClick={() => void remove(place)} />
              </>
            )}
          </li>
        ))}
      </ul>
      <form className="jp-places__add" onSubmit={add}>
        <input
          className="jp-input"
          aria-label="New place"
          placeholder="New place: Shelf 2, Dry box A…"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label className="jp-filament-form__check">
          <input type="checkbox" checked={dryBox} onChange={(event) => setDryBox(event.target.checked)} />
          Dry box
        </label>
        <Button type="submit" icon={Plus} disabled={!name.trim()}>
          Add
        </Button>
      </form>
    </Modal>
  );
}
