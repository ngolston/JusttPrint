import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { exposeGlobal } from '../page';
import { pathTreeRows } from './pathTree';

declare global {
  interface Window {
    /** The details panel's path rows (renderer.js setDetailsPath drives it). */
    detailsPath?: { show: (filePath: string) => void; clear: () => void };
    /** folder-tree.js: show one folder in the grid. */
    FolderTree?: { applyDirectoryFilter: (directory: string) => Promise<void> };
  }
}

const ICONS = { folder: 'path-tree-folder-icon', zip: 'path-tree-zip-icon', file: 'path-tree-file-icon' };

/**
 * The folders, ZIP and file of the shown model, rendered inside #path-tree-container (whose
 * data-file-path attribute renderer.js keeps). Clicking a folder shows that folder in the grid.
 */
export function DetailsPath() {
  const [container] = useState(() => document.getElementById('path-tree-container'));
  const [filePath, setFilePath] = useState<string | null>(null);

  useEffect(() => exposeGlobal('detailsPath', {
    show: (path: string) => setFilePath(path),
    clear: () => setFilePath(null)
  }), []);

  if (!container || filePath === null) return null;
  const rows = pathTreeRows(filePath);
  return createPortal(
    rows.length ? rows.map((row, index) => (
      <div key={index} className="path-tree-item" style={{ marginLeft: `${row.depth * 14}px` }}>
        <span className={`path-tree-icon ${ICONS[row.kind]}`} />
        {row.kind === 'file' ? <span className="path-tree-file">{row.label}</span> : (
          <span className="path-tree-folder" data-path={row.directory} title="Show this folder in the library"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (row.directory) window.FolderTree?.applyDirectoryFilter(row.directory);
            }}>{row.label}</span>
        )}
      </div>
    )) : <div className="path-tree-item">No path available</div>,
    container
  );
}
