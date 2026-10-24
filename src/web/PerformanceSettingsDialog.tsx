import { useEffect, useRef, useState } from 'react';
import { settings } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openPerformanceSettings?: () => void;
  }
}

const DEFAULT_MAX_FILE_SIZE_MB = '50';

/** Settings → Scanning → File Size: the largest file a scan adds. Registers window.openPerformanceSettings. */
export function PerformanceSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [maxFileSize, setMaxFileSize] = useState(DEFAULT_MAX_FILE_SIZE_MB);
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openPerformanceSettings', () => {
        settings
          .get<string | null>('maxFileSizeMB')
          .then((value) => setMaxFileSize(value || DEFAULT_MAX_FILE_SIZE_MB))
          .catch((error) => console.error('Could not load the performance settings:', error))
          .finally(() => {
            if (!dialogRef.current?.open) dialogRef.current?.showModal();
          });
      }),
    []
  );

  async function save() {
    const mb = Number(maxFileSize);
    if (!Number.isInteger(mb) || mb < 1) {
      await showMessage('Error', 'Invalid max file size. Must be a whole number of at least 1 MB.');
      return;
    }
    setSaving(true);
    try {
      await settings.save('maxFileSizeMB', String(mb));
      dialogRef.current?.close();
      await showMessage('Saved', `Scans now add files up to ${mb} MB.`);
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog
      id="performance-settings-dialog"
      title="File Size"
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" id="save-performance-settings" className="is-primary" disabled={saving} onClick={save}>
            Save
          </button>
          <button type="button" id="cancel-performance-settings" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </>
      }
    >
      <div className="settings-group">
        <div className="form-group">
          <label htmlFor="max-file-size">Largest file to scan (MB)</label>
          <input
            type="number"
            id="max-file-size"
            min="1"
            step="1"
            value={maxFileSize}
            onChange={(event) => setMaxFileSize(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
          <p className="setting-description">
            Scans skip larger files: they stay in their folder but are not added to the library. Very large files take longer to scan and to render thumbnails
            for.
          </p>
        </div>
      </div>
    </ModalDialog>
  );
}
