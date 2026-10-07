import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, FolderOpen, Plus, Upload, X } from 'lucide-react';
import { cancelUpload, uploadFile, uploads, type UploadInfo } from '../api';
import { Button, IconButton } from '../components/Button';
import { pickFolder } from '../components/FolderPicker';
import { Modal } from '../components/Overlay';
import { ProgressBar } from '../components/Panel';
import { getFilterState } from '../filters/store';
import { formatBytes } from '../shell/AppShell';
import { navigate } from '../shell/routes';
import { stlHomeDirectories } from '../scan/stlHome';
import { useCan } from '../session';
import { exposeGlobal } from '../page';
import { checkFile, type FileCheck } from './check';
import { forgetSession, saveSession, savedSession } from './resume';

declare global {
  interface Window {
    /** Open Upload Models, with dropped or chosen files already listed. */
    openUpload?: (files?: File[]) => void;
  }
}

const FOLDER_KEY = 'justtprint.uploadFolder';

type Status = 'waiting' | 'uploading' | 'done' | 'error' | 'skipped';

interface Entry {
  key: string;
  file: File;
  status: Status;
  progress: number;
  message: string;
  savedAs?: string;
  /** The server's session while it uploads (cancelled with it). */
  sessionId?: string;
}

function rememberedFolder(): string {
  try {
    return localStorage.getItem(FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

function rememberFolder(folder: string) {
  try {
    localStorage.setItem(FOLDER_KEY, folder);
  } catch { /* private window */ }
}

/** Where uploads go first: the folder the library shows, else the last one used, else STL Home. */
async function defaultFolder(): Promise<string> {
  const shown = getFilterState().directory;
  if (shown && !shown.includes('::')) return shown;
  const last = rememberedFolder();
  if (last) return last;
  const homes = await stlHomeDirectories().catch(() => [] as string[]);
  return homes[0] || '';
}

const uploadLabel = (count: number) => (count === 0 ? 'Upload' : `Upload ${count} ${count === 1 ? 'File' : 'Files'}`);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The scan-limit warning for a file that may be uploaded, if any. */
function scanWarning(file: File, info: UploadInfo | null): string {
  const check = info ? checkFile(file, info) : null;
  return check && check.ok ? check.warning || '' : '';
}

function entryFor(file: File, info: UploadInfo | null): Entry {
  const check: FileCheck = info ? checkFile(file, info) : { ok: true };
  return {
    key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
    file,
    status: check.ok ? 'waiting' : 'skipped',
    progress: 0,
    message: check.ok ? check.warning || '' : check.reason
  };
}

/**
 * Upload Models (Library → Upload, or drop files on the page): pick a library folder, add files,
 * and upload them one by one (POST /api/upload). Afterwards the folder is scanned, so the models
 * appear with thumbnails. Editors and admins only.
 */
export function UploadDialog() {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [info, setInfo] = useState<UploadInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const infoRef = useRef<UploadInfo | null>(null);

  function addFiles(files: File[]) {
    if (!files.length) return;
    setSummary('');
    setEntries((list) => [...list.filter((entry) => entry.status !== 'done'), ...files.map((file) => entryFor(file, infoRef.current))]);
  }

  useEffect(() => exposeGlobal('openUpload', (files?: File[]) => {
    setOpen(true);
    if (files?.length) addFiles(files);
    uploads.info().then((result) => {
      infoRef.current = result;
      setInfo(result);
      // Files added before the limits arrived are checked now.
      setEntries((list) => list.map((entry) => (entry.status === 'waiting' ? { ...entryFor(entry.file, result), key: entry.key } : entry)));
    }).catch(() => {});
    void defaultFolder().then((dir) => setFolder((current) => current || dir));
  }), []);

  async function chooseFolder() {
    const picked = await pickFolder({ title: 'Upload Into', initial: folder || undefined, confirmLabel: 'Upload Here' });
    if (picked) setFolder(picked);
  }

  function patch(key: string, changes: Partial<Entry>) {
    setEntries((list) => list.map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)));
  }

  async function start() {
    const queue = entries.filter((entry) => entry.status === 'waiting' || entry.status === 'error');
    if (!folder || !queue.length) return;
    rememberFolder(folder);
    setBusy(true);
    setSummary('');
    let uploaded = 0;
    let failed = 0;
    const paths: string[] = [];
    for (const entry of queue) {
      const controller = new AbortController();
      abort.current = controller;
      patch(entry.key, { status: 'uploading', progress: entry.progress });
      const resumeId = savedSession(folder, entry.file);
      try {
        const result = await uploadFile(entry.file, folder, {
          chunkBytes: infoRef.current?.chunkBytes || 16 * 1024 * 1024,
          signal: controller.signal,
          resumeId,
          onSession: (id, received) => {
            saveSession(folder, entry.file, id);
            patch(entry.key, {
              sessionId: id,
              progress: received / Math.max(1, entry.file.size),
              message: received > 0 ? `Continuing from ${formatBytes(received)}` : entry.message
            });
          },
          onProgress: (fraction) => patch(entry.key, { progress: fraction }),
          onRetry: (attempt, delay) => patch(entry.key, { message: `Connection problem, trying again in ${Math.round(delay / 1000)} s (attempt ${attempt})` })
        });
        forgetSession(folder, entry.file);
        paths.push(result.filePath);
        uploaded++;
        patch(entry.key, {
          status: 'done',
          progress: 1,
          savedAs: result.fileName,
          message: [result.fileName !== entry.file.name ? `Saved as ${result.fileName} (the name was taken).` : '', scanWarning(entry.file, infoRef.current)].filter(Boolean).join(' ')
        });
      } catch (error) {
        failed++;
        if (controller.signal.aborted) {
          // Cancelled: the server deletes what it has.
          const id = savedSession(folder, entry.file);
          if (id) void cancelUpload(id);
          forgetSession(folder, entry.file);
          patch(entry.key, { status: 'error', progress: 0, message: 'Cancelled' });
          break;
        }
        // A lost connection keeps the session: Upload again continues it. Other errors start over.
        if (!(error instanceof Error && /connection was lost/.test(error.message))) forgetSession(folder, entry.file);
        patch(entry.key, { status: 'error', message: errorText(error) });
      }
    }
    abort.current = null;
    if (uploaded) {
      setSummary(`Uploaded ${uploaded} ${uploaded === 1 ? 'file' : 'files'}. Adding to the library…`);
      try {
        const { inLibrary } = await uploads.finish(folder, paths);
        const files = `${uploaded} ${uploaded === 1 ? 'file' : 'files'}`;
        const added = inLibrary === uploaded
          ? `${uploaded === 1 ? 'it is' : 'all are'} in the library.`
          : `${inLibrary} of them in the library. The others are larger than the scan limit (Settings → General → Performance): raise it and scan again to add them.`;
        setSummary(`Uploaded ${files}; ${added}${failed ? ` ${failed} failed.` : ''}`);
      } catch (error) {
        setSummary(`Uploaded ${uploaded} ${uploaded === 1 ? 'file' : 'files'}, but the scan failed: ${errorText(error)}`);
      }
    } else if (failed) {
      setSummary('Nothing was uploaded.');
    }
    setBusy(false);
  }

  function close() {
    if (busy) abort.current?.abort();
    setOpen(false);
    setEntries([]);
    setSummary('');
  }

  const waiting = entries.filter((entry) => entry.status === 'waiting' || entry.status === 'error').length;
  const accept = info?.extensions.join(',');

  return (
    <Modal open={open} onClose={close} title="Upload Models" className="jp-upload"
      footer={(
        <>
          {summary && entries.some((entry) => entry.status === 'done') && !busy && (
            <Button onClick={() => { close(); navigate('library'); }}>Show Library</Button>
          )}
          <Button onClick={close}>{busy ? 'Cancel' : 'Close'}</Button>
          <Button variant="primary" icon={Upload} id="jp-upload-start" disabled={busy || !folder || waiting === 0} onClick={start}>
            {busy ? 'Uploading…' : uploadLabel(waiting)}
          </Button>
        </>
      )}>
      <div className="jp-upload__folder">
        <div className="jp-upload__folder-text">
          <span className="jp-label">Library folder</span>
          <span className="jp-upload__path" id="jp-upload-folder" title={folder}>{folder || 'Choose a folder in your library'}</span>
        </div>
        <Button icon={FolderOpen} onClick={chooseFolder} disabled={busy} id="jp-upload-choose-folder">Choose Folder</Button>
      </div>

      <div className="jp-upload__drop" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          addFiles(Array.from(event.dataTransfer.files || []));
        }}>
        <Upload size={22} aria-hidden="true" />
        <span>Drop model files here, or</span>
        <Button size="sm" icon={Plus} onClick={() => input.current?.click()} disabled={busy}>Add Files</Button>
        <input ref={input} type="file" multiple hidden accept={accept} id="jp-upload-input"
          onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
        {info && (
          <span className="jp-meta jp-upload__limits">
            {info.extensions.join(' ')} · up to {formatBytes(info.maxBytes)} each. More types under Settings → File Types.
          </span>
        )}
      </div>

      {entries.length > 0 && (
        <ul className="jp-upload__list" aria-label="Files to upload">
          {entries.map((entry) => (
            <li key={entry.key} className={`jp-upload__item is-${entry.status}`}>
              <span className="jp-upload__icon" aria-hidden="true">
                {entry.status === 'done' ? <CheckCircle2 size={16} /> : entry.status === 'error' || entry.status === 'skipped' ? <CircleAlert size={16} /> : <Upload size={16} />}
              </span>
              <span className="jp-upload__name" title={entry.file.name}>{entry.file.name}</span>
              <span className="jp-upload__size">{formatBytes(entry.file.size)}</span>
              {!busy && entry.status !== 'uploading' && (
                <IconButton icon={X} size="sm" label={`Remove ${entry.file.name}`}
                  onClick={() => setEntries((list) => list.filter((other) => other.key !== entry.key))} />
              )}
              {entry.status === 'uploading' && (
                <span className="jp-upload__progress">
                  <ProgressBar value={entry.progress} max={1} label={`Uploading ${entry.file.name}`} />
                  <span className="jp-upload__sent">{formatBytes(entry.progress * entry.file.size)} of {formatBytes(entry.file.size)}</span>
                </span>
              )}
              {entry.message && (
                <span className="jp-upload__message">
                  {entry.status === 'skipped' ? 'Skipped: ' : entry.status === 'error' ? 'Failed: ' : ''}{entry.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="jp-upload__summary" role="status" id="jp-upload-summary">{summary}</p>
    </Modal>
  );
}

/** True while files (not text or a model card) are dragged over the page. */
function draggingFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');
}

/**
 * Drop model files anywhere on the page to upload them (editors and admins). Shows a hint while
 * files are dragged over the window; dialogs that take drops themselves are left alone.
 */
export function UploadDropZone() {
  const allowed = useCan('editor');
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (!allowed) return undefined;
    let depth = 0;
    const busyElsewhere = () => !!document.querySelector('dialog[open]:not(.jp-upload)');
    const onEnter = (event: DragEvent) => {
      if (!draggingFiles(event) || busyElsewhere()) return;
      depth++;
      setOver(true);
    };
    const onOver = (event: DragEvent) => {
      if (!draggingFiles(event) || busyElsewhere()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event: DragEvent) => {
      if (!draggingFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setOver(false);
      if (!draggingFiles(event) || busyElsewhere() || event.defaultPrevented) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) window.openUpload?.(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [allowed]);

  if (!over) return null;
  return (
    <div className="jp jp-upload-overlay" aria-hidden="true">
      <div className="jp-upload-overlay__card">
        <Upload size={32} />
        <span>Drop to upload into your library</span>
      </div>
    </div>
  );
}
