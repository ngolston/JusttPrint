'use strict';

/**
 * Update check against GitHub Releases of the JusttPrint repository.
 * Stable users get the latest release; beta users get the newest one, pre-releases included.
 */

const RELEASES_REPO = 'ngolston/JusttPrint';
const PROJECT_URL = `https://github.com/${RELEASES_REPO}`;

function releasesApiUrl(isBeta) {
  return isBeta
    ? `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=20`
    : `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
}

function releasesPageUrl(isBeta) {
  return isBeta
    ? `${PROJECT_URL}/releases`
    : `${PROJECT_URL}/releases/latest`;
}

/**
 * Version number ("2.3.0") of the newest usable release in a GitHub API response:
 * one release object (/releases/latest) or a newest-first list (/releases).
 */
function latestVersionFromReleases(body, isBeta) {
  const list = Array.isArray(body) ? body : [body];
  for (const item of list) {
    if (!item || item.draft || (!isBeta && item.prerelease)) continue;
    const version = String(item.tag_name || '').trim().replace(/^v/i, '');
    // The app compares plain numbers, so tags like "v2.4.0-beta" are skipped.
    if (/^\d+\.\d+(\.\d+)?$/.test(version)) return version;
  }
  return null;
}

module.exports = { RELEASES_REPO, PROJECT_URL, releasesApiUrl, releasesPageUrl, latestVersionFromReleases };
