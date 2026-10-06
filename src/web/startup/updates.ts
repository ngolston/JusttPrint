/** The update check at startup (About → Updates turns it off). Reads GitHub Releases on the server. */
import { callAction, settings } from '../api';
import { showMessage } from '../page';

/** -1, 0 or 1, comparing dotted version numbers (missing parts count as 0). */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Offer a newer release once (a declined version is not offered again). */
export async function checkForUpdatesOnStartup() {
  try {
    if (await settings.get<string | null>('autoUpdateCheck') === '0') return;
    const [current, beta, declined] = await Promise.all([
      settings.get<string | null>('currentVersion'),
      settings.get<string | null>('betaOptIn'),
      settings.get<string | null>('lastDeclinedVersion')
    ]);
    const isBeta = beta === 'true';
    const latest = await callAction<string | null>('check-for-updates', isBeta);
    if (!latest || !current) return;
    await settings.save('latestVersion', latest);
    await settings.save('lastUpdateCheck', new Date().toISOString());
    if (compareVersions(latest, current) <= 0 || latest === declined) return;
    const answer = await showMessage('Update Available',
      `Version ${latest} is available. You are currently running version ${current}. Would you like to update?`, ['Yes', 'No']);
    if (answer === 'Yes') {
      const url = await callAction<string>('open-update-page', isBeta);
      if (url) window.open(url, '_blank', 'noopener');
    } else {
      await settings.save('lastDeclinedVersion', latest);
    }
  } catch (error) {
    console.error('Error checking for updates:', error);
  }
}
