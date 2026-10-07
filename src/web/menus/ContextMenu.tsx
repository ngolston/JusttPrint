import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { callAction, downloadUrl } from '../api';
import { copyText, exposeGlobal, showMessage } from '../page';

/** One entry of a menu the server built (src/server/ipc/context-menu.js). */
export interface ContextMenuItem {
  type?: 'separator';
  label?: string;
  enabled?: boolean;
  submenu?: ContextMenuItem[];
  /** Run in this browser instead of on the server: Download, Copy Path, or Send to Slicer through the helper. */
  clientAction?: ClientAction;
}

type ClientAction =
  | { type: 'download'; filePath: string }
  | { type: 'copy-paths'; filePaths: string[] }
  | { type: 'open-in-slicer' | 'open-in-orcaslicer' | 'slicer-error'; [key: string]: unknown };

/** Save a library file (or a ZIP entry) through /api/download. */
function downloadFile(filePath: string) {
  const link = document.createElement('a');
  link.href = downloadUrl(filePath);
  link.download = '';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 100);
}

/** Copy the paths, one per line; show them when the browser refuses. */
async function copyPaths(filePaths: string[]) {
  const text = filePaths.join('\n');
  if (await copyText(text)) return;
  await showMessage('Copy Path', `The browser did not allow copying. Select the path${filePaths.length === 1 ? '' : 's'} below and copy:\n\n${text}`);
}

export interface ContextMenuData {
  type: 'html-menu';
  requestId: string;
  items: ContextMenuItem[];
  filePaths?: string[];
}

interface Open {
  menu: ContextMenuData;
  x: number;
  y: number;
  /** An × in the corner (the card's ⋯ button opens the menu without a pointer to click away with). */
  showClose: boolean;
}

declare global {
  interface Window {
    /** The model menu: ask the server for the menu for one model, several, or a group, and show it at x, y. */
    contextMenu?: { show: (target: unknown, x: number, y: number, options?: { showClose?: boolean }) => Promise<void> };
    JusttPrintSlicerProtocol?: { launchFromCommand: (command: unknown) => void };
  }
}

const basename = (filePath: string) => filePath.split(/[/\\]/).pop() || filePath;

/** Delete from Disk and Remove from Library ask first, listing the files. */
async function confirmDestructive(label: string | undefined, menu: ContextMenuData): Promise<boolean> {
  if (label !== 'Delete from Disk' && label !== 'Remove from Library') return true;
  const paths = (menu.filePaths || []).filter(Boolean);
  const count = paths.length || 1;
  const files = paths.slice(0, 20).map(basename).join('\n');
  const more = paths.length > 20 ? `\n... and ${paths.length - 20} more file${paths.length - 20 === 1 ? '' : 's'}` : '';
  const s = count === 1 ? '' : 's';
  const isDelete = label === 'Delete from Disk';
  const message = isDelete
    ? `Are you sure you want to DELETE ${count} file${s} from disk?\nThis will permanently delete the files and cannot be undone!\n\nFiles:\n${files}${more}`
    : `Are you sure you want to remove ${count} file${s} from the library?\nFiles will remain on disk but will be removed from JusttPrint.\n\nFiles:\n${files}${more}`;
  return (await showMessage(isDelete ? 'Confirm Delete' : 'Confirm Remove', message, ['Yes', 'No'])) === 'Yes';
}

function Submenu({ items, run }: { items: ContextMenuItem[]; run: (item: ContextMenuItem, subIndex: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  // Keep it on screen: open to the left at the right edge, and move up at the bottom.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const next: CSSProperties = {};
    if (rect.right > window.innerWidth) Object.assign(next, { left: 'auto', right: '100%', marginLeft: 0, marginRight: 2 });
    if (rect.bottom > window.innerHeight) next.top = -(rect.bottom - window.innerHeight);
    setStyle(next);
  }, []);
  return (
    <div className="html-context-menu-submenu" ref={ref}
      style={style}>
      {items.map((sub, i) => (
        <div key={i} className={`html-context-menu-subitem${sub.enabled ? '' : ' is-disabled'}`}
          onClick={(e) => { e.stopPropagation(); if (sub.enabled) run(sub, i); }}>{sub.label}</div>
      ))}
    </div>
  );
}

/** The model menu (#html-context-menu) at the pointer. */
export function ContextMenu() {
  const [open, setOpen] = useState<Open | null>(null);
  const [submenu, setSubmenu] = useState<number | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(null);

  useEffect(() => exposeGlobal('contextMenu', {
    show: async (target: unknown, x: number, y: number, options?: { showClose?: boolean }) => {
      const menu = await callAction<ContextMenuData | null>('show-context-menu', target);
      if (menu?.type === 'html-menu') {
        setSubmenu(null);
        setPosition(null);
        setOpen({ menu, x, y, showClose: !!options?.showClose });
      }
    }
  }), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // At the pointer, moved back on screen when it would overflow.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let left = open.x;
    let top = open.y;
    if (left + rect.width > window.innerWidth) left = Math.max(8, open.x - rect.width);
    if (top + rect.height > window.innerHeight) top = Math.max(8, open.y - rect.height);
    setPosition({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [open]);

  if (!open) return null;
  const { menu } = open;

  const run = async (item: ContextMenuItem, index: number, subIndex: number | null) => {
    try {
      const action = item.clientAction;
      if (action?.type === 'download') return downloadFile(action.filePath);
      if (action?.type === 'copy-paths') return await copyPaths(action.filePaths);
      if (action && window.JusttPrintSlicerProtocol) {
        window.JusttPrintSlicerProtocol.launchFromCommand(action);
        return;
      }
      if (!(await confirmDestructive(item.label, menu))) return;
      await callAction('execute-context-menu-action', menu.requestId, index, subIndex);
    } catch (error) {
      console.error('Error executing menu action:', error);
      await showMessage('Error', `Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      close();
    }
  };

  const dismiss = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  return createPortal(
    <>
      <div id="html-context-menu-backdrop" style={{ position: 'fixed', inset: 0, zIndex: 12999, background: 'transparent' }}
        onPointerDown={dismiss} onClick={dismiss} />
      <div id="html-context-menu" ref={ref} className={`html-context-menu${open.showClose ? ' html-context-menu-with-close' : ''}`}
        style={{ left: position?.left ?? open.x, top: position?.top ?? open.y, visibility: position ? undefined : 'hidden' }}>
        {open.showClose && (
          <button type="button" className="html-context-menu-close" onClick={(e) => { e.stopPropagation(); close(); }}>x</button>
        )}
        {menu.items.map((item, index) => {
          if (item.type === 'separator') return <div key={index} className="html-context-menu-separator" />;
          const hasSubmenu = !!item.enabled && !!item.submenu?.length;
          return (
            <div key={index} className={`html-context-menu-item${item.enabled ? '' : ' is-disabled'}`}
              style={hasSubmenu ? { paddingRight: 30 } : undefined}
              onMouseEnter={() => { if (hasSubmenu) setSubmenu(index); }}
              onMouseLeave={() => { if (hasSubmenu) setSubmenu(null); }}
              onClick={(e) => {
                e.stopPropagation();
                if (!item.enabled) return;
                if (hasSubmenu) setSubmenu(submenu === index ? null : index);
                else run(item, index, null);
              }}>
              {item.label}
              {hasSubmenu && <span className="html-context-menu-arrow">▶</span>}
              {hasSubmenu && submenu === index && <Submenu items={item.submenu!} run={(sub, subIndex) => run(sub, index, subIndex)} />}
            </div>
          );
        })}
      </div>
    </>,
    document.body
  );
}
