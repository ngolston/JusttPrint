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
