import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Plus, Upload, X } from 'lucide-react';
import { callAction, cancelUpload, uploadFile, uploads, type UploadInfo } from '../api';
import { Button, IconButton } from '../components/Button';
import { Modal } from '../components/Overlay';
import { ProgressBar } from '../components/Panel';
import { formatBytes } from '../shell/AppShell';
import { navigate } from '../shell/routes';
import { useCan } from '../session';
import { exposeGlobal, showMessage } from '../page';
import { checkFile, type FileCheck } from './check';
import { forgetSession, saveSession, savedSession } from './resume';
import { defaultModelName, lastSegment, mediaKindOf, stem, targetFolder, type UploadMode } from './plan';

declare global {
  interface Window {
    /** Open Upload Models, with dropped or chosen files already listed. */
    openUpload?: (files?: File[]) => void;
  }
}

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
  /** The model folder made for this file (each file its own model), kept for a retry. */
  modelFolder?: string;
}

/** The Upload folder every upload goes to (Settings → Scanning → Organize, or JUSTTPRINT_UPLOAD_FOLDER), or '' when none is set. */
async function uploadFolder(): Promise<string> {
  const inbox = await callAction<{ uploadFolder: string }>('get-upload-folder').catch(() => null);
  return inbox?.uploadFolder || '';
}

const uploadLabel = (count: number) => (count === 0 ? 'Upload' : `Upload ${count} ${count === 1 ? 'File' : 'Files'}`);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The scan-limit warning for a file that may be uploaded, if any. */
function scanWarning(file: File, info: UploadInfo | null): string {
  const check = info ? checkFile(file, info) : null;
  return check && check.ok ? check.warning || '' : '';
}

function entryFor(file: File, info: UploadInfo | null, mode: UploadMode = 'one'): Entry {
  const check: FileCheck = info ? checkFile(file, info, mode === 'each' ? 'no' : 'yes') : { ok: true };
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
 * and upload them one by one (POST /api/upload). Every model gets a folder of its own named after
 * it (src/server/model-folders.js): the files as one model, or each model file as its own. In
 * the model's folder, pictures go into image/, videos into video/ and documents into document/;
 * a folder that is a model's folder already takes them as they are. Afterwards the folder is
 * scanned, so the models appear with thumbnails (the first picture is the cover). Editors and
 * admins only.
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
  const [mode, setModeState] = useState<UploadMode>('one');
  const modeRef = useRef<UploadMode>('one');
  /** The model's name (one model); empty means the first model file's name. */
  const [modelName, setModelName] = useState('');
  /** The model folder made for this batch (one model), so a retry uploads into it again. */
  const madeFolder = useRef<string | null>(null);

  function addFiles(files: File[]) {
    if (!files.length) return;
    setSummary('');
    setEntries((list) => [...list.filter((entry) => entry.status !== 'done'), ...files.map((file) => entryFor(file, infoRef.current, modeRef.current))]);
  }

  /** Check the files again for a new mode (pictures need a model folder). */
  function setMode(next: UploadMode) {
    modeRef.current = next;
    setModeState(next);
    madeFolder.current = null;
    setEntries((list) =>
      list.map((entry) =>
        entry.status === 'waiting' || entry.status === 'skipped' ? { ...entryFor(entry.file, infoRef.current, next), key: entry.key } : entry
      )
    );
  }

  // A folder that is a model's folder already takes the files as they are.
  useEffect(() => {
    if (!folder) return;
    let current = true;
    callAction<{ isModelFolder: boolean }>('get-model-media', folder)
      .catch(() => ({ isModelFolder: false }))
      .then((found) => {
        if (!current) return;
        if (found.isModelFolder) setMode('add');
        else if (modeRef.current === 'add') setMode('one');
      });
    return () => {
      current = false;
    };
  }, [folder]);

  useEffect(
    () =>
      exposeGlobal('openUpload', async (files?: File[]) => {
        // Everything goes to the Upload folder: without one, it is chosen first.
        const inbox = await uploadFolder();
        if (!inbox) {
          navigate('settings', 'organize');
          await showMessage('Upload', 'Choose the Upload folder first (it is where every upload goes), then upload again.');
          return;
        }
        madeFolder.current = null;
        setFolder(inbox);
        setOpen(true);
        if (files?.length) addFiles(files);
        uploads
          .info()
          .then((result) => {
            infoRef.current = result;
            setInfo(result);
            // Files added before the limits arrived are checked now.
            setEntries((list) =>
              list.map((entry) => (entry.status === 'waiting' ? { ...entryFor(entry.file, result, modeRef.current), key: entry.key } : entry))
            );
          })
          .catch(() => {});
      }),
    []
  );

  function patch(key: string, changes: Partial<Entry>) {
    setEntries((list) => list.map((entry) => (entry.key === key ? { ...entry, ...changes } : entry)));
  }

  async function start() {
    const queue = entries.filter((entry) => entry.status === 'waiting' || entry.status === 'error');
    if (!folder || !queue.length) return;
    setBusy(true);
    setSummary('');
    let uploaded = 0;
    let failed = 0;
    let cancelled = false;
    /** The files uploaded into each model folder. */
    const byFolder = new Map<string, string[]>();
    const info = infoRef.current;
    for (const entry of queue) {
      let modelFolder: string;
      try {
        modelFolder = await folderFor(entry);
      } catch (error) {
        failed++;
        patch(entry.key, { status: 'error', message: errorText(error) });
        continue;
      }
      const target = targetFolder(modelFolder, entry.file.name, info);
      const controller = new AbortController();
      abort.current = controller;
      patch(entry.key, { status: 'uploading', progress: entry.progress });
      const resumeId = savedSession(target, entry.file);
      try {
        const result = await uploadFile(entry.file, target, {
          chunkBytes: info?.chunkBytes || 16 * 1024 * 1024,
          signal: controller.signal,
          resumeId,
          onSession: (id, received) => {
            saveSession(target, entry.file, id);
            patch(entry.key, {
              sessionId: id,
              progress: received / Math.max(1, entry.file.size),
              message: received > 0 ? `Continuing from ${formatBytes(received)}` : entry.message
            });
          },
          onProgress: (fraction) => patch(entry.key, { progress: fraction }),
          onRetry: (attempt, delay) => patch(entry.key, { message: `Connection problem, trying again in ${Math.round(delay / 1000)} s (attempt ${attempt})` })
        });
        forgetSession(target, entry.file);
        byFolder.set(modelFolder, [...(byFolder.get(modelFolder) || []), result.filePath]);
        uploaded++;
        patch(entry.key, {
          status: 'done',
          progress: 1,
          savedAs: result.fileName,
          message: [
            result.fileName !== entry.file.name ? `Saved as ${result.fileName} (the name was taken).` : '',
            mediaKindOf(entry.file.name, info) ? '' : scanWarning(entry.file, info)
          ]
            .filter(Boolean)
            .join(' ')
        });
      } catch (error) {
        failed++;
        if (controller.signal.aborted) {
          // Cancelled: the server deletes what it has.
          const id = savedSession(target, entry.file);
          if (id) void cancelUpload(id);
          forgetSession(target, entry.file);
          patch(entry.key, { status: 'error', progress: 0, message: 'Cancelled' });
          cancelled = true;
          break;
        }
        // A lost connection keeps the session: Upload again continues it. Other errors start over.
        if (!(error instanceof Error && /connection was lost/.test(error.message))) forgetSession(target, entry.file);
        patch(entry.key, { status: 'error', message: errorText(error) });
      }
    }
    abort.current = null;
    if (uploaded) {
      setSummary(`Uploaded ${uploaded} ${uploaded === 1 ? 'file' : 'files'}. Adding to the library…`);
      let inLibrary = 0;
      /** Archives (RAR, 7Z; a ZIP while ZIP scanning is off): kept as they are, for Organize to move. */
      let kept = 0;
      let scanError = '';
      const notAdded: { name: string; reason: string }[] = [];
      for (const [modelFolder, paths] of byFolder) {
        try {
          const done = await uploads.finish(modelFolder, paths);
          inLibrary += done.inLibrary;
          kept += done.kept || 0;
          notAdded.push(...(done.notAdded || []));
        } catch (error) {
          scanError = errorText(error);
        }
      }
      const files = `${uploaded} ${uploaded === 1 ? 'file' : 'files'}`;
      const where = byFolder.size === 1 ? ` into “${lastSegment([...byFolder.keys()][0])}”` : ` into ${byFolder.size} model folders`;
      if (scanError) setSummary(`Uploaded ${files}${where}, but the scan failed: ${scanError}`);
      else {
        const why = notAdded.map((n) => `${n.name}: ${n.reason}`).join('; ');
        const keptText = kept
          ? ` ${kept} ${kept === 1 ? 'archive is' : 'archives are'} kept as ${kept === 1 ? 'it is' : 'they are'} (Organize moves ${kept === 1 ? 'it' : 'them'}).`
          : '';
        const added =
          inLibrary + kept >= uploaded && !notAdded.length
            ? `${uploaded === 1 ? 'it is' : 'all are'} in the library.${keptText}`
            : `${inLibrary} of them in the library.${keptText} Not added: ${why || 'larger than the scan limit (Settings → General → Performance)'}.`;
        setSummary(`Uploaded ${files}${where}; ${added}${failed && !cancelled ? ` ${failed} failed.` : ''}`);
      }
    } else if (failed) {
      setSummary('Nothing was uploaded.');
    }
    setBusy(false);
  }

  /** The model folder a file goes into: made on first use (one per batch, or one per file). */
  async function folderFor(entry: Entry): Promise<string> {
    if (modeRef.current === 'add') return folder;
    if (modeRef.current === 'one') {
      if (!madeFolder.current) {
        const name =
          modelName.trim() ||
          defaultModelName(
            entries.map((e) => e.file.name),
            infoRef.current
          ) ||
          'Model';
        madeFolder.current = (await callAction<{ folder: string }>('make-model-folder', folder, name)).folder;
      }
      return madeFolder.current;
    }
    if (entry.modelFolder) return entry.modelFolder;
    const made = (await callAction<{ folder: string }>('make-model-folder', folder, stem(entry.file.name) || 'Model')).folder;
    patch(entry.key, { modelFolder: made });
    return made;
  }

  function close() {
    if (busy) abort.current?.abort();
    setOpen(false);
    setEntries([]);
    setSummary('');
    setModelName('');
    madeFolder.current = null;
  }

  const waiting = entries.filter((entry) => entry.status === 'waiting' || entry.status === 'error').length;
  const accept = [...(info?.extensions || []), ...(mode === 'each' ? [] : Object.values(info?.mediaExtensions || {}).flat())].join(',');

  return (
    <Modal
      open={open}
      onClose={close}
      title="Upload Models"
      className="jp-upload"
      footer={
        <>
          {summary && entries.some((entry) => entry.status === 'done') && !busy && (
            <Button
              onClick={() => {
                close();
                navigate('library');
              }}
            >
              Show Library
            </Button>
          )}
          <Button onClick={close}>{busy ? 'Cancel' : 'Close'}</Button>
          <Button variant="primary" icon={Upload} id="jp-upload-start" disabled={busy || !folder || waiting === 0} onClick={start}>
            {busy ? 'Uploading…' : uploadLabel(waiting)}
          </Button>
        </>
      }
    >
      <div className="jp-upload__folder">
        <div className="jp-upload__folder-text">
          <span className="jp-label">Upload folder</span>
          <span className="jp-upload__path" id="jp-upload-folder" title={folder}>
            {folder}
          </span>
        </div>
      </div>

      <fieldset className="jp-upload__mode" id="jp-upload-mode" disabled={busy}>
        {mode === 'add' ? (
          <p className="jp-meta">
            This is the folder of the model “{lastSegment(folder)}”: model files go into it, pictures into image/, videos into video/ and documents into
            document/.
          </p>
        ) : (
          <>
            <legend className="jp-label">Each model gets a folder named after it</legend>
            <label className="jp-upload__choice">
              <input type="radio" name="jp-upload-mode" value="one" checked={mode === 'one'} onChange={() => setMode('one')} />
              <span>
                One model
                <span className="jp-meta"> · all these files in one folder, pictures, videos and documents with them</span>
              </span>
            </label>
            {mode === 'one' && (
              <input
                type="text"
                className="jp-input jp-upload__name-input"
                id="jp-upload-model-name"
                aria-label="Model name"
                placeholder={
                  defaultModelName(
                    entries.map((entry) => entry.file.name),
                    info
                  ) || 'Model name'
                }
                value={modelName}
                onChange={(event) => {
                  madeFolder.current = null;
                  setModelName(event.target.value);
                }}
              />
            )}
            <label className="jp-upload__choice">
              <input type="radio" name="jp-upload-mode" value="each" checked={mode === 'each'} onChange={() => setMode('each')} />
              <span>
                Each file its own model
                <span className="jp-meta"> · a folder for every model file</span>
              </span>
            </label>
          </>
        )}
      </fieldset>

      <div
        className="jp-upload__drop"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          addFiles(Array.from(event.dataTransfer.files || []));
        }}
      >
        <Upload size={22} aria-hidden="true" />
        <span>Drop model files, pictures, videos or documents here, or</span>
        <Button size="sm" icon={Plus} onClick={() => input.current?.click()} disabled={busy}>
          Add Files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={accept}
          id="jp-upload-input"
          onChange={(event) => {
            addFiles(Array.from(event.target.files || []));
            event.target.value = '';
          }}
        />
        {info && (
          <span className="jp-meta jp-upload__limits">
            {info.extensions.join(' ')}
            {mode !== 'each' && info.mediaExtensions ? ', pictures, videos and documents' : ''} · up to {formatBytes(info.maxBytes)} each. More model types
            under Settings → File Types.
          </span>
        )}
      </div>

      {entries.length > 0 && (
        <ul className="jp-upload__list" aria-label="Files to upload">
          {entries.map((entry) => (
            <li key={entry.key} className={`jp-upload__item is-${entry.status}`}>
              <span className="jp-upload__icon" aria-hidden="true">
                {entry.status === 'done' ? (
                  <CheckCircle2 size={16} />
                ) : entry.status === 'error' || entry.status === 'skipped' ? (
                  <CircleAlert size={16} />
                ) : (
                  <Upload size={16} />
                )}
              </span>
              <span className="jp-upload__name" title={entry.file.name}>
                {entry.file.name}
              </span>
              <span className="jp-upload__size">{formatBytes(entry.file.size)}</span>
              {!busy && entry.status !== 'uploading' && (
                <IconButton
                  icon={X}
                  size="sm"
                  label={`Remove ${entry.file.name}`}
                  onClick={() => setEntries((list) => list.filter((other) => other.key !== entry.key))}
                />
              )}
              {entry.status === 'uploading' && (
                <span className="jp-upload__progress">
                  <ProgressBar value={entry.progress} max={1} label={`Uploading ${entry.file.name}`} />
                  <span className="jp-upload__sent">
                    {formatBytes(entry.progress * entry.file.size)} of {formatBytes(entry.file.size)}
                  </span>
                </span>
              )}
              {entry.message && (
                <span className="jp-upload__message">
                  {entry.status === 'skipped' ? 'Skipped: ' : entry.status === 'error' ? 'Failed: ' : ''}
                  {entry.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="jp-upload__summary" role="status" id="jp-upload-summary">
        {summary}
      </p>
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
