# Printventory TODO

## Direction

**The Docker container and web UI come first.** Everything should be possible from a browser against the container. The desktop app waits until the container and web UI are finished (Phase 2).

Items are ordered from most important to least within each phase. Line numbers are approximate and were taken at version 2.2.16.

### How the container works today

- The image runs the full **Electron desktop app** on a fake display (Xvfb) with `--server`. The web UI is the desktop UI plus `server-bridge.js`, which forwards Electron IPC calls over a WebSocket.
- Anything that opens a native dialog, menu or window (`dialog.showOpenDialog` alone is used 12 times in `main.js`) appears on the invisible display, or fails, in the container.
- The image is large and slow to build, because it ships Electron, Chromium and GTK/X11 just to run a web server.
- The container runs as **root**.

Phase 1 therefore fixes the security problems in the container now, then moves the app to a standalone Node server with a real web client. The folder reorganization happens during that move.

### Target folder layout

```
src/
  core/      database, scanning, parsers, thumbnails, print history, AI tagging (no Electron, no Express)
  server/    Express app, HTTP API, WebSocket, auth, MCP, TLS
  web/       index.html, web UI scripts, styles, PWA files
  desktop/   Electron main, preload, native dialogs/menus (Phase 2)
assets/      images and icons (logo, png/jpg, icons)
build/       installer resources (BMP, .nsh, entitlements)
docker/      Dockerfile, entrypoint, compose files
extensions/  chrome-extension, helper
vendor/      third-party browser bundles
scripts/     build and release scripts
tests/       unit/, e2e/, fixtures/
docs/        GUIDE.md, guide/ images
```

`README.md`, `CHANGELOG.md`, `LICENSE.txt`, `TODO.md` and `package.json` stay at the root. Move files a few modules at a time, keeping tests green after each move, rather than all at once.

---

# Phase 1: Docker container and web UI

## 🔴 1. Critical: server security

- [ ] **Add authentication to server mode** (a login with a session cookie, plus API tokens for MCP and the extension). Anyone who can reach the container can control it today.
- [ ] **Restrict `/api/file/*` and `/api/download/*`** ([main.js:798](main.js#L798)). They return any file in the container (e.g. `/api/file//etc/passwd`). Only serve files inside configured library folders.
- [ ] **Check the origin of WebSocket connections and require auth on them** ([main.js:1135](main.js#L1135)). Any web page can connect and call every IPC handler, including `delete-file`.
- [ ] **Replace `Access-Control-Allow-Origin: *`** ([main.js:670](main.js#L670)) with an allowlist.
- [ ] **Validate every path the web UI sends**, for scan, delete, move and organize. Reject anything outside the library folders.
- [ ] **Replace `xmldom`.** It has a critical vulnerability with no fix (the package is abandoned). Switch to `@xmldom/xmldom` and rebuild `vendor/xmldom-worker-bundle.js`.
- [ ] **Fix the remaining vulnerable dependencies** (`npm audit`: 16 high, 4 moderate), which come from `puppeteer`, `ws`, `express`, `acme-client` and `fflate`. Start with `npm audit fix`.
- [ ] **Add security headers to the web UI**: Content Security Policy, `X-Content-Type-Options`, `frame-ancestors`.

## 🟠 2. High: remove usage tracking, and privacy

- [ ] **Remove GoatCounter completely:**
  - [ ] `main.js`: the `analytics` object (~244–335), the `track-event` handler (~13720–13770), the settings-change tracking (~6700), and the `CollectUsage: '1'` default (~3730).
  - [ ] `renderer.js` ~14004: it loads a remote script from `gc.zgo.at`.
  - [ ] `preload.js:148` (`trackEvent`) and `server-bridge.js:562` (`track-event`).
  - [ ] The "Collect usage" option in the About dialog (`renderer.js` ~6186–6230).
  - [ ] Mentions in the README, guide and privacy text.
- [ ] **Delete the `CollectUsage` setting from existing databases** with a migration.
- [ ] **Review the other outgoing connections:**
  - The version check to printventory.com: keep it, but make it optional.
  - Puter AI.
  - The support-log webhook.

  Document each one, and send nothing before the terms of service are accepted.

## 🟠 3. High: container fixes

- [ ] **Fix the image build from a clean clone.** The Dockerfile copies and requires `support-webhook.json`, but that file is in `.gitignore`, so the build fails for anyone but you. Make it optional.
- [ ] **Run as a non-root user**, with `PUID`/`PGID` support so files on mounted libraries and NAS shares get the right owner.
- [ ] **Add a `HEALTHCHECK`** and a `/api/health` endpoint.
- [ ] **Make all configuration available through environment variables**: port, data directory, library paths, admin password, TLS.
- [ ] **Shut down cleanly on `docker stop`**: close the database and let in-progress scans finish or roll back.
- [ ] **Publish a multi-arch image** (amd64 and arm64) for Raspberry Pi, Apple Silicon and many NAS boxes.

## 🟡 4. Medium: standalone server (remove Electron from the container)

This is the main refactor, and the folder reorganization above happens as part of it.

- [ ] **Move non-Electron logic out of `main.js`** (~14.5k lines, 171 IPC handlers) into `src/core/`, one area at a time:
  - database and migrations
  - scanning
  - thumbnails
  - tags and metadata
  - duplicates
  - organize library
  - print history
  - filament and Spoolman
  - printers
  - AI tagging
  - backup/restore
- [ ] **Create `src/server/`**: a plain Node entry point that starts Express, the API and the WebSocket using `src/core/`, with **no Electron**.
- [ ] **Replace the IPC-over-WebSocket shim with a proper HTTP API** (REST or JSON-RPC), so each action is a defined endpoint with auth and validation.
- [ ] **Generate thumbnails without Electron or Xvfb**, using a server-side renderer (e.g. headless WebGL or a Node rasterizer), or in the browser and upload the result.
- [ ] **Replace Puppeteer** (Thangs/MakerWorld scraping) with plain HTTP and site APIs where possible. Keep headless Chromium only as an optional fallback.
- [ ] **Slim the Docker image**: drop Electron, Xvfb, GTK and X11 once the server no longer needs them.
- [ ] **Keep a migration path**: the new server opens existing `./data` databases and thumbnails unchanged.

## 🟡 5. Medium: web UI can do everything

- [ ] **Audit every desktop-only action** and give each one a web equivalent:
  - [ ] Folder pickers (`showOpenDialog`): a server-side folder browser limited to the mounted volumes.
  - [ ] File pickers for restore/import: browser uploads.
  - [ ] "Show in folder" and "open file": download, or copy the path.
  - [ ] Native right-click menus (the `menuItems` handler, [main.js:9805](main.js#L9805)): in-page context menus.
  - [ ] Input dialogs (`input-dialog.html`): in-page modals.
  - [ ] Backup/restore: download and upload a backup file in the browser.
  - [ ] "Send to slicer": the existing helper/protocol handler, documented for web users.
- [ ] **Show scan, thumbnail and AI-tagging progress live in the browser**, and keep it working after a page reload.
- [ ] **Make sure multiple browsers can use the server at once**: one user's actions refresh the others, and edits don't conflict.
- [ ] **Polish the mobile web UI and PWA**: test on phones, and make the PWA installable.
- [ ] **Split `renderer.js`** (~25k lines) into feature modules under `src/web/`: grid, dialogs, settings, preview, tags, printers, filament.

## 🟡 6. Medium: bugs, tests and CI

- [ ] **Fix the version check.** It reports "latest version 2.2.2" while the app is at 2.2.16.
- [ ] **Run the unit tests (`test:*` scripts) in CI.** `.github/workflows/testdriver.yml` only runs the TestDriver tests.
- [ ] **Build the Docker image in CI and smoke-test it**: start it, log in, scan a fixture library, load the web UI.
- [ ] **Add Playwright end-to-end tests that drive the web UI against the container.**
- [ ] **Make the database tests (`print-events`, `printer-manager`) run in the same runtime as the server.** `better-sqlite3` is currently built for Electron, so they fail on plain Node. This fixes itself once the server runs on plain Node.
- [ ] **Move CI from Node 20 to Node 22+.**
- [ ] **Standardize on one test runner.** Vitest/TestDriver and Playwright overlap.

## 🔵 7. Cleanup

- [ ] **Reorganize files and folders into the target layout above** (done alongside sections 4 and 5).
- [ ] **Remove unneeded dependencies:**
  - `fs`: an empty placeholder package.
  - `node-fetch`: Node has `fetch` built in.
  - Either `jszip` or `fflate`, since they overlap.
- [ ] **Replace the ~500 `console.log` calls with a leveled logger.** Settings reads currently log on every call. Container logs should be readable with `docker logs`.
- [ ] **Review the 133 `innerHTML =` assignments** for injection of file names or scraped data.
- [ ] **Remove redundant code**, e.g. the JS content-type middleware where both branches do the same thing ([main.js:746](main.js#L746)).
- [ ] **Replace the long hand-maintained file lists** in the `Dockerfile` and `package.json` `build.files` with folder copies once the layout is in place.
- [ ] **Add ESLint and Prettier**, then gradually add type checking (JSDoc + `// @ts-check`).
- [ ] **Update docs**: the README says version 2.2.9; rewrite the install section with Docker first.

## 🟢 8. Feature ideas, server and web (most valuable first)

- [ ] **User accounts and roles** (admin, read-only, guest) for sharing with family or a makerspace.
- [ ] **Automatic, scheduled backups** with retention, saved to a mounted volume.
- [ ] **Folder watching**: pick up new or removed files on mounted libraries automatically instead of rescanning by hand.
- [ ] **Upload models through the web UI** (drag and drop) into a chosen library folder.
- [ ] **Send to printer**: upload and start a print via OctoPrint, Moonraker or Bambu, using the saved printer details. A server is a natural fit for this.
- [ ] **Cost and time estimates** from G-code or sliced 3MF metadata plus filament prices.
- [ ] **Collections/projects** that group models across folders.
- [ ] **Read-only share links and QR codes** for a model or collection.
- [ ] **Geometry-based duplicate detection**: find the same model across different files.
- [ ] **Bulk import from Printables/Thingiverse/MakerWorld URLs**, building on the Chrome extension.
- [ ] **Undo for metadata and tag edits.**
- [ ] **Statistics dashboard**: prints per month, success rate, filament used, top designers (Chart.js is already a dependency).

---

# Phase 2: Desktop app (after the container and web UI are done)

- [ ] **Rebuild the desktop app as a thin Electron shell around `src/core/`.** Ideally it runs the same server locally and loads the same web UI, so there is one UI to maintain.
- [ ] **Harden the Electron windows:**
  - Add `setWindowOpenHandler` and `will-navigate` guards.
  - Add a Content Security Policy.
  - Turn `sandbox: false` back on where possible.
- [ ] **Fix Windows path parsing on macOS/Linux in `fileStem`** ([slicer-detect.js:83](slicer-detect.js#L83)). `path.basename` doesn't split on `\`, so `test:slicer-detect` fails.
- [ ] **Remove or rebuild `open-model-viewer`.** It loads `viewer.html`, which doesn't exist ([main.js:13348](main.js#L13348)).
- [ ] **Keep native features where they help on desktop**: native folder pickers, "Show in folder", tray, local slicer launch.
- [ ] **Update desktop packaging** (`electron-builder` config, installers, macOS signing) for the new folder layout.
- [ ] **Add packaged-app smoke tests** for Windows, macOS and Linux to CI.
