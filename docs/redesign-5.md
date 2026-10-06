# JusttPrint 5 redesign: migration plan

Source of truth: `JusttPrint_5_UI_UX_Redesign_Specification.pdf` and the reference render. This plan maps them onto the real app. Work happens on the `redesign-5` branch and ships once, as **5.0.0**. Every phase leaves the app runnable with `npm test` and `npm run test:e2e` green.

## Decisions

- **Real data only.** Nothing on screen is invented. Parts of the render that JusttPrint cannot back yet are adapted or left out (table below) and listed as later features.
- **One release.** 5.0.0 when all phases are done; no mixed old and new UI on `main`.
- **Hero visual** is rendered from a model in the user's own library (see Phase 5), not a stock image.
- **Dark first**, with every color a semantic token so a light theme needs no component changes. The current accent themes (Settings → Theme) are replaced by the new token set.
- **Inter** (OFL) and **Lucide** icons (`lucide-react`, ISC) are bundled into the image, not loaded from a CDN, so the app works offline on a LAN and under the current Content Security Policy.
- **No backend rewrite** (spec §54). New server code is limited to small read-only actions the new screens need (library storage, recent activity, dashboard counts).

## Render vs. what JusttPrint has

| In the render | JusttPrint today | Plan |
|---|---|---|
| "Good afternoon, James" | One shared password, no user names | "Good afternoon" with no name. User accounts stay a feature idea. |
| Avatar menu | Server Access, Log Out exist | Account icon opens a menu with Server Access and Log Out. |
| Notification bell | No notifications | Left out until there are notifications. |
| Sun (theme) toggle | Dark only after the redesign | Left out until a light theme exists. |
| Stats: Models, Printed, In Queue, Printers | All countable from the database | Real counts. |
| Recent Activity | Print log (`print_events`), `dateAdded` on models, scan completion events | Recent prints (date, outcome, filament), "N new models added" grouped by day. No filament stock events (stock is not tracked). |
| Your Printers with live state and progress | Printer inventory and maintenance reminders, no connection to printers | Each saved printer with its type, a link to its web UI, and maintenance due. No Ready/Printing state. Live status and "Print" become a later feature (Moonraker, OctoPrint, Bambu). |
| Queue (sidebar, badge 3) | Models with print status Queued and Printing | Queue page lists Printing then Queued models; badge = count. No ordering or per-printer assignment. |
| Collections | Not in JusttPrint | Left out of the navigation until Collections exist (TODO section 8). |
| Library Storage 128 GB of 500 GB | Model sizes in the database; disk size readable on the server | New read-only action: total size of the library and the free space of the volume STL Home is on. |
| Card badges 3MF/STL and PLA | File type; filaments assigned to a model | Format badge, first filament's material, print-status badge. |
| Details "Print" button | No send-to-printer | **Log Print** (the existing dialog) in that place. |
| Open in Slicer with dropdown | Send to Slicer with several configured slicers | Same action; the dropdown lists the configured slicers. |
| Filament (Recommended) | Filaments assigned to the model, with color and vendor | Shows the assigned filament(s); chevron opens the Filament Manager. |
| Print History with printer names | Print log has date, outcome, filaments, notes; no printer | Date, filament, outcome badge. No printer name. |
| Duplicates Keep Left/Both/Right | De-Dup dialog with keeper choice | Redesigned page with side-by-side comparison; never deletes without confirmation (already true). |

Everything JusttPrint does today keeps a home (spec §53): parts stock, printer maintenance, Organize Library, Purge, Manage Thumbnails, Tag from Folder, Pull Metadata, notes, parent models, bundles, multi-edit, ratings, Print Roulette, MCP, HTTPS, backups, AI tagging, Puter sign-in, system report, keyboard shortcuts, Quick Start Guide.

## Architecture

- **Shell.** `index.html` becomes a minimal page with one React root. `AppShell` (sidebar, top bar, main, details panel) replaces the old sidebar/menu-bar layout and `MobileShell`.
- **Routing.** A small hash router (`#/home`, `#/library`, `#/queue`, `#/printers`, `#/filament`, `#/tags`, `#/duplicates`, `#/organize`, `#/scan`, `#/ai-tagging`, `#/settings/<section>`, `#/help`). No dependency needed; back/forward and reloads work.
- **Pages replace dialogs** where the spec makes them destinations (Printers, Filament, Tags, Duplicates, Organize, Settings). The existing React dialog bodies are reused inside pages wherever possible, so behaviour and tests carry over.
- **Library.** The existing virtualized grid, selection, filters store and search keep working; the card and toolbar are redrawn. Filter chips and the folder tree move into a Filter popover and a folder panel.
- **Details panel.** Composed from the existing details components (fields, filaments, notes, print history, path) in the render's order.
- **Styles.** `src/web/styles/` holds `tokens.css`, `typography.css`, `layout.css`, `components.css`, `utilities.css`. New components only use tokens. The nine legacy stylesheets are removed in Phase 14 once nothing uses them.
- **Components** (`src/web/components/`): Button, IconButton, Badge, StatusBadge, Tag, Panel, StatCard, ProgressBar, Dropdown, Drawer, Modal, EmptyState, Skeleton, ActivityItem, PrinterRow, ModelCard, ModelGrid, ModelList, ModelPreview, ModelDetailsPanel, FilterBar, SearchBox, CommandPalette.

## Phases

Each phase: build, unit tests, end-to-end tests, then a screenshot at 1536 × 1024 compared with the reference render before moving on (spec §60).

1. **Tokens and component library.** Tokens from spec §2 and §4, Inter and Lucide bundled, base components with unit tests. No visible change yet.
2. **Shell, sidebar, top bar, routing.** New layout and navigation; old screens open inside the main area. Library Storage indicator (new action). Search box with Ctrl/⌘ K.
3. **Library and model cards.** "Your Library", state tabs (All, Printed, Unprinted, Queue, Favorites), count, grid/list, Filter popover; new card design, four per row at 1536 px.
4. **Model details panel.** Large preview with thumbnail strip, identity, tags, Open in Slicer / Log Print, details list, filaments, print history.
5. **Home dashboard.** Hero with greeting, four stats and a cyan render of a library model (most recently printed, else most recently added; rendered client-side with the existing 3D engine and cached). Recent Activity, Your Printers.
6. **Print Queue.** Printing now, Up next (Queued), Completed (recent successful prints).
7. **Printers.** Printer cards and detail (inventory, maintenance, web UI link).
8. **Filament.** Visual spool inventory from the filament catalog and Spoolman.
9. **Tags** (and Collections later).
10. **Duplicates and Organize.**
11. **Settings.** One page grouped as spec §47, holding today's settings dialogs.
12. **Responsive.** Laptop: details as drawer. Tablet: icon rail, 2–3 columns. Phone: drawer or bottom nav, 1–2 columns, details as a full-screen sheet.
13. **Accessibility and performance.** Focus states, ARIA, keyboard paths, reduced motion, contrast; virtualization and lazy loading checked with a large library.
14. **Remove the legacy UI.** Old stylesheets, `MobileShell`, old menu bar, unused slots in `index.html`.

Then: README, GUIDE screenshots, CHANGELOG with upgrade notes, 5.0.0 release.

## Later features (not in 5.0.0)

Printer connections with live status and a real Print button; Collections; notifications; user accounts with names; light theme; filament stock levels.

## Progress

- **Phase 1 done.** Tokens (`src/web/styles/tokens.css`), type scale, component styles, Inter and Lucide bundled (build-time only; `web-build/app.css` and the Inter `.woff2` files). Components in `src/web/components/`: Button, IconButton, Badge, StatusBadge, PrintStatusBadge, Tag, AddTagButton, Panel, StatCard, ProgressBar, Skeleton, EmptyState, Tabs, Menu, Modal, Drawer, SearchBox, with unit tests (`components.test.tsx`). All components are shown at `#/design-system` (`src/web/design/Gallery.tsx`). The legacy stylesheet's global `button` rule is undone on the new classes only, so old screens are unchanged until Phase 14.
- **Phase 2 done.** `AppShell` (sidebar with brand, navigation in spec order, Queue badge, Library Storage; top bar with search, Ctrl/⌘ K and the account menu) and a hash router (`#/home`, `#/library`, `#/settings/<group>`, `#/help`). Settings and Help pages list every tool and setting; `nav.test.ts` checks every old menu action has a place. New read-only actions `get-library-storage` (library size, STL Home volume usage) and `get-library-counts` (models, printed, queued, printing, printers). The API helper fires `jp:library-changed` after data changes so shell figures refresh. The old library screens sit right of the shell through `legacy-bridge.css`; the old menu bar and logo are hidden. Phones keep the old phone layout until Phase 12. Home is a placeholder until Phase 5; the app opens on the library until then.
- **Phase 3 done.** Library header (`src/web/pages/LibraryPage.tsx`): "Your Library", state tabs (All Models, Printed, Unprinted, Queue, Favorites; `src/web/library/tabs.ts`), model count, Folders, Grid / Wall / List, and a Filter popover holding the old sidebar's filter section; the active filters show as chips under the tabs. The old page parts move into the shell while it is shown and back for the phone layout (`src/web/shell/adopt.ts`). New card design (`ModelCard` / `GroupCard` with `tile`): responsive columns of at least 200 px (four at 1536 px), preview on top with Favorite, More and the rating, footer with title, designer (else folder), format and material badges and the print status (click logs a print, Shift-click sets the status). The old sidebar is now the 360 px details column on the right with a "No model selected" state; scan and thumbnail job progress sit in the shell sidebar above Library Storage. Server: the print filter `in-queue` (Queued or Printing) for the Queue tab and sidebar link, and `filamentMaterial` (first filament's material) on list rows. Scan a Folder, View Entire Library and Print Roulette moved from the old sidebar to Settings; Reveal in folders opens the folder panel; Ctrl+/ focuses the top bar search. The old sidebar's width handle is gone (fixed details width). Fixed from Phase 2: the top bar search and the Queue link now run the search.
- **Phase 4 done.** Details panel on the desktop (`src/web/details/ModelDetailsPanel.tsx`, styles in `details.css`): large preview (click or "3D" opens the 3D preview) with Favorite and More (the model menu), a thumbnail strip of the model's images, the name as title and "By designer", tags as pills with the pickers after them, Open in Slicer (sends to the first slicer; the dropdown lists all, or offers Slicer Settings) and Log Print. Then Details (File, Format, Size, Print status, Source, Designer, Parent Model, License, Location as a breadcrumb of the last folders, Added, Rating), Filament (spool rows; the chevron opens the Filament Manager), Notes, Print History (date, details, outcome badge) and Enter Multi-Edit Mode. The editors are the existing details components moved into this layout (`shell/adopt.ts`), so saving works as before; selects and inputs read as values until hovered. Send to Slicer code is shared with the 3D preview (`src/web/slicer.ts`). The tags have their own slot (`#details-tags-slot`). Bundle and multi-edit panels keep their old look until a later phase.
- **Phase 5 done.** Home (`src/web/pages/HomeDashboard.tsx`, styles in `home.css`) is the dashboard above "Your Library", as in the render; Library is the library alone. The app opens on Home. Hero: "Good morning/afternoon/evening" (no name), a one-line summary from real figures (printing, queued, or models added this week), four figures from `get-library-counts` that open the matching tab (Printers opens the Printer Manager), and a cyan render of the most recently printed model, else the newest (`src/web/home/heroRender.ts`, lazy-loaded with three.js, cached in localStorage per model version; its caption opens the model). Recent Activity (new read-only action `get-recent-activity`, `src/core/recent-activity.js`): logged prints with outcome, printer and first filament, and models added per day (opens the "new models" view). Your Printers: each saved printer with make and model, print count or "Maintenance due" (reminders due within 7 days), and a link to its web page; Manage opens the Printer Manager. The grid now refits its height when the header above it changes (filter chips, the dashboard). `useLibraryData` moved to `src/web/shell/libraryData.ts`.
- **Phase 6 done.** Print Queue page at `#/queue` (`src/web/pages/QueuePage.tsx`, `queue.css`); the sidebar's Queue opens it (badge unchanged). Printing now (models with status Printing: Log Print finishes one, ↩ puts it back in the queue), Up next (Queued, numbered, oldest addition first since there is no queue order yet: Start sets Printing, × removes it from the queue), Completed (the latest successful logged prints with printer and filament; ↻ queues it again). A name opens the model in the library. "Show in Library" opens the library's Queue tab. New read-only action `get-recent-prints` (`src/core/recent-activity.js`). No live progress or remaining time: there is no printer connection yet.
- **Phase 7 done.** Printers page at `#/printers` (`src/web/pages/PrintersPage.tsx`, `printers.css`); the sidebar's Printers, the Settings row and the dashboard's printer figure, rows and Manage open it. A card per printer (make and model, type, firmware, Klipper, print count, last print, "Maintenance due"); the selected one (`#/printers/<id>`) shows Open Web UI, Edit, Maintenance and Delete, its details, pending reminders (Done completes one and logs it, as in the Printer Manager), the latest maintenance log and its recent prints (`get-recent-prints` now takes a printer). Add Printer, Edit and Maintenance open the Printer Manager dialog at the form or tab (`openPrinterManagement({ action, printerId, tab })`); Parts opens the Parts Manager. No live status or current print: there is no printer connection yet.
- **Phase 8 done.** Filament page at `#/filament` (`src/web/pages/FilamentPage.tsx`, `filament.css`); the sidebar's Filament and the Settings row open it. Each catalog filament is a spool drawn in its color, with vendor and name, material, diameter, source (Manual or Spoolman), how many models use it, and how many logged prints and when it was last used (`get-all-filaments` now returns `print_count` and `last_used_at`). Search (name, vendor, material, color) and material chips; Show models opens the library filtered to that filament; Remove asks first. Add Filament and Spoolman open the Filament Manager at the form or the Spoolman setup (`openFilamentManager({ action })`). Remaining amount, location and printer compatibility are not tracked yet (later feature: filament stock levels).
- **Phase 9 done.** Tags page at `#/tags` (`src/web/pages/TagsPage.tsx`, `tags.css`); the sidebar's Tags opens it. Every tag with how many models use it and a bar relative to the most used; order by Most used or A–Z, search, and an Unused filter. Create a tag, rename it inline (renaming onto an existing name merges after asking; clearing the name deletes), delete (asks when models use it), and show its models in the library. The rules are shared with the Tag Manager dialog (`src/web/tags/manage.ts`), which stays for its other entry points. AI Tagging opens the AI settings. Collections stay a later feature.
