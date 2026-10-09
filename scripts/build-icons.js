#!/usr/bin/env node
'use strict';

/**
 * Build every icon and logo image from the vector mark (assets/icon-mark.svg):
 *
 *   node scripts/build-icons.js
 *
 * Chrome (through Playwright) draws each image, so the results are sharp at every size.
 * Writes assets/logo.png, the home-screen icons (pwa-icon-*, pwa-maskable-*, apple-touch-icon),
 * assets/favicon.ico (16, 32 and 48 px), docs/images/logo-wordmark.png, and assets/3d.png (the
 * placeholder for a model without a thumbnail, from assets/placeholder.svg).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const CHROME =
  process.env.JUSTTPRINT_CHROMIUM ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));

const mark = `data:image/svg+xml;base64,${fs.readFileSync(path.join(ASSETS, 'icon-mark.svg')).toString('base64')}`;
const font = `data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')).toString('base64')}`;

/** The dark navy the app uses (tokens.css --jp-bg), lit from the middle. */
const BACKGROUND = 'radial-gradient(circle at 50% 50%, #0d335d 0%, #061a30 45%, #030b16 100%)';

/** A square icon: the mark at `fill` of the width, on the background or transparent. */
const squareIcon = (fill, background = true) => `
  <div style="width:512px;height:512px;display:flex;align-items:center;justify-content:center;${background ? `background:${BACKGROUND}` : ''}">
    <img src="${mark}" style="width:${fill * 100}%;height:${fill * 100}%">
  </div>`;

/** The mark with "JusttPrint" and "Your 3D printing library" beside it. */
const wordmark = `
  <style>
    @font-face { font-family: 'Inter JP'; src: url(${font}) format('woff2'); font-weight: 100 900; }
    .card { width: 1400px; height: 440px; display: flex; align-items: center; gap: 36px; padding: 0 70px; box-sizing: border-box;
      background: radial-gradient(ellipse at 22% 50%, #0d3a6b 0%, #061b33 38%, #030b16 80%); border-radius: 40px; font-family: 'Inter JP'; }
    .name { font-size: 150px; font-weight: 800; letter-spacing: -4px; line-height: 1; }
    .justt { background: linear-gradient(180deg, #ffffff 0%, #dbe7f0 60%, #a9bccb 100%); -webkit-background-clip: text; color: transparent; }
    .print { background: linear-gradient(180deg, #8fe0ff 0%, #2fa6ff 55%, #1670e0 100%); -webkit-background-clip: text; color: transparent; }
    .tag { margin-top: 18px; font-size: 38px; font-weight: 500; letter-spacing: 9px; color: #d6e6f2; text-transform: uppercase; }
  </style>
  <div class="card">
    <img src="${mark}" style="width:360px;height:360px;flex:none">
    <div><div class="name"><span class="justt">Justt</span><span class="print">Print</span></div><div class="tag">Your 3D printing library</div></div>
  </div>`;

async function render(page, html, size, out, { transparent = false, width = 512, height = 512 } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<html><body style="margin:0;background:transparent">${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  const png = await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  if (!out) return png;
  fs.writeFileSync(out, size === width ? png : await resize(page, png, size, transparent));
  console.log('wrote', path.relative(ROOT, out));
  return png;
}

/** Scale a PNG down in the browser (smooth, high quality). */
async function resize(page, png, size, transparent) {
  const src = `data:image/png;base64,${png.toString('base64')}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${src}" style="width:${size}px;height:${size}px;display:block"></body></html>`
  );
  await page.waitForTimeout(50);
  return page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}

/** An .ico holding PNG images (every current browser reads these). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

(async () => {
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const a = (name) => path.join(ASSETS, name);

  // Home screen and in-app: the mark fills most of the square.
  const full = await render(page, squareIcon(0.9), 512, a('logo.png'));
  fs.writeFileSync(a('pwa-icon-512.png'), full);
  fs.writeFileSync(a('pwa-icon-192.png'), await resize(page, full, 192));
  fs.writeFileSync(a('apple-touch-icon.png'), await resize(page, full, 180));
  // Maskable: Android may crop to a circle, so the mark stays inside the middle 72%.
  const maskable = await render(page, squareIcon(0.72), 512, a('pwa-maskable-512.png'));
  fs.writeFileSync(a('pwa-maskable-192.png'), await resize(page, maskable, 192));
  // Browser tab: the mark alone, on transparent, as large as it fits.
  const tab = await render(page, squareIcon(1, false), 512, null, { transparent: true });
  const sizes = [16, 32, 48];
  const tabImages = [];
  for (const size of sizes) tabImages.push({ size, png: await resize(page, tab, size, true) });
  fs.writeFileSync(a('favicon.ico'), ico(tabImages));
  console.log('wrote assets/pwa-icon-192.png, pwa-icon-512.png, apple-touch-icon.png, pwa-maskable-192.png, favicon.ico');
  // The placeholder, inline so its letters use Inter.
  const placeholder = fs.readFileSync(path.join(ASSETS, 'placeholder.svg'), 'utf8');
  await render(
    page,
    `<style>@font-face { font-family: 'Inter JP'; src: url(${font}) format('woff2'); font-weight: 100 900; }</style>${placeholder}`,
    662,
    a('3d.png'),
    { transparent: true, width: 662, height: 377 }
  );
  // The README logo.
  await render(page, wordmark, 1400, path.join(ROOT, 'docs/images/logo-wordmark.png'), { transparent: true, width: 1400, height: 440 });

  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
