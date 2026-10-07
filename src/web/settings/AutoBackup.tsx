import { useEffect, useRef, useState } from 'react';
import { autoBackup, downloadUrl, type AutoBackupSettings, type AutoBackupStatus } from '../api';
import { pickFolder } from '../components/FolderPicker';
import { showMessage } from '../page';
import { formatFileSize } from '../StatsDialog';
import { useCan } from '../session';

/** The choices for "Every"; another value (set by JUSTTPRINT_BACKUP_INTERVAL_HOURS) is added when needed. */
const INTERVALS: [number, string][] = [[6, '6 hours'], [12, '12 hours'], [24, 'Day'], [168, 'Week']];

/** Which environment variable sets each setting (shown when the container locks it). */
const ENV_NAMES: Record<string, string> = {
  autoBackupEnabled: 'JUSTTPRINT_AUTO_BACKUP',
  autoBackupIntervalHours: 'JUSTTPRINT_BACKUP_INTERVAL_HOURS',
  autoBackupKeep: 'JUSTTPRINT_BACKUP_KEEP',
  autoBackupDirectory: 'JUSTTPRINT_BACKUP_DIR'
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const when = (iso: string | null | undefined) => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
};
const hoursLabel = (hours: number) => INTERVALS.find(([h]) => h === hours)?.[1] ?? `${hours} hours`;

function download(filePath: string) {
  const link = document.createElement('a');
  link.href = downloadUrl(filePath);
  link.download = filePath.split('/').pop() || '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Settings → Backup → Automatic Backups: on/off, how often, how many to keep, the folder, the
 * last and next run, Back Up Now, and the backups with Download and Restore.
 * `opened` changes each time the Backup page opens, to reload.
 */
export function AutoBackup({ opened }: { opened: number }) {
  const [status, setStatus] = useState<AutoBackupStatus | null>(null);
  const [keep, setKeep] = useState('');
  const [directory, setDirectory] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<'run' | 'restore' | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const show = (next: AutoBackupStatus) => {
    setStatus(next);
    setKeep(String(next.keep));
    setDirectory(next.customDirectory);
  };
  const reload = () => autoBackup.status().then(show, (error) => setProblem(errorText(error)));

  const isAdmin = useCan('admin');

  useEffect(() => {
    if (!isAdmin) return undefined;
    void reload();
    // Scheduled backups run on the server: follow them while the page is open.
    const timer = window.setInterval(() => {
      if (sectionRef.current?.closest('dialog')?.open && document.visibilityState === 'visible') void autoBackup.status().then(setStatus, () => {});
    }, 15000);
    return () => window.clearInterval(timer);
  }, [opened, isAdmin]);

  async function save(settings: AutoBackupSettings) {
    setProblem('');
    // Show the switch and the interval at once; the server's answer replaces them.
    if (status) {
      setStatus({
        ...status,
        ...('enabled' in settings ? { enabled: !!settings.enabled } : {}),
        ...('intervalHours' in settings ? { intervalHours: Number(settings.intervalHours) } : {})
      });
    }
    try {
      show(await autoBackup.save(settings));
    } catch (error) {
      setProblem(errorText(error));
      if (status) show(status);
    }
  }

  async function runNow() {
    setBusy('run');
    setProblem('');
    try {
      const result = await autoBackup.runNow();
      show(result.status);
      if (!result.success) setProblem(result.message || 'The backup failed.');
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  async function restore(name: string, date: string) {
    const answer = await showMessage('Restore Backup',
      `Replace the library with the automatic backup from ${when(date) || name}? Changes made since then are lost. The current database is kept as justtprint.db.before-restore.`,
      ['Restore', 'Cancel']);
    if (answer !== 'Restore') return;
    setBusy('restore');
    try {
      const result = await autoBackup.restore(name);
      if (!result.success) {
        await showMessage('Error', result.message || 'Failed to restore the backup.');
        return;
      }
      await showMessage('Success', 'Backup restored. The page will now reload.');
      window.location.reload();
    } catch (error) {
      await showMessage('Error', `Failed to restore the backup: ${errorText(error)}`);
    } finally {
      setBusy(null);
    }
  }

  const locked = new Set(status?.setByEnvironment || []);
  const lockTitle = (key: string) => (locked.has(key) ? `Set by ${ENV_NAMES[key]} on this container` : undefined);
  const enabled = !!status?.enabled;
  const intervals = status && !INTERVALS.some(([h]) => h === status.intervalHours)
    ? [...INTERVALS, [status.intervalHours, hoursLabel(status.intervalHours)] as [number, string]]
    : INTERVALS;
  const commitKeep = () => {
    if (!status || keep.trim() === String(status.keep)) return;
    void save({ keep: Number(keep) });
  };
  const commitDirectory = (value = directory) => {
    if (!status || value.trim() === status.customDirectory) return;
    void save({ directory: value.trim() });
  };

  let line = 'No automatic backup yet.';
  if (status?.running || busy === 'run') line = 'Backing up…';
  else if (status?.lastError) line = `Last backup failed${status.lastAttempt ? ` (${when(status.lastAttempt)})` : ''}: ${status.lastError}`;
  else if (status?.lastRun) line = `Last backup: ${when(status.lastRun)}.`;
  const next = enabled && status?.nextRun && !status.running ? ` Next: ${when(status.nextRun)}.` : '';

  return (
    <section ref={sectionRef} id="auto-backup" className="auto-backup">
      <h4>Automatic Backups</h4>
      <p className="setting-description">
        The server copies the database on a schedule and keeps the newest copies. For protection against a failed disk, choose a folder on a different disk or volume than the data folder.
      </p>

      <label className="auto-backup-toggle" htmlFor="auto-backup-enabled" title={lockTitle('autoBackupEnabled')}>
        <input type="checkbox" id="auto-backup-enabled" checked={enabled} disabled={!status || locked.has('autoBackupEnabled')}
          onChange={(event) => save({ enabled: event.target.checked })} />
        <span>Back up the database automatically</span>
      </label>

      <div className="auto-backup-fields">
        <div className="form-group">
          <label htmlFor="auto-backup-interval">Every</label>
          <select id="auto-backup-interval" value={status?.intervalHours ?? 24} disabled={!status || locked.has('autoBackupIntervalHours')}
            title={lockTitle('autoBackupIntervalHours')} onChange={(event) => save({ intervalHours: Number(event.target.value) })}>
            {intervals.map(([hours, text]) => <option key={hours} value={hours}>{text}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="auto-backup-keep">Keep the newest</label>
          <input type="number" id="auto-backup-keep" min={1} max={1000} step={1} value={keep} disabled={!status || locked.has('autoBackupKeep')}
            title={lockTitle('autoBackupKeep')} onChange={(event) => setKeep(event.target.value)} onBlur={commitKeep}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitKeep(); } }} />
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="auto-backup-directory">Folder</label>
        <div className="auto-backup-folder">
          <input type="text" id="auto-backup-directory" spellCheck={false} autoComplete="off" value={directory}
            placeholder="Default: the data volume" disabled={!status || locked.has('autoBackupDirectory')}
            title={lockTitle('autoBackupDirectory')} onChange={(event) => setDirectory(event.target.value)} onBlur={() => commitDirectory()}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitDirectory(); } }} />
          <button type="button" id="auto-backup-browse" disabled={!status || locked.has('autoBackupDirectory')} onClick={async () => {
            const dir = await pickFolder({ title: 'Backup Folder', initial: directory.trim() || undefined, confirmLabel: 'Use This Folder' });
            if (dir) { setDirectory(dir); commitDirectory(dir); }
          }}>Browse…</button>
        </div>
        <p className="setting-description">Leave it empty to use <code>{status?.defaultDirectory || 'backups/ in the data folder'}</code> on the data volume.</p>
      </div>

      {locked.size > 0 && (
        <p id="auto-backup-env-note" className="setting-description">
          Set on this container by {[...locked].map((key) => ENV_NAMES[key]).join(', ')}. Change {locked.size === 1 ? 'it' : 'them'} there and restart the container.
        </p>
      )}

      <div className="auto-backup-status-row">
        <p id="auto-backup-status" className={status?.lastError && !status.running ? 'auto-backup-status is-error' : 'auto-backup-status'} role="status">{line}{next}</p>
        <button type="button" id="auto-backup-run" disabled={!status || !!busy || !!status.running} onClick={runNow}>
          {busy === 'run' || status?.running ? 'Backing up…' : 'Back Up Now'}
        </button>
      </div>
      {(problem || status?.folderProblem) && <p id="auto-backup-problem" className="auto-backup-status is-error" role="alert">{problem || status?.folderProblem}</p>}

      {!!status?.backups.length && (
        <ul id="auto-backup-list" className="auto-backup-list" aria-label="Automatic backups">
          {status.backups.map((item) => (
            <li key={item.name} className="auto-backup-item">
              <span className="auto-backup-item__when" title={item.path}>{when(item.date) || item.name}</span>
              <span className="auto-backup-item__size">{formatFileSize(item.size)}</span>
              <button type="button" className="auto-backup-download" onClick={() => download(item.path)}>Download</button>
              <button type="button" className="auto-backup-restore" disabled={!!busy} onClick={() => restore(item.name, item.date)}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
