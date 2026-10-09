# JusttPrint TODO

## Direction

**JusttPrint is Docker-only.** Everything happens in a browser against the container. The Electron desktop app and the Windows, macOS and Linux desktop builds are being removed (section 4); Phase 2 is dropped.

Items are ordered from most important to least within each phase. Line numbers are approximate and were taken at version 2.2.16.

### How the container works today

- The image runs the server on plain Node (`src/server/index.js` → `src/server/app.js`), with library logic in `src/core/` and the server in `src/server/`.
- Thumbnails render in headless Chromium inside the container. The web UI is React and TypeScript (`src/web`), calling the HTTP API; the WebSocket only brings events and dialogs.
- Server-initiated native dialogs answer Cancel, since there is no window to show them in.

### Target folder layout

```
src/
  core/      database, scanning, parsers, thumbnails, print history, AI tagging (no Electron, no Express)
  server/    Express app, HTTP API, WebSocket, auth, MCP, TLS
  web/       index.html, web UI scripts, styles, PWA files
assets/      images and icons (logo, png/jpg, icons)
docker/      Dockerfile, entrypoint, compose files
extensions/  helper
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
- [x] **Replace `Access-Control-Allow-Origin: *`** with same-origin plus `JUSTTPRINT_ALLOWED_ORIGINS`, and refuse cross-site state-changing requests.
- [x] **Stop serving the whole app folder as static files.** Secret config files, `package.json`, `main.js` and `node_modules` were public. Only web assets are served now.
- [x] **Validate every path the web UI and MCP send.** One guard checks the path arguments of 30 IPC channels and 14 MCP tools: files must be in the library, moves stay in the library, new scan and organize folders cannot be system, app or data folders, and MCP backups/exports only write to the library or data folder. "Open on server" actions are desktop only.
- [x] **Replace `xmldom`** with `@xmldom/xmldom` 0.9, and rebuild `vendor/xmldom-worker-bundle.js`.
- [x] **Fix the vulnerable dependencies**: `npm audit fix`, Puppeteer 24 → 25, and removed the `overrides` that pinned the vulnerable `basic-ftp` 5.3.1. Down from 21 to 2.
- [x] **Remove channels that skipped the secret-settings guard or could stop the server**: `getSetting`, `saveSetting`, `quitApp`, and the unused `get-db`.
- [x] **Stop running slicer programs on the server.** The `execute-client-command` channel (which started any program path a browser sent) and all server-side spawning are gone. `open-file-in-slicer` returns an open-in-slicer command with a short-lived download token; the browser opens it as a `justtprint://` link and the helper on the user's computer (`helper/`, with `helper/slicer-launch.js`) downloads the files and starts the slicer there. MCP `open_in_slicer` sends the command to the open browsers. Also fixed: Send to Slicer from the 3D preview sent no download token.
- [ ] **`node-forge` (via `acme-client`)**: no fixed release exists yet (1.4.0 is the latest). Only used to create Let's Encrypt requests, not to verify untrusted signatures. Update when a fix ships.
- [x] **Add security headers**: `frame-ancestors`/`X-Frame-Options`, `nosniff`, `Referrer-Policy`, `object-src 'none'`, `base-uri`, `form-action`; removed `X-Powered-By`.
- [x] **Add `script-src` to the Content Security Policy.** `script-src 'self' 'wasm-unsafe-eval'`: the three inline `<script>` blocks moved to `page-init.js`, the 53 `onclick=` attributes became `data-close-dialog` / `data-action` (or listeners in `page-init.js`), and the server no longer inlines `server-bridge.js` into the page. The model parse worker alone also allows `'unsafe-eval'`, because the STEP library builds functions from strings.
- [x] **Drop `'unsafe-eval'` from the parse worker.** `vendor/occt-import-js` is rebuilt from 0.0.23 with Emscripten 3.1.69 and `-sDYNAMIC_EXECUTION=0` ([scripts/build-occt-import-js.sh](scripts/build-occt-import-js.sh), [BUILD.md](vendor/occt-import-js/BUILD.md)); meshes are identical on upstream's 56 STEP/IGES test files. Every page and worker now runs under `script-src 'self' 'wasm-unsafe-eval'`.
- [x] **Resolve symlinks before the library-folder check.** Paths must be inside the library both as written and after following links; this also covers move destinations, write targets and new scan folders.
- [x] **Make the login rate limit work behind a reverse proxy.** `JUSTTPRINT_TRUST_PROXY` (hop count, `true`, or addresses) makes it use the client address from `X-Forwarded-For`; off by default.
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
- [x] **Publish a multi-arch image.** `npm run docker:hub:multiarch` builds `linux/amd64` and `linux/arm64` with Buildx and pushes one tag (`JUSTTPRINT_PLATFORMS` to change the list). Keep both: Intel/AMD for most NAS boxes and PCs, ARM for Raspberry Pi and Apple Silicon.

## 🟡 4. Medium: standalone server (remove Electron from the container)

The Docker image runs on plain Node. `src/server/index.js` starts `src/server/app.js`; library logic is in `src/core/`, the server and its IPC handlers in `src/server/`.

- [x] **Create `src/server/`**: `node src/server/index.js` runs server mode with no Electron (Electron stand-in: app paths and events, IPC registry, dialogs that answer Cancel, freedesktop trash, no windows).
- [x] **Generate thumbnails without Electron or Xvfb.** The server starts headless Chromium (Puppeteer, system Chromium) on the web UI as a worker client, identified by a secret cookie, and sends it the thumbnail jobs. It restarts after a crash. NVIDIA WebGL still works via `JUSTTPRINT_GPU`.
- [x] **Run STL Home scans in the server.** They were started by the hidden Electron window; the server now scans at startup and on the configured interval, then renders thumbnails for new models.
- [x] **Slim the Docker image**: no Electron, Xvfb, D-Bus, GTK or X11; production dependencies only. 2.46 GB → 1.11 GB.
- [x] **Keep a migration path**: same data path (`/root/.config/justtprint`) and database, so existing volumes keep working.
- [x] **Remove Electron completely.** `electron` and `electron-builder` are gone from `package.json`, along with the desktop window, menus, hidden worker window, preload, native input dialog and model viewer. `npm start` runs `src/server/index.js` on plain Node, and the DB tests run on plain Node. Text prompts use an in-page dialog. Since then the rewrite removed the remaining desktop branches, windows and native dialogs from `main.js`, and the Electron stand-in became `src/server/runtime.js` (paths, lifecycle, IPC registry, trash), required directly.
- [x] **Remove everything specific to Windows, macOS and Linux desktops.** Desktop build scripts, installer assets, `Dockerfile.build-linux`, slicer install detection, macOS/AppImage switches, asar lookups, `LOCALAPPDATA` paths and Windows UNC path modes are gone; the README and GUIDE describe Docker only. Kept: the Send to Slicer helper. The Chrome extension was removed later (4.5.x).
- [x] **Rewrite `main.js` to be cleaner and lighter.** `main.js` (12.6k lines) is gone. Its code now lives in modules under `src/core/` (database, models, search/filter SQL, thumbnails, library paths, file formats) and `src/server/` (HTTP/WebSocket server, MCP, thumbnail worker, and one IPC module per area in `src/server/ipc/`); `src/server/app.js` only starts and stops the server. Removed on the way: duplicate handler registrations, the always-off `DEBUG` logging, the Electron-era event fallbacks, dead functions and ~120 unused imports, `node-fetch`. Server-only libraries moved from the root into `src/`, so they are no longer served as static files. The e2e suite grew from 58 to 108 checks to cover each moved area.
- [x] **Split the largest modules further.** Done: `src/server/http.js` 1,082 → 734 lines (`port80.js`, `puter-ai-proxy.js`, `library-file-routes.js`), `ipc/context-menu.js` 1,100 → 623 (`context-menu-generate-tags.js`, `context-menu-pull-metadata.js`), `ipc/models.js` 1,006 → 450 (`model-save.js`), `ipc/previews.js` 949 → 698 (`previews-other-formats.js`).
- [x] **Drop `threemf-svg-extrude.js`**: nothing but a test loaded it.
- [x] **Server-initiated dialogs in the browser.** `src/server/client-dialogs.js` sends message boxes and prompts to the browser that made the request and waits for the answer (Pull Metadata, Purge Models, Tag from Folder, errors). Folder pickers are Choose Folder (section 5).
- [x] **Large stored thumbnails on Node.** Done differently: the originals stay; the grid gets small copies (512 px, WebP) made by the Chromium worker ([src/server/grid-thumbnails.js](src/server/grid-thumbnails.js)). The no-op `thumbnail-compress.js` is gone.
- [x] **Server GPU details in System Report.** Done: the System Report shows the thumbnail worker Chromium's WebGL renderer, vendor, version and texture size ([src/server/thumbnail-worker.js](src/server/thumbnail-worker.js) `webglInfo`).
- [x] **Replace the IPC-over-WebSocket shim with a proper HTTP API.** `POST /api/actions/<name>` (`src/server/api.js`), with the allowed actions and their argument types in `src/server/api-actions.js`. Login, same origin, arguments and library paths are checked before a handler runs. The WebSocket only pushes events and dialogs.
- [x] **Remove the IPC handlers that nothing calls**, their path rules, and the dead entries in the bridge's method list. `generateTagsHandler` stays for MCP; `openPath` and `showItemInFolder` stay in the bridge until their web replacements (section 5).
- [x] **Replace Puppeteer scraping** (Thangs/MakerWorld) with plain HTTP and site APIs. MakerWorld, Printables and Thingiverse use their APIs over plain HTTPS ([src/server/link-import.js](src/server/link-import.js), [src/server/site-details.js](src/server/site-details.js)); the Thangs page scraper, which nothing called any more, is removed. Puppeteer stays for the thumbnail worker.

## 🟡 5. Medium: web UI can do everything

- [x] **Rewrite the frontend in React + TypeScript (Vite), screen by screen.** The rename, the `main.js` rewrite and the HTTP API are done, so new screens call `/api/actions/*` directly (`src/web/api.ts`). Mount React into parts of the existing page so the app keeps working throughout:
  - [x] First a self-contained dialog, to set up Vite, TypeScript and the build in the Docker image. Server Access is in `src/web/` (built into `web-build/app.js` by `npm run build:web`, and by a stage in the Dockerfile).
  - [x] The dialogs and managers (4.2.0): tags, parts, filament, printers, stats, system report, backup/restore, about, shortcuts, every settings dialog, purge, metadata manager, STL Home, organize, de-dup.
  - [x] The model grid (virtualized), the details panel, the ZIP bundle and multi-edit panels, the 3D preview on current three.js (an imperative engine in `src/web/preview/engine.ts`; react-three-fiber was not needed), Manage Thumbnails, the Log Print dialog, the thumbnail renderer and parse worker, and the grid selection (`src/web/selection.ts`).
  - [x] The sidebar's search, sort and filters and the filter strip (`src/web/filters/`), replacing `search.js` and `query-builder.js`.
  - [x] The folder tree (select, popover, rail, Reveal in folders) and the sidebar layout (More filters, resize handles) in `src/web/folders/`, replacing `folder-tree.js` and `sidebar-layout.js`.
  - [x] The sidebar's counts and buttons (`src/web/filters/SidebarActions.tsx`).
  - [x] The menu bar and the phone layout (`src/web/shell/`): one menu for both, the app bar, bottom nav, sheets, More sheet and the details panels' phone header, replacing `mobile-ui.js`.
  - [x] The model menu (right-click, long-press and ⋯) in `src/web/menus/ContextMenu.tsx`.
  - [x] Keyboard shortcuts (`src/web/shortcuts.ts`, tested), shared with the Keyboard Shortcuts dialog.
  - [x] The Terms of Service and welcome dialogs (`src/web/startup/FirstRun.tsx`).
  - [x] Review Generated Tags (`src/web/tags/`), with its state and merge rule tested.
  - [x] Scanning, the thumbnail queue and the model loader, and the bulk thumbnail jobs with their progress (`src/web/scan/`, `src/web/thumbnails/`).
  - [x] The grid toolbar (views, tile size, Show/Hide columns) and the list view's columns and header (`src/web/grid/`).
  - [x] The searchable list dialog (`src/web/components/ListPicker.tsx`).
  - [x] The grid's model list and groups, selection, the details and bundle panels, multi-edit mode and saving (`src/web/library/`).
  - [x] Startup, the theme and the update check (`src/web/startup/`), Puter AI (`src/web/ai/`), and the page and server events (`src/web/library/actions.ts`, `components/ServerProgressDialog.tsx`). `renderer.js`, `filament.js` and `grid-refresh.js` are gone.
  - [x] The page scripts: `server-bridge.js` became [src/web/bridge/server.ts](src/web/bridge/server.ts) and [src/web/bridge/dialogs.ts](src/web/bridge/dialogs.ts) (only the 20 of its 90 methods still used), `guide.js` the React [QuickStartGuide.tsx](src/web/QuickStartGuide.tsx), `page-init.js` and `pwa.js` [startup/pageInit.ts](src/web/startup/pageInit.ts). Left as plain JavaScript on purpose: `slicer-protocol.js` (the Send to Slicer helper loads it too), `step-assembly.js` and `stl-sanity.js` (the parse worker loads them).
  - Test each screen in the browser against the container before moving on.
- [x] **Audit every desktop-only action** and give each one a web equivalent:
  - [x] Folder pickers: Choose Folder ([src/web/components/FolderPicker.tsx](src/web/components/FolderPicker.tsx)), a server-side folder browser ([src/server/folder-browse.js](src/server/folder-browse.js)) that starts from the mounted volumes and library folders and follows the scan rule (no system, app or data folders). Used by Scan a Folder, STL Home, Duplicates and Organize.
  - [x] File pickers for restore/import: browser uploads (Settings → Backup).
  - [x] "Show in folder" and "open file": **Download** and **Copy Path** in the model menu, run in the browser that clicked; **Reveal in folders** in the details panel.
  - [x] Native right-click menus: in-page model menu (`src/web/menus/ContextMenu.tsx`), built by [src/server/ipc/context-menu.js](src/server/ipc/context-menu.js).
  - [x] Input dialogs: in-page prompts (`askText` in [src/web/page.ts](src/web/page.ts)).
  - [x] Backup/restore: download and upload a backup file in the browser.
  - [x] "Send to slicer": the helper and `justtprint://` link, documented in GUIDE.md (Slicers).
- [x] **Show scan, thumbnail and AI-tagging progress live in the browser**, and keep it working after a page reload. Scans and thumbnail jobs since 6.0; AI tagging in 7.3.0 ([src/server/ai-tag-job.js](src/server/ai-tag-job.js)): progress in the sidebar, Stop, and a review reopened after a reload.
- [x] **Make sure multiple browsers can use the server at once** (7.1.0): changes show up live in the other browsers (`models-changed`, `events.broadcastToOthers`), and saving a field someone else changed meanwhile asks Keep Mine / Keep Theirs (notes: Keep Both); tags merge ([src/core/edit-merge.js](src/core/edit-merge.js)).
- [x] **Polish the mobile web UI and PWA** (7.4.0): touch-screen sizes and hover-only controls ([responsive.css](src/web/styles/responsive.css)), the drawer, and **Install App** ([src/web/install.ts](src/web/install.ts)). Still worth a check on real phones now and then (the audit used Chrome's phone emulation).
- [x] **Retire `renderer.js`** (~25k lines at 2.x): replaced screen by screen through the React rewrite above.

## 🟡 6. Medium: bugs, tests and CI

- [x] **Puter.com AI could not load Puter.js** (the CSP blocked `js.puter.com`). Puter.js now runs only on its own sign-in popup ([puter-signin.html](puter-signin.html)), which hands the login to the page ([src/web/ai/puterAuth.ts](src/web/ai/puterAuth.ts)); the library page's CSP is unchanged.
- [x] **Preview reopened within ~1 second logs "Container has zero dimensions"**: gone with `preview.js` (the 3D preview is React now).
- [x] **Fix the version check.** The startup check always used the public channel (2.2.2), so beta users never saw beta updates. It now follows `betaOptIn`.
- [x] **Run the tests in CI.** `.github/workflows/tests.yml` runs `npm test` and `npm run test:e2e` (with the runner's Google Chrome) on every push.
- [x] **Build the Docker image in CI and smoke-test it**: [scripts/docker-smoke.js](scripts/docker-smoke.js) (`npm run test:docker`, and the `docker` job in [.github/workflows/tests.yml](.github/workflows/tests.yml)) starts the image with the fixture library and checks health, PUID, login, the STL Home scan, the web UI, server-side thumbnails and a clean `docker stop`.
- [x] **Add end-to-end tests that drive the web UI.** `npm run test:e2e` starts the server on plain Node with `tests/fixtures/library` and runs 53 checks (API, security, path guard, MCP, backup, trash, and the browser UI).
- [x] **Run `npm run test:e2e` against the built Docker image too** (same checks, server in the container): `npm run test:e2e:docker` ([scripts/e2e-docker.js](scripts/e2e-docker.js)); the test folders are mounted at the same paths. It found the Settings forms popping up after leaving Settings (fixed).
- [x] **AI tagging review after a reload, in the container**: a review reopened while a result came in missed it ([src/web/tags/TagPreviewDialog.tsx](src/web/tags/TagPreviewDialog.tsx) now catches up after opening). `npm run test:e2e:docker` passes in full.
- [x] **Rebuild the performance checks**: `npm run test:perf` ([tests/perf/run.js](tests/perf/run.js)) times the scan, the API, the grid's pictures and scrolling, grid copies and repeated 3D previews on a generated 3,000-model library, against budgets and the previous run. Its first run found the grid regrouping the whole library for every picture that arrived (fixed: scrolling 3,000 models went from 81 slow frames to none).
- [x] **Make the database tests (`print-events`, `printer-manager`) run in the same runtime as the server.** They run on plain Node since Electron was removed.
- [x] **Move CI from Node 20 to Node 22+.**
- [x] **Standardize on one test runner.** TestDriver.ai is removed (its only test was the vendor's demo shop, and its workflow failed on every push without an API key). Unit tests run with Node and Vitest, the browser tests with Playwright (`npm run test:e2e`).

## 🔵 7. Cleanup

- [x] **Rename and rebrand the project to JusttPrint.** Name, docs, UI, package, Docker image, data folder, database file, `JUSTTPRINT_*` variables, `justtprint://` helper link, MCP name, browser extension and GitHub repository. A clean break (4.0.0) with upgrade steps in the CHANGELOG.
- [x] **New logo and icons for JusttPrint** (7.3.1; vector redraw in 7.3.2): drawn from [assets/icon-mark.svg](assets/icon-mark.svg), rendered by `npm run build:icons`; images live in `assets/`.
- [ ] **Reorganize files and folders into the target layout above** (done alongside sections 4 and 5).
- [x] **Remove unneeded dependencies**: the empty `fs` package, `node-fetch`, and `jszip` (zips are read and written with `fflate`; `openZip()` in `src/core/zip-entries.js`).
- [x] **Replace the ~500 `console.log` calls with a leveled logger.** Done (6.1.0): [src/core/log.js](src/core/log.js) adds time and level to every line and hides `console.debug` unless `JUSTTPRINT_LOG_LEVEL=debug`; per-request and per-file lines moved to `console.debug`. Before: Settings reads currently log on every call. Container logs should be readable with `docker logs`.
- [x] **Review the 133 `innerHTML =` assignments** for injection of file names or scraped data. Done (6.1.0): six were left after the React rewrite; only model notes build HTML from data, through the escaping Markdown renderer ([src/web/notes/markdown.ts](src/web/notes/markdown.ts), with injection tests). Links from data are limited to http(s).
- [x] **Remove redundant code**: the JS content-type middleware and the second static-file handler in [src/server/http.js](src/server/http.js), which could never serve anything the first did not.
- [x] **Replace the long hand-maintained file lists** in the `Dockerfile` and `package.json` `build.files`: the `Dockerfile` copies the project (`COPY . .`, trimmed by `.dockerignore`) and `build.files` went with Electron.
- [x] **Add ESLint and Prettier.** Done: [eslint.config.mjs](eslint.config.mjs) (JavaScript; TypeScript stays with `tsc` until typescript-eslint supports TypeScript 7) and [.prettierrc.json](.prettierrc.json); `npm test` runs both.
- [x] **Type checking for the server, and no ESLint warnings.** `npm run typecheck:server` ([tsconfig.server.json](tsconfig.server.json)) checks `src/server` and `src/core` from their JSDoc; `npm test` runs it and fails on any ESLint warning. Next step: `strict` mode, one folder at a time.
- [x] **Update docs**: the README and GUIDE describe the Docker web app only.
- [x] **Fix the "Archive" badge overlapping the file name** on zip-entry tiles in Preview view. Done (6.1.0): the label is in the name row.
- [x] **Fix the sidebar banner text in Docker.** The "Server Mode / UNC paths required" box is removed, and Scan Directory asks for a container path.
- [x] **Filament Manager: the hex color field is squeezed to nothing.** The Filament Manager dialog is gone (6.0); **Add Filament** ([src/web/components/AddFilamentDialog.tsx](src/web/components/AddFilamentDialog.tsx)) has a full-width hex field next to the picker.
- [x] **Fix the app-wide input style that puts a dropdown arrow on every `.form-group` input.** Only selects get the arrow now (`src/web/styles/legacy/base.css`); the per-dialog workarounds are harmless and go as those dialogs are redrawn.

## 🟢 8. Feature ideas, server and web (most valuable first)

- [x] **User accounts and roles** for sharing with family or a makerspace. Done in 6.2.0 as Admin, Editor and Viewer ([src/server/users.js](src/server/users.js), [src/server/server-auth.js](src/server/server-auth.js), roles per action in [src/server/api-actions.js](src/server/api-actions.js), Settings → Users in [src/web/UsersDialog.tsx](src/web/UsersDialog.tsx)). Per-user display preferences and read-only controls for viewers followed in 6.4.0 ([src/server/ipc/settings.js](src/server/ipc/settings.js), [src/web/components/EditOnly.tsx](src/web/components/EditOnly.tsx)). Left: a no-login guest mode.
- [x] **Automatic, scheduled backups** with retention, saved to a mounted volume: Settings → Backup → Automatic Backups ([src/server/auto-backup.js](src/server/auto-backup.js), [src/web/settings/AutoBackup.tsx](src/web/settings/AutoBackup.tsx)) and the `JUSTTPRINT_*BACKUP*` variables.
- [x] **Clean up hand-made backups and exports.** Done in 6.0.1 ([src/server/download-files.js](src/server/download-files.js)): downloads go into `downloads/` and are deleted after an hour; Settings → Backup offers to delete old ones. Before: **Create Backup** and **Export Library** write `justtprint-backup-*.db` and `justtprint-library-*.json` into the data folder for the browser to download, and nothing deletes them afterwards.
- [x] **Folder watching**: pick up new or removed files on mounted libraries automatically instead of rescanning by hand. One `fs.watch` per STL Home folder ([src/server/folder-watch.js](src/server/folder-watch.js)), batched rescans of the changed folders ([src/server/stl-home.js](src/server/stl-home.js)); network shares still rely on the timed scan.
- [x] **Upload models through the web UI** (drag and drop) into a chosen library folder. Done in 6.2.0: `POST /api/upload` ([src/server/uploads.js](src/server/uploads.js)) and the Upload Models dialog ([src/web/upload/UploadDialog.tsx](src/web/upload/UploadDialog.tsx)).
- [x] **Collections/projects** that group models across folders. Done in 6.5.0 ([src/core/collections.js](src/core/collections.js), [src/web/pages/CollectionsPage.tsx](src/web/pages/CollectionsPage.tsx)).
- [x] **Read-only share links and QR codes** for a model or collection. Done in 6.5.0 ([src/core/share-links.js](src/core/share-links.js), public page [src/server/share-pages.js](src/server/share-pages.js), [src/web/share/ShareDialog.tsx](src/web/share/ShareDialog.tsx)). Possible later: a 3D preview on the shared page.
- [x] **Geometry-based duplicate detection**: find the same model across different files. Done as **Find: Same geometry** on the Duplicates page ([src/core/geometry-signature.js](src/core/geometry-signature.js), [src/server/geometry-job.js](src/server/geometry-job.js)): rotation- and placement-proof, mirror-aware. Models inside ZIP files are compared too (when ZIP archives are on). Not covered: the same design meshed at another resolution.
- [x] **Bulk import from Printables/Thingiverse/MakerWorld URLs** in the web UI. Done as **Add Links** ([src/web/links/LinkImportDialog.tsx](src/web/links/LinkImportDialog.tsx), [src/server/link-import.js](src/server/link-import.js), parsing in [src/core/link-import.js](src/core/link-import.js)). Possible later: an MCP tool for it. MakerWorld models also get details and downloads in the details panel ([src/web/makerworld/MakerWorldSection.tsx](src/web/makerworld/MakerWorldSection.tsx), [src/server/site-details.js](src/server/site-details.js)); Printables and Thingiverse could get the same.
- [x] **Undo for metadata and tag edits** (7.2.0): the Undo notice and Ctrl/Cmd+Z ([src/web/library/undo.ts](src/web/library/undo.ts)). Not covered: Tag Manager renames and deletes, the Metadata Editor.
- [x] **Statistics dashboard**: prints per month, success rate, top designers (filament used was dropped with filament in 7.0). Done in 6.2.0 as the Statistics page ([src/web/pages/StatsPage.tsx](src/web/pages/StatsPage.tsx), [src/core/print-stats.js](src/core/print-stats.js)), drawn in SVG (Chart.js is no longer a dependency). Filament is counted in prints: the print log does not record grams.

---

# Phase 2: Desktop app (dropped)

JusttPrint is Docker-only. The desktop items that were here (hardening Electron windows, desktop packaging, packaged-app tests, the slicer-detect path bug, `viewer.html`) are replaced by "Remove Electron completely" and "Remove everything specific to Windows, macOS and Linux desktops" in section 4.
