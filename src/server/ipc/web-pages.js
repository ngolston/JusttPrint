'use strict';

const { ipcMain } = require('../runtime');
const puppeteer = require('puppeteer');

/**
 * The URL as a URL object when it is https on one of `hosts` (or a subdomain); throws otherwise.
 * Keeps the server from loading arbitrary addresses (internal services, file://) for a browser.
 */
function siteUrl(raw, hosts) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch (_) {
    throw new Error('Not a valid link');
  }
  const host = url.hostname.toLowerCase();
  const allowed = url.protocol === 'https:' && hosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!allowed) throw new Error(`Only https links to ${hosts.join(' or ')} can be fetched`);
  return url;
}

// Reads parent model, designer and license from a Thangs model page.
ipcMain.handle('fetch-thangs-page', async (event, rawUrl) => {
  const url = siteUrl(rawUrl, ['thangs.com']);
  console.debug('Fetching Thangs page:', url.href);
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url.href, { waitUntil: 'networkidle0' });

    const data = await page.evaluate(() => {
      // The model title is used as the parent model.
      const titleElement = document.querySelector('div[class^="ModelTitle_Text-"]');
      const parentModel = titleElement ? titleElement.textContent.trim() : null;

      const designerElement = document.querySelector('a[class^="ModelDesigner_ProfileLink-"]');
      const designer = designerElement ? designerElement.textContent.trim() : null;

      // License: look for license wording in the description.
      const descriptionElement = document.querySelector('div[class^="ModelDescription_"]');
      const description = descriptionElement ? descriptionElement.textContent.toLowerCase() : '';
      let license = 'Unknown';
      if (description.includes('personal use')) {
        license = 'For Personal Use';
      } else if (description.includes('creative commons')) {
        license = 'Creative Commons';
      } else if (description.includes('commercial use')) {
        license = 'Commercial Use Allowed';
      }

      return { parentModel, designer, license };
    });

    console.debug('Scraped Thangs data:', data);
    return data;
  } catch (error) {
    console.error('Error fetching Thangs page:', error);
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

module.exports = { siteUrl };
