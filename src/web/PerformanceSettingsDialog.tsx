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

/** Settings → Performance: the largest file a scan processes. Registers window.openPerformanceSettings. */
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
      await showMessage('Success', 'Performance settings saved successfully');
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog
      id="performance-settings-dialog"
      title="Performance Settings"
      dialogRef={dialogRef}
      description={<p className="warning-text">Warning: These settings can impact application performance and stability. Change with caution.</p>}
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
        <h4>File Processing</h4>
        <div className="form-group">
          <label htmlFor="max-file-size">Max File Size (MB):</label>
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
          <p className="setting-description">Maximum file size to process. Files larger than this will be skipped during scanning.</p>
        </div>
      </div>
    </ModalDialog>
  );
}
