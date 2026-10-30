# JusttPrint 10: FilamentHub merged in

FilamentHub (ngolston/FilamentHub: Python, FastAPI, SQLAlchemy, Alembic, React 18) tracks filament: spools, filament profiles, AMS slots, drying, reorder, QR labels, alerts. JusttPrint 7.0 removed its own filament support. JusttPrint 10 brings filament back by moving FilamentHub's features into JusttPrint, then retires FilamentHub. The look is in [design-bento.md](design-bento.md).

## Decisions

- **JusttPrint is the app that stays.** FilamentHub's backend is rewritten in JusttPrint's Node server (`src/core`, `src/server/ipc`, better-sqlite3); no Python in the image.
- **One release: 10.0.0** (major: new data model, new look). Work on a `merge-10` branch, as `redesign-5` was; every phase leaves `npm test` and `npm run test:e2e` green.
- **One household, not one account per spool.** FilamentHub gives every spool, printer and location an owner (`owner_id`). JusttPrint's users share one library, so spools, printers and locations are shared too; `created_by` records who added them.
- **JusttPrint's accounts, roles, sessions, API token, notifications and backups stay.** FilamentHub's are mapped onto them (below), not added beside them.
- **New table names never reuse 7.0's dropped names.** `removeFilamentData()` in `src/core/db-init.js` drops `filaments`, `model_filaments` and `print_event_filaments` on every start. 10.0 uses `spools`, `filament_profiles`, `model_plate_filaments` and `print_event_spools`, and keeps `removeFilamentData()` (it still cleans up 6.x databases).
- **The filament check is the point of the merge.** Every model knows the colors and grams each plate needs; every spool knows what is left; the app says "Ready to print" or "12 g short" before you print, and takes the grams off when you log the print.

## Data mapping

### Tables that come over (new in JusttPrint)

| FilamentHub | JusttPrint 10 | Changes |
|---|---|---|
| `brands` | `filament_brands` | As is. |
| `filament_profiles` | `filament_profiles` | As is (material, color, diameter, density, temperatures, drying, product link, photo). `is_community`/`is_verified` become `source` (`manual`, `catalog`, `spoolman`). Seeded from FilamentHub's `app/data/filament_profiles_db.json`. |
| `spools` | `spools` | Drop `owner_id`, add `created_by` (user id). Keep weights (`initial_weight`, `spool_weight`, `used_weight`), price, supplier, lot, color, material, status, dates. Remaining = initial − used. |
| `storage_locations` | `storage_locations` | Drop `owner_id`. Drop the printer and AMS columns: where a loaded spool is comes from the AMS tables and `printers.direct_spool_id`. |
| `weight_logs` | `spool_weight_logs` | As is. |
| `drying_sessions` | `drying_sessions` | As is. |
| `ams_units`, `ams_slots` | `printer_ams_units`, `printer_ams_slots` | As is, against JusttPrint's `printers`. Add `humidity` to units. |
| `alert_rules`, `alert_fired` | `low_stock_rules`, `low_stock_fired` | Drop `owner_id`. Firing writes a JusttPrint notification (`src/server/notifications.js`) and, if set, Discord, email or webhooks. |
| `webhooks` | `webhooks` | Drop `owner_id`; admin-only. Events gain JusttPrint's (print logged, models added). |
| `print_job_photos` | `print_event_photos` | Against `print_events`. Files under the data volume like thumbnails. |

### Tables that merge with JusttPrint's

| FilamentHub | JusttPrint today | JusttPrint 10 |
|---|---|---|
| `printers` (name, model, connection_type, serial_number, api_url, api_key, status, last_seen_at, direct_spool_id) | `printers` (nickname, manufacturer, model, printer_type, firmware_type, is_klipper, web_url, notes) | JusttPrint's table gains `connection_type`, `serial_number`, `api_url`, `api_secret` (FilamentHub's `api_key`; never sent to the browser, never logged), `status`, `last_seen_at`, `direct_spool_id`. Name → `nickname`. Maintenance logs and reminders stay as they are. |
| `print_jobs` (printer, plate_number, file_name, filament_used_g, duration_seconds, outcome, started_at, finished_at) + `print_job_spools` | `print_events` (model_id, printed_at, outcome, quantity, notes, printer_id) | `print_events` gains `plate_index`, `file_name`, `duration_seconds`, `started_at`, `filament_used_g`. New `print_event_spools (event_id, spool_id, grams)`. Logging a print with spools adds to each spool's `used_weight` in the same transaction. Outcomes map: success → printed, failed → failed, cancelled → failed with a note. |
| `users` (UUID id, email, display_name, role admin/editor/viewer/operator, TOTP, preferences, discord_webhook_url, bambu_config, ha_config) | `users` (username, password_hash, role, session_key) | JusttPrint's users stay. The FilamentHub import matches by email local part or display name, else creates the user with a random password the admin resets. `operator` → `editor`. Units, currency and timezone become library-wide settings. Discord, Bambu cloud and Home Assistant settings become admin settings. TOTP is a later feature. |
| `api_keys` (per user, scoped) | One API token (settings `serverApiToken`), acts as admin | Keep the single token for 10.0; per-user scoped keys are a later feature. |
| `refresh_tokens`, `password_reset_tokens` | Session key per user | Not carried over. |
| `system_config` (SMTP, allow_registration) | `settings` table | SMTP becomes `settings` keys (password stored like the other secrets). `allow_registration` is dropped: JusttPrint admins create accounts. |
| `projects` (name, client, design link, priority, plate data, filament estimates, comments) | Models, collections, kits, queue | Each project becomes a collection named after it; linked models are matched by file name, the rest of the project goes into the collection's description. **Not decided yet (open question below).** |

### New in JusttPrint 10 (neither app has it)

| Table | Purpose |
|---|---|
| `model_plate_filaments (model_id, plate_index, slot, material, color_hex, grams)` | What each plate needs. Filled from the 3MF's `Metadata/slice_info.config` (`<filament id type color used_g>` per plate; `src/server/threemf-plates.js` already reads each plate's total grams and time from the same file) and from MakerWorld print profiles (`instanceFilaments` in `src/core/makerworld.js`). |
| `print_queue (id, model_id, plate_index, printer_id, position, created_by, created_at)` | A real queue with order, plates and printers. Today the queue is `models.print_status = 'queued'`; that status stays in step (a model is Queued while it has queue rows). |
| `queue_spool_holds (queue_id, spool_id, grams)` | Grams reserved by queued prints, so "Ready to print" counts what earlier queued prints will use. |

## The filament check

`src/core/filament-check.js` (new): for a model and plate (or all plates), match each needed color to a spool, preferring (1) a spool loaded in the chosen printer with the same material and the nearest color, (2) any spool of that material and color in storage. A color matches within a small distance in Lab space or by a manual match the user saved. Result per color: spool, remaining after holds, grams short. The library's "Fits my filament" filter and the cards' badge come from a cached per-model result, refreshed when spools, loads or holds change (like the library counts, `jp:library-changed`).

## Phases

1. **Tokens and components.** Bento tokens, Plus Jakarta Sans, the new components in the design system gallery (design-bento.md). No page changes yet.
2. **Schema.** Every table above, created in `db-init.js` style (create if missing, add columns if missing), with unit tests. A backup is taken before the first 10.0 start, as auto-backup already allows.
3. **Spools and profiles.** IPC handlers in `src/server/ipc/spools.js`, `filament-profiles.js`, `locations.js`, `drying.js`; Filament page (J2 · Filament) with add, edit, weigh, dry, move, archive; catalog import from `filament_profiles_db.json`; Spoolman import (FilamentHub `services/import_export.py`).
4. **Plates and the check.** Read per-plate filament from 3MF and MakerWorld into `model_plate_filaments` (also for existing models, as a background job with progress like thumbnails); `filament-check.js`; FitBadge on cards; Log Print takes spools and grams.
5. **Printers.** Merged printer fields, AMS units and slots, direct spool; Printers page in Bento. Bambu cloud device list from FilamentHub `services/bambu.py` (login, 2FA, devices) as an optional connection; live status (LAN mode) is a later feature, after 10.0.
6. **Queue.** `print_queue` and holds; Queue page; "Up next" filament check on Home.
7. **Library and model page.** Browse layout and model page (J2 boards); Home in Bento.
8. **Alerts and webhooks.** Low-stock rules, Discord, email (SMTP), webhooks with HMAC signing (FilamentHub `core/notifications.py`), reorder list, QR labels (FilamentHub `features/qr-labels`).
9. **FilamentHub import.** Settings → Import → FilamentHub: reads a FilamentHub database file (`filamenthub.db` from its data volume) or its JSON export, shows what it will add, then imports in one transaction. Re-running it skips what is already there (FilamentHub ids kept in a `source_ref` column).
10. **MCP and stats.** MCP tools for spools and the filament check; Statistics gain filament used and cost per model, printer and month.
11. **Release.** README, GUIDE, CHANGELOG with upgrade notes, version 10.0.0, the checks and Docker Hub push from CLAUDE.md. FilamentHub's README points to JusttPrint and the repository is archived.

## Progress

- **Phase 1 done.** Bento tokens in `src/web/styles/tokens.css`, light by default with a Bento dark (Settings → Theme keeps Light, Dark and Match the system; the accent themes are removed, `uiTheme` is no longer read). Every text use of coral and the status colors moved to the new `*-text` tokens. Plus Jakarta Sans replaces Inter (`@fontsource-variable/plus-jakarta-sans`). Buttons and cards take the Bento radii, weights and shadow. New components in `Bento.tsx`, `Filament.tsx`, `Browse.tsx` and `ModelParts.tsx` (styles in `styles/bento.css`), shown at `#/design-system`, with unit tests; `formatDuration` and `formatGrams` moved to `src/web/format.ts`. Page layouts are unchanged. Not done yet: the app icon and logo (still the blue mark) and the share pages (`src/server/share-pages.js`, still the 5.0 colors).
- **Phase 3 done.** Server: `src/core/filament-profiles.js` (brands, profiles, the catalogue), `spools.js` (save, weigh, move, archive, delete, the page's summary), `storage-locations.js`, `drying.js`, `spoolman-import.js` and `filament-values.js` (checks), behind `src/server/ipc/spools.js`, `filament-profiles.js`, `locations.js` and `drying.js`; reading needs a viewer, changing an editor. The catalogue is a trimmed copy of FilamentHub's `filament_profiles_db.json` (27,630 filaments, 4.5 MB; rebuilt with `scripts/build-filament-catalog.js <file>`) in `src/core/data/filament-catalog.json`, searched in memory; a filament added from it becomes a profile (`source` catalog, `source_ref` `catalog:<id>`) whose material is the base material (`baseMaterial`: "PLA Silk" → PLA; the full one is the spool's `material_type`). The Spoolman import takes the API's nested spools, the export's flattened ones or `{ spools }`; `source_ref` is `spoolman:<id>` (and `spoolman-filament:<id>` on profiles), so `source_ref` values carry a prefix, and FilamentHub's will be `filamenthub:<id>`. Page: `#/filament` (`pages/FilamentPage.tsx`, `filament/*`, `styles/filament.css`), in the sidebar under Printing and in Settings → Printers: On hand, Add a spool and Dryer (while something dries) tiles; the spools with filters (running low under 300 g, drying, material, archived) and a search; a spool's drawer with Weigh, Dry / Finish drying, Move, Edit, Archive and Delete; forms for the spool, catalogue, Spoolman and places. Left for later phases, as the mockup's tiles need their data: Reorder (8), Loaded in printers (5), Used this month and "lasts N months" (4, 10), Scan QR (8), the money on hand (currency setting, 10). The phone bottom bar still has Queue, not Filament.
- **Phase 2 done.** `src/core/filament-schema.js` (`ensureFilamentSchema`, run by `db-init.js` on every start and after a restore) creates every table in the mapping above and adds the new `printers` and `print_events` columns, with indexes. Choices made: `created_by` is a users.id without a foreign key (deleting an account keeps what it added); every table a FilamentHub import fills has `source_ref` (Phase 9); text values (status, source, connection type) are checked in code, not with CHECK constraints; a deleted spool clears its AMS slot and `direct_spool_id` and leaves its `print_event_spools` rows with `spool_id` NULL, so the history keeps the grams; deleting a model removes its plate filaments and queue rows; spools keep FilamentHub's three extra colors as `color_hex_2` to `_4`; drying uses `target_hours`. The first time `print_queue` is created, Queued models go into it, oldest added first. The first 10.0 start on a 9.x library writes `justtprint-before-10.0-<time>.db` (VACUUM INTO, checked) to the automatic backups' folder; automatic pruning never removes it, and a failed copy is logged without stopping startup (9.x can still open a 10.0 database: everything is added, nothing changed). A restore now also turns foreign keys on. Tests: `tests/filament-schema.test.js`. For Phase 6: merging an online model into a local one (`merge-online-model.js`) deletes the online row, so its queue rows must move first.

## Settled

- **Spools are shared** by everyone on the library (no per-user spools). Imported FilamentHub accounts' spools all land in the one library.
- **Currency and units are one setting for the whole library**, not per user.
- **Bambu live status (LAN mode: MQTT, live AMS and progress) is a later feature**, not in 10.0. 10.0 keeps FilamentHub's cloud device list as an optional connection.

## Open questions

- **FilamentHub projects** (decide later): collections (as in the mapping above), or a new "Project" type that groups queue items for a client? Until decided, phase 9's import leaves projects out and says so.
