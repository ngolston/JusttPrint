/**
 * Page startup: wait for the server connection, ask for the terms, then load the settings the
 * page needs and the library. The server's thumbnail worker page (?pv-thumbnail-worker=1) stops
 * after connecting: it only renders bulk thumbnail jobs.
 */
import { settings } from '../api';
import { runSearch } from '../filters/search';
import { loadSavedFilterSettings } from '../filters/store';
import { loadCurrentUser } from '../session';
import { parseRoute } from '../shell/routes';
import { setFoldersAfterWelcome } from './FirstRun';
import { needsFolderSetup, openFolderSetup } from './FolderSetup';
import { applyColorScheme } from './theme';
import { checkForUpdatesOnStartup } from './updates';
import { showWhatsNewAfterUpdate } from './WhatsNew';

declare global {
  interface Window {
    currentRenderColor?: string;
    currentRenderLighting?: boolean;
    showWelcome?: () => void;
  }
}

const isWorkerPage = () => new URLSearchParams(window.location.search).get('pv-thumbnail-worker') === '1';

/** The bridge's WebSocket is open (or 15 seconds passed). */
async function connected() {
  const bridge = window.electron as { whenConnected?: () => Promise<unknown> } | undefined;
  if (!bridge?.whenConnected) return;
  await Promise.race([bridge.whenConnected(), new Promise((resolve) => setTimeout(resolve, 15000))]).catch(() => {});
}

/** The model color, lighting and background used for thumbnails and previews. */
async function loadRenderSettings() {
  const [background, color, lighting, scheme] = await Promise.all(
    ['modelBackgroundColor', 'renderColor', 'renderLighting', 'uiColorScheme'].map((key) => settings.get<string | null>(key).catch(() => null))
  );
  if (background) document.documentElement.style.setProperty('--model-background-color', background);
  window.currentRenderColor = color || '#cccccc';
  window.currentRenderLighting = lighting == null ? true : lighting === 'true';
  applyColorScheme(scheme);
}

/** How long the Models grid waits, opened on another page, before it loads anyway. */
const GRID_DEFER_MS = 3000;

/**
 * The Models grid's first load. On the Models page it loads at once; on another page it waits
 * until that page has loaded (a few seconds) or Models is opened, whichever comes first, so the
 * page's own widgets do not wait behind the whole library.
 */
async function loadLibraryGrid() {
  if (parseRoute(window.location.hash).page === 'models') return runSearch();
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    window.removeEventListener('hashchange', onHash);
    clearTimeout(timer);
    void runSearch();
  };
  const onHash = () => {
    if (parseRoute(window.location.hash).page === 'models') go();
  };
  window.addEventListener('hashchange', onHash);
  const timer = setTimeout(go, GRID_DEFER_MS);
}

async function start() {
  document.getElementById('loading-overlay')?.style.setProperty('display', 'none');
  await connected();
  if (isWorkerPage()) {
    document.body.classList.add('server-thumbnail-worker');
    return;
  }
  // Guests keep no settings: the welcome is for accounts.
  const guest = !!(await loadCurrentUser())?.guest;
  // No model folders yet: an admin chooses them (after the welcome on a first run).
  const chooseFolders = !guest && (await needsFolderSetup());
  const firstRun = !guest && !(await settings.get<string | null>('hasRunBefore').catch(() => 'true'));
  if (firstRun) {
    setFoldersAfterWelcome(chooseFolders);
    window.showWelcome?.();
    settings.save('hasRunBefore', 'true').catch(() => {});
  } else if (chooseFolders) openFolderSetup();
  document.querySelector('.file-grid')?.classList.remove('hidden');
  await Promise.all([loadRenderSettings(), loadSavedFilterSettings()]);
  await loadLibraryGrid();
  // After the library is up, so the page paints first: What's New after an update (guests keep
  // no settings), then the update check.
  setTimeout(() => {
    void (guest ? Promise.resolve() : showWhatsNewAfterUpdate(firstRun)).finally(() => checkForUpdatesOnStartup());
  }, 2000);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => {
      start();
    });
  else start();
}
