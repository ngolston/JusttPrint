import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { exposeGlobal } from '../page';
import { plural, refreshTotal, setViewCount, useModelCounts } from './counts';
import { runSearch } from './search';
import { filterActions } from './store';

declare global {
  interface Window {
    /** renderer.js: the STL Home directories from settings. */
    getStlHomeDirectories?: () => Promise<string[]>;
    /** renderer.js: scan a folder the user types in, or every STL Home directory. */
    scanDirectory?: () => Promise<void>;
    runScanSTLHome?: () => void;
    /** renderer.js: re-read every model and redraw the grid. */
    forceGridRefresh?: () => Promise<void>;
    disableGridRefresh?: boolean;
    /** For renderer.js: the number of models in the grid, and whether a scan is running. */
    sidebarStatus?: { setViewCount: (count: number) => void; setScanning: (scanning: boolean) => void };
  }
}

/** Clear every filter and show the whole library again. */
export async function viewEntireLibrary() {
  try {
    window.disableGridRefresh = false;
    const grid = document.querySelector<HTMLElement & { currentModels?: unknown }>('.file-grid');
    if (grid) grid.currentModels = null;
    filterActions.clearAll();
    if (window.forceGridRefresh) await window.forceGridRefresh();
    else await runSearch({ force: true });
  } catch (error) {
    console.error('Error loading library:', error);
    await window.electron?.showMessage?.('Error', 'Failed to load library.');
  }
}

/**
 * The top of the sidebar under the logo: model counts, the tool buttons, Scan Directory,
 * Scan STL Home (only when STL Home directories are set) and View Entire Library.
 */
export function SidebarActions() {
  const [container] = useState(() => document.getElementById('sidebar-actions-slot'));
  const { view: viewCount, total } = useModelCounts();
  const [scanning, setScanning] = useState(false);
  const [hasStlHome, setHasStlHome] = useState(false);

  useEffect(() => {
    const checkStlHome = async () => {
      try {
        setHasStlHome(((await window.getStlHomeDirectories?.()) || []).length > 0);
      } catch {
        setHasStlHome(false);
      }
    };
    checkStlHome();
    refreshTotal();
    const unexposeStatus = exposeGlobal('sidebarStatus', { setViewCount, setScanning });
    const unexposeStlHome = exposeGlobal('updateScanStlHomeButtonVisibility', checkStlHome);
    return () => {
      unexposeStatus();
      unexposeStlHome();
    };
  }, []);

  if (!container) return null;
  const send = (channel: string) => () => window.electron?.send?.(channel);
  const tool = (id: string, title: string, img: string, alt: string, channel: string) => (
    <button id={id} className="icon-button" title={title} onClick={send(channel)}>
      <img src={img} alt={alt} />
    </button>
  );
  return createPortal(
    <>
      <div className="model-stats">
        <div id="view-count" className="model-count">{plural(viewCount)} in view</div>
        <div id="total-count" className="model-count">{plural(total)} total</div>
      </div>
      <div className="icon-buttons-container">
        {tool('dup-button', 'De-Dup', 'dup.png', 'De-Dup', 'open-dedup')}
        {tool('tag-button', 'Tag - Tag Manager', 'tag.png', 'Tag Manager', 'open-tag-manager')}
        {tool('filament-button', 'Filament - Filament Manager', 'filament.png', 'Filament Manager', 'open-filament-manager')}
        {tool('roulette-button', 'Roulette - Print Roulette', 'roulette.png', 'Print Roulette', 'start-print-roulette')}
      </div>
      <button id="scan-directory-button" disabled={scanning} onClick={() => window.scanDirectory?.()}>Scan Directory</button>
      {hasStlHome && (
        <button id="scan-stl-home-button" className="secondary-button" disabled={scanning} onClick={() => window.runScanSTLHome?.()}>Scan STL Home</button>
      )}
      <button id="view-library-button" onClick={viewEntireLibrary}>View Entire Library</button>
    </>,
    container
  );
}
