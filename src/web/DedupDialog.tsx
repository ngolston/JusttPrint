import { useCallback, useEffect, useRef, useState } from 'react';
import { dedup, settings, type DuplicateGroup, type HashProgress } from './api';
import { ModalDialog } from './components/ModalDialog';
import { fileIsUnderPreferredDirectory, pickDedupKeeperPath } from './dedup-keeper.mjs';
import { exposeGlobal, onServerEvent, showMessage, type LibraryFilters } from './page';
import { formatFileSize } from './StatsDialog';
import { makeThumbnail } from './thumbnails/pipeline';

declare global {
  interface Window {
    openDedup?: () => void;
  }
}

/** Fixed row height (150px preview plus padding and border), so the list can be virtualized. */
const ROW_HEIGHT = 171;
const OVERSCAN = 6;
const PREVIEW_CONCURRENCY = 4;

const isZipEntry = (filePath: string) => filePath.includes('::');

/** Loads thumbnails a few at a time, newest request first, so scrolling stays responsive. */
const previewQueue = (() => {
  let running = 0;
  const waiting: (() => Promise<void>)[] = [];
  const pump = () => {
    while (running < PREVIEW_CONCURRENCY && waiting.length) {
      const job = waiting.pop()!;
      running += 1;
      job().finally(() => {
        running -= 1;
        pump();
      });
    }
  };
  return (job: () => Promise<void>) => {
    waiting.push(job);
    pump();
  };
})();

async function loadPreview(filePath: string): Promise<string | null> {
  const stored = await dedup.thumbnail(filePath).catch(() => null);
  if (stored && stored !== '3d.png' && stored.trim()) return stored;
  // No stored thumbnail: draw one in this browser.
  return (await makeThumbnail(filePath).catch(() => null))?.image ?? null;
}

function GroupPreview({ filePath }: { filePath: string }) {
  const [image, setImage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    previewQueue(async () => {
      if (!live) return;
      const result = await loadPreview(filePath);
      if (live) setImage(result);
    });
    return () => { live = false; };
  }, [filePath]);
  return (
    <div className="duplicate-preview">
      {image === undefined ? <div className="dedup-preview-loading">Loading preview…</div>
        : image ? <img src={image} alt="" /> : <div className="error-message">No preview available</div>}
    </div>
  );
}

function GroupRow({ group, selected, preferredDir, onToggle }: {
  group: DuplicateGroup; selected: Set<string>; preferredDir: string; onToggle: (filePath: string, checked: boolean) => void;
}) {
  return (
    <div className="duplicate-group" data-hash={group.hash} style={{ minHeight: ROW_HEIGHT - 1, boxSizing: 'border-box' }}>
      <GroupPreview filePath={group.files[0].filePath} />
      <div className="duplicate-files">
        <div className="duplicate-header">{group.files.length} duplicate files found</div>
        {group.files.map((file) => {
          const zip = isZipEntry(file.filePath);
          const preferred = !!preferredDir && fileIsUnderPreferredDirectory(file.filePath, preferredDir);
          return (
            <div key={file.filePath} className={['duplicate-file', zip && 'zip-entry', preferred && 'preferred-directory'].filter(Boolean).join(' ')}>
              <input type="checkbox" data-filepath={file.filePath} disabled={zip}
                title={zip ? 'Cannot delete files inside ZIP archives' : undefined}
                checked={!zip && selected.has(file.filePath)} onChange={(event) => onToggle(file.filePath, event.target.checked)} />
              <span className="duplicate-file-path">
                {preferred && <span className="preferred-directory-badge" title="This copy is inside the preferred directory. Easy keeps one copy from that folder.">Preferred</span>}
                {zip && <span className="zip-entry-badge" title="Model in ZIP archive (cannot be deleted)">ZIP</span>}
                <span>{file.filePath}</span>
              </span>
              <span className="duplicate-file-size">{formatFileSize(file.size || 0)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Only the rows in view (plus a few) are rendered; the spacer keeps the scroll height. */
function GroupList({ groups, selected, preferredDir, onToggle, note }: {
  groups: DuplicateGroup[]; selected: Set<string>; preferredDir: string; onToggle: (filePath: string, checked: boolean) => void; note: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const frame = useRef(0);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    list.scrollTop = 0;
    setScrollTop(0);
    const resize = new ResizeObserver(() => setHeight(list.clientHeight || 300));
    resize.observe(list);
    return () => resize.disconnect();
  }, [groups]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(groups.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  return (
    <div className="duplicate-groups" ref={listRef} onScroll={() => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setScrollTop(listRef.current?.scrollTop ?? 0);
      });
    }}>
      <div className="dedup-virtual-summary">
        <span className="dedup-group-count">{groups.length.toLocaleString()} duplicate group{groups.length === 1 ? '' : 's'}</span>
        <span className="dedup-selection-count">{selected.size > 0 ? ` · ${selected.size} selected` : ''}</span>
      </div>
      {note && <div className="hash-generation-warning">{note}</div>}
      <div className="dedup-virtual-spacer" style={{ height: groups.length * ROW_HEIGHT }}>
        <div className="dedup-virtual-content" style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${start * ROW_HEIGHT}px)` }}>
          {groups.slice(start, end).map((group) => (
            <GroupRow key={group.hash || group.files[0].filePath} group={group} selected={selected} preferredDir={preferredDir} onToggle={onToggle} />
          ))}
        </div>
      </div>
    </div>
  );
}

type View =
  | { kind: 'loading'; text: string }
  | { kind: 'hashes'; progress: HashProgress; joined: boolean }
  | { kind: 'ready'; groups: DuplicateGroup[]; generating: boolean }
  | { kind: 'error'; text: string };

const RUNNING_NOTE = 'Note: Hash generation is currently running in the background. Additional duplicate files may be found once the process completes.';

/**
 * Tools → De-Dup: groups of identical files (same hash) in the library or the current view,
 * with Easy (keep one per group, preferring the preferred directory) and Delete Selected.
 * Offers to generate missing hashes first. Registers window.openDedup.
 */
export function DedupDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<View>({ kind: 'loading', text: 'Loading duplicate files...' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<'current' | 'entire'>('entire');
  const [filters, setFilters] = useState<LibraryFilters | null>(null);
  const [includeZip, setIncludeZip] = useState(false);
  const [zipEnabled, setZipEnabled] = useState(false);
  const [preferredDir, setPreferredDir] = useState('');
  const [deleting, setDeleting] = useState(false);
  const loadId = useRef(0);
  const waitingForHashes = useRef(false);
  const easyOnLoad = useRef(false);
  const preferredRef = useRef('');
  preferredRef.current = preferredDir;
  const savedPreferred = useRef('');

  const easySelection = useCallback((groups: DuplicateGroup[], dir: string) => {
    const next = new Set<string>();
    for (const group of groups) {
      const keeper = pickDedupKeeperPath(group.files, dir);
      for (const file of group.files) {
        if (!isZipEntry(file.filePath) && file.filePath !== keeper) next.add(file.filePath);
      }
    }
    return next;
  }, []);

  /** Loads the duplicate groups; with checkHashes, first offers to hash models that have none. */
  const load = useCallback(async (options: { checkHashes: boolean; scopeFilters: LibraryFilters | null; zip: boolean }) => {
    const id = ++loadId.current;
    const current = () => id === loadId.current && !!dialogRef.current?.open;
    try {
      if (options.checkHashes) {
        setView({ kind: 'loading', text: 'Checking file hashes...' });
        const missing = await dedup.modelsWithoutHash(options.scopeFilters);
        if (!current()) return;
        if (missing > 0) {
          if (await dedup.isGeneratingHashes()) {
            waitingForHashes.current = true;
            setView({ kind: 'hashes', progress: { processed: 0, total: missing }, joined: true });
            return;
          }
          const answer = await showMessage('Generate File Hashes',
            `${missing} models${options.scopeFilters ? ' in the current view' : ''} don't have file hashes which are needed for de-duplication. Would you like to generate the hashes now?`,
            ['Yes', 'No']);
          if (!current()) return;
          if (answer === 'Yes') {
            waitingForHashes.current = true;
            setView({ kind: 'hashes', progress: { processed: 0, total: missing }, joined: false });
            const result = await dedup.generateHashes(options.scopeFilters);
            if (result?.alreadyRunning) setView({ kind: 'hashes', progress: { processed: 0, total: missing }, joined: true });
            if (result?.started || result?.alreadyRunning) return; // The progress events reload the list when hashing is done.
            waitingForHashes.current = false;
          }
        }
      }
      setView({ kind: 'loading', text: 'Analyzing duplicates...' });
      const zipSetting = await settings.get<string | null>('enableZipArchives').catch(() => null);
      const zip = zipSetting === '1' && options.zip;
      setZipEnabled(zipSetting === '1');
      const [groups, generating] = await Promise.all([
        dedup.groups({ includeZip: zip, filters: options.scopeFilters || undefined }),
        dedup.isGeneratingHashes().catch(() => false)
      ]);
      if (!current()) return;
      setSelected((previous) => {
        if (easyOnLoad.current && preferredRef.current) {
          easyOnLoad.current = false;
          return easySelection(groups, preferredRef.current);
        }
        // Keep selections that still exist after a reload.
        const present = new Set(groups.flatMap((group) => group.files.map((file) => file.filePath)));
        return new Set([...previous].filter((filePath) => present.has(filePath)));
      });
      setView({ kind: 'ready', groups, generating });
    } catch (error) {
      console.error('Error loading duplicates:', error);
      if (current()) setView({ kind: 'error', text: 'Failed to load duplicate files' });
    }
  }, [easySelection]);

  const scopeFilters = scope === 'current' ? filters : null;
  const optionsRef = useRef({ scopeFilters, zip: includeZip });
  optionsRef.current = { scopeFilters, zip: includeZip };

  useEffect(() => exposeGlobal('openDedup', () => {
    const current = window.getCurrentLibraryFilters?.() ?? null;
    const active = !!window.libraryFiltersAreActive?.(current);
    const nextScope = active ? 'current' : 'entire';
    setFilters(active ? current : null);
    setScope(nextScope);
    setIncludeZip(false);
    setSelected(new Set());
    easyOnLoad.current = false;
    settings.get<string | null>('dedupPreferredDirectory')
      .then((saved) => {
        savedPreferred.current = typeof saved === 'string' ? saved : '';
        setPreferredDir(savedPreferred.current);
      })
      .catch(() => {});
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    load({ checkHashes: true, scopeFilters: active ? current : null, zip: false });
  }), [load]);

  // Hash progress and completion arrive as server events while the dialog is open.
  useEffect(() => {
    const finish = () => {
      if (!waitingForHashes.current) return;
      waitingForHashes.current = false;
      setTimeout(() => load({ checkHashes: false, ...optionsRef.current }), 500);
    };
    const stopProgress = onServerEvent('hash-generation-progress', (progress: HashProgress) => {
      if (!waitingForHashes.current || !progress) return;
      setView((previous) => (previous.kind === 'hashes' ? { ...previous, progress } : previous));
      if (progress.processed >= progress.total) finish();
    });
    const stopComplete = onServerEvent('hash-generation-complete', (result: { failed?: number; total?: number; firstError?: string } = {}) => {
      if (result.failed && result.failed === result.total) {
        showMessage('Warning', `All file hashes failed to generate.${result.firstError ? ` ${result.firstError}` : ' This may be due to network issues or file access problems.'}`);
      }
      finish();
    });
    return () => { stopProgress(); stopComplete(); };
  }, [load]);

  function changeScope(next: 'current' | 'entire') {
    setScope(next);
    setSelected(new Set());
    load({ checkHashes: true, scopeFilters: next === 'current' ? filters : null, zip: includeZip });
  }

  function changeIncludeZip(next: boolean) {
    setIncludeZip(next);
    load({ checkHashes: false, scopeFilters, zip: next });
  }

  /** Saves the preferred directory; a new one (or Enter) also runs Easy with it. */
  function commitPreferred(dir: string, applyEasy: boolean, force = false) {
    const next = dir.trim();
    setPreferredDir(next);
    if (next === savedPreferred.current && !force) return;
    savedPreferred.current = next;
    if (force) applyEasy = true;
    settings.save('dedupPreferredDirectory', next).catch((error) => console.error('Error saving de-dup preferred directory:', error));
    if (applyEasy && next) {
      if (view.kind === 'ready') setSelected(easySelection(view.groups, next));
      else easyOnLoad.current = true;
    }
  }

  function toggle(filePath: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  }

  async function deleteSelected() {
    const files = [...selected].filter((filePath) => filePath && !isZipEntry(filePath));
    if (!files.length) {
      await showMessage('No Selection', 'Please select files to delete');
      return;
    }
    const names = files.slice(0, 5).map((filePath) => filePath.split(/[/\\]/).pop()).join('\n');
    const more = files.length > 5 ? `\n... and ${files.length - 5} more` : '';
    if (await showMessage('Confirm Delete',
      `Are you sure you want to DELETE ${files.length} files?\nThis cannot be undone!\n\nFiles:\n${names}${more}`, ['Yes', 'No']) !== 'Yes') return;
    setDeleting(true);
    try {
      const failed: string[] = [];
      for (const filePath of files) {
        if (!await dedup.deleteFile(filePath).catch(() => false)) failed.push(filePath);
      }
      if (failed.length) {
        await showMessage('Error', `Failed to delete ${failed.length} file${failed.length === 1 ? '' : 's'}:\n${failed.slice(0, 5).join('\n')}`);
      }
      setSelected(new Set(failed));
      window.refreshAfterDedupDelete?.().catch((error) => console.error('Grid refresh after De-Dup delete:', error));
      await load({ checkHashes: false, scopeFilters, zip: includeZip });
    } finally {
      setDeleting(false);
    }
  }

  const hasFilters = !!filters;
  const groups = view.kind === 'ready' ? view.groups : [];
  const scopeSummary = !hasFilters
    ? 'Apply a library filter (designer, tags, search, …) to de-dup only that subset.'
    : scope === 'current'
      ? (() => {
        const label = window.describeLibraryFilters?.(filters) || '';
        return label ? `De-dupping models matching: ${label}` : 'De-dupping the current library view.';
      })()
      : 'De-dupping the entire library.';

  return (
    <ModalDialog id="dedup-dialog" className="dedup-dialog" title="Duplicate Files" dialogRef={dialogRef} fullscreenToggle
      onClose={() => { loadId.current += 1; waitingForHashes.current = false; setView({ kind: 'loading', text: 'Loading duplicate files...' }); }}
      description={<p className="dedup-intro">De-duplication is performed using the file hash to ensure that only identical files are considered duplicates. Limit the scan to your current library filters so a large collection does not have to be processed all at once.</p>}
      footer={<button type="button" id="close-dedup" onClick={() => dialogRef.current?.close()}>Close</button>}>
      <div id="dedup-scope-container" className="dedup-scope">
        <span className="dedup-scope-label">Scope</span>
        <label className={`dedup-scope-option${hasFilters ? '' : ' disabled'}`} htmlFor="dedup-scope-current">
          <input type="radio" name="dedup-scope" id="dedup-scope-current" value="current" disabled={!hasFilters}
            checked={scope === 'current'} onChange={() => changeScope('current')} />
          <span>Current view</span>
        </label>
        <label className="dedup-scope-option" htmlFor="dedup-scope-entire">
          <input type="radio" name="dedup-scope" id="dedup-scope-entire" value="entire" checked={scope === 'entire'} onChange={() => changeScope('entire')} />
          <span>Entire library</span>
        </label>
        <p id="dedup-scope-summary" className="dedup-scope-summary">{scopeSummary}</p>
      </div>
      <div id="dedup-preferred-directory" className="dedup-preferred">
        <label className="dedup-scope-label" htmlFor="dedup-preferred-directory-input">Preferred directory</label>
        <div className="dedup-preferred-row">
          <input type="text" id="dedup-preferred-directory-input" placeholder="Folder whose copies should be kept (a path on the server)"
            autoComplete="off" spellCheck={false} value={preferredDir}
            onChange={(event) => setPreferredDir(event.target.value)}
            onBlur={(event) => commitPreferred(event.target.value, true)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commitPreferred(event.currentTarget.value, true, true);
            }} />
          <button type="button" id="dedup-preferred-clear" className="modal-fullscreen-toggle" title="Clear the preferred directory"
            onClick={() => commitPreferred('', false)}>Clear path</button>
        </div>
        <p className="dedup-scope-summary">Easy keeps one copy from this folder, including subfolders, and selects the other duplicates.</p>
      </div>
      {zipEnabled && (
        <div id="include-zip-container" className="dedup-include-zip">
          <label>
            <input type="checkbox" id="include-zipped-models" checked={includeZip} onChange={(event) => changeIncludeZip(event.target.checked)} />
            <span>Include Zipped Models</span>
          </label>
        </div>
      )}
      <div className="dialog-buttons dedup-actions">
        <button type="button" id="dedup-easy-button" className="easy-button" disabled={!groups.length}
          title="Select all but one per group. Keeps a copy in the preferred directory when one exists, otherwise an archived/ZIP copy."
          onClick={() => setSelected(easySelection(groups, preferredDir.trim()))}>Easy</button>
        <button type="button" id="dedup-clear-button" className="modal-fullscreen-toggle" title="Clear all selections"
          onClick={() => setSelected(new Set())}>Clear</button>
        {groups.length > 0 && (
          <button type="button" id="delete-selected" className="danger-button" disabled={deleting} onClick={deleteSelected}>
            {deleting ? 'Deleting...' : 'Delete Selected'}
          </button>
        )}
      </div>
      {view.kind === 'ready' && groups.length > 0 ? (
        <GroupList groups={groups} selected={selected} preferredDir={preferredDir.trim()} onToggle={toggle} note={view.generating ? RUNNING_NOTE : ''} />
      ) : (
        <div className="duplicate-groups">
          {view.kind === 'loading' && <div className="dedup-status"><div className="dedup-spinner" />{view.text}</div>}
          {view.kind === 'hashes' && (
            <div className="dedup-status" id="dedup-hash-progress">
              <div>Generating File Hashes</div>
              <progress value={view.progress.total ? view.progress.processed : 0} max={view.progress.total || 1} />
              <div>
                {view.progress.processed}/{view.progress.total}
                {view.progress.success !== undefined && view.progress.failed !== undefined
                  ? ` (${view.progress.success} succeeded, ${view.progress.failed} failed)` : ''}
              </div>
              <p className="setting-description">
                {view.joined ? 'Hash generation is already running in the background. Progress will be shown here.'
                  : 'File hashes are needed for de-duplication. This may take some time for large files.'}
              </p>
            </div>
          )}
          {view.kind === 'error' && <div className="error-message">{view.text}</div>}
          {view.kind === 'ready' && (
            <>
              {view.generating && <div className="hash-generation-warning">{RUNNING_NOTE}</div>}
              <div className="dedup-status">No duplicate models found{scopeFilters ? ' in the current view' : ''}</div>
            </>
          )}
        </div>
      )}
    </ModalDialog>
  );
}
