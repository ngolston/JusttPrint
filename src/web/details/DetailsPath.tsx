import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { folderTreeActions, showFolder } from '../folders/store';
import { exposeGlobal } from '../page';
import { pathTreeRows } from './pathTree';

declare global {
  interface Window {
    /** The details panel's path rows (library/details.ts drives it). */
    detailsPath?: { show: (filePath: string) => void; clear: () => void };
  }
}

const ICONS = { folder: 'path-tree-folder-icon', zip: 'path-tree-zip-icon', file: 'path-tree-file-icon' };

/**
 * The folders, ZIP and file of the shown model, rendered inside #path-tree-container (whose
 * data-file-path attribute library/details.ts keeps). Clicking a folder shows that folder in the grid;
 * the ☰ beside it reveals the model's folder in the folder tree.
 */
export function DetailsPath() {
  const [container] = useState(() => document.getElementById('path-tree-container'));
  const [revealSlot] = useState(() => document.getElementById('details-reveal-slot'));
  const [filePath, setFilePath] = useState<string | null>(null);

  useEffect(
    () =>
      exposeGlobal('detailsPath', {
        show: (path: string) => setFilePath(path),
        clear: () => setFilePath(null)
      }),
    []
  );

  const reveal =
    revealSlot &&
    createPortal(
      <button
        type="button"
        id="reveal-in-folders-button"
        className="icon-button"
        title="Reveal in folders"
        onClick={(event) => {
          event.preventDefault();
          if (filePath) folderTreeActions.reveal(filePath);
        }}
      >
        ☰
      </button>,
      revealSlot
    );
  if (!container || filePath === null) return reveal;
  const rows = pathTreeRows(filePath);
  return (
    <>
      {reveal}
      {createPortal(
        rows.length ? (
          rows.map((row, index) => (
            <div key={index} className="path-tree-item" style={{ marginLeft: `${row.depth * 14}px` }}>
              <span className={`path-tree-icon ${ICONS[row.kind]}`} />
              {row.kind === 'file' ? (
                <span className="path-tree-file">{row.label}</span>
              ) : (
                <span
                  className="path-tree-folder"
                  data-path={row.directory}
                  title="Show this folder in the library"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (row.directory) showFolder(row.directory);
                  }}
                >
                  {row.label}
                </span>
              )}
            </div>
          ))
        ) : (
          <div className="path-tree-item">No path available</div>
        ),
        container
      )}
    </>
  );
}
