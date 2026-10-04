import { useEffect, useRef, useState } from 'react';
import { extensionInbox, settings, type InboxImportResult } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openBrowserExtensionSettings?: () => void;
  }
}

const STORE_URL = 'https://chromewebstore.google.com/detail/pigngedngcegmemgfbkaiihjnbplaedj?utm_source=item-share-cb';

const FIELDS = {
  inbox: 'extensionInboxDirectory',
  clientPrefix: 'extensionClientPathPrefix',
  containerPrefix: 'extensionContainerPathPrefix',
  copyToNas: 'extensionCopyToNasPath'
} as const;

type Field = keyof typeof FIELDS;
type Values = Record<Field, string>;

const EMPTY: Values = { inbox: '', clientPrefix: '', containerPrefix: '', copyToNas: '' };

function importCounts(result: Partial<InboxImportResult>): string[] {
  const parts: string[] = [];
  if (result.imported != null) parts.push(`${result.imported} imported`);
  if (result.failed) parts.push(`${result.failed} failed`);
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  return parts;
}

/** The stored extensionInboxLastStatus ({ at, imported, failed, errors }) as one line. */
function lastStatusText(stored: string | null): string {
  if (!stored) return 'Last import: none yet.';
  try {
    const status = JSON.parse(stored) as Partial<InboxImportResult> & { at?: string };
    const parts = [status.at, ...importCounts(status)].filter(Boolean);
    return `Last import: ${parts.join(' · ')}${status.errors?.length ? ` — ${status.errors[0]}` : ''}`;
  } catch {
    return 'Last import: none yet.';
  }
}

/**
 * Tools → Browser Extension: the inbox folder the Chrome extension writes to, and the optional
 * path mapping for Docker/NAS setups. Registers window.openBrowserExtensionSettings.
 */
export function BrowserExtensionSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  const [defaultInbox, setDefaultInbox] = useState('Downloads/JusttPrintInbox');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => exposeGlobal('openBrowserExtensionSettings', () => {
    (async () => {
      try {
        const keys = Object.keys(FIELDS) as Field[];
        const stored = await Promise.all(keys.map((field) => settings.get<string | null>(FIELDS[field])));
        setValues(Object.fromEntries(keys.map((field, index) => [field, stored[index] || ''])) as Values);
        setStatus(lastStatusText(await settings.get<string | null>('extensionInboxLastStatus')));
        const fallback = await extensionInbox.defaultDirectory().catch(() => '');
        if (fallback) setDefaultInbox(fallback);
      } catch (error) {
        setStatus(`Could not load the settings: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    })();
  }), []);

  const set = (field: Field) => (event: { target: { value: string } }) =>
    setValues((previous) => ({ ...previous, [field]: event.target.value }));

  async function saveFields(fields: Field[]) {
    for (const field of fields) await settings.save(FIELDS[field], values[field].trim());
  }

  async function save() {
    setBusy(true);
    try {
      await saveFields(Object.keys(FIELDS) as Field[]);
      dialogRef.current?.close();
    } catch (error) {
      await showMessage('Error', `Could not save the settings: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function importNow() {
    setBusy(true);
    setStatus('Importing...');
    try {
      await saveFields(['inbox']);
      const result = await extensionInbox.importNow();
      if (result.busy) {
        setStatus('An import is already running. Try again in a moment.');
        return;
      }
      const counts = importCounts(result).join(' · ') || 'nothing to import';
      setStatus(`Last import: just now · ${counts}${result.errors?.length ? ` — ${result.errors[0]}` : ''}`);
    } catch (error) {
      setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const textField = (field: Field, id: string, label: string, placeholder: string, help: string) => (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <input type="text" id={id} placeholder={placeholder} value={values[field]} onChange={set(field)} />
      <p className="setting-description">{help}</p>
    </div>
  );

  return (
    <ModalDialog id="browser-extension-settings-dialog" title="Browser Extension" dialogRef={dialogRef}
      description={(
        <>
          <p className="setting-description">The Chrome extension writes queue files to an inbox folder. JusttPrint imports them on start and every minute. JusttPrint does not need to be open in a browser when you add models.</p>
          <p className="setting-description"><a id="browser-extension-store-link" href={STORE_URL} target="_blank" rel="noopener noreferrer">Download the JusttPrint Watcher on Chrome Web Store</a></p>
        </>
      )}
      footer={(
        <>
          <button type="button" id="save-browser-extension-settings" disabled={busy} onClick={save}>Save</button>
          <button type="button" id="cancel-browser-extension-settings" onClick={() => dialogRef.current?.close()}>Cancel</button>
        </>
      )}>
      <div className="settings-group">
        <div className="form-group">
          <label htmlFor="extension-inbox-directory">Inbox directory:</label>
          <input type="text" id="extension-inbox-directory" placeholder={defaultInbox} value={values.inbox} onChange={set('inbox')} />
          <div className="dialog-buttons extension-inbox-actions">
            <button type="button" id="import-extension-inbox-now" disabled={busy} onClick={importNow}>Import now</button>
          </div>
          <p className="setting-description">Optional override, as a path on the server. JusttPrint always also checks <code>Downloads/JusttPrintInbox</code> and <code>JusttPrintInbox</code> next to <code>justtprint.db</code> (the folder the Chrome extension asks you to pick).</p>
          <p className="setting-description" id="extension-inbox-last-status" role="status">{status}</p>
        </div>
        <p className="setting-description extension-mapping-heading">Path mapping (optional, Docker/NAS)</p>
        {textField('clientPrefix', 'extension-client-path-prefix', 'Client path prefix:', 'e.g. C:\\Users\\You\\Downloads',
          'Path on the machine where the browser runs. Leave empty to disable mapping.')}
        {textField('containerPrefix', 'extension-container-path-prefix', 'Container path prefix:', 'e.g. /mnt/downloads',
          'Mounted path inside the container that corresponds to the client path above.')}
        {textField('copyToNas', 'extension-copy-to-nas-path', 'Copy to NAS path:', 'e.g. /mnt/network-share/models',
          'If set, extension-added files are copied here and the library uses this path.')}
      </div>
    </ModalDialog>
  );
}
