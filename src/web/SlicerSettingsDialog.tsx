import { useEffect, useRef, useState } from 'react';
import { slicers as slicerApi } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openSlicerSettings?: () => void;
  }
}

interface Row {
  key: number;
  name: string;
  path: string;
}

let nextKey = 1;
const row = (name = '', path = ''): Row => ({ key: nextKey++, name, path });

/** "C:\...\orca-slicer.exe" → "Orca Slicer". */
export function suggestSlicerName(slicerPath: string): string {
  const base = slicerPath.split(/[/\\]/).pop() || '';
  const spaced = base.replace(/\.(exe|app|appimage|dmg)$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const pathKey = (slicerPath: string) => slicerPath.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();

/** The first problem with the list, or '' when it can be saved. */
function listProblem(list: { name: string; path: string }[]): string {
  if (list.some((slicer) => !slicer.name || !slicer.path)) return 'Please fill in both name and path for all slicers.';
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const slicer of list) {
    if (names.has(slicer.name.toLowerCase())) return `"${slicer.name}" is already used. Each slicer needs its own name.`;
    names.add(slicer.name.toLowerCase());
    if (paths.has(pathKey(slicer.path))) return `"${slicer.path}" is already used. Each slicer needs its own path.`;
    paths.add(pathKey(slicer.path));
  }
  return '';
}

function saveErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const named = message.match(/"[^"]+" is already used\. Each slicer needs its own (?:name|path)\./);
  if (named) return named[0];
  if (/slicers\.name/i.test(message)) return 'That slicer name is already used. Each slicer needs its own name.';
  if (/slicers\.path/i.test(message)) return 'That slicer path is already used. Each slicer needs its own path.';
  return `Error saving slicer settings: ${message}`;
}

/**
 * Settings → Slicer: the slicers Send to Slicer can open (paths on the user's computer), and the
 * download for the helper that opens them. Registers window.openSlicerSettings.
 */
export function SlicerSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusKeyRef = useRef<number | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [insecure, setInsecure] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => exposeGlobal('openSlicerSettings', () => {
    setRows([]);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    slicerApi.list()
      .then((list) => setRows((list || []).map((slicer) => row(slicer.name, slicer.path))))
      .catch((error) => console.error('Error loading slicers:', error));
  }), []);

  const update = (key: number, change: Partial<Row>) =>
    setRows((previous) => previous.map((existing) => (existing.key === key ? { ...existing, ...change } : existing)));

  function addRow() {
    const added = row();
    focusKeyRef.current = added.key;
    setRows((previous) => [...previous, added]);
  }

  async function save() {
    const list = rows.map((existing) => ({ name: existing.name.trim(), path: existing.path.trim() }));
    const problem = listProblem(list);
    if (problem) {
      await showMessage('Slicer Settings', problem);
      return;
    }
    setSaving(true);
    try {
      await slicerApi.replaceAll(list);
      dialogRef.current?.close();
      await showMessage('Slicer Settings', 'Slicer settings saved successfully.');
    } catch (error) {
      console.error('Error saving slicer settings:', error);
      await showMessage('Slicer Settings', saveErrorText(error));
    } finally {
      setSaving(false);
    }
  }

  function downloadHelper() {
    const link = document.createElement('a');
    link.href = `/api/helper/bundle${insecure ? '?insecure=1' : ''}`;
    link.download = 'JusttPrint-Helper.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <ModalDialog id="slicer-dialog" title="Slicer Settings" dialogRef={dialogRef}
      footer={(
        <>
          <button type="button" id="save-slicer-settings" className="is-primary" disabled={saving} onClick={save}>Save</button>
          <button type="button" id="cancel-slicer-settings" onClick={() => dialogRef.current?.close()}>Cancel</button>
        </>
      )}>
      <div id="slicer-list">
        {rows.map((entry) => (
          <div key={entry.key} className="slicer-entry">
            <div className="form-group slicer-entry-fields">
              <label className="slicer-field-label" htmlFor={`slicer-name-${entry.key}`}>Name</label>
              <input type="text" id={`slicer-name-${entry.key}`} className="slicer-name" placeholder="e.g. Orca Slicer" autoComplete="off"
                value={entry.name} onChange={(event) => update(entry.key, { name: event.target.value })}
                ref={(input) => {
                  if (input && focusKeyRef.current === entry.key) {
                    focusKeyRef.current = null;
                    input.focus();
                  }
                }} />
              <label className="slicer-field-label" htmlFor={`slicer-path-${entry.key}`}>Path</label>
              <div className="input-with-icon">
                <input type="text" id={`slicer-path-${entry.key}`} className="slicer-path" autoComplete="off"
                  placeholder="Path on your computer, e.g. C:\Program Files\OrcaSlicer\orca-slicer.exe"
                  value={entry.path} onChange={(event) => update(entry.key, { path: event.target.value })}
                  onBlur={() => { if (!entry.name.trim() && entry.path.trim()) update(entry.key, { name: suggestSlicerName(entry.path.trim()) }); }} />
                <button type="button" className="remove-slicer-button icon-button" title="Remove slicer" aria-label="Remove slicer"
                  onClick={() => setRows((previous) => previous.filter((existing) => existing.key !== entry.key))}>×</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="slicer-list-actions">
        <button type="button" id="add-slicer-button" className="full-width-button" onClick={addRow}>Add New Slicer</button>
      </div>
      <div id="slicer-helper-install">
        <p className="setting-description">Send to Slicer uses a helper on this computer. Type the slicer's full path on this computer above. Download the helper package for this server, unzip it, and run the installer. If Node.js is missing, the installer downloads it.</p>
        {window.location.protocol === 'https:' && (
          <div className="form-group checkbox-container" id="slicer-helper-insecure-row">
            <input type="checkbox" id="slicer-helper-insecure" checked={insecure} onChange={(event) => setInsecure(event.target.checked)} />
            <label htmlFor="slicer-helper-insecure">This server uses a self-signed certificate</label>
          </div>
        )}
        <button type="button" id="download-slicer-helper" className="full-width-button" onClick={downloadHelper}>Download helper for this server</button>
      </div>
    </ModalDialog>
  );
}
