/**
 * Page startup: wait for the server connection, ask for the terms, then load the settings the
 * page needs and the library. The server's thumbnail worker page (?pv-thumbnail-worker=1) stops
 * after connecting: it only renders bulk thumbnail jobs.
 */
import { settings } from '../api';
import { runSearch } from '../filters/search';
import { loadSavedFilterSettings } from '../filters/store';
import { loadCurrentUser } from '../session';
import { setFoldersAfterWelcome } from './FirstRun';
import { needsFolderSetup, openFolderSetup } from './FolderSetup';
import { applyColorScheme } from './theme';
import { checkForUpdatesOnStartup } from './updates';

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
  if (!guest && !(await settings.get<string | null>('hasRunBefore').catch(() => 'true'))) {
    setFoldersAfterWelcome(chooseFolders);
    window.showWelcome?.();
    settings.save('hasRunBefore', 'true').catch(() => {});
  } else if (chooseFolders) openFolderSetup();
  document.querySelector('.file-grid')?.classList.remove('hidden');
  await Promise.all([loadRenderSettings(), loadSavedFilterSettings()]);
  await runSearch();
  // After the library is up, so the page paints first.
  setTimeout(() => {
    checkForUpdatesOnStartup();
  }, 2000);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => {
      start();
    });
  else start();
}
