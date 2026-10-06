import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FolderTree as FolderTreeIcon } from 'lucide-react';
import { getFilterState, subscribeFilters } from '../filters/store';
import { FOLDERS, SIDEBAR, getWidth, loadSavedWidths, startResize } from './layout';
import { folderTreeActions, getFolderTreeState, initFolderTree, showFolder, subscribeFolderTree } from './store';
import { findNode, folderName, matchesQuery, nodeIs, pathsEqual, toDirectoryFilter, type FolderNode } from './tree';

function useFolderTree() {
  return useSyncExternalStore(subscribeFolderTree, getFolderTreeState);
}

function useDirectory() {
  return useSyncExternalStore(subscribeFilters, () => getFilterState().directory);
}

function TreeNode({ node, query, selected }: { node: FolderNode; query: string; selected: string }) {
  const { expanded } = useFolderTree();
  if (query && !matchesQuery(node, query)) return null;
  const kids = node.children || [];
  const open = !kids.length || !!query || expanded.has(node.path);
  return (
    <div className="folder-tree-node" data-path={node.path}>
      <button type="button" className={`folder-tree-row${selected && nodeIs(node, selected) ? ' is-selected' : ''}`}
        data-path={node.path} title={node.tooltip || node.path}
        onClick={(event) => {
          event.preventDefault();
          if (kids.length && (event.target as HTMLElement).closest('[data-twist]')) folderTreeActions.toggleExpanded(node.path);
          else folderTreeActions.pick(node);
        }}>
        <span className={`folder-tree-twist${kids.length ? '' : ' is-empty'}`} data-twist="1">{kids.length ? (open ? '▾' : '▸') : '•'}</span>
        <span className={`folder-tree-icon${node.isBundle ? ' is-bundle' : ''}`} aria-hidden="true" />
        <span className="folder-tree-label">{node.label}</span>
        <span className="folder-tree-count">{Number(node.count) || 0}</span>
      </button>
      {kids.length > 0 && open && (
        <div className="folder-tree-children">
          {kids.map((child) => <TreeNode key={child.path} node={child} query={query} selected={selected} />)}
        </div>
      )}
    </div>
  );
}

/** The tree with its search box. Scrolls to a revealed folder. */
function TreeView({ id, searchId, wrapSearch, autoFocus }: { id: string; searchId: string; wrapSearch: boolean; autoFocus?: boolean }) {
  const { forest, reveal, revealSeq } = useFolderTree();
  const selected = useDirectory();
  const [query, setQuery] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reveal) return;
    treeRef.current?.querySelector(`.folder-tree-row[data-path="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: 'center' });
  }, [revealSeq]);

  const search = (
    <input type="search" id={searchId} placeholder="Find folder..." autoComplete="off" value={query} autoFocus={autoFocus}
      onChange={(e) => setQuery(e.target.value)} />
  );
  return (
    <>
      {wrapSearch ? <div id={`${searchId}-wrap`} className="folder-tree-search-wrap">{search}</div> : search}
      <div id={id} className="folder-tree" ref={treeRef}>
        {forest.roots.length
          ? forest.roots.map((root) => <TreeNode key={root.path} node={root} query={query} selected={selected} />)
          : <div className="folder-tree-row" style={{ opacity: 0.6 }}>No scanned folders yet</div>}
      </div>
    </>
  );
}

/** "Folders:" in the sidebar: a select of the roots and recent picks, and ☰ for the tree popover. */
function FolderSelect({ container, buttonRef }: { container: HTMLElement; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const { forest, recent, popoverOpen } = useFolderTree();
  const directory = useDirectory();
  const options = [...forest.roots, ...recent].map(toDirectoryFilter);
  const current = options.find((value) => pathsEqual(value, directory)) ?? directory;
  return createPortal(
    <div className="form-group">
      <label htmlFor="folder-select">Folders:</label>
      <div className="dropdown-with-list">
        <select id="folder-select" value={current}
          onChange={(e) => {
            const value = e.target.value;
            showFolder(value, value ? findNode(forest.roots, value) || recent.find((item) => pathsEqual(toDirectoryFilter(item), value)) : null);
          }}>
          <option value="">All folders</option>
          {forest.roots.length > 0 && (
            <optgroup label="Library roots">
              {forest.roots.map((root) => <option key={root.path} value={toDirectoryFilter(root)}>{root.label}</option>)}
            </optgroup>
          )}
          {recent.length > 0 && (
            <optgroup label="Recent">
              {recent.map((item) => <option key={item.path} value={toDirectoryFilter(item)}>{item.label || item.path}</option>)}
            </optgroup>
          )}
          {current && !options.includes(current) && <option value={current}>{folderName(current)}</option>}
        </select>
        <button type="button" id="folder-tree-button" ref={buttonRef} className="list-button icon-button folder-tree-button" title="Browse folder tree"
          onClick={(e) => { e.preventDefault(); folderTreeActions.setPopoverOpen(!popoverOpen); }}>☰</button>
      </div>
    </div>,
    container
  );
}

/** The tree in a popover under the ☰ button. Closes on a pick, a click outside, or Escape. */
function FolderPopover({ anchor }: { anchor: RefObject<HTMLButtonElement | null> }) {
  const { popoverOpen } = useFolderTree();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Below the button, or above it when there is no room; kept on screen.
  useLayoutEffect(() => {
    if (!popoverOpen || !anchor.current || !ref.current) {
      setPosition(null);
      return;
    }
    const rect = anchor.current.getBoundingClientRect();
    const width = getWidth(FOLDERS);
    const height = ref.current.offsetHeight || 360;
    const left = rect.left + width > window.innerWidth - 8 ? Math.max(8, window.innerWidth - width - 8) : rect.left;
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    setPosition({ left, top });
  }, [popoverOpen]);

  useEffect(() => {
    if (!popoverOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (document.body.classList.contains('is-panel-resizing')) return;
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) folderTreeActions.setPopoverOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') folderTreeActions.setPopoverOpen(false); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [popoverOpen]);

  if (!popoverOpen) return null;
  const maxWidth = () => {
    const left = ref.current?.getBoundingClientRect().left ?? 0;
    return Math.min(FOLDERS.max, Math.max(FOLDERS.min, window.innerWidth - left - 8));
  };
  return createPortal(
    <div id="folder-tree-popover" className="folder-tree-popover" role="dialog" aria-label="Folder tree" ref={ref}
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}>
      <TreeView id="folder-tree-popover-tree" searchId="folder-tree-search" wrapSearch={false} autoFocus />
      <div id="folder-tree-resize-handle" className="panel-resize-handle" role="separator" aria-orientation="vertical"
        aria-label="Resize folders panel" title="Drag to resize folders panel" onMouseDown={startResize(FOLDERS, maxWidth)} />
    </div>,
    document.body
  );
}

/** The tree beside the grid (#folder-rail), with its toggle in the view switcher. */
function FolderRail({ rail, toggleSlot }: { rail: HTMLElement; toggleSlot: HTMLElement | null }) {
  const { railOpen } = useFolderTree();
  useEffect(() => {
    rail.classList.toggle('hidden', !railOpen);
    rail.hidden = !railOpen;
    document.body.classList.toggle('folder-rail-open', railOpen);
  }, [rail, railOpen]);
  return (
    <>
      {createPortal(
        <>
          <div className="folder-rail-header">
            <span>Folders</span>
            <button type="button" id="folder-rail-close" className="icon-button" title="Hide folder tree"
              onClick={() => folderTreeActions.setRailOpen(false)}>×</button>
          </div>
          <TreeView id="folder-rail-tree" searchId="folder-rail-search" wrapSearch />
          <div id="folder-rail-resize-handle" className="panel-resize-handle" role="separator" aria-orientation="vertical"
            aria-label="Resize folders panel" title="Drag to resize folders panel" onMouseDown={startResize(FOLDERS)} />
        </>,
        rail
      )}
      {toggleSlot && createPortal(
        <button type="button" id="folder-rail-toggle" className={`folder-rail-toggle${railOpen ? ' active' : ''}`} title="Show folder tree beside the grid"
          aria-pressed={railOpen} onClick={() => folderTreeActions.setRailOpen(!railOpen)}>
          <FolderTreeIcon className="folder-rail-toggle__icon" size={16} aria-hidden="true" />
          <span>Folders</span>
        </button>,
        toggleSlot
      )}
    </>
  );
}

/** The sidebar's Folders control, the folder tree popover and rail, and the sidebar's resize handle. */
export function FolderTree() {
  const [slots] = useState(() => ({
    select: document.getElementById('sidebar-folders-slot'),
    rail: document.getElementById('folder-rail'),
    toggle: document.getElementById('folder-rail-toggle-slot'),
    sidebarHandle: document.getElementById('sidebar-resize-slot')
  }));
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    initFolderTree();
    loadSavedWidths();
  }, []);

  return (
    <>
      {slots.select && <FolderSelect container={slots.select} buttonRef={buttonRef} />}
      <FolderPopover anchor={buttonRef} />
      {slots.rail && <FolderRail rail={slots.rail} toggleSlot={slots.toggle} />}
      {slots.sidebarHandle && createPortal(
        <div id="sidebar-resize-handle" className="panel-resize-handle sidebar-resize-handle" role="separator" aria-orientation="vertical"
          aria-label="Resize sidebar" title="Drag to resize sidebar" onMouseDown={startResize(SIDEBAR)} />,
        slots.sidebarHandle
      )}
    </>
  );
}
