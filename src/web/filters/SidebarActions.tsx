import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { exposeGlobal } from '../page';
import { plural, refreshTotal, useModelCounts } from './counts';
import { scanDirectory, scanStlHome, useScanProgress } from '../scan/scan';
import { stlHomeDirectories } from '../scan/stlHome';
import { runSearch } from './search';
import { filterActions } from './store';
import { printRoulette } from '../library/actions';

declare global {
  interface Window {
    /** library/actions.ts: re-read every model and redraw the grid. */
    forceGridRefresh?: () => Promise<void>;
  }
}

/** Clear every filter and show the whole library again. */
export async function viewEntireLibrary() {
  try {
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
  const scanning = !!useScanProgress();
  const [hasStlHome, setHasStlHome] = useState(false);

  useEffect(() => {
    const checkStlHome = async () => {
      try {
        setHasStlHome((await stlHomeDirectories()).length > 0);
      } catch {
        setHasStlHome(false);
      }
    };
    checkStlHome();
    refreshTotal();
    return exposeGlobal('updateScanStlHomeButtonVisibility', checkStlHome);
  }, []);

  if (!container) return null;
  const tool = (id: string, title: string, img: string, alt: string, run: () => void) => (
    <button id={id} className="icon-button" title={title} onClick={run}>
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
        {tool('dup-button', 'De-Dup', 'dup.png', 'De-Dup', () => window.openDedup?.())}
        {tool('tag-button', 'Tag - Tag Manager', 'tag.png', 'Tag Manager', () => window.openTagManager?.())}
        {tool('filament-button', 'Filament - Filament Manager', 'filament.png', 'Filament Manager', () => window.openFilamentManager?.())}
        {tool('roulette-button', 'Roulette - Print Roulette', 'roulette.png', 'Print Roulette', () => { printRoulette(); })}
      </div>
      <button id="scan-directory-button" disabled={scanning} onClick={() => scanDirectory()}>Scan Directory</button>
      {hasStlHome && (
        <button id="scan-stl-home-button" className="secondary-button" disabled={scanning} onClick={() => scanStlHome()}>Scan STL Home</button>
      )}
      <button id="view-library-button" onClick={viewEntireLibrary}>View Entire Library</button>
    </>,
    container
  );
}
