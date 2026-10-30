import { useEffect, useRef, useState } from 'react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal } from '../page';

declare global {
  interface Window {
    openFilamentHubImport?: () => void;
  }
}

/*
 * Settings → Integrations → Import from FilamentHub (docs/merge-10.md, Phase 9): choose
 * FilamentHub's filamenthub.db (or one of its backup ZIPs), see what comes in, then import it.
 * Importing again only adds what is new.
 */

interface Count {
  total: number;
  add: number;
}
interface Preview {
  users: { label: string; match: string | null; create: string | null; role: string }[];
  counts: Record<string, Count>;
  printsWithoutModel: number;
  leftOut: { projects: number; printPhotos: number; apiKeys: number };
  email: boolean;
  discord: boolean;
}
interface Result {
  added: Record<string, number | boolean | { username: string; role: string; from: string }[]>;
  printsWithoutModel: number;
  leftOut: { projects: number; printPhotos: number; apiKeys: number };
}

const LABELS: Record<string, string> = {
  spools: 'Spools',
  profiles: 'Filaments',
  brands: 'Brands',
  locations: 'Places',
  weighings: 'Weighings',
  dryings: 'Drying sessions',
  printers: 'Printers',
  amsUnits: 'AMS units',
  prints: 'Logged prints',
  alertRules: 'Low-stock rules',
  webhooks: 'Webhooks'
};

/** The file as base64 (the import's upload, as Restore takes a backup). */
async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function FilamentHubImportDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(
    () =>
      exposeGlobal('openFilamentHubImport', () => {
        setFile(null);
        setPlan(null);
        setResult(null);
        setError('');
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  const run = async (action: 'preview-filamenthub-import' | 'run-filamenthub-import') => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const payload = { base64: await base64Of(file), name: file.name };
      if (action === 'preview-filamenthub-import') setPlan(await callAction<Preview>(action, payload));
      else setResult(await callAction<Result>(action, payload));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const toAdd = plan ? Object.values(plan.counts).reduce((sum, c) => sum + c.add, 0) + plan.users.filter((u) => u.create).length : 0;
  const madeUsers = result ? (result.added.users as { username: string; role: string; from: string }[]) : [];

  return (
    <ModalDialog
      id="filamenthub-import-dialog"
      title="Import from FilamentHub"
      dialogRef={dialogRef}
      className="jp-fh-import"
      footer={
        <>
          {error && (
            <span className="jp-fh-import__error" role="alert">
              {error}
            </span>
          )}
          {!result && plan && (
            <Button variant="primary" disabled={busy || !toAdd} onClick={() => void run('run-filamenthub-import')} id="fh-import-run">
              {busy ? 'Importing…' : toAdd ? 'Import' : 'Nothing new to import'}
            </Button>
          )}
          {!result && !plan && (
            <Button variant="primary" disabled={busy || !file} onClick={() => void run('preview-filamenthub-import')} id="fh-import-preview">
              {busy ? 'Reading…' : 'See what comes in'}
            </Button>
          )}
          <Button onClick={() => dialogRef.current?.close()}>{result ? 'Done' : 'Cancel'}</Button>
        </>
      }
    >
      {!result && (
        <>
          <p className="setting-description">
            Choose <code>filamenthub.db</code> from FilamentHub&apos;s data volume, or one of its backup ZIPs (Settings → Backup in FilamentHub). Spools,
            filaments, places, weighings, drying, printers with their AMS, logged prints, low-stock rules, webhooks and the email and Discord settings come in.
            Importing again only adds what is new.
          </p>
          <div className="form-group">
            <label htmlFor="fh-import-file">FilamentHub database or backup</label>
            <input
              id="fh-import-file"
              type="file"
              accept=".db,.sqlite,.zip,application/zip,application/x-sqlite3"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPlan(null);
              }}
            />
          </div>
        </>
      )}
      {plan && !result && (
        <div className="jp-fh-import__plan" id="fh-import-plan">
          <table className="jp-fh-import__table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">In the file</th>
                <th scope="col">New</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(plan.counts)
                .filter(([, c]) => c.total > 0)
                .map(([key, c]) => (
                  <tr key={key}>
                    <td>{LABELS[key] || key}</td>
                    <td>{c.total}</td>
                    <td>{c.add}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {plan.users.length > 0 && (
            <>
              <h4>Accounts</h4>
              <ul className="jp-fh-import__list">
                {plan.users.map((user) => (
                  <li key={user.label}>
                    {user.label}: {user.match ? `is ${user.match} here` : `becomes a new ${user.role} account, ${user.create}`}
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="jp-fh-import__list jp-meta">
            {plan.printsWithoutModel > 0 && <li>{plan.printsWithoutModel} logged prints are of files not in the library: they are left out.</li>}
            {plan.leftOut.projects > 0 && <li>{plan.leftOut.projects} projects are left out (JusttPrint has no projects yet).</li>}
            {plan.leftOut.printPhotos > 0 && <li>{plan.leftOut.printPhotos} print photos are left out.</li>}
            {plan.leftOut.apiKeys > 0 && <li>{plan.leftOut.apiKeys} API keys are left out (JusttPrint has one API token, under JusttPrint Backend Access).</li>}
            {(plan.email || plan.discord) && <li>The email server and Discord webhook come in only where JusttPrint has none set.</li>}
          </ul>
        </div>
      )}
      {result && (
        <div className="jp-fh-import__plan" id="fh-import-result">
          <p>
            Imported:{' '}
            {Object.entries(result.added)
              .filter(([key, value]) => key !== 'users' && typeof value === 'number' && value > 0)
              .map(([key, value]) => `${value} ${(LABELS[key] || key).toLowerCase()}`)
              .join(', ') || 'nothing new'}
            {result.added.email ? ', the email server' : ''}
            {result.added.discord ? ', the Discord webhook' : ''}.
          </p>
          {madeUsers.length > 0 && (
            <p className="setting-description">
              New accounts: {madeUsers.map((user) => `${user.username} (${user.role}, from ${user.from})`).join(', ')}. They have random passwords: set one for
              each under Users before they log in.
            </p>
          )}
        </div>
      )}
    </ModalDialog>
  );
}
