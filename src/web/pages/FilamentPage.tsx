import { useId, useMemo, useState } from 'react';
import { Cable, Library, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { filaments as filamentApi, type Filament } from '../api';
import { Button, IconButton, cx } from '../components/Button';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { SearchBox } from '../components/SearchBox';
import { normalizeColorHex } from '../FilamentManagerDialog';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { timeAgo } from '../home/format';
import { refreshFilamentPickers, showMessage } from '../page';
import { useLibraryData } from '../shell/libraryData';
import { navigate } from '../shell/routes';

const loadFilaments = () => filamentApi.list();

/** "Bambu Lab PLA Basic Black": vendor and name. */
export const filamentName = (filament: Pick<Filament, 'vendor' | 'name'>) =>
  [filament.vendor, filament.name].map((part) => String(part || '').trim()).filter(Boolean).join(' ') || 'Unnamed filament';

/** Materials in the catalog with their counts, most used first ("" for filaments without one is left out). */
export function materialCounts(list: Pick<Filament, 'material'>[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const filament of list) {
    const material = String(filament.material || '').trim().toUpperCase();
    if (material) counts.set(material, (counts.get(material) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Search (name, vendor, material, color) and material filter. */
export function filterFilaments<T extends Pick<Filament, 'name' | 'vendor' | 'material' | 'color_hex'>>(list: T[], search: string, material: string): T[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((filament) => {
    if (material && String(filament.material || '').trim().toUpperCase() !== material) return false;
    const text = [filament.vendor, filament.name, filament.material, filament.color_hex].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** A spool in the filament's color (spec §45: make the inventory visual). */
export function Spool({ color, size = 88 }: { color: string; size?: number }) {
  const hex = normalizeColorHex(color);
  const shine = `jp-spool-shine-${useId().replace(/:/g, '')}`;
  return (
    <svg className="jp-spool" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="47" className="jp-spool__flange" />
      <circle cx="50" cy="50" r="40" fill={hex ? `#${hex}` : 'var(--jp-surface-hover)'} />
      {/* Windings */}
      {[36, 31, 26].map((r) => <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="0.8" />)}
      <circle cx="50" cy="50" r="40" fill={`url(#${shine})`} />
      <circle cx="50" cy="50" r="17" className="jp-spool__hub" />
      <circle cx="50" cy="50" r="7" className="jp-spool__hole" />
      <defs>
        <radialGradient id={shine} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.28" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.25" />
        </radialGradient>
      </defs>
      {!hex && <text x="50" y="54" textAnchor="middle" className="jp-spool__unknown">?</text>}
    </svg>
  );
}

function showModels(filament: Filament) {
  navigate('library');
  applyFilterChange(() => {
    filterActions.clearAll();
    filterActions.addValue('filaments', String(filament.id));
  });
}

async function removeFilament(filament: Filament) {
  const answer = await showMessage('Remove Filament',
    `Remove "${filamentName(filament)}" from JusttPrint? Model assignments will be cleared. Synced filaments return on the next Spoolman sync.`,
    ['Remove', 'Cancel']);
  if (answer !== 'Remove') return;
  try {
    await filamentApi.remove(filament.id);
    await refreshFilamentPickers();
  } catch (error) {
    await showMessage('Error', `Failed to remove filament: ${(error as Error)?.message || error}`);
  }
}

function FilamentCard({ filament }: { filament: Filament }) {
  const models = Number(filament.model_count) || 0;
  const prints = Number(filament.print_count) || 0;
  const name = filamentName(filament);
  return (
    <li className="jp-spool-card" data-filament-id={filament.id}>
      <div className="jp-spool-card__visual" title={filament.color_hex ? `#${normalizeColorHex(filament.color_hex)}` : 'No color set'}>
        <Spool color={filament.color_hex || ''} />
      </div>
      <div className="jp-spool-card__body">
        <h3 className="jp-spool-card__name" title={name}>{name}</h3>
        <div className="jp-spool-card__badges">
          {filament.material && <span className="jp-badge">{filament.material}</span>}
          {filament.diameter ? <span className="jp-badge">{filament.diameter} mm</span> : null}
          <span className={cx('jp-badge', filament.source === 'spoolman' && 'jp-badge--accent')}>{filament.source === 'spoolman' ? 'Spoolman' : 'Manual'}</span>
        </div>
        <p className="jp-spool-card__usage">
          {models ? `Used in ${models} ${models === 1 ? 'model' : 'models'}` : 'Not on any model yet'}
        </p>
        <p className="jp-spool-card__usage">
          {prints ? `${prints} ${prints === 1 ? 'print' : 'prints'} • last used ${timeAgo(filament.last_used_at)}` : 'No logged prints'}
        </p>
      </div>
      <div className="jp-spool-card__actions">
        <Button size="sm" variant="ghost" icon={Library} disabled={!models} onClick={() => showModels(filament)}>Show models</Button>
        <IconButton size="sm" icon={Trash2} label={`Remove ${name}`} onClick={() => removeFilament(filament)} />
      </div>
    </li>
  );
}

/**
 * Filament (spec §45): the filament catalog (manual entries and Spoolman spools) as spools in their
 * color, with material, diameter, where it is used and when it was last printed. Adding and
 * Spoolman setup use the Filament Manager dialog. Remaining amount, location and printer
 * compatibility are not tracked yet (docs/redesign-5.md).
 */
export function FilamentPage() {
  const list = useLibraryData(loadFilaments);
  const [search, setSearch] = useState('');
  const [material, setMaterial] = useState('');
  const materials = useMemo(() => materialCounts(list || []), [list]);
  const shown = useMemo(() => filterFilaments(list || [], search, material), [list, search, material]);
  const fromSpoolman = (list || []).filter((filament) => filament.source === 'spoolman').length;

  return (
    <div className="jp-page__inner jp-filament">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-page-title">Filament</h1>
          <p className="jp-meta">
            {list ? `${list.length} ${list.length === 1 ? 'filament' : 'filaments'}${fromSpoolman ? ` • ${fromSpoolman} from Spoolman` : ''}` : 'Your filament catalog.'}
          </p>
        </div>
        <div className="jp-printers__header-actions">
          <Button icon={RefreshCw} onClick={() => window.openFilamentManager?.({ action: 'spoolman' })}>Spoolman</Button>
          <Button variant="primary" icon={Plus} id="jp-add-filament" onClick={() => window.openFilamentManager?.({ action: 'add' })}>Add Filament</Button>
        </div>
      </header>

      {!list ? (
        <div className="jp-home__skeleton"><Skeleton height={180} /></div>
      ) : !list.length ? (
        <Panel>
          <EmptyState icon={Cable} title="No filament yet"
            action={<Button variant="primary" icon={Plus} onClick={() => window.openFilamentManager?.({ action: 'add' })}>Add Filament</Button>}>
            Add the filament you print with, or sync your spools from Spoolman.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <div className="jp-filament__toolbar">
            <SearchBox className="jp-filament__search" label="Search filament" placeholder="Search by name, vendor, material or color"
              value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="jp-filament__materials" role="group" aria-label="Material">
              <button type="button" className={cx('jp-chip', !material && 'is-selected')} aria-pressed={!material} onClick={() => setMaterial('')}>
                All <span className="jp-chip__count">{list.length}</span>
              </button>
              {materials.map(([name, count]) => (
                <button key={name} type="button" className={cx('jp-chip', material === name && 'is-selected')} aria-pressed={material === name}
                  onClick={() => setMaterial(material === name ? '' : name)}>
                  {name} <span className="jp-chip__count">{count}</span>
                </button>
              ))}
            </div>
          </div>
          {shown.length ? (
            <ul className="jp-spool-grid" aria-label="Filament">
              {shown.map((filament) => <FilamentCard key={filament.id} filament={filament} />)}
            </ul>
          ) : (
            <Panel>
              <EmptyState icon={Cable} title="No filament matches"
                action={<Button onClick={() => { setSearch(''); setMaterial(''); }}>Clear search</Button>}>
                Try another search or material.
              </EmptyState>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
