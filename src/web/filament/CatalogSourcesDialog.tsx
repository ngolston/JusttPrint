import { useEffect, useRef, useState } from 'react';
import { Check, Pencil, RefreshCw, Search, X } from 'lucide-react';
import { catalogSources, type CatalogBrand, type CatalogReport, type CatalogStatus } from '../api';
import { Button, IconButton } from '../components/Button';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal, showMessage } from '../page';
import { formatDay } from '../units';

declare global {
  interface Window {
    openCatalogSources?: () => void;
  }
}

/*
 * Settings → Integrations → Filament catalogue (admins; src/core/filament-catalog.js): what "Add
 * from catalogue" searches. One list merged from 3dfilamentprofiles.com (bundled, updated with
 * JusttPrint's releases) and SpoolmanDB (checked for updates here), with the brands that may be the
 * same to merge, and every brand to rename or merge by hand.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const n = (value: number) => value.toLocaleString();
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

/** What an update did, in a sentence. */
export function reportText(name: string, report: CatalogReport) {
  const parts = [
    report.added ? plural(report.added, 'new filament', 'new filaments') : '',
    report.merged ? `${n(report.merged)} merged with ones already there` : '',
    report.duplicates ? `${n(report.duplicates)} other spool sizes and repeats` : '',
    report.updated ? `${n(report.updated)} changed` : '',
    report.removed ? `${n(report.removed)} gone` : '',
    report.brands ? plural(report.brands, 'new brand', 'new brands') : ''
  ].filter(Boolean);
  return `${name}: ${plural(report.entries, 'entry', 'entries')}${parts.length ? ` · ${parts.join(', ')}` : ', nothing changed'}.`;
}

type Group = { id: number; name: string; count: number }[];

export function CatalogSourcesDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<CatalogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<Group[]>([]);
  const [brandQuery, setBrandQuery] = useState('');
  const [brands, setBrands] = useState<CatalogBrand[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [into, setInto] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [round, setRound] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openCatalogSources', () => {
        setStatus('');
        setError('');
        setChosen([]);
        setRenaming(null);
        setOpen(true);
        setRound((value) => value + 1);
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  // The totals, sources and suggestions, after opening and after each change.
  useEffect(() => {
    if (!open) return;
    catalogSources.get().then(setState, (failure) => setError(errorText(failure)));
    catalogSources.suggestions().then(setSuggestions, () => setSuggestions([]));
  }, [open, round]);

  // The brand list, as the search changes.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const timer = setTimeout(() => {
      catalogSources.brands(brandQuery.trim(), 100).then(
        (list) => alive && setBrands(list),
        (failure) => alive && setError(errorText(failure))
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, brandQuery, round]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      setStatus(await work());
      setRound((value) => value + 1);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const spoolman = state?.sources.find((source) => source.id === 'spoolmandb') || null;
  const bundled = state?.sources.find((source) => source.id === '3dfilamentprofiles') || null;

  const check = () =>
    run(async () => {
      const next = await catalogSources.checkSpoolmanDb();
      setState(next);
      if (next.upToDate) return 'SpoolmanDB is up to date: it has not changed since the last download.';
      return next.report ? reportText('SpoolmanDB', next.report) : 'SpoolmanDB is in the catalogue.';
    });
  const remove = async () => {
    const answer = await showMessage(
      'Remove SpoolmanDB',
      'Take SpoolmanDB out of the catalogue? Filaments only it has go; ones it shares with 3dfilamentprofiles.com stay. Filaments and spools already added from it stay.',
      ['Remove', 'Cancel']
    );
    if (answer !== 'Remove') return;
    await run(async () => {
      const next = await catalogSources.removeSpoolmanDb();
      setState(next);
      return `SpoolmanDB is no longer in the catalogue${next.report?.removed ? ` (${plural(next.report.removed, 'filament', 'filaments')} went)` : ''}.`;
    });
  };
  const merge = (group: Group, intoId: number) =>
    run(async () => {
      const keep = group.find((brand) => brand.id === intoId);
      const result = await catalogSources.mergeBrands(
        group.map((brand) => brand.id).filter((id) => id !== intoId),
        intoId
      );
      setChosen([]);
      setInto(null);
      return `Merged ${group
        .filter((brand) => brand.id !== intoId)
        .map((brand) => brand.name)
        .join(
          ', '
        )} into ${keep?.name || result.brand.name}${result.merged ? `; ${plural(result.merged, 'duplicate filament', 'duplicate filaments')} merged` : ''}.`;
    });
  const notSame = (group: Group) =>
    run(async () => {
      await catalogSources.ignoreSuggestion(group.map((brand) => brand.id));
      return `${group.map((brand) => brand.name).join(' and ')} stay apart.`;
    });
  const rename = () => {
    if (!renaming) return;
    const target = renaming;
    return run(async () => {
      const result = await catalogSources.renameBrand(target.id, target.name);
      setRenaming(null);
      return result.merged ? `Renamed and merged into ${result.brand.name}.` : `Renamed to ${result.brand.name}.`;
    });
  };
  const chosenBrands = brands.filter((brand) => chosen.includes(brand.id));
  const toggle = (id: number) => setChosen((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <ModalDialog
      id="catalog-sources-dialog"
      title="Filament catalogue"
      dialogRef={dialogRef}
      className="jp-catalog-admin"
      onClose={() => setOpen(false)}
      footer={
        <>
          {error && (
            <span className="jp-fh-import__error" role="alert">
              {error}
            </span>
          )}
          {status && (
            <span className="jp-meta" id="catalog-sources-status">
              {status}
            </span>
          )}
          <Button onClick={() => dialogRef.current?.close()}>Close</Button>
        </>
      }
    >
      <p className="setting-description" id="catalog-totals">
        {state
          ? `What Add from catalogue (Filament page) searches: ${plural(state.filaments, 'filament', 'filaments')} from ${plural(state.brands, 'brand', 'brands')}, ${plural(
              state.merged,
              'duplicate',
              'duplicates'
            )} merged${state.manual ? `, ${n(state.manual)} added here` : ''}.`
          : 'What Add from catalogue (Filament page) searches.'}
      </p>
      {state && (
        <table className="jp-security__table" id="catalog-sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Entries</th>
              <th scope="col">List from</th>
              <th scope="col">
                <span className="jp-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>3dfilamentprofiles.com</td>
              <td>{bundled ? n(bundled.count) : '—'}</td>
              <td>{bundled?.fetchedAt ? formatDay(bundled.fetchedAt) : '—'}</td>
              <td className="jp-meta">Comes with JusttPrint, newer with each version</td>
            </tr>
            <tr>
              <td>SpoolmanDB</td>
              <td id="catalog-spoolmandb-count">{spoolman ? n(spoolman.count) : 'Not downloaded'}</td>
              <td>
                {spoolman?.fetchedAt ? formatDay(spoolman.fetchedAt) : '—'}
                {spoolman?.checkedAt && spoolman.checkedAt !== spoolman.fetchedAt && (
                  <span className="jp-meta"> · checked {formatDay(spoolman.checkedAt)}</span>
                )}
              </td>
              <td className="jp-catalog-admin__actions">
                <Button
                  size="sm"
                  icon={RefreshCw}
                  variant={spoolman ? 'secondary' : 'primary'}
                  onClick={() => void check()}
                  disabled={busy}
                  id="catalog-spoolmandb-refresh"
                >
                  {busy ? 'Checking…' : spoolman ? 'Check for updates' : 'Download'}
                </Button>
                {spoolman && (
                  <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy}>
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="setting-description">
        Both lists are merged into one: brands spelled differently (SUNLU, Sunlu) are one brand, and a filament both lists have is one filament, with the
        details each has. SpoolmanDB (about 9,000 entries, from <code>{state?.url || 'donkie.github.io/SpoolmanDB'}</code>) is only downloaded when you ask;
        Check for updates downloads it again only when it changed. 3dfilamentprofiles.com has no list meant for downloading, so its list comes with JusttPrint.
        Filaments people add or change in Add from catalogue stay as they left them.
      </p>

      {suggestions.length > 0 && (
        <section className="jp-catalog-admin__section" aria-labelledby="catalog-suggestions-title">
          <h3 className="jp-label" id="catalog-suggestions-title">
            Brands that may be the same
          </h3>
          <ul className="jp-catalog-admin__suggestions" id="catalog-suggestions">
            {suggestions.map((group) => (
              <li key={group.map((brand) => brand.id).join('-')}>
                <span className="jp-catalog-admin__names">
                  {group.map((brand, index) => (
                    <span key={brand.id}>
                      {index > 0 && ' · '}
                      <strong>{brand.name}</strong> <span className="jp-meta">({n(brand.count)})</span>
                    </span>
                  ))}
                </span>
                <Button size="sm" onClick={() => void merge(group, group[0].id)} disabled={busy}>
                  Merge into {group[0].name}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void notSame(group)} disabled={busy}>
                  Not the same
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="jp-catalog-admin__section" aria-labelledby="catalog-brands-title">
        <h3 className="jp-label" id="catalog-brands-title">
          Brands
        </h3>
        <label className="jp-catalog__search">
          <Search size={16} aria-hidden="true" />
          <span className="jp-sr-only">Search brands</span>
          <input
            id="catalog-brand-search"
            className="jp-input"
            type="search"
            placeholder="Find a brand"
            value={brandQuery}
            onChange={(event) => setBrandQuery(event.target.value)}
          />
        </label>
        {chosenBrands.length >= 2 && (
          <div className="jp-catalog-admin__merge" id="catalog-merge-bar">
            <span>Merge {chosenBrands.length} brands into</span>
            <select
              className="jp-input"
              aria-label="The brand to keep"
              value={into ?? chosenBrands[0].id}
              onChange={(event) => setInto(Number(event.target.value))}
            >
              {chosenBrands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void merge(chosenBrands, into && chosen.includes(into) ? into : chosenBrands[0].id)}
              disabled={busy}
            >
              Merge
            </Button>
          </div>
        )}
        <ul className="jp-catalog-admin__brands" id="catalog-brands" aria-label="Brands">
          {brands.map((brand) => (
            <li key={brand.id}>
              {renaming?.id === brand.id ? (
                <span className="jp-catalog-admin__rename">
                  <input
                    className="jp-input"
                    aria-label={`New name for ${brand.name}`}
                    value={renaming.name}
                    autoFocus
                    onChange={(event) => setRenaming({ id: brand.id, name: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void rename();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                  />
                  <IconButton icon={Check} size="sm" label="Save the name" onClick={() => void rename()} disabled={busy} />
                  <IconButton icon={X} size="sm" label="Cancel" onClick={() => setRenaming(null)} />
                </span>
              ) : (
                <>
                  <label className="jp-catalog-admin__brand">
                    <input type="checkbox" checked={chosen.includes(brand.id)} onChange={() => toggle(brand.id)} aria-label={`Choose ${brand.name} to merge`} />
                    <span>{brand.name}</span>
                    <span className="jp-meta">{n(brand.count)}</span>
                  </label>
                  <IconButton icon={Pencil} size="sm" label={`Rename ${brand.name}`} onClick={() => setRenaming({ id: brand.id, name: brand.name })} />
                </>
              )}
            </li>
          ))}
          {!brands.length && <li className="jp-meta">No brand by that name.</li>}
        </ul>
        <p className="jp-meta">Tick two or more brands to merge them. A merged brand's other spellings stay with it when the lists are updated.</p>
      </section>
    </ModalDialog>
  );
}
