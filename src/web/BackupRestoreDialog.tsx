import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { backup, downloadUrl, leftoverDownloads, type FileResult, type LeftoverDownloads } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, refreshModelDisplay, showMessage } from './page';
import { AutoBackup } from './settings/AutoBackup';
import { formatFileSize } from './StatsDialog';

declare global {
  interface Window {
    openBackupRestore?: () => void;
  }
}

type Task = 'backup' | 'restore' | 'export' | 'import';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    // A data: URL is "data:<type>;base64,<data>".
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/** Start a browser download of a file the server just wrote. */
function download(filePath: string) {
  const link = document.createElement('a');
  link.href = downloadUrl(filePath);
  link.download = filePath.split(/[\\/]/).pop() || '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Settings → Backup/Restore: automatic backups, download a database backup or a library export,
 * restore a backup, or merge an export into the library. Registers window.openBackupRestore.
 */
export function BackupRestoreDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<Task | null>(null);
  const [opened, setOpened] = useState(0);
  const [leftovers, setLeftovers] = useState<LeftoverDownloads | null>(null);

  useEffect(() => {
    leftoverDownloads.list().then(setLeftovers, () => setLeftovers(null));
  }, [opened]);

  async function deleteLeftovers() {
    if (!leftovers?.files.length) return;
    const n = leftovers.files.length;
    const answer = await showMessage('Delete Old Backup Files',
      `Delete ${n} backup and export file${n === 1 ? '' : 's'} (${formatFileSize(leftovers.totalBytes)}) from ${leftovers.folder}? Automatic backups and your database are not touched.`,
      ['Delete', 'Cancel']);
    if (answer !== 'Delete') return;
    try {
      await leftoverDownloads.remove();
    } catch (error) {
      await showMessage('Error', `Could not delete the files: ${errorText(error)}`);
    }
    setLeftovers(await leftoverDownloads.list().catch(() => null));
  }

  useEffect(() => exposeGlobal('openBackupRestore', () => {
    setOpened((n) => n + 1);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }), []);

  async function run(task: Task, work: () => Promise<void>) {
    if (busy) return;
    setBusy(task);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  }

  async function downloadResult(create: () => Promise<FileResult>, what: string) {
    try {
      const result = await create();
      if (!result.success) {
        await showMessage('Error', result.message || `Failed to create the ${what}.`);
        return;
      }
      download(result.filePath);
    } catch (error) {
      await showMessage('Error', `Failed to create the ${what}: ${errorText(error)}`);
    }
  }

  const createBackup = () => run('backup', () => downloadResult(backup.create, 'database backup'));
  const exportLibrary = () => run('export', () => downloadResult(backup.exportLibrary, 'library export'));

  async function chooseRestoreFile() {
    const answer = await showMessage('Confirm Restore',
      'Warning: Restoring from backup will replace all current data. This cannot be undone. Continue?', ['Yes', 'No']);
    if (answer === 'Yes') restoreInputRef.current?.click();
  }

  async function chooseImportFile() {
    const answer = await showMessage('Confirm Import',
      'This will merge the imported library with your current library. Existing models will be updated. Continue?', ['Yes', 'No']);
    if (answer === 'Yes') importInputRef.current?.click();
  }

  /** The chosen file, with the input cleared so choosing the same file again still fires. */
  function takeFile(event: ChangeEvent<HTMLInputElement>): File | null {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    return file;
  }

  function restore(event: ChangeEvent<HTMLInputElement>) {
    const file = takeFile(event);
    if (!file) return;
    run('restore', async () => {
      try {
        const result = await backup.restore(await fileToBase64(file));
        if (!result.success) {
          await showMessage('Error', result.message || 'Failed to restore the database.');
          return;
        }
        await showMessage('Success', 'Database restored successfully. The page will now reload.');
        window.location.reload();
      } catch (error) {
        await showMessage('Error', `Failed to restore the database: ${errorText(error)}`);
      }
    });
  }

  function importLibrary(event: ChangeEvent<HTMLInputElement>) {
    const file = takeFile(event);
    if (!file) return;
    run('import', async () => {
      try {
        const result = await backup.importLibrary(await file.text());
        if (!result.success) {
          await showMessage('Error', result.message || 'Failed to import the library.');
          return;
        }
        await refreshModelDisplay();
        await showMessage('Success',
          `Library imported successfully. ${result.imported ?? 0} new models added, ${result.updated ?? 0} models updated.`);
      } catch (error) {
        await showMessage('Error', `Failed to import the library: ${errorText(error)}`);
      }
    });
  }

  const label = (task: Task, idle: string, working: string) => (busy === task ? working : idle);

  return (
    <ModalDialog id="backup-restore-dialog" title="Backup/Restore" dialogRef={dialogRef}
      footer={<button type="button" id="save-backup-restore" onClick={() => dialogRef.current?.close()}>Close</button>}>
      <AutoBackup opened={opened} />
      {!!leftovers?.files.length && (
        <div id="leftover-downloads" className="leftover-downloads">
          <p className="setting-description">
            {leftovers.files.length} backup and export file{leftovers.files.length === 1 ? '' : 's'} from earlier downloads take up {formatFileSize(leftovers.totalBytes)} in the data folder. New ones are deleted an hour after you download them.
          </p>
          <button type="button" id="delete-leftover-downloads" onClick={deleteLeftovers}>Delete Them</button>
        </div>
      )}
      <div className="backup-restore-columns">
        <div>
          <h4>Database</h4>
          <div className="form-group">
            <label>Database Backup</label>
            <p className="setting-description">Download a backup of your database: model information, tags and settings.</p>
            <button type="button" id="backup-button" className="full-width-button" disabled={!!busy} onClick={createBackup}>
              {label('backup', 'Create Backup', 'Creating backup...')}
            </button>
          </div>
          <div className="form-group">
            <label>Database Restore</label>
            <p className="setting-description">Restore your database from a backup file. This replaces all current data.</p>
            <button type="button" id="restore-button" className="full-width-button" disabled={!!busy} onClick={chooseRestoreFile}>
              {label('restore', 'Restore from Backup', 'Restoring...')}
            </button>
            <input ref={restoreInputRef} id="restore-file-input" type="file" accept=".db" hidden onChange={restore} />
          </div>
        </div>
        <div>
          <h4>Library</h4>
          <div className="form-group">
            <label>Library Export</label>
            <p className="setting-description">Download your library (models and tags) as a JSON file for backup or sharing.</p>
            <button type="button" id="export-library-button" className="full-width-button" disabled={!!busy} onClick={exportLibrary}>
              {label('export', 'Export Library', 'Exporting...')}
            </button>
          </div>
          <div className="form-group">
            <label>Library Import</label>
            <p className="setting-description">Merge models and tags from a library JSON file into your current library.</p>
            <button type="button" id="import-library-button" className="full-width-button" disabled={!!busy} onClick={chooseImportFile}>
              {label('import', 'Import Library', 'Importing...')}
            </button>
            <input ref={importInputRef} id="import-library-file-input" type="file" accept=".json,application/json" hidden onChange={importLibrary} />
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
