import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { catalogSources, type CatalogFilament } from '../api';
import { Button } from '../components/Button';
import { fromTemperatureInput, fromWeightInput, temperatureLabel, toTemperatureInput, toWeightInput, weightInputUnit } from '../units';
import { showMessage } from '../page';
import { Field, FormModal, MATERIALS, text, useSave } from './SpoolDialogs';
import { numberOrNull } from './format';

/*
 * Add a filament to the catalogue, or change or delete one (src/core/filament-catalog.js; editors).
 * One changed here keeps its details when its source is updated; one deleted stays out of it.
 */

const SOURCE_NAMES: Record<string, string> = { '3dfilamentprofiles': '3dfilamentprofiles.com', spoolmandb: 'SpoolmanDB' };

export function CatalogFilamentForm({
  filament,
  start,
  onClose,
  onSaved
}: {
  filament?: CatalogFilament | null;
  /** What a new one starts with (the words searched for). */
  start?: { brand?: string; material?: string; name?: string };
  onClose: () => void;
  onSaved: (saved: CatalogFilament | null) => void;
}) {
  const [form, setForm] = useState({
    brand: filament?.brand ?? start?.brand ?? '',
    material: filament?.material ?? start?.material ?? '',
    name: filament?.name ?? start?.name ?? '',
    color_name: text(filament?.color_name),
    color_hex: text(filament?.color_hex),
    diameter: text(filament?.diameter ?? 1.75),
    weight: toWeightInput(filament?.weight ?? 1000),
    spool_weight: toWeightInput(filament?.spool_weight),
    density: text(filament?.density),
    print_temp_min: toTemperatureInput(filament?.print_temp_min),
    print_temp_max: toTemperatureInput(filament?.print_temp_max),
    bed_temp_min: toTemperatureInput(filament?.bed_temp_min),
    bed_temp_max: toTemperatureInput(filament?.bed_temp_max),
    product_url: text(filament?.product_url)
  });
  const { busy, error, run } = useSave();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const save = () =>
    run(
      async () => {
        const saved = await catalogSources.saveFilament({
          id: filament?.id,
          brand: form.brand,
          material: form.material,
          name: form.name,
          color_name: form.color_name || null,
          color_hex: form.color_hex || null,
          diameter: numberOrNull(form.diameter),
          weight: fromWeightInput(form.weight),
          spool_weight: fromWeightInput(form.spool_weight),
          density: numberOrNull(form.density),
          print_temp_min: fromTemperatureInput(form.print_temp_min),
          print_temp_max: fromTemperatureInput(form.print_temp_max),
          bed_temp_min: fromTemperatureInput(form.bed_temp_min),
          bed_temp_max: fromTemperatureInput(form.bed_temp_max),
          product_url: form.product_url || null
        });
        onSaved(saved);
      },
      () => {}
    );
  const remove = async () => {
    if (!filament) return;
    const answer = await showMessage(
      'Delete from the catalogue?',
      `Take ${filament.brand} · ${filament.name} out of the catalogue? Filaments and spools already added from it stay.${
        filament.sources.length ? ' Updates of its source will not bring it back.' : ''
      }`,
      ['Delete', 'Cancel']
    );
    if (answer !== 'Delete') return;
    await run(
      async () => {
        await catalogSources.deleteFilament(filament.id);
        onSaved(null);
      },
      () => {}
    );
  };
  const temp = temperatureLabel();
  return (
    <FormModal
      id="jp-catalog-filament"
      title={filament ? 'Change catalogue filament' : 'Add to the catalogue'}
      onClose={onClose}
      onSubmit={() => void save()}
      saveLabel={filament ? 'Save' : 'Add to catalogue'}
      busy={busy}
      error={error}
      wide
    >
      <p className="jp-meta jp-catalog-form__from">
        {filament
          ? filament.sources.length
            ? `From ${filament.sources.map((source) => SOURCE_NAMES[source] || source).join(' and ')}. ${
                filament.edited ? 'Changed here, so updates leave it as it is.' : 'Saving a change keeps it as you leave it when its source is updated.'
              }`
            : 'Added by hand: updates never change it.'
          : 'Everyone on this library can then add it with Add from catalogue. Updates of the catalogue never change it.'}
      </p>
      <div className="jp-edit__grid">
        <Field label="Brand" htmlFor="jp-catalog-filament-brand">
          <input id="jp-catalog-filament-brand" className="jp-input" value={form.brand} onChange={set('brand')} required autoFocus={!filament} />
        </Field>
        <Field label="Material" htmlFor="jp-catalog-filament-material" hint="With its kind: PLA Silk, PETG HF, TPU 95A…">
          <input
            id="jp-catalog-filament-material"
            className="jp-input"
            list="jp-catalog-filament-materials"
            value={form.material}
            onChange={set('material')}
            required
          />
          <datalist id="jp-catalog-filament-materials">
            {MATERIALS.map((material) => (
              <option key={material} value={material} />
            ))}
          </datalist>
        </Field>
        <Field label="Name" htmlFor="jp-catalog-filament-name" hint="Usually the color, as the brand calls it.">
          <input id="jp-catalog-filament-name" className="jp-input" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Color name" htmlFor="jp-catalog-filament-color-name">
          <input id="jp-catalog-filament-color-name" className="jp-input" value={form.color_name} onChange={set('color_name')} />
        </Field>
        <Field label="Color" htmlFor="jp-catalog-filament-color" hint="#rrggbb, or pick one.">
          <span className="jp-filament-form__color">
            <input
              type="color"
              aria-label="Pick a color"
              value={/^#[0-9a-f]{6}$/i.test(form.color_hex) ? form.color_hex : '#9aa4b4'}
              onChange={set('color_hex')}
            />
            <input id="jp-catalog-filament-color" className="jp-input" value={form.color_hex} onChange={set('color_hex')} placeholder="#2f6fdf" />
          </span>
        </Field>
        <Field label="Diameter (mm)" htmlFor="jp-catalog-filament-diameter">
          <input id="jp-catalog-filament-diameter" className="jp-input" inputMode="decimal" value={form.diameter} onChange={set('diameter')} />
        </Field>
        <Field label={`Holds (${weightInputUnit()})`} htmlFor="jp-catalog-filament-weight" hint="Filament on a full spool.">
          <input id="jp-catalog-filament-weight" className="jp-input" inputMode="decimal" value={form.weight} onChange={set('weight')} />
        </Field>
        <Field label={`Empty spool (${weightInputUnit()})`} htmlFor="jp-catalog-filament-tare">
          <input id="jp-catalog-filament-tare" className="jp-input" inputMode="decimal" value={form.spool_weight} onChange={set('spool_weight')} />
        </Field>
        <Field label="Density (g/cm³)" htmlFor="jp-catalog-filament-density">
          <input id="jp-catalog-filament-density" className="jp-input" inputMode="decimal" value={form.density} onChange={set('density')} />
        </Field>
        <Field label={`Nozzle (${temp})`} htmlFor="jp-catalog-filament-nozzle-min" hint="From – to.">
          <span className="jp-catalog-form__range">
            <input id="jp-catalog-filament-nozzle-min" className="jp-input" inputMode="numeric" value={form.print_temp_min} onChange={set('print_temp_min')} />
            <input aria-label="Nozzle up to" className="jp-input" inputMode="numeric" value={form.print_temp_max} onChange={set('print_temp_max')} />
          </span>
        </Field>
        <Field label={`Bed (${temp})`} htmlFor="jp-catalog-filament-bed-min" hint="From – to.">
          <span className="jp-catalog-form__range">
            <input id="jp-catalog-filament-bed-min" className="jp-input" inputMode="numeric" value={form.bed_temp_min} onChange={set('bed_temp_min')} />
            <input aria-label="Bed up to" className="jp-input" inputMode="numeric" value={form.bed_temp_max} onChange={set('bed_temp_max')} />
          </span>
        </Field>
        <Field label="Product page" htmlFor="jp-catalog-filament-url" wide>
          <input id="jp-catalog-filament-url" className="jp-input" type="url" value={form.product_url} onChange={set('product_url')} placeholder="https://" />
        </Field>
      </div>
      {filament && (
        <p className="jp-catalog-form__delete">
          <Button variant="danger" size="sm" icon={Trash2} onClick={() => void remove()} disabled={busy}>
            Delete from catalogue
          </Button>
        </p>
      )}
    </FormModal>
  );
}
