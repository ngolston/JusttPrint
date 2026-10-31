import { useEffect, useRef, useState } from 'react';
import { catalogSources, type CatalogSource } from '../api';
import { Button } from '../components/Button';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal, showMessage } from '../page';
import { formatDay } from '../units';

declare global {
  interface Window {
    openCatalogSources?: () => void;
  }
}

/*
 * Settings → Integrations → Filament catalogue (docs/plan-10.1.md, Phase 13; admins): what "Add from
 * catalogue" searches. The bundled 3dfilamentprofiles.com snapshot comes with JusttPrint; SpoolmanDB
 * is downloaded here on request (and refreshed or removed).
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function CatalogSourcesDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ bundled: CatalogSource | null; spoolmandb: CatalogSource | null; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(
    () =>
      exposeGlobal('openCatalogSources', () => {
        setStatus('');
        setError('');
        catalogSources.get().then(setState, (failure) => setError(errorText(failure)));
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  const run = async (work: () => Promise<typeof state>, done: (next: NonNullable<typeof state>) => string) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const next = await work();
      if (next) {
        setState(next);
        setStatus(done(next));
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const download = () =>
    run(
      () => catalogSources.refreshSpoolmanDb(),
      (next) => `SpoolmanDB is in the catalogue: ${next.spoolmandb?.count.toLocaleString()} filaments.`
    );
  const remove = async () => {
    if ((await showMessage('Remove SpoolmanDB', 'Take SpoolmanDB out of the catalogue? Filaments you added from it stay.', ['Remove', 'Cancel'])) !== 'Remove')
      return;
    await run(
      () => catalogSources.removeSpoolmanDb(),
      () => 'SpoolmanDB is no longer in the catalogue.'
    );
  };

  return (
    <ModalDialog
      id="catalog-sources-dialog"
      title="Filament catalogue"
      dialogRef={dialogRef}
      footer={
        <>
          {error && (
            <span className="jp-fh-import__error" role="alert">
              {error}
            </span>
          )}
          {status && <span className="jp-meta">{status}</span>}
          <Button onClick={() => dialogRef.current?.close()}>Close</Button>
        </>
      }
    >
      <p className="setting-description">What Add from catalogue (Filament page) searches.</p>
      {state && (
        <table className="jp-security__table" id="catalog-sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Filaments</th>
              <th scope="col">As of</th>
              <th scope="col">
                <span className="jp-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>3dfilamentprofiles.com</td>
              <td>{state.bundled ? state.bundled.count.toLocaleString() : '—'}</td>
              <td>{state.bundled?.fetchedAt ? formatDay(state.bundled.fetchedAt) : '—'}</td>
              <td className="jp-meta">Comes with JusttPrint</td>
            </tr>
            <tr>
              <td>SpoolmanDB</td>
              <td id="catalog-spoolmandb-count">{state.spoolmandb ? state.spoolmandb.count.toLocaleString() : 'Not downloaded'}</td>
              <td>{state.spoolmandb?.fetchedAt ? formatDay(state.spoolmandb.fetchedAt) : '—'}</td>
              <td>
                <Button
                  size="sm"
                  variant={state.spoolmandb ? 'secondary' : 'primary'}
                  onClick={() => void download()}
                  disabled={busy}
                  id="catalog-spoolmandb-refresh"
                >
                  {busy ? 'Downloading…' : state.spoolmandb ? 'Refresh' : 'Download'}
                </Button>
                {state.spoolmandb && (
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
        SpoolmanDB is the open filament database Spoolman uses: about 9,000 filaments with their spool weights, densities and temperatures. Download fetches its
        list (about 6 MB) from <code>{state?.url || 'donkie.github.io/SpoolmanDB'}</code> into this library; Refresh fetches it again. The
        3dfilamentprofiles.com catalogue is a snapshot that comes with JusttPrint and is updated with its releases: that site has no list meant for downloading.
      </p>
    </ModalDialog>
  );
}
