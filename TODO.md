# Printventory TODO

## Direction

**Printventory is Docker-only.** Everything happens in a browser against the container. The Electron desktop app and the Windows, macOS and Linux desktop builds are being removed (section 4); Phase 2 is dropped.

Items are ordered from most important to least within each phase. Line numbers are approximate and were taken at version 2.2.16.

### How the container works today

- The image runs the server on plain Node (`src/server/index.js`). `main.js` still carries the old desktop code; `src/server/electron-shim.js` stands in for Electron so it runs without it.
- Thumbnails render in headless Chromium inside the container. The web UI is still the old desktop UI plus `server-bridge.js`, which forwards IPC calls over a WebSocket.
- Server-initiated native dialogs answer Cancel, since there is no window to show them in.

### Target folder layout

```
src/
  core/      database, scanning, parsers, thumbnails, print history, AI tagging (no Electron, no Express)
  server/    Express app, HTTP API, WebSocket, auth, MCP, TLS
  web/       index.html, web UI scripts, styles, PWA files
assets/      images and icons (logo, png/jpg, icons)
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

- [x] **Add authentication to server mode**: password login with a signed session cookie, an API token for MCP, and short-lived download tokens for the slicer helper (`server-auth.js`).
- [x] **Restrict `/api/file/*` and `/api/download/*`** to library folders, stored model paths, and backups/exports (`server-paths.js`).
- [x] **Check the origin of WebSocket connections and require auth on them.** Open sockets are also closed when the password changes.
- [x] **Replace `Access-Control-Allow-Origin: *`** with same-origin plus `PRINTVENTORY_ALLOWED_ORIGINS`, and refuse cross-site state-changing requests.
- [x] **Stop serving the whole app folder as static files.** Secret config files, `package.json`, `main.js` and `node_modules` were public. Only web assets are served now.
- [x] **Validate every path the web UI and MCP send.** One guard checks the path arguments of 30 IPC channels and 14 MCP tools: files must be in the library, moves stay in the library, new scan and organize folders cannot be system, app or data folders, and MCP backups/exports only write to the library or data folder. "Open on server" actions are desktop only.
- [x] **Replace `xmldom`** with `@xmldom/xmldom` 0.9, and rebuild `vendor/xmldom-worker-bundle.js`.
- [x] **Fix the vulnerable dependencies**: `npm audit fix`, Puppeteer 24 → 25, and removed the `overrides` that pinned the vulnerable `basic-ftp` 5.3.1. Down from 21 to 2.
- [ ] **`node-forge` (via `acme-client`)**: no fixed release exists yet (1.4.0 is the latest). Only used to create Let's Encrypt requests, not to verify untrusted signatures. Update when a fix ships.
- [x] **Add security headers**: `frame-ancestors`/`X-Frame-Options`, `nosniff`, `Referrer-Policy`, `object-src 'none'`, `base-uri`, `form-action`; removed `X-Powered-By`.
- [ ] **Add `script-src` to the Content Security Policy.** Needs the inline `<script>` blocks and `onclick=` attributes moved into files first (fits with splitting `renderer.js`, section 5).
- [x] **Resolve symlinks before the library-folder check.** Paths must be inside the library both as written and after following links; this also covers move destinations, write targets and new scan folders.
- [x] **Make the login rate limit work behind a reverse proxy.** `PRINTVENTORY_TRUST_PROXY` (hop count, `true`, or addresses) makes it use the client address from `X-Forwarded-For`; off by default.
- [x] **Remove the legacy `/api/extension-upload` route.** No extension build since 2.2.4 uses it (they use the inbox folder), and it silently overwrote files. Removed with its IPC handler, setting and `EXTENSION_UPLOAD_DIR`. Web uploads come back properly as a section 8 feature.

## 🟠 2. High: remove usage tracking, and privacy

- [x] **Remove GoatCounter completely:**
  - [x] `main.js`: the `analytics` object (~244–335), the `track-event` handler (~13720–13770), the settings-change tracking (~6700), and the `CollectUsage: '1'` default (~3730).
  - [x] `renderer.js` ~14004: it loads a remote script from `gc.zgo.at`.
  - [x] `preload.js:148` (`trackEvent`) and `server-bridge.js:562` (`track-event`).
  - [x] The "Collect usage" option in the About dialog (`renderer.js` ~6186–6230).
  - [x] Mentions in the README, guide and privacy text.
- [x] **Delete the `CollectUsage` and `ClientId` settings from existing databases.**
- [x] **Review the other outgoing connections** (documented under *Network Connections* in the README; the update check can be turned off under About → Updates and waits for the terms):
  - The version check: optional, and since 2.3.0 it reads GitHub Releases (the old website is no longer used).
  - Puter AI.
  - Support-log uploads (removed in 2.3.x along with the rest of the original project's services).

  Document each one, and send nothing before the terms of service are accepted.

## 🟠 3. High: container fixes

- [x] **Fix the image build from a clean clone.** It no longer needs files that aren't in the repository.
- [x] **Run as a non-root user** with `PUID`/`PGID` (default 1000:1000, `PUID=0` for root). The data folder is re-owned on start only when needed; the app keeps the right to bind port 80 for Let's Encrypt.
- [x] **Bake the Electron binary into the image.** `npm install --ignore-scripts` skipped it, so every new container downloaded ~100 MB from GitHub at startup.
- [x] **Add a `HEALTHCHECK` to the Dockerfile.** `healthcheck.js` asks `/api/health` on the port and scheme the server actually listens on.
- [x] **Make configuration available through environment variables.** Port, password, library paths, TLS and the database path already had variables; added zip support, extra file types, scan exclusions and AI settings (`env-settings.js`), documented in the README table. Setting values (including API keys) are no longer written to the log.
- [x] **Shut down cleanly on `docker stop`.** On every quit (`docker stop`, closing the window, Ctrl+C) a `will-quit` handler cancels the thumbnail job, closes connections, checkpoints and closes the database, then copies the backup. Tested by stopping the container in the middle of a 22,000-model thumbnail job: database intact.
- [x] **Publish a multi-arch image.** `npm run docker:hub:multiarch` builds `linux/amd64` and `linux/arm64` with Buildx and pushes one tag (`PRINTVENTORY_PLATFORMS` to change the list). Keep both: Intel/AMD for most NAS boxes and PCs, ARM for Raspberry Pi and Apple Silicon.

## 🟡 4. Medium: standalone server (remove Electron from the container)

The Docker image now runs on plain Node. `src/server/index.js` loads `main.js` with `src/server/electron-shim.js` in place of Electron, so the same code serves both. The remaining items replace that bridge with real modules over time.

- [x] **Create `src/server/`**: `node src/server/index.js` runs server mode with no Electron (Electron stand-in: app paths and events, IPC registry, dialogs that answer Cancel, freedesktop trash, no windows).
- [x] **Generate thumbnails without Electron or Xvfb.** The server starts headless Chromium (Puppeteer, system Chromium) on the web UI as a worker client, identified by a secret cookie, and sends it the thumbnail jobs. It restarts after a crash. NVIDIA WebGL still works via `PRINTVENTORY_GPU`.
- [x] **Run STL Home scans in the server.** They were started by the hidden Electron window; the server now scans at startup and on the configured interval, then renders thumbnails for new models.
- [x] **Slim the Docker image**: no Electron, Xvfb, D-Bus, GTK or X11; production dependencies only. 2.46 GB → 1.11 GB.
- [x] **Keep a migration path**: same data path (`/root/.config/printventory`) and database, so existing volumes keep working.
- [x] **Remove Electron completely.** `electron` and `electron-builder` are gone from `package.json`, along with the desktop window, menus, hidden worker window, preload, native input dialog and model viewer. `npm start` runs `src/server/index.js` on plain Node, and the DB tests run on plain Node. Text prompts use an in-page dialog. Since then the rewrite removed the remaining desktop branches, windows and native dialogs from `main.js`, and the Electron stand-in became `src/server/runtime.js` (paths, lifecycle, IPC registry, trash), required directly.
- [x] **Remove everything specific to Windows, macOS and Linux desktops.** Desktop build scripts, installer assets, `Dockerfile.build-linux`, slicer install detection, macOS/AppImage switches, asar lookups, `LOCALAPPDATA` paths and Windows UNC path modes are gone; the README and GUIDE describe Docker only. Kept: the Send to Slicer helper and the Chrome extension.
- [ ] **Rewrite `main.js` to be cleaner and lighter.** Split it (~12.6k lines) into small modules under `src/core/` and `src/server/`, and delete what isn't used: dead IPC handlers, legacy settings and migrations, duplicate helpers, debug logging. Work one area at a time and test after each step: unit tests, the container test suite (security, path guard, health), and a browser check of the grid, previews and thumbnails. This replaces the "move logic out of `main.js`" item below.
- [x] **Server-initiated dialogs in the browser.** `src/server/client-dialogs.js` sends message boxes and prompts to the browser that made the request and waits for the answer (Pull Metadata, Purge Models, Tag from Folder, errors). Folder pickers ask for a container path until the folder browser exists.
- [ ] **Re-compress large stored thumbnails on Node.** `thumbnail-compress.js` used Electron's `nativeImage`; on Node it skips compression. Do it in the Chromium worker or with an image library.
- [ ] **Server GPU details in System Report** (`app.getGPUInfo` returns nothing on Node). Report the worker Chromium's WebGL renderer instead.
- [ ] **Move non-Electron logic out of `main.js`** (covered by the rewrite above; areas to cover):
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
- [ ] **Replace the IPC-over-WebSocket shim with a proper HTTP API** (REST or JSON-RPC), so each action is a defined endpoint with auth and validation.
- [ ] **Replace Puppeteer scraping** (Thangs/MakerWorld) with plain HTTP and site APIs where possible. Chromium stays in the image for thumbnails either way.

## 🟡 5. Medium: web UI can do everything

- [ ] **Rewrite the frontend in React + TypeScript (Vite), screen by screen.** First choose the new project name and do the rename (section 7). Start after the `main.js` rewrite and the HTTP API (section 4), so the new screens call clear endpoints instead of the IPC-over-WebSocket bridge. Mount React into parts of the existing page so the app keeps working throughout:
  - First a self-contained dialog (Server Access or Settings), to set up Vite, TypeScript and the build in the Docker image.
  - Then the model grid (virtualized, e.g. TanStack Virtual), the details panel, and the 3D preview (react-three-fiber).
  - Then the remaining dialogs and managers (tags, filament, printers, parts, dedup, organize).
  - Remove `renderer.js`, `server-bridge.js` and the inline scripts and `onclick` attributes as their screens move over; this also allows a strict `script-src` CSP (section 1).
  - Test each screen in the browser against the container before moving on.
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
- [ ] **Retire `renderer.js`** (~25k lines): it goes away screen by screen through the React rewrite above, rather than being split into modules first.

## 🟡 6. Medium: bugs, tests and CI

- [ ] **Preview reopened within ~1 second logs "Container has zero dimensions"** (`preview.js` sets up the 3D scene 100 ms after opening). Harmless; goes away with the React preview.
- [x] **Fix the version check.** The startup check always used the public channel (2.2.2), so beta users never saw beta updates. It now follows `betaOptIn`.
- [ ] **Run the unit tests (`test:*` scripts) in CI.** `.github/workflows/testdriver.yml` only runs the TestDriver tests.
- [ ] **Build the Docker image in CI and smoke-test it**: start it, log in, scan a fixture library, load the web UI.
- [x] **Add end-to-end tests that drive the web UI.** `npm run test:e2e` starts the server on plain Node with `tests/fixtures/library` and runs 53 checks (API, security, path guard, MCP, backup, trash, and the browser UI).
- [ ] **Run `npm run test:e2e` against the built Docker image too** (same checks, server in the container).
- [ ] **Rebuild the performance checks on the e2e harness**: large-grid scrolling and 3MF preview stress. The old scripts predated the login and were removed.
- [x] **Make the database tests (`print-events`, `printer-manager`) run in the same runtime as the server.** They run on plain Node since Electron was removed.
- [ ] **Move CI from Node 20 to Node 22+.**
- [ ] **Standardize on one test runner.** Vitest/TestDriver and Playwright overlap.

## 🔵 7. Cleanup

- [ ] **Rename and rebrand the project.** Choose the new name first, then change it everywhere:
  - Name, logo, icons and wording in the web UI, PWA manifest, login page, README, GUIDE and CHANGELOG.
  - `package.json` name, GitHub repository name, Docker image and container names, and the release zip.
  - Technical names: `PRINTVENTORY_*` environment variables, the `/root/.config/printventory` data path, the `printventory://` slicer helper protocol, cookies and log prefixes. Keep reading the old names for a release or two so existing installs keep working.
  - Best done before the React rewrite (section 5), so new screens use the new name from the start.
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
- [x] **Update docs**: the README and GUIDE describe the Docker web app only.
- [ ] **Fix the "Archive" badge overlapping the file name** on zip-entry tiles in Preview view.
- [ ] **Fix the sidebar banner text in Docker.** It says "UNC paths required for all file operations", which only applies to Windows server mode.
- [ ] **Fix the app-wide input style that puts a dropdown arrow on every `.form-group` input** (`styles.css` ~276), not just dropdowns. Several dialogs work around it one by one.

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

# Phase 2: Desktop app (dropped)

Printventory is Docker-only. The desktop items that were here (hardening Electron windows, desktop packaging, packaged-app tests, the slicer-detect path bug, `viewer.html`) are replaced by "Remove Electron completely" and "Remove everything specific to Windows, macOS and Linux desktops" in section 4.
