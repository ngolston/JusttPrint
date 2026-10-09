import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Copy, FolderOpen, Trash2 } from 'lucide-react';
import { dedup, settings, type DuplicateFile, type DuplicateGroup, type HashProgress } from '../api';
import { cx } from '../components/Button';
import { pickFolder } from '../components/FolderPicker';
import { fileIsUnderPreferredDirectory, pickDedupKeeperPath } from '../dedup-keeper.mjs';
import { exposeGlobal, onServerEvent, showMessage, type LibraryFilters } from '../page';
import { navigate } from '../shell/routes';
import { formatFileSize } from '../StatsDialog';
import { makeThumbnail } from '../thumbnails/pipeline';

declare global {
  interface Window {
    openDedup?: () => void;
  }
}

/** Fixed group height (header, 150px previews and the file lines), so the list can be virtualized. */
const ROW_HEIGHT = 352;
const OVERSCAN = 4;
const PREVIEW_CONCURRENCY = 4;
/** Copies drawn side by side per group; Easy, Keep this and Keep all still act on all of them. */
const SHOWN_COPIES = 24;

const isZipEntry = (filePath: string) => filePath.includes('::');

/** "cube copy.stl" and its folder "/library/Designer A" (for ZIP entries: the archive and the folder inside it). */
export function splitPath(filePath: string): { name: string; folder: string } {
  const inner = filePath.includes('::') ? filePath.split('::') : null;
  const target = inner ? inner[1] || '' : filePath;
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  const name = cut >= 0 ? target.slice(cut + 1) : target;
  const folder = inner ? `${inner[0]}${cut > 0 ? ` → ${target.slice(0, cut)}` : ''}` : (cut > 0 ? target.slice(0, cut) : '');
  return { name: name || filePath, folder };
}

/** Select every copy of a group except `keep` for deletion (ZIP entries are never selected). */
export function keepOnly(selected: Set<string>, group: DuplicateGroup, keep: string | null): Set<string> {
  const next = new Set(selected);
  for (const file of group.files) {
    if (file.filePath === keep || isZipEntry(file.filePath) || keep === null) next.delete(file.filePath);
    else next.add(file.filePath);
  }
  return next;
}

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

function Preview({ filePath }: { filePath: string }) {
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
    <div className="jp-dup-copy__preview">
      {image === undefined ? <div className="dedup-preview-loading">Loading preview…</div>
        : image ? <img src={image} alt="" /> : <div className="error-message">No preview</div>}
    </div>
  );
}

function CopyCard({ file, selected, preferred, onToggle, onKeep }: {
  file: DuplicateFile; selected: boolean; preferred: boolean; onToggle: (checked: boolean) => void; onKeep: () => void;
}) {
  const zip = isZipEntry(file.filePath);
  const { name, folder } = splitPath(file.filePath);
  return (
    <div className={cx('jp-dup-copy', selected && 'is-removed', zip && 'zip-entry', preferred && 'preferred-directory')}>
      <Preview filePath={file.filePath} />
      <div className="jp-dup-copy__body">
        <div className="jp-dup-copy__name" title={file.filePath}>{name}</div>
        <div className="jp-dup-copy__folder" title={folder}><FolderOpen size={13} aria-hidden="true" /><span>{folder || '—'}</span></div>
        <div className="jp-dup-copy__meta">
          <span className="jp-dup-copy__size">{formatFileSize(file.size || 0)}</span>
          {preferred && <span className="preferred-directory-badge jp-badge jp-badge--accent" title="This copy is inside the preferred directory. Easy keeps one copy from that folder.">Preferred</span>}
          {zip && <span className="zip-entry-badge jp-badge" title="Model in ZIP archive (cannot be deleted)">ZIP</span>}
        </div>
        <div className="jp-dup-copy__actions">
          <label className={cx('jp-dup-copy__remove', zip && 'is-disabled')} title={zip ? 'Cannot delete files inside ZIP archives' : 'Delete this copy with Delete Selected'}>
            <input type="checkbox" data-filepath={file.filePath} disabled={zip} checked={!zip && selected}
              onChange={(event) => onToggle(event.target.checked)} />
            <span>{selected ? 'Will be deleted' : 'Delete'}</span>
          </label>
          <button type="button" className="jp-btn jp-btn--secondary jp-btn--sm" onClick={onKeep} title="Keep this copy and select the others for deletion">Keep this</button>
        </div>
      </div>
    </div>
  );
}

/** One group of identical files side by side (spec §46): Keep this on any copy, or Keep all. */
function GroupRow({ group, selected, preferredDir, onToggle, onSelect }: {
  group: DuplicateGroup; selected: Set<string>; preferredDir: string;
  onToggle: (filePath: string, checked: boolean) => void; onSelect: (next: Set<string>) => void;
}) {
  const size = group.files[0]?.size || 0;
  const removing = group.files.filter((file) => selected.has(file.filePath)).length;
  // Same geometry: "geometry:<triangles>:<area>:…" (src/core/geometry-signature.js).
  const geometry = String(group.hash || '').startsWith('geometry:');
  const triangles = geometry ? Number(String(group.hash).split(':')[1]) : 0;
  const title = geometry ? `${group.files.length} files with the same geometry` : `${group.files.length} identical copies`;
  return (
    <div className="jp-dup-group" role="group" data-hash={group.hash} style={{ height: ROW_HEIGHT - 12, boxSizing: 'border-box' }}
      aria-label={`${title}: ${splitPath(group.files[0]?.filePath || '').name}`}>
      <header className="jp-dup-group__header">
        <span className="jp-dup-group__title">{title}</span>
        {geometry
          ? <span className="jp-dup-group__meta">{triangles.toLocaleString()} triangles • different files, same shape</span>
          : <span className="jp-dup-group__meta">{formatFileSize(size)} each • hash <code title={group.hash}>{String(group.hash || '').slice(0, 12)}</code></span>}
        {removing > 0 && <span className="jp-dup-group__removing">{removing} to delete</span>}
        <button type="button" className="jp-link jp-dup-group__keep-all" onClick={() => onSelect(keepOnly(selected, group, null))} disabled={!removing}>Keep all</button>
      </header>
      <div className="jp-dup-group__copies">
        {group.files.slice(0, SHOWN_COPIES).map((file) => (
          <CopyCard key={file.filePath} file={file} selected={selected.has(file.filePath)}
            preferred={!!preferredDir && fileIsUnderPreferredDirectory(file.filePath, preferredDir)}
            onToggle={(checked) => onToggle(file.filePath, checked)}
            onKeep={() => onSelect(keepOnly(selected, group, file.filePath))} />
        ))}
        {group.files.length > SHOWN_COPIES && (
          <div className="jp-dup-more">
            <strong>{(group.files.length - SHOWN_COPIES).toLocaleString()} more copies</strong>
            <span>Keep this and Easy also select these.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Only the groups in view (plus a few) are rendered; the spacer keeps the scroll height. */
function GroupList({ groups, selected, preferredDir, onToggle, onSelect, note }: {
  groups: DuplicateGroup[]; selected: Set<string>; preferredDir: string;
  onToggle: (filePath: string, checked: boolean) => void; onSelect: (next: Set<string>) => void; note: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const frame = useRef(0);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    list.scrollTop = 0;
    setScrollTop(0);
    const resize = new ResizeObserver(() => setHeight(list.clientHeight || 600));
    resize.observe(list);
    return () => resize.disconnect();
  }, [groups]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(groups.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  return (
    <div className="duplicate-groups jp-dup-list" ref={listRef} onScroll={() => {
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
      <div className="dedup-virtual-spacer" style={{ height: groups.length * ROW_HEIGHT, position: 'relative' }}>
        <div className="dedup-virtual-content" style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${start * ROW_HEIGHT}px)` }}>
          {groups.slice(start, end).map((group) => (
            <GroupRow key={group.hash || group.files[0].filePath} group={group} selected={selected} preferredDir={preferredDir}
              onToggle={onToggle} onSelect={onSelect} />
          ))}
        </div>
      </div>
    </div>
  );
}

type View =
  | { kind: 'loading'; text: string }
  | { kind: 'hashes'; progress: HashProgress; joined: boolean }
  | { kind: 'geometry'; progress: HashProgress }
  | { kind: 'ready'; groups: DuplicateGroup[]; generating: boolean }
  | { kind: 'error'; text: string };

const RUNNING_NOTE = 'Note: Hash generation is currently running in the background. Additional duplicate files may be found once the process completes.';

/**
 * Duplicates: groups of identical files (same hash), or of different files with the same
 * geometry (Same geometry: an STL and its 3MF, a re-export), in the library or the current view, side
 * by side, with Keep this / Keep all per group, Easy (keep one per group, preferring the
 * preferred directory) and Delete Selected, which always asks first. Offers to generate missing
 * hashes. Mounted while shown: as the #/duplicates page, or in the De-Dup dialog on phones.
 */
function Duplicates({ footer }: { footer: (actions: ReactNode) => ReactNode }) {
  const [view, setView] = useState<View>({ kind: 'loading', text: 'Loading duplicate files...' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<'current' | 'entire'>('entire');
  const [filters, setFilters] = useState<LibraryFilters | null>(null);
  const [includeZip, setIncludeZip] = useState(false);
  const [zipEnabled, setZipEnabled] = useState(false);
  const [preferredDir, setPreferredDir] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [mode, setMode] = useState<'files' | 'geometry'>('files');
  const modeRef = useRef<'files' | 'geometry'>('files');
  modeRef.current = mode;
  const mounted = useRef(true);
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
    const current = () => id === loadId.current && mounted.current;
    try {
      // Same geometry: fingerprints first (asked for, like hashes), then the groups.
      if (modeRef.current === 'geometry') {
        setView({ kind: 'loading', text: 'Comparing geometry...' });
        const zipOn = (await settings.get<string | null>('enableZipArchives').catch(() => null)) === '1';
        setZipEnabled(zipOn);
        const found = await dedup.geometryGroups(options.scopeFilters, zipOn && options.zip);
        if (!current()) return;
        if (found.running) {
          setView({ kind: 'geometry', progress: { processed: found.processed, total: found.total } });
          return;
        }
        if (found.missing > 0 && options.checkHashes) {
          const answer = await showMessage('Compare Geometry',
            `${found.missing} STL and 3MF models${options.scopeFilters ? ' in the current view' : ''} have not been compared by geometry yet. Read their shapes now? This takes a while for large files; you can leave the page meanwhile.`,
            ['Yes', 'No']);
          if (!current()) return;
          if (answer === 'Yes') {
            const started = await dedup.startGeometry(options.scopeFilters);
            setView({ kind: 'geometry', progress: { processed: 0, total: started.total } });
            return;
          }
        }
        setSelected(new Set());
        setView({ kind: 'ready', groups: found.groups, generating: false });
        return;
      }
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

  // Shown: start from the library's current filters (when any), and load.
  useEffect(() => {
    mounted.current = true;
    const current = window.getCurrentLibraryFilters?.() ?? null;
    const active = !!window.libraryFiltersAreActive?.(current);
    setFilters(active ? current : null);
    setScope(active ? 'current' : 'entire');
    settings.get<string | null>('dedupPreferredDirectory')
      .then((saved) => {
        savedPreferred.current = typeof saved === 'string' ? saved : '';
        setPreferredDir(savedPreferred.current);
      })
      .catch(() => {});
    void load({ checkHashes: true, scopeFilters: active ? current : null, zip: false });
    return () => {
      mounted.current = false;
      loadId.current += 1;
      waitingForHashes.current = false;
    };
  }, [load]);

  // Hash progress and completion arrive as server events while shown.
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
    // Geometry fingerprints: progress, then the groups.
    const stopGeometry = onServerEvent('geometry-progress', (progress: HashProgress & { running?: boolean }) => {
      if (modeRef.current !== 'geometry' || !progress) return;
      setView((previous) => (previous.kind === 'geometry' ? { ...previous, progress } : previous));
    });
    const stopGeometryDone = onServerEvent('geometry-complete', () => {
      if (modeRef.current === 'geometry') setTimeout(() => load({ checkHashes: false, ...optionsRef.current }), 300);
    });
    return () => { stopProgress(); stopComplete(); stopGeometry(); stopGeometryDone(); };
  }, [load]);

  function changeMode(next: 'files' | 'geometry') {
    setMode(next);
    modeRef.current = next;
    setSelected(new Set());
    load({ checkHashes: true, scopeFilters, zip: includeZip });
  }

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

  const actions = (
    <>
      <button type="button" id="dedup-easy-button" className="easy-button jp-btn jp-btn--secondary jp-btn--md" disabled={!groups.length}
        title="Select all but one per group. Keeps a copy in the preferred directory when one exists, otherwise an archived/ZIP copy."
        onClick={() => setSelected(easySelection(groups, preferredDir.trim()))}>Easy</button>
      <button type="button" id="dedup-clear-button" className="jp-btn jp-btn--ghost jp-btn--md" title="Clear all selections"
        onClick={() => setSelected(new Set())}>Clear</button>
      {groups.length > 0 && (
        <button type="button" id="delete-selected" className="danger-button jp-btn jp-btn--danger jp-btn--md" disabled={deleting || !selected.size} onClick={deleteSelected}>
          <Trash2 size={16} aria-hidden="true" />
          <span>{deleting ? 'Deleting...' : `Delete Selected${selected.size ? ` (${selected.size})` : ''}`}</span>
        </button>
      )}
    </>
  );

  return (
    <>
      <div className="jp-dup-options">
        <div className="dedup-scope" id="dedup-mode">
          <span className="dedup-scope-label">Find</span>
          <label className="dedup-scope-option" htmlFor="dedup-mode-files">
            <input type="radio" name="dedup-mode" id="dedup-mode-files" checked={mode === 'files'} onChange={() => changeMode('files')} />
            <span>Identical files</span>
          </label>
          <label className="dedup-scope-option" htmlFor="dedup-mode-geometry">
            <input type="radio" name="dedup-mode" id="dedup-mode-geometry" checked={mode === 'geometry'} onChange={() => changeMode('geometry')} />
            <span>Same geometry</span>
          </label>
          <p className="dedup-scope-summary">
            {mode === 'files' ? 'Byte-for-byte copies of a file.'
              : 'The same model in different files: an STL and its 3MF, a re-export, a copy moved or turned on the plate. Mirrored left and right parts are not matched. STL and 3MF, also inside ZIP files.'}
          </p>
        </div>
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
            <input type="text" id="dedup-preferred-directory-input" className="jp-input" placeholder="Folder whose copies should be kept (a path in the JusttPrint backend's container)"
              autoComplete="off" spellCheck={false} value={preferredDir}
              onChange={(event) => setPreferredDir(event.target.value)}
              onBlur={(event) => commitPreferred(event.target.value, true)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                commitPreferred(event.currentTarget.value, true, true);
              }} />
            <button type="button" id="dedup-preferred-browse" className="jp-btn jp-btn--secondary jp-btn--md" title="Choose the preferred directory"
              onClick={async () => {
                const dir = await pickFolder({ title: 'Preferred Directory', initial: preferredDir.trim() || undefined });
                if (dir) commitPreferred(dir, true, true);
              }}>Browse…</button>
            <button type="button" id="dedup-preferred-clear" className="jp-btn jp-btn--ghost jp-btn--md" title="Clear the preferred directory"
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
      </div>
      {footer(actions)}
      {view.kind === 'ready' && groups.length > 0 ? (
        <GroupList groups={groups} selected={selected} preferredDir={preferredDir.trim()} onToggle={toggle} onSelect={setSelected}
          note={view.generating ? RUNNING_NOTE : ''} />
      ) : (
        <div className="duplicate-groups jp-dup-list">
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
          {view.kind === 'geometry' && (
            <div className="dedup-status" id="dedup-geometry-progress">
              <div>Reading model shapes</div>
              <progress value={view.progress.total ? view.progress.processed : 0} max={view.progress.total || 1} />
              <div>{view.progress.processed}/{view.progress.total}{view.progress.failed ? ` (${view.progress.failed} could not be read)` : ''}</div>
              <p className="setting-description">Each STL and 3MF is read once and remembered until the file changes. You can leave this page; it keeps going.</p>
            </div>
          )}
          {view.kind === 'error' && <div className="error-message">{view.text}</div>}
          {view.kind === 'ready' && (
            <>
              {view.generating && <div className="hash-generation-warning">{RUNNING_NOTE}</div>}
              <div className="dedup-status jp-dup-none">
                <CheckCircle2 size={28} aria-hidden="true" />
                <span>No duplicate models found{scopeFilters ? ' in the current view' : ''}</span>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

const INTRO = 'Identical files are found by their file hash; Same geometry finds the same model saved as different files. Limit the scan to your current library filters so a large collection does not have to be processed all at once. Nothing is deleted until you confirm.';

/** Duplicates as a page of the JusttPrint 5 shell (#/duplicates). */
export function DuplicatesPage() {
  return (
    <div className="jp-page__inner jp-dup" id="dedup-page">
      <header className="jp-page__header">
        <h1 className="jp-page-title"><Copy size={24} aria-hidden="true" className="jp-dup__title-icon" />Duplicates</h1>
        <p className="jp-meta dedup-intro">{INTRO}</p>
      </header>
      <Duplicates footer={(actions) => <div className="jp-dup-actions dedup-actions">{actions}</div>} />
    </div>
  );
}

/** window.openDedup (Settings, the old menu actions): the Duplicates page. */
export function DuplicatesOpener() {
  useEffect(() => exposeGlobal('openDedup', () => navigate('duplicates')), []);
  return null;
}
