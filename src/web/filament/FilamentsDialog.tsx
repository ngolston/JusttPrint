import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { filament, type FilamentBrand, type FilamentProfile } from '../api';
import { Button, IconButton } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { ColorDot } from '../components/Filament';
import { Modal } from '../components/Overlay';
import { Tabs } from '../components/Tabs';
import { showMessage } from '../page';
import { errorText, Field, FormModal, MATERIALS, text, useSave } from './SpoolDialogs';
import { numberOrNull } from './format';
import { PhotoBlock } from './Photo';

/*
 * Filament page → Filaments (docs/plan-10.1.md, Phase 1): every filament profile (from the
 * catalogue, Spoolman, FilamentHub or added by hand) and every brand. Editors add, change and
 * delete them; viewers see them. Deleting a filament or a brand keeps its spools as they are.
 */

const SOURCE_LABELS: Record<FilamentProfile['source'], string> = { manual: 'Added by hand', catalog: 'Catalogue', spoolman: 'Spoolman' };

const range = (min: number | null, max: number | null, unit: string) => {
  if (min === null && max === null) return '';
  if (min === null || max === null || min === max) return `${min ?? max} ${unit}`;
  return `${min}–${max} ${unit}`;
};

type Tab = 'filaments' | 'brands';

export function FilamentsDialog({
  onClose,
  onEdit,
  onAddSpool
}: {
  onClose: () => void;
  onEdit: (profile: FilamentProfile | null) => void;
  onAddSpool: (profile: FilamentProfile) => void;
}) {
  const [tab, setTab] = useState<Tab>('filaments');
  const [search, setSearch] = useState('');
  const [profiles, setProfiles] = useState<FilamentProfile[] | null>(null);
  const [brands, setBrands] = useState<FilamentBrand[] | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [newBrand, setNewBrand] = useState('');
  const [error, setError] = useState('');

  const reload = () =>
    Promise.all([filament.profiles(), filament.brands()]).then(
      ([p, b]) => {
        setProfiles(p);
        setBrands(b);
      },
      (failure) => setError(errorText(failure))
    );
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

  const shown = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (profiles || []).filter((p) => {
      const hay = [p.brand_name, p.name, p.material, p.color_name].filter(Boolean).join(' ').toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }, [profiles, search]);

  const removeProfile = async (profile: FilamentProfile) => {
    const count = profile.spool_count || 0;
    const answer = await showMessage(
      'Delete filament?',
      `Delete ${[profile.brand_name, profile.name].filter(Boolean).join(' ')}?${count ? ` Its ${count} ${count === 1 ? 'spool keeps' : 'spools keep'} their material and color.` : ''}`,
      ['Delete', 'Cancel']
    );
    if (answer === 'Delete') await attempt(() => filament.removeProfile(profile.id));
  };

  const removeBrand = async (brand: FilamentBrand) => {
    const uses = [
      brand.profile_count && `${brand.profile_count} ${brand.profile_count === 1 ? 'filament' : 'filaments'}`,
      brand.spool_count && `${brand.spool_count} ${brand.spool_count === 1 ? 'spool' : 'spools'}`
    ]
      .filter(Boolean)
      .join(' and ');
    const answer = await showMessage('Delete brand?', `Delete ${brand.name}?${uses ? ` Its ${uses} then have no brand.` : ''}`, ['Delete', 'Cancel']);
    if (answer === 'Delete') await attempt(() => filament.removeBrand(brand.id));
  };

  const rename = (event: FormEvent, brand: FilamentBrand) => {
    event.preventDefault();
    if (!editing) return;
    const target = (brands || []).find((b) => b.id !== brand.id && b.name.toLowerCase() === editing.name.trim().toLowerCase());
    void (async () => {
      if (target && (await showMessage('Merge brands?', `${target.name} already exists. Merge ${brand.name} into it?`, ['Merge', 'Cancel'])) !== 'Merge')
        return;
      await attempt(async () => {
        await filament.saveBrand({ id: brand.id, name: editing.name });
        setEditing(null);
      });
    })();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Filaments"
      id="jp-filaments-dialog"
      className="jp-filament-form jp-filament-form--wide"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="jp-filaments__bar">
        <Tabs<Tab>
          label="Filaments or brands"
          items={[
            { id: 'filaments', label: profiles ? `Filaments (${profiles.length})` : 'Filaments' },
            { id: 'brands', label: brands ? `Brands (${brands.length})` : 'Brands' }
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'filaments' && (
          <EditOnly>
            <Button size="sm" icon={Plus} onClick={() => onEdit(null)} id="jp-filament-new">
              New filament
            </Button>
          </EditOnly>
        )}
      </div>
      {error && (
        <p className="jp-filament-form__error" role="alert">
          {error}
        </p>
      )}

      {tab === 'filaments' && (
        <>
          <label className="jp-catalog__search">
            <Search size={16} aria-hidden="true" />
            <span className="jp-sr-only">Search your filaments</span>
            <input
              id="jp-filaments-search"
              className="jp-input"
              type="search"
              placeholder="Brand, material, color"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {profiles && !profiles.length && (
            <p className="jp-meta">No filaments yet. Adding a spool from the catalogue or Spoolman adds its filament here, or add one with New filament.</p>
          )}
          {profiles && profiles.length > 0 && !shown.length && <p className="jp-meta">No filament matches.</p>}
          <ul className="jp-catalog__list jp-filaments__list" aria-label="Filaments">
            {shown.map((profile) => (
              <li key={profile.id} className="jp-places__row jp-filaments__row">
                {profile.photo ? (
                  <img className="jp-filaments__photo" src={profile.photo} alt="" loading="lazy" />
                ) : (
                  <ColorDot color={profile.color_hex || '#9aa4b4'} size={22} />
                )}
                <span className="jp-catalog__text">
                  <span className="jp-catalog__name">{[profile.brand_name, profile.name].filter(Boolean).join(' · ')}</span>
                  <span className="jp-catalog__meta">
                    {[
                      profile.material,
                      `${profile.diameter} mm`,
                      range(profile.print_temp_min, profile.print_temp_max, '°C'),
                      SOURCE_LABELS[profile.source],
                      profile.spool_count ? `${profile.spool_count} ${profile.spool_count === 1 ? 'spool' : 'spools'}` : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <EditOnly>
                  <Button size="sm" icon={Plus} onClick={() => onAddSpool(profile)}>
                    Add spool
                  </Button>
                  <IconButton size="sm" icon={Pencil} label={`Edit ${profile.name}`} onClick={() => onEdit(profile)} />
                  <IconButton size="sm" icon={Trash2} label={`Delete ${profile.name}`} onClick={() => void removeProfile(profile)} />
                </EditOnly>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === 'brands' && (
        <>
          {brands && !brands.length && <p className="jp-meta">No brands yet.</p>}
          <ul className="jp-places" aria-label="Brands">
            {(brands || []).map((brand) => (
              <li key={brand.id} className="jp-places__row">
                {editing?.id === brand.id ? (
                  <form className="jp-places__rename" onSubmit={(event) => rename(event, brand)}>
                    <input
                      className="jp-input"
                      aria-label={`New name for ${brand.name}`}
                      autoFocus
                      value={editing.name}
                      onChange={(event) => setEditing({ id: brand.id, name: event.target.value })}
                    />
                    <Button type="submit" size="sm" variant="primary">
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="jp-places__name">{brand.name}</span>
                    <span className="jp-meta">
                      {brand.profile_count} {brand.profile_count === 1 ? 'filament' : 'filaments'} · {brand.spool_count}{' '}
                      {brand.spool_count === 1 ? 'spool' : 'spools'}
                    </span>
                    <EditOnly>
                      <IconButton size="sm" icon={Pencil} label={`Rename ${brand.name}`} onClick={() => setEditing({ id: brand.id, name: brand.name })} />
                      <IconButton size="sm" icon={Trash2} label={`Delete ${brand.name}`} onClick={() => void removeBrand(brand)} />
                    </EditOnly>
                  </>
                )}
              </li>
            ))}
          </ul>
          <EditOnly>
            <form
              className="jp-places__add"
              onSubmit={(event) => {
                event.preventDefault();
                void attempt(async () => {
                  await filament.saveBrand({ name: newBrand });
                  setNewBrand('');
                });
              }}
            >
              <input
                className="jp-input"
                aria-label="New brand"
                placeholder="New brand"
                value={newBrand}
                onChange={(event) => setNewBrand(event.target.value)}
              />
              <Button type="submit" icon={Plus} disabled={!newBrand.trim()}>
                Add
              </Button>
            </form>
            <p className="jp-meta">Renaming a brand to the name of another merges them: its filaments and spools move to that brand.</p>
          </EditOnly>
        </>
      )}
    </Modal>
  );
}

/** Add a filament (no `profile`) or change one. */
export function FilamentProfileDialog({ profile, onClose }: { profile: FilamentProfile | null; onClose: () => void }) {
  const [brands, setBrands] = useState<FilamentBrand[]>([]);
  const [form, setForm] = useState(() => ({
    brand_name: text(profile?.brand_name),
    name: text(profile?.name),
    material: text(profile?.material),
    color_name: text(profile?.color_name),
    color_hex: text(profile?.color_hex),
    diameter: text(profile?.diameter ?? 1.75),
    density: text(profile?.density),
    print_temp_min: text(profile?.print_temp_min),
    print_temp_max: text(profile?.print_temp_max),
    bed_temp_min: text(profile?.bed_temp_min),
    bed_temp_max: text(profile?.bed_temp_max),
    max_print_speed: text(profile?.max_print_speed),
    drying_temp: text(profile?.drying_temp),
    drying_hours: text(profile?.drying_hours),
    product_url: text(profile?.product_url),
    notes: text(profile?.notes)
  }));
  const { busy, error, run } = useSave();
  const [photo, setPhoto] = useState(profile?.photo ?? null);
  useEffect(() => {
    filament.brands().then(setBrands, () => {});
  }, []);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));
  const save = () =>
    run(
      () =>
        filament.saveProfile({
          id: profile?.id,
          brand_name: form.brand_name || null,
          name: form.name,
          material: form.material,
          color_name: form.color_name || null,
          color_hex: form.color_hex || null,
          diameter: numberOrNull(form.diameter) ?? 1.75,
          density: numberOrNull(form.density),
          print_temp_min: numberOrNull(form.print_temp_min),
          print_temp_max: numberOrNull(form.print_temp_max),
          bed_temp_min: numberOrNull(form.bed_temp_min),
          bed_temp_max: numberOrNull(form.bed_temp_max),
          max_print_speed: numberOrNull(form.max_print_speed),
          drying_temp: numberOrNull(form.drying_temp),
          drying_hours: numberOrNull(form.drying_hours),
          product_url: form.product_url || null,
          notes: form.notes || null
        }),
      onClose
    );
  const number = (key: keyof typeof form, label: string, id: string, hint?: string) => (
    <Field label={label} htmlFor={id} hint={hint}>
      <input id={id} className="jp-input" inputMode="decimal" value={form[key]} onChange={set(key)} />
    </Field>
  );
  return (
    <FormModal
      id="jp-profile-form"
      title={profile ? `Edit ${[profile.brand_name, profile.name].filter(Boolean).join(' ')}` : 'New filament'}
      onClose={onClose}
      onSubmit={() => void save()}
      saveLabel={profile ? 'Save' : 'Add filament'}
      busy={busy}
      error={error}
      wide
    >
      {profile && (
        <PhotoBlock
          photo={photo}
          label={[profile.brand_name, profile.name].filter(Boolean).join(' ')}
          onSave={async (next) => setPhoto((await filament.setFilamentPhoto(profile.id, next)).photo ?? null)}
          idPrefix="jp-profile"
        />
      )}
      <div className="jp-edit__grid">
        <Field label="Brand" htmlFor="jp-profile-brand">
          <input id="jp-profile-brand" className="jp-input" list="jp-profile-brands" value={form.brand_name} onChange={set('brand_name')} />
          <datalist id="jp-profile-brands">
            {brands.map((brand) => (
              <option key={brand.id} value={brand.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Name" htmlFor="jp-profile-name" hint="Left empty: the material and color.">
          <input id="jp-profile-name" className="jp-input" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Material" htmlFor="jp-profile-material">
          <input id="jp-profile-material" className="jp-input" list="jp-profile-materials" value={form.material} onChange={set('material')} required />
          <datalist id="jp-profile-materials">
            {MATERIALS.map((material) => (
              <option key={material} value={material} />
            ))}
          </datalist>
        </Field>
        <Field label="Color name" htmlFor="jp-profile-color-name">
          <input id="jp-profile-color-name" className="jp-input" value={form.color_name} onChange={set('color_name')} />
        </Field>
        <Field label="Color" htmlFor="jp-profile-color" hint="#rrggbb, or pick one.">
          <span className="jp-filament-form__color">
            <input
              type="color"
              aria-label="Pick a color"
              value={/^#[0-9a-f]{6}$/i.test(form.color_hex) ? form.color_hex : '#9aa4b4'}
              onChange={set('color_hex')}
            />
            <input id="jp-profile-color" className="jp-input" value={form.color_hex} onChange={set('color_hex')} placeholder="#2f6fdf" />
          </span>
        </Field>
        {number('diameter', 'Diameter (mm)', 'jp-profile-diameter')}
        {number('density', 'Density (g/cm³)', 'jp-profile-density')}
        {number('max_print_speed', 'Max speed (mm/s)', 'jp-profile-speed')}
        {number('print_temp_min', 'Nozzle from (°C)', 'jp-profile-nozzle-min')}
        {number('print_temp_max', 'Nozzle to (°C)', 'jp-profile-nozzle-max')}
        {number('bed_temp_min', 'Bed from (°C)', 'jp-profile-bed-min')}
        {number('bed_temp_max', 'Bed to (°C)', 'jp-profile-bed-max')}
        {number('drying_temp', 'Drying (°C)', 'jp-profile-dry-temp', 'Dry starts from it.')}
        {number('drying_hours', 'Drying (hours)', 'jp-profile-dry-hours')}
        <Field label="Product page" htmlFor="jp-profile-url" wide>
          <input id="jp-profile-url" className="jp-input" type="url" value={form.product_url} onChange={set('product_url')} placeholder="https://" />
        </Field>
        <Field label="Notes" htmlFor="jp-profile-notes" wide>
          <textarea id="jp-profile-notes" className="jp-input" rows={3} value={form.notes} onChange={set('notes')} />
        </Field>
      </div>
    </FormModal>
  );
}
