'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { releasesApiUrl, releasesPageUrl, latestVersionFromReleases } = require('../releases');
const https = require('https');

// Update the checkForUpdates function to track user's response
async function checkForUpdates(isBeta = false) {
  try {
    // First check if we've already shown update dialog this session
    const versionCheckPerformed = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('versionCheckPerformedOnStartup');
    if (versionCheckPerformed && versionCheckPerformed.value === 'true') {
      console.debug('Version check already performed this session, skipping');
      return null;
    }

    return new Promise((resolve, reject) => {
      const versionUrl = releasesApiUrl(isBeta);
      console.debug('Main Process - Checking GitHub releases:', versionUrl);

      https
        .get(
          versionUrl,
          {
            // GitHub's API requires a User-Agent.
            headers: { 'User-Agent': 'JusttPrint', Accept: 'application/vnd.github+json' }
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              let version;
              try {
                version = latestVersionFromReleases(JSON.parse(data), isBeta);
              } catch (_) {
                version = null;
              }
              console.log('Main Process - Latest release:', version, `(HTTP ${res.statusCode})`);
              if (version) {
                console.debug('Main Process - Valid version format received:', version);
                // Update the database with the latest version
                try {
                  database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(version, 'latestVersion');
                  database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(new Date().toISOString(), 'lastUpdateCheck');
                  // Mark that we've performed the version check
                  database.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('true', 'versionCheckPerformedOnStartup');
                  console.debug('Database updated with latest version:', version);
                } catch (dbError) {
                  console.error('Error updating version in database:', dbError);
                }
                resolve(version);
              } else {
                reject(new Error(`No release found (HTTP ${res.statusCode})`));
              }
            });
          }
        )
        .on('error', (err) => {
          console.error('Error checking for updates:', err);
          reject(err);
        });
    });
  } catch (error) {
    console.error('Error in checkForUpdates:', error);
    return null;
  }
}

// Update the IPC handler
ipcMain.handle('check-for-updates', async (event, isBeta) => {
  try {
    console.debug('Main Process - Update check requested:', { isBeta });
    // Add timeout to the version check
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Version check timed out')), 5000);
    });

    const versionPromise = checkForUpdates(isBeta);
    const latestVersion = await Promise.race([versionPromise, timeoutPromise]);

    console.debug('Main Process - Latest version found:', latestVersion);
    return latestVersion;
  } catch (error) {
    console.error('Error checking for updates:', error);
    // Return current version to prevent update dialog on failure
    const currentVersion = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('currentVersion');
    return currentVersion?.value || null;
  }
});

// The browser opens the release page; the server only knows the address.
ipcMain.handle('open-update-page', async (event, isBeta) => releasesPageUrl(isBeta));
