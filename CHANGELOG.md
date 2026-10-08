# Changelog

All notable changes contributed via pull request are documented in this file.

## [7.5.0] - 2026-10-07

**Upgrading:** no changes needed. Reload open browser tabs after the update. The JusttPrint backend now contacts Printables, Thingiverse and MakerWorld when someone uses **Add Links**: allow outgoing HTTPS to `api.printables.com`, `media.printables.com`, `www.thingiverse.com`, `resize.thingiverse.com`, `cdn.thingiverse.com`, `makerworld.com` and `makerworld.bblmw.com` if your network limits it.

**Changes:**
- **Add Links:** **Add Links** in the Library (next to **Upload**) takes a list of Printables, Thingiverse and MakerWorld links, pasted one per line or mixed with other text, up to 200 at a time. Each model is added as an online model with its name, designer, license and picture from the site, and the link as its source. While you paste, the dialog lists each model and marks the ones already in your library (as an online model, or as a file whose source is that link); those are skipped, and so is the same model pasted twice in another form (`/files`, a language prefix, with or without the name). Then it adds them one by one with a status per link; **Stop** finishes the current one. When a site cannot be reached the model is still added, named from the link, with a note to fill in the details; a model the site does not have is left out. Editors and admins only.
- The JusttPrint backend asks each site for one model number at fixed addresses (Printables' and MakerWorld's public APIs, the Thingiverse model page) and loads pictures only from those sites' image servers, so pasted text cannot make it load anything else.

**Fixes:**
- Online models (added from links, or by the old browser extension) no longer show an **Archive** badge on their cards.

## [7.4.0] - 2026-10-07

**Upgrading:** no changes needed. Reload open browser tabs after the update.

**Changes:**
- **Install App:** **Settings → Install App** (and **Help**) adds JusttPrint to the home screen or the desktop, with the steps for your browser: one **Install** button in Chrome and Edge, **Share → Add to Home Screen** on iPhone and iPad, and a note when the browser needs HTTPS first. A minimal service worker is registered so browsers offer to install; it handles no requests, so pages load exactly as before. The Guide explains the HTTPS part (a reverse proxy with a certificate is the easiest).
- **Touch screens:** buttons that appeared only on mouse hover are always shown on phones and tablets: a card's heart and **…**, the search and **+** buttons beside the details fields, and print history's delete. Small controls are finger-sized: card buttons, the view switch, tabs and chips, the details and multi-edit fields and buttons, the rating stars. A mouse keeps the compact sizes.
- **Phone menu:** the Menu drawer scrolls as a whole, so Help is no longer hidden under Library Storage.

**Fixes:**
- The arrow beside **Open in Slicer** (choose a slicer) was squeezed to half its width on every screen size.

## [7.3.3] - 2026-10-07

**Changes:**
- Removed `assets/sidebar-bg.jpg`, an old background texture nothing used.

## [7.3.2] - 2026-10-07

**Upgrading:** no changes needed. Browsers keep old icons for a while: reload the page, and on a phone remove and add the home-screen icon again.

**Changes:**
- **Sharper logo and icons:** the printer-in-a-hexagon is redrawn as a vector ([assets/icon-mark.svg](assets/icon-mark.svg)) with more detail (lit hexagon with depth, rails, print head, a layered print and a glowing bed), and every icon is rendered from it, so it is crisp from the 16 px browser tab to the 512 px home-screen icon. The README logo and the "3D" placeholder for models without a thumbnail are redrawn too. `npm run build:icons` rebuilds them all after an edit.
- **Images moved to `assets/`:** the logo, icons and placeholder are no longer at the top of the project. `/favicon.ico` and `/3d.png` (the placeholder name stored for models without a thumbnail) still work.

## [7.3.1] - 2026-10-07

**Upgrading:** no changes needed. Browsers keep old icons for a while: reload the page, and on a phone remove and add the home-screen icon again to see the new one.

**Changes:**
- **New logo and icons:** the JusttPrint printer-in-a-hexagon replaces the old Printventory artwork in the browser tab, the home-screen icon (with versions Android can crop to a circle or rounded square), the sidebar, the login page, About, the Terms of Service and shared-link pages, and the README. The installed app's background color matches the app.

## [7.3.0] - 2026-10-07

**Upgrading:** no changes needed. Reload open browser tabs after the update.

**Changes:**
- **AI tagging keeps going when you leave:** the JusttPrint backend keeps a Generate Tags run's progress and suggestions. The sidebar shows the run in every open browser (who started it, and how far it is). Close the review with **Run in Background**, or reload the page, and **Review** in the sidebar opens it again with every suggestion so far. **Stop** (in the review or the sidebar) skips the models not started yet. One run at a time: a second Generate Tags while one runs says so. With Puter, the AI runs in the browser that started the run, so that tab must stay open.

## [7.2.0] - 2026-10-07

**Upgrading:** no changes needed. Reload open browser tabs after the update.

**Changes:**
- **Undo:** after you change a model's designer, parent model, license, source, notes or tags (one model, or the selected models in multi-edit), a notice at the bottom says what changed, with an **Undo** button. **Ctrl/⌘ Z** (when you are not typing in a field) undoes your last 20 edits one by one, newest first. Undo checks for other people's changes like any edit: tags take back only what your edit added or removed, and a field someone else changed since asks whose value stays (in multi-edit, those models keep theirs and you are told how many).

## [7.1.0] - 2026-10-07

**Upgrading:** no changes needed. Reload open browser tabs after the update.

**Changes:**
- **Edits from two browsers at once:** when someone changes a model (its fields, tags, rating, print status or a logged print), every other open browser updates that card and its details panel right away; the details panel waits while you are typing in it. When you save a designer, parent model, license, source or notes that someone else changed after you started editing, JusttPrint no longer overwrites theirs: it shows both versions and you choose **Keep Mine** or **Keep Theirs** (notes also **Keep Both**). Tags merge: what each of you added or removed is kept. For scripts, `save-model` takes `_base` (the values you started from) to get this check; without it, saves work as before.
- **Wording:** the app and the docs say "JusttPrint backend" for the part of JusttPrint that runs in the Docker container (Settings → **JusttPrint Backend**, **Restart JusttPrint Backend**, **JusttPrint Backend Access** for the API token), and example addresses use `<docker-host-ip>`. Nothing else changed: the container name `justtprint-server` and the environment variables stay.

## [7.0.0] - 2026-10-07

**Upgrading:** filament is gone from JusttPrint. **Before updating, take a backup** (**Settings → Backup**) if you might want your filament data back: on the first start of 7.0 the filament catalog, the filaments on your models and the filaments in your print history are deleted from the database. Prints themselves (dates, outcomes, quantities, printers, parts, notes) stay. MCP clients lose the `list_filaments`, `save_filament`, `delete_filament` and `set_model_filaments` tools, and `get_model`, `update_model` and `log_print_event` no longer take or return filaments. Library exports no longer contain filaments, and filaments in older exports are ignored on import. Reload open browser tabs after the update.

**Changes:**
- **Removed:** the Filament page and its sidebar and Settings entries, Add Filament, the Filament section of a model's details panel and of Multi-Edit, the filament picker in Log Print and filaments in the print history, the Filament filter and the filament search field, the material badge on model cards (and on Home and the Queue), the filament and material lists on the Statistics page, the filament actions of the HTTP API and the MCP filament tools.
- The database drops its `filaments`, `model_filaments` and `print_event_filaments` tables on the first start, and the leftover Spoolman settings.
- Removed the "cost and time estimates from filament prices" idea from the to-do list.
- **Fixed:** screen readers could not announce the months of the Statistics chart properly (each month column now has an image role with its numbers).

## [6.6.0] - 2026-10-07

**Upgrading:** no changes needed; slicers set up with the helper keep working. To open models in OrcaSlicer without the helper, add it under **Settings → Slicer → Add OrcaSlicer (no helper)**. Reload open browser tabs after the update.

**Changes:**
- **Open in OrcaSlicer without the helper:** an OrcaSlicer entry added with **Add OrcaSlicer (no helper)** opens models through OrcaSlicer's own `orcaslicer://` links. OrcaSlicer downloads each model straight from JusttPrint and puts it on the plate of the window already open; nothing else needs installing. Each file gets its own download address that ends in its name and works for 30 minutes; up to 10 files at a time, 1 GB each (OrcaSlicer's limit). Tested with OrcaSlicer 2.4.2. It needs OrcaSlicer to reach the server's address, and with HTTPS a trusted certificate.
- Other slicers still use the helper, and so can OrcaSlicer when added with its path.
- Removed the "Send to printer" plan from the to-do list, and the printer form no longer promises a Moonraker integration that does not exist (the Klipper box only shows a badge).

## [6.5.0] - 2026-10-07

**Upgrading:** no changes needed. To open share links from outside your home network, JusttPrint must be reachable from there (a reverse proxy with HTTPS); the links use the address you opened JusttPrint with. Reload open browser tabs after the update.

**Changes:**
- **Collections** (sidebar): group models from any folders. **Add to Collection…** in the model menu adds one model or a whole selection (tick the collections, or make a new one in the dialog); a collection's page shows its models with **×** to take one out, plus **Rename**, **Description**, **Share** and delete (the models stay). Everyone can view collections; editors and admins change them.
- **Share links and QR codes:** **Share…** in a model's menu, or **Share** on a collection, makes a read-only link that opens without an account, with a QR code to copy, scan or save. Choose whether files may be downloaded and when the link expires (never, or after 1 to 90 days). The page shows names, pictures, designer, license, tags and source links, never notes, file locations or print history, and a shared collection includes models added later. **Settings → Sharing** lists every link with its views, and turns links off. Deleting a collection turns off its links. Editors and admins make links.
- The shared pages have no scripts, are not indexed by search engines, and a link only reaches its own models.

## [6.4.0] - 2026-10-07

**Upgrading:** no changes needed. Every user starts with the layout and color scheme the server had; from now on, changing them changes them for that user only. Reload open browser tabs after the update.

**Changes:**
- **Your own display preferences:** grid or list view, sort order, list columns, panel widths, the folder panel and recent folders, tile size, the De-Dup preferred folder and the color scheme are now kept per user. Until someone changes one, they get the server's value, which stays as the default for new users. The thumbnail colors and lighting stay the same for everyone (admins change them), and the API token and MCP use the server's values.
- **Settings → Appearance → Theme** is open to every user for their own color scheme; only admins can change the thumbnail colors and lighting there.
- **Viewers see no edit controls:** the details panel shows designer, parent model, license, source, tags, filament, notes, rating and print status without ways to change them, and without Log Print or the favorite button; the Queue, Printers, Filament, Home and archive details hide their edit buttons, and Multi-Edit Mode is hidden. The server already refused these edits; now they are not offered.
- Each new user sees the welcome and the Quick Start Guide once, on their first login.
- A deleted user's preferences are deleted with the account.

## [6.3.0] - 2026-10-07

**Upgrading:** no changes needed. To upload files of 5 or 10 GB, set `JUSTTPRINT_MAX_UPLOAD_MB` (for example `10240`) and raise the scan limit under **Settings → General → Performance** (50 MB unless changed), or big models are saved but not added to the library. Behind nginx, `client_max_body_size 32m;` is now enough for any file size. Reload open browser tabs after the update.

**Changes:**
- **Large uploads:** the browser now uploads in 16 MB pieces (`JUSTTPRINT_UPLOAD_CHUNK_MB`), so files of many gigabytes get through reverse proxies with a body size limit and Cloudflare (100 MB per request), and no upload runs into the server's 5-minute request limit. A piece that fails is sent again (for about two minutes); after that, or after a reload, uploading the same file again continues where it stopped, also after a server restart. The progress shows how much has arrived. Cancel deletes what was sent; unfinished uploads are deleted after a day. The server checks the free disk space before an upload starts.
- The upload dialog warns about files larger than the scan limit (Settings → General → Performance), which are saved but not added to the library, and says afterwards how many of the uploaded files are in the library (folder watching may add them first, so "new models" undercounted).
- For scripts: `POST /api/upload` (one request) still works; the pieces API is described in `src/server/uploads.js`.

## [6.2.0] - 2026-10-07

**Upgrading:** JusttPrint now has user accounts. The first start turns your password into the **admin** account (or the name in the new `JUSTTPRINT_USERNAME`): browsers are logged out once, so log in again with the user name `admin` and your usual password. `JUSTTPRINT_PASSWORD` keeps setting that account's password on every start. Scripts that log in with only a password still work, and the MCP API token is unchanged (it acts as an admin). Behind a reverse proxy, raise its upload size limit to use uploads (nginx: `client_max_body_size`). Reload open browser tabs after the update.

**Changes:**
- **User accounts and roles** (Settings → Authentication → Users): admins add people with a user name, password and role. **Viewers** browse, search, preview, download and see Statistics; **Editors** also edit models, tags and the print log, upload, move, trash and delete files, and scan; **Admins** also change settings, backups, Organize, AI setup, HTTPS, the API token and the accounts. The server checks the role on every action (a refused one says why), viewers' model menus only offer Preview, Download, Copy Path and Open in Slicer, and each person sees only the pages and settings their role can use. An admin can change a role, set a new password (which logs that person out everywhere) or delete an account; the last admin and the `JUSTTPRINT_PASSWORD` account stay admins. The login page asks for a user name, and the account menu shows who is logged in.
- **Change Password** (account menu): each user changes their own password, which logs them out in every browser. Server Access now only holds the API token.
- **Upload models from the browser:** drop model files anywhere on the page, or click **Upload** in the Library, choose a library folder and upload. Files stream to disk with a progress bar, never replace a file (a taken name becomes `Name (2).stl`), must be a type the library scans, and may be up to 2 GB (`JUSTTPRINT_MAX_UPLOAD_MB`). The folder is scanned afterwards, so the models show up with thumbnails. Editors and admins only.
- **Statistics page** (sidebar): prints, success rate, failed and cancelled prints and models added for the last 6 or 12 months, 2 years or all time; prints per month by outcome (hover a month, or show the table); and the designers, models, filaments and printers printed most. All from your print log and library.
- Settings are shared by every user: viewers and editors may only save display preferences (view, sort, column layout), and cannot read API keys or tokens.

## [6.1.0] - 2026-10-07

**Upgrading:** no changes needed. `docker logs` now shows less; set `JUSTTPRINT_LOG_LEVEL=debug` when you need the old detail to track down a problem. Reload open browser tabs after the update.

**Changes:**
- **Readable logs:** every line in `docker logs` now starts with the time and its level (`INFO`, `WARN`, `ERROR`). Detail that only helps when tracking down a problem (each database query, each saved model, each hashed file, each menu click) is hidden unless you set `JUSTTPRINT_LOG_LEVEL=debug`; `warn` or `error` show even less.
- **Fixed:** in the Wall view, a ZIP entry's **Archive** label covered the start of its file name. It now sits in front of the name.
- Security review: no HTML is built from library data except model notes, whose Markdown renderer escapes everything and only links to http, https and mailto; new tests try the usual injection tricks against it. Links built from data (a model's source, a printer's web page) only open http and https.

## [6.0.1] - 2026-10-07

**Upgrading:** no changes needed. To free space, delete the old backup and export files under **Settings → Backup** (the page shows how many and how big). Reload open browser tabs after the update.

**Changes:**
- **Fixed:** every **Create Backup** and **Export Library** left a copy in the data folder for good (a copy of the whole database for each backup). They now go into `downloads/` next to the database and are deleted an hour later, once the download has had time to finish.
- **Fixed:** with JusttPrint open in more than one browser, messages meant for one of them reached all: a scan's progress, "Removed N non-existent files", the progress dialog of Import Library and Organize, and the 3MF preview status. They now go only to the browser that started the action; changes to the library still refresh every browser.
- **Fixed:** the scheduled STL Home scan no longer pops up "Removed N non-existent files" in every open browser (the server log still has it).
- **Settings → Backup** lists the backup and export files earlier versions left in the data folder, with their total size and a **Delete Them** button. They are not deleted on their own, because the MCP `backup_database` and `export_library` tools save there too.

## [6.0.0] - 2026-10-07

**Upgrading:** the Filament Manager dialog and Spoolman support are removed.
- Your filaments stay: the catalog, the filaments on your models and in your print history are unchanged. Filaments that came from Spoolman stay as ordinary filaments and can no longer be synced.
- On the first start, the Spoolman settings (server address and API token) and each filament's link to Spoolman are deleted. Keep a backup if you may go back to 5.x.
- If you ran Spoolman with `docker-compose.spoolman.yml`, that file is gone; your Spoolman container is not affected.
- MCP: the `sync_spoolman_filaments` tool is gone.

**Changes:**
- **Removed:** the Filament Manager dialog (Settings menu, the **+** and **›** in a model's Filament section, Multi-Edit's Manage Filament) and Spoolman: the sync, its settings, the `test-spoolman-connection` and `sync-spoolman-filaments` actions, the MCP tool and the Compose file.
- **Add Filament** is a small dialog of its own, opened from the **Filament** page or the **+** beside a model's filament picker, which also puts the new filament on that model. The color has a picker and a full-width hex field (the old dialog squeezed it to nothing), and a typed color must be a hex code.
- **›** on a model's filament and Multi-Edit's **Manage Filament** open the Filament page.
- Library exports no longer include Spoolman fields; importing an older export matches filaments by name, vendor, material and color.

## [5.3.1] - 2026-10-07

**Upgrading:** no changes needed. If the server log showed "Could not start Chromium" before, thumbnails are now rendered by the server again. Reload open browser tabs after the update.

**Changes:**
- CI now builds the Docker image on every push and smoke-tests it the way it is run: it must report healthy, run as `PUID`/`PGID`, accept the password, scan the mounted library, serve the web UI, render thumbnails in its own Chromium with no browser open, and close the database on `docker stop`. Run it locally with `npm run test:docker` (needs Docker).
- **Fixed:** on some Linux hosts the container's Chromium could not start ("chrome_crashpad_handler: --database is required"), so the server rendered no thumbnails and only open browsers did. Chromium now gets its own writable folders and no crash reporter, and the server tries again a few times if it still fails to start. Found by the new smoke test.
- **Fixed:** for a library inside a folder whose name starts with a dot (for example `/home/me/.local/models`), every scan removed all its models and added them back as new, losing their tags, notes, ratings and print history. Only folders inside the library count as hidden now.
- **Fixed:** scanning a folder also checked the models of a sibling folder whose name starts the same (`Designer B` and `Designer Bx`).

## [5.3.0] - 2026-10-07

**Upgrading:** no changes needed. Folder watching starts on its own for your STL Home folders; turn it off under **Settings → Scanning → STL Home** or with `JUSTTPRINT_WATCH_FOLDERS=false`. A very large library on an older Linux host can run out of folder watches: the STL Home page then says so, and raising `fs.inotify.max_user_watches` on the host fixes it. Reload open browser tabs after the update.

**Changes:**
- **Folder watching:** JusttPrint now watches the STL Home folders. Models you copy in show up within seconds (with thumbnails), and deleted ones leave the library, without waiting for the next scan or pressing **Scan Library**. It waits until a copy has finished, rescans only the folders that changed, and skips hidden and excluded folders. On by default; switch it off under **Settings → Scanning → STL Home** or with `JUSTTPRINT_WATCH_FOLDERS=false`. Network shares (SMB/NFS) and Docker Desktop on Mac or Windows may not report changes; the timed STL Home scan still covers them. The STL Home page shows how many folders are watched, or why watching failed.

## [5.2.0] - 2026-10-07

**Upgrading:** no changes needed; automatic backups stay off until you switch them on under **Settings → Backup**. To keep backups on another disk, mount a folder there (for example `- /mnt/usb/justtprint-backups:/backups`) and choose `/backups`. Reload open browser tabs after the update.

**Changes:**
- **Automatic Backups** (Settings → Backup): the server backs up the database every 6 hours, 12 hours, day or week and keeps the newest copies (7 unless you change it). Off until you switch it on; the first backup is written right away. Backups go to `backups` in the data folder, or to a folder you choose (**Browse…**), for example a volume on another disk. Each copy is checked before it is kept, and only files named `justtprint-auto-….db` are ever deleted. The page shows the last and next backup and any error, has **Back Up Now**, and lists the backups with **Download** and **Restore** (restoring from the server needs no upload).
- New environment variables `JUSTTPRINT_AUTO_BACKUP`, `JUSTTPRINT_BACKUP_INTERVAL_HOURS`, `JUSTTPRINT_BACKUP_KEEP` and `JUSTTPRINT_BACKUP_DIR` (they win over the page, which shows them locked).
- **Fixed:** in Choose Folder, typing a path while the first folder was still loading could be overwritten, so Enter opened the wrong folder.

## [5.1.0] - 2026-10-06

**Upgrading:** no changes needed. Reload open browser tabs after the update. **Choose Folder** shows the volumes you mount into the container, so mount your models folders as before (see Volumes in the README).

**Changes:**
- **Choose Folder:** Scan a Folder, the STL Home lists (**Browse…**), the Duplicates preferred directory and Organize's folders open a folder browser instead of asking you to type a path. It starts from the volumes mounted into the container and your library folders, lists subfolders, and still takes a typed or pasted path. System, app and data folders cannot be browsed, the same rule as scanning.
- The model menu has **Copy Path** (**Copy Paths** for several models).
- **Fixed:** with JusttPrint open in more than one browser, the model menu acted on all of them: **Download** downloaded the file in every open tab, and **Preview**, **Add Image**, **Manage Thumbnails** and **Generate Tags** opened there too. They now happen only in the browser you clicked in.
- **Fixed:** the Copy buttons for the API token (Server Access) and the MCP address did nothing over plain `http://` on a LAN address; they now copy there too.
- Removed the unused typed-path folder and file dialogs from the server.

## [5.0.4] - 2026-10-06

**Upgrading:** no changes needed. Reload open browser tabs after the update.

**Changes:**
- The Multi-Edit panel is redrawn in the JusttPrint 5 style, like the single-model details panel: the selection count as its title, **Select All** and **Clear Selection** side by side, then **Printing**, **Details**, **Tags** and **Filament** sections with labels beside each field, and **Exit Multi-Edit Mode** at the bottom. Its old styles are removed.
- The Remove pickers for tags and filament say "None to remove" and are disabled when no selected model has one.
- Button icons no longer shrink when a label is long.

## [5.0.3] - 2026-10-06

**Upgrading:** no changes needed. Reload open browser tabs after the update.

**Changes:**
- The Multi-Edit and bundle panels on the right now use the same background as the rest of the details column. They had kept an old navy tint and a strip above their heading from before JusttPrint 5.
- The library grid and the details column have thin scrollbars in the theme's colours, and the details column no longer keeps an empty scrollbar strip when it has nothing to scroll.

## [5.0.2] - 2026-10-06

**Upgrading:** no changes needed. The app is unchanged from 5.0.0 (only a test changed).

**Changes:**
- The end-to-end checks of Purge Models first answer a "Thumbnail generation finished" message that the scan check before them can leave behind. On GitHub's slower machines it opened over the Purge Models dialog and blocked its buttons; the test now notes such a message in its output.

## [5.0.1] - 2026-10-06

**Upgrading:** no changes needed. The app is unchanged from 5.0.0 (only a test changed).

**Changes:**
- The end-to-end check "below 1200 px the details open as a drawer over the grid" waits for the drawer's close button and backdrop to appear instead of looking straight after the drawer opens. It failed on GitHub's slower machines (the drawer worked: the next check closed it), and it now reports what it saw if it fails.

## [5.0.0] - 2026-10-06

JusttPrint 5 is a new interface: a sidebar of pages, a redesigned library and details panel, a Home dashboard, pages for the queue, printers, filament, tags, duplicates, organizing and settings, and layouts for laptops, tablets and phones. The library, database and server are unchanged.

**Upgrading:**
- Docker: pull the new image (`docker compose pull && docker compose up -d`). Your data folder, settings and environment variables carry over; nothing to migrate. Reload open browser tabs after the update.
- The menu bar is gone. Everything it had is on a page in the sidebar, under **Settings** (one page, grouped: General, Appearance, Library, Scanning, Slicer, Printers, Filament, Integrations, AI, Server, Authentication, Backup, Advanced, About) or under **Help**. For example: **Tools → Server Access** is **Settings → Authentication → Server Access**, **Tools → MCP Server** is **Settings → Integrations** and **Settings → Server → HTTPS / SSL**, **Tools → Backup/Restore** is **Settings → Backup**, **De-Dup** is **Duplicates**, **Tag/Filament/Printer Manager** are the **Tags**, **Filament** and **Printers** pages.
- The app opens on **Home**; **Library** is the model grid.
- The **Theme** accent color now colors the whole interface. The purple theme is a little lighter (`#b47cfa`) so text on it stays readable.
- If you serve the files yourself instead of using the Docker image, run `npm run build:web`: every style is now in `web-build/app.css`, and `styles.css`, `theme.css`, `mobile-ui.css`, `parts-stock.css`, `printer-management.css`, `notes-markdown.css`, `preview-wall.css`, `thumbnail-progress.css` and `organize-library.css` are removed, as are `bg.png`, `dup.png`, `filament.png`, `file-icon.png`, `roulette.png` and `tag.png`.

**New:**
- **Shell**: a sidebar with every page (Home, Library; Printing: Queue, Printers, Filament; Manage: Tags, Duplicates, Organize, Scan Library, AI Tagging; System: Settings, Help), a Queue badge, **Library Storage** (how full the models disk is) and scan and thumbnail progress. The top bar has the search box (Ctrl/⌘ K) and the account menu. Pages have addresses (`#/home`, `#/library`, `#/queue`, `#/printers/<id>`, `#/settings/<group>`, …), so back, forward and reload work.
- **Home**: a greeting with a summary, four figures (models, printed, in queue, printers) that open the matching view, a render of the model printed last (else the newest) in the accent color, Recent Activity (logged prints with outcome, printer and filament, and models added), Your Printers (with maintenance due) and the models added most recently.
- **Library**: "Your Library" with tabs (All Models, Printed, Unprinted, Queue, Favorites), the model count, Grid / Wall / List, the folder panel and a **Filter** popover with every filter; active filters show as removable chips. New model cards: preview with Favorite, More and the rating; title, designer (or folder), file type and filament material badges and the print status.
- **Details panel**: large preview with a thumbnail strip, name and designer, tags as pills, **Open in Slicer** (with a list of your slicers) and **Log Print**, then Details (file, format, size, print status, source, designer, parent model, license, a clickable location, date added, rating), Filament, Notes and Print History. It is a column on wide screens and a drawer below 1200 px.
- **Queue** page: Printing now, Up next (Start, remove) and Completed (queue again).
- **Printers** page: a card per printer with type, firmware, print count, last print and maintenance due; the selected printer shows its web page link, reminders (mark done), maintenance log and recent prints. Add, Edit and Maintenance open the printer forms; Parts opens the Parts Manager.
- **Filament** page: each filament as a spool in its color, with material, diameter, source (manual or Spoolman), how many models use it, its logged prints and when it was last used; search, material chips, Show models and Remove.
- **Tags** page: every tag with its usage, sorted by use or name, search and an Unused filter; create, rename (onto an existing tag merges), delete and show models.
- **Duplicates** page: each group of identical files side by side with preview, folder and size, **Keep this** and **Keep all**, plus Easy, the preferred folder and the scope as before. **Organize** is a page too.
- **Settings** is one page with an index; most settings forms are shown right on it.
- **Responsive**: laptops get the details drawer; tablets an icon rail; phones a bottom bar (Home, Library, Queue, Printers, Menu), the sidebar as a drawer, two cards per row and full-screen details and filters.
- **Accessibility**: every card is one Tab stop with a spoken summary; Enter or Space selects, the arrow keys move, the Menu key or Shift+F10 opens the model menu. A Skip to content link, landmarks, focus handling in drawers, reduced motion, and colors checked for contrast (WCAG AA). The browser tests run an accessibility audit (axe-core) on the main pages and every dialog.
- New read-only server actions for these pages: `get-library-storage`, `get-library-counts`, `get-recent-activity`, `get-recent-prints`; `get-all-filaments` returns each filament's print count and last use, model lists include the first filament's material, and the print filter `in-queue` matches queued and printing models.

**Changes:**
- The design uses the Inter font and Lucide icons, bundled with the app (nothing is loaded from the internet).
- The older dialogs (Printer Manager, Filament Manager, Parts Manager, Metadata Manager, Tag Manager, Stats, System Report and the rest) and the message and prompt boxes use the new colors, type, buttons and inputs.
- Only dropdowns show a dropdown arrow; text fields no longer do.
- The Quick Start Guide, README and GUIDE describe the new interface, with new screenshots (`docs/images/`).
- Fixed: the top bar search and the Queue link did not run a search; card ratings and favorites showed through the Filter popover; the folder tree popover could cover its own button on short screens; on a phone the Menu button took the keyboard focus when the page loaded.
- Removed with the old interface: the menu bar, the old phone layout, the old sidebar's logo, counts and tool buttons, the sidebar resize handle, and two dialogs nothing opened (the old guide and the server mode information; **Help → Installing and Setup** opens the README).

## [4.6.2] - 2026-10-06

**Upgrading:** no changes needed.

**Changes:**
- No part of JusttPrint may run code built from strings any more. The STEP/IGES importer (occt-import-js 0.0.23) is rebuilt with Emscripten's `-sDYNAMIC_EXECUTION=0`, so its JavaScript calls into WebAssembly through plain closures instead of `new Function`, and the model parse worker loses the `'unsafe-eval'` it was the only exception for. Meshes are identical to the npm build on upstream's 56 STEP and IGES test files. `scripts/build-occt-import-js.sh` repeats the build and `vendor/occt-import-js/BUILD.md` records the versions. A test parses STEP and IGES in Node with code generation from strings turned off.
- The `occt-import-js` npm package is no longer installed (only a test used it; the browser always loaded the copy in `vendor/`).

## [4.6.1] - 2026-10-05

**Upgrading:** no changes needed. The Docker image is unchanged from 4.6.0 (only a test changed).

**Changes:**
- The end-to-end check "details add a new designer" waits for the details panel and the card to redraw after the save instead of reading them straight away. It failed now and then on GitHub's slower machines (the app was fine), and it now reports what the panel and card showed if it fails.

## [4.6.0] - 2026-10-05

**Upgrading:** the browser extension no longer works with JusttPrint; uninstall it from your browser. Inbox folders (`JusttPrintInbox`) are no longer read and can be deleted.

**Changes:**
- **Tools → MCP Server → Settings** shows the setup for the AI app you pick: a `claude mcp add` command for Claude Code, a `mcp-remote` config for Claude Desktop, and the config formats Cursor and VS Code expect, each with this server's address and the API token filled in and a line saying where it goes. The single config it showed before only worked as-is in Cursor. The README's MCP section walks through it.
- Removed TestDriver.ai, left over from the original project: its only test logged in to the vendor's demo shop, not JusttPrint, and its GitHub workflow failed on every push without an API key. Gone with it: the `testdriverai` package, `vitest.config.js`, `tests/example.test.js`, `tests/login.js`, and the TestDriver Copilot agent and skill files under `.github/`. The unit tests and the browser suite (`npm run test:e2e`) are unchanged.
- Removed the browser (Chrome) extension: the `chrome-extension/` folder, **Tools → Browser Extension**, the inbox folder JusttPrint checked every few minutes for `*.pvimport.json` files, and the path mapping and copy-to-folder settings that `save-model` applied for it. Models the extension already added, including link-only models, stay in the library and work as before. The listen port setting keeps its old internal name (`browserExtensionPort`) so saved ports still apply.
- Four database tests no longer say to run them through Electron with `ELECTRON_RUN_AS_NODE`; they run with plain Node like the rest (`npm test`).

## [4.5.2] - 2026-10-05

**Upgrading:** no changes needed. Browsers that block popups need to allow them for JusttPrint to sign in to Puter.

**Changes:**
- Puter.com AI tagging works again. Puter.js no longer runs on the library page, where the Content Security Policy blocked it; it runs only on a small sign-in page (`puter-signin.html`) opened in a popup, which hands the Puter login back to the page. **Settings → AI Config** shows the Puter account with Sign In and Sign Out. When tagging needs a login and the browser blocks the popup, a dialog asks for the click. The login is kept in the browser, and a login Puter refuses is replaced by a new sign-in. Puter requests from the server now wait up to 3 minutes, so the first one can wait for the sign-in.
- OpenAI's newer models (gpt-5 family, o1/o3/o4) work for AI tagging and Test. They refused `max_tokens` and a custom `temperature`; OpenAI requests now send `max_completion_tokens`, leave the temperature out for those models, and give them a larger reply limit, since their hidden reasoning counts against it. Claude, Gemini and local servers send what they did before.

## [4.5.1] - 2026-10-05

**Upgrading:** no changes needed.

**Changes:**
- The README is now a short Docker install guide: a four-step Quick Start with the published `ace2123/justtprint` image, Docker Run, the Compose options and environment variables explained, the web app, AI tagging, network shares, GPU, updating and troubleshooting. Development, build and code structure notes are removed.
- The README's menu names match the app (HTTPS is under **Tools → MCP Server → HTTPS / SSL**, backups under **Tools → Backup/Restore**), and **Help → Server Mode Info** lands on the install steps.

## [4.5.0] - 2026-10-05

**Upgrading:** no changes needed for Docker. If you serve the files yourself, rebuild with `npm run build:web`; `search.js`, `query-builder.js`, `renderer.js`, `filament.js`, `grid-refresh.js`, `folder-tree.js`, `sidebar-layout.js`, `mobile-ui.js`, `thumbnail-progress.js` and `vendor/fuse.min.js` are removed.

**Changes:**
- The sidebar's search, sort and filters, and the filter strip above them (chips, AND / OR / NOT, Clear All), are React (`src/web/filters/`). The filters live in one store with a tested query model (`query.ts`) that builds the server request, the chips and the AND / OR / NOT editing. `search.js` and `query-builder.js` (about 2,000 lines) and about 550 lines of `renderer.js` are gone, including filter listeners that were attached twice.
- The sidebar's Folders control, the folder tree popover and the folder rail beside the grid are React (`src/web/folders/`), as are **More filters** and the drag handles that resize the sidebar and the folder panels. `folder-tree.js` and `sidebar-layout.js` are gone. The Folders select now also follows folder changes made elsewhere (a path click in the details panel, a removed chip), and folder names are no longer inserted as HTML.
- The top of the sidebar is React (`src/web/filters/SidebarActions.tsx`): the model counts, the De-Dup, Tag, Filament and Roulette buttons, **Scan Directory**, **Scan STL Home** and **View Entire Library**. **Scan Directory** asks for the folder in the app's own prompt (it used the browser's prompt and asked for a UNC path). Removed: the "Server Mode / UNC paths required" box at the top of the sidebar, and an empty banner under View Entire Library that was never shown.
- The menu bar (Tools, Settings, Help) and the phone layout are React (`src/web/shell/`). Both read one menu definition, so the phone's More sheet no longer copies the menu bar's markup. The phone's app bar, bottom nav, Filters and More sheets, and the details panels' phone buttons (3D, Favorite, Log print) replace `mobile-ui.js`. **Restart Server** asks and reports in the app's own dialogs instead of the browser's.
- The model menu (right-click, long-press, and the card's ⋯ button) is React (`src/web/menus/ContextMenu.tsx`). Errors show in the app's own dialog instead of the browser's alert, and menu labels are no longer built as HTML.
- Keyboard shortcuts are React (`src/web/shortcuts.ts`), with one table for the keys and the Keyboard Shortcuts dialog. ↑ / ↓ with Ctrl or ⌘ no longer move between models.
- The Terms of Service and welcome dialogs are React (`src/web/startup/FirstRun.tsx`). Escape no longer closes the terms without an answer, which left the app waiting.
- Review Generated Tags is React (`src/web/tags/`), about 1,100 lines of `renderer.js` less. Each model shows once however often the server reports it, so the old duplicate-removal workarounds are gone. Applying shows its progress on the Apply button; it used the shared progress dialog, whose bar had the same id as the scan progress bar in the sidebar and moved that one instead.
- Scanning and thumbnails are TypeScript (`src/web/scan/`, `src/web/thumbnails/`): the render queue (tested), the model loader, the server's bulk thumbnail job and its dialog, and the sidebar progress. About 3,400 lines of `renderer.js` are gone.
- After a scan, the server's thumbnail worker renders every model still without a thumbnail, in the background (it used to be the browser, and only for up to 80 models). Every open page follows a running thumbnail job in the sidebar, also one started by another page, by the server after an STL Home scan, or before the page was reloaded.
- Pages refresh after the server's own STL Home scans. The browser no longer runs its own periodic STL Home scan next to the server's, and a changed STL Home update interval applies from the next scan without a restart.
- A model that fails to render shows its failure image instead of being retried over and over while on screen, and placeholder images are drawn once instead of for every check.
- The grid's toolbar (Detailed / Preview / List, the tile size, Show/Hide columns) and the list view's column header are React (`src/web/grid/`), with the column layout in a tested module (`columns.ts`). About 900 lines of `renderer.js` are gone. Columns are ordered with CSS instead of moving the rows' elements, which React owns.
- The searchable list behind the ☰ buttons (designers, parent models, licenses, tags, filaments) is React (`src/web/components/ListPicker.tsx`), about 330 lines of `renderer.js` less.
- The grid's model list, the bundle and parent-model groups, selection, the details and bundle panels, multi-edit mode and saving are TypeScript (`src/web/library/`), with the filter check after an edit and the path labels tested. About 2,300 lines of `renderer.js` are gone, along with code nothing called (group tag prompts, a per-card element index, field statistics nobody read).
- `renderer.js` is gone. Its last part (startup, the theme, the update check, Print Roulette, Clear New Flag, Add Image, downloads, the server's thumbnail events, Puter.com AI and the progress dialog for backups and organizing) is TypeScript in `src/web/startup/`, `src/web/ai/` and `src/web/library/actions.ts`. Event forwarders for the old desktop menus, and handlers registered too late to ever run, are removed. Server events that arrive before the page has a listener for them now wait in `server-bridge.js` instead of being dropped.
- Fixed: answering Yes to "Update Available" did nothing; it now opens the release page.
- Fixed: the "Database Cleanup" message after a cleanup never showed (its handler read the message from the wrong argument).
- Fixed: rendering a thumbnail for a ZIP entry left a temporary copy of the file on the server each time.
- Fixed: the backup, restore and organize progress dialogs moved the sidebar's scan progress bar (both used the id `progress-bar`).
- Fixed: a left-click on a card right after right-clicking it was ignored for about half a second (that guard is now only for touch long-press).
- Fixed: **Reveal in folders** on a model at the top level of a ZIP looked for a folder named after the model instead of the archive.
- Fixed: changing a filter while a search was still loading could be ignored. Designer, tag and other names in the filter chips are no longer inserted as HTML.
- Fixed: **Invert Filters** on a query, and NOT in a query, left out every model whose field in the query was empty (for example a model with no designer when the query named a designer).

## [4.4.0] - 2026-10-05

**Upgrading:** no changes needed for Docker. If you build from source, run `npm run build:web` (it now also builds the parse worker, `web-build/parse-worker.js`). Removed files: `preview.js`, `parse-worker.js`, and the bundled three.js r128 copies in `vendor/` (`three.min.js`, its loaders, `OrbitControls.js`, `fflate.min.js`). Behind a strict proxy or CSP of your own, allow `'unsafe-eval'` for `/web-build/parse-worker.js` instead of `/parse-worker.js` (the STEP importer needs it).

**Changes:**
- The details panel's path row is React (`src/web/details/DetailsPath.tsx`). Clicking a folder in it now shows that folder in the library; it used to try to open the folder on the server, which the server refuses. Folder names are no longer inserted as HTML.
- The ZIP bundle panel is React (`src/web/details/BundleDetails.tsx`). Its ↗ button shows the archive's folder in the library (it used to ask the server to open a folder, which the server refuses), and its + button asks for the new tag in the app's own prompt.
- The multi-edit panel is React (`src/web/details/MultiEditPanel.tsx`), and about 2,000 lines of multi-edit and dialog code are gone from `renderer.js`. The + buttons ask for the new designer, parent model, license or tag in the app's own prompt; the separate Add Designer / Parent / License / Tag dialogs and an unreachable bulk-edit dialog are removed.
- Fixed in multi-edit: changing the designer, parent model or license saved once more each time the panel had been opened, and adding a new tag or designer could save twice. **Remove Filament** removed every filament from the selected models instead of only the chosen one.
- Fixed: when the server refreshed the grid (after a scan finished, an MCP edit or an import), the multi-edit selection was silently dropped while the panel still showed the old count, so the next change applied to nothing. The selection now stays, and selected cards stay highlighted.
- **Manage Thumbnails** is React (`src/web/ManageThumbnailsDialog.tsx`). Deleting an image asks in the app's own dialog, the card is redrawn after a delete too (not only after changing the active image), and the buttons can't be pressed again while a change is saving. An unreachable group version of the dialog is removed.
- The **3D preview** is React (`src/web/preview/`) on current three.js (0.181, from npm) instead of the bundled 2021 copy (r128). It looks the same: colors are not color-managed and light intensities are scaled to match the old renderer. three.js is loaded only when a preview first opens (`web-build/engine.js`). `preview.js` is gone.
- Thumbnails and the model parse worker also use three.js 0.181: the thumbnail renderer is `src/web/thumbnails/` and the worker is `src/web/parse/worker.ts`, built to `web-build/parse-worker.js` (the server's relaxed script policy for the STEP library now applies to that path). Thumbnails look the same. The bundled three.js r128 files (`vendor/three.min.js` and its loaders, `OrbitControls.js`, `fflate.min.js`) and `parse-worker.js` are removed, and the page no longer loads three.js at startup: it is fetched with the first preview or thumbnail.
- Fixed in the 3D preview: the 3D preview of a ZIP or folder bundle failed with an error. The canvas was sized once when the preview opened and could end up taller than its area (cut off at the bottom, slightly stretched); it now follows the dialog's size, including full screen and the Studio panel. Esc in "Sit on face" mode leaves that mode instead of closing the preview. Rotate speed is hidden while Auto rotate is off. Error messages are no longer inserted as HTML.
- The grid selection is a TypeScript store (`src/web/selection.ts`) that the cards and the multi-edit panel follow, instead of a set in `renderer.js` kept in step with the cards' classes by hand.
- Fixed: after moving through models with the arrow keys (or J/K) in the details panel, the next grid redraw highlighted the first model again. Print Roulette leaves the chosen model selected.
- Fixed: removing the last tag from a ZIP bundle, or from selected models in multi-edit, did not save. A batch update with an empty tag list now removes the tags.

## [4.3.0] - 2026-10-04

**Upgrading:** no changes needed. `notes-markdown.js` and `print-history.js` are removed; if you serve the files yourself, rebuild with `npm run build:web`.

**Changes:**
- The library grid is React (`src/web/grid/`): its layout (views, columns, ZIP and parent-model groups, the rows near the viewport) is tested TypeScript, and the model cards and group cards (ZIP bundles, parent-model groups) in all three views are React components that redraw from their models. Editing a model updates its card without rebuilding it.
- The details panel's name, source URL, designer, parent model, license and tags are React (`src/web/details/DetailsFields.tsx`). Each change saves once (picking from the ☰ list used to save twice). The + buttons ask for the new name in the app's own prompt.
- The details panel's notes and the **Edit Notes** dialog are React (`src/web/details/DetailsNotes.tsx`); the Markdown code is TypeScript (`src/web/notes/markdown.ts`) and `notes-markdown.js` is gone. The link button asks for the URL in the app's own prompt instead of the browser's.
- The details panel's filaments are React (`src/web/details/DetailsFilaments.tsx`) and come with the model instead of a second request. The multi-edit filament controls and the sidebar filament filter are unchanged.
- Print status, print history and the **Log a print** dialog are React (`src/web/print/`), and `print-history.js` is gone. Deleting a history entry asks in the app's own dialog instead of the browser's, and Save can't be pressed twice while a log is saving.
- About 5,300 lines of grid code are gone from `renderer.js`, including the 700-line routine that patched each card's DOM after an edit.

## [4.2.0] - 2026-10-04

**Upgrading:** no changes needed for Docker. Building from source now needs `npm run build:web` before `npm start` (the Docker image does this itself). Puter.com AI does not work in the browser yet (the page's security policy blocks Puter.js); use another AI service for now.

**Changes:**
- Every dialog except Manage Thumbnails and the print log is rebuilt in React + TypeScript; the model grid, details panel and 3D preview are next.
- First React + TypeScript screen: **Tools → Server Access** is rebuilt in React (`src/web/`), built with Vite into `web-build/app.js` and mounted into the existing page. It calls the HTTP API directly. Same behavior: change the password (when it is not set by `JUSTTPRINT_PASSWORD`), copy or regenerate the API token.
- The Docker image builds the React screens in a separate stage; the runtime image has no build tools.
- **Tag Manager** is rebuilt in React: create, rename inline (renaming onto an existing name merges the two after asking), search, delete, full screen.
- **Parts Manager** is rebuilt in React: add, edit, step or type quantities, low-stock flags, search, remove. Removing a part now asks in the app's own dialog, and "Part saved." is no longer hidden when the form collapses.
- **Filament Manager** is rebuilt in React: add filaments (with a color picker), Spoolman setup, test and sync, search, remove (asked in the app's own dialog). Assigning filaments to models is unchanged.
- **Printer Manager** is rebuilt in React: onboard and edit printers, open their web interfaces, schedule and complete maintenance reminders, and keep a maintenance log. Confirmations and the notes prompt use the app's own dialogs instead of the browser's, and "Printer added" is no longer hidden when the form collapses.
- **Library Stats** is rebuilt in React. Its two charts are drawn by the page itself, so the bundled Chart.js library (~200 KB) is removed.
- **System Report** is rebuilt in React. Each section shows its result as soon as its check finishes, instead of waiting for both benchmarks.
- **Backup/Restore** is rebuilt in React. Backups and library exports download directly without an extra "download should start" message, buttons show progress and can't be pressed twice, and the grid refreshes before the import result is shown.
- **Keyboard Shortcuts** and **About** are rebuilt in React. The About links are ordinary links that open in a new tab.
- **Performance Settings** is rebuilt in React. Enter saves, and a value like `2.5` is refused instead of being cut to `2`.
- **MCP Server** settings are rebuilt in React and show only what applies to the container: this server's MCP URL, the other addresses, the tool list and the client config. Fixed: the client config shown there had no API token, so clients set up from it were refused; it now includes the `Authorization` header. The unused enable/port controls and the `sync-local-http-server` action are removed.
- **Browser Extension** settings are rebuilt in React. The **Choose folder** button is removed: it opened a native picker that the server always answered with Cancel. Type the inbox path instead (a path on the server). Import now shows progress and says when an import is already running.
- **File Type** settings are rebuilt in React; the file type list comes from the server. Fixed: after saving, the sidebar's file type filter now updates right away instead of after a reload.
- **HTTPS / SSL** settings are rebuilt in React, without the desktop-mode text. Buttons are disabled while a certificate request or save runs, so Let's Encrypt can't be asked twice.
- **AI Configuration** and its prompt editor are rebuilt in React. Changes are now saved only by **Save**; before, typing in the endpoint, model or key fields, or changing the service, saved right away, so Cancel did not undo them.
- The React screens send the page's id with their requests, so the server can show dialogs in, and send progress to, the page that asked (needed for AI tests that run in the browser).
- **Purge Models** is rebuilt in React. Fixed: purging failed with "FOREIGN KEY constraint failed" once any print had been logged. It now also removes print history (as removing a single model does), in one transaction.
- **Theme** settings are rebuilt in React. The dialog now shows the saved model color and lighting when it opens (it could show stale values before).
- **Slicer** settings are rebuilt in React (`slicer.js` is removed). The Browse button is gone: browsers only reveal a file's name, never its path, so it could not fill in the path. Type the slicer's full path on your computer; an empty name is suggested from it.
- **Metadata Manager** is rebuilt in React: rename (or merge) and clear designers, parent models and licenses. Search filters as you type, and the delete prompt names the value it removes.
- **STL Home** settings are rebuilt in React. Fixed: Save ran twice per click, which could start two STL Home scans. The Add Directory buttons (native folder pickers, which never opened in the browser) are removed; type server paths instead.
- **Organize Library** is rebuilt in React (`organize-library-ui.js` is removed). The two Browse buttons (native folder pickers, which never opened in the browser) are removed; type the folder inside the scanned directory and the destination. The grid refreshes after a run.
- **De-Dup** is rebuilt in React (`dedup-preferred.js` moves to `src/web/dedup-keeper.mjs`). Hash generation progress shows inside the De-Dup window instead of a second dialog, and a failed delete is reported once for all files instead of one message per file. The preferred-directory Browse button (a native folder picker, which never opened in the browser) is removed. Fixed: each time De-Dup opened it added another set of hash-progress listeners that were never removed.
- Fixed: a database restore could break requests that arrived while the database was being swapped (on CI it stopped the thumbnail job), and could have created a new session secret, logging everyone out. Login checks now keep the session secret and API token in memory.
- Restoring a backup keeps the server's current password, API token and sessions; they are no longer replaced by the ones stored in the backup.
- Backups use SQLite's online backup, so the database stays open while a backup is written.
- Fixed: opening a dialog or running a menu action (Tag Manager, Clear New, Regenerate Thumbnails, ...) in one browser also did it in every other open browser. Those events now stay in the page that sent them, and the server no longer relays browser events to other browsers.

## [4.1.1] - 2026-10-04

**Upgrading:** no changes needed.

**Changes:**
- Removed server handlers that nothing called (`check-files-exist`, `extract-zip-archive`, `get-duplicate-files`, `calculate-missing-hashes`, `get-models-by-designer`, `get-models-by-directory`, `get-models-page`, `is-server-mode`, `start-extension-server`, `stop-extension-server`, `get-tag-model-count`; `generate-tags` remains an MCP tool only).
- Zip and 3MF files are read with `fflate` only; `jszip` is gone. Entries are listed without decompressing and read on demand. The Send to Slicer helper download is built with `fflate` and keeps its executable installers.
- Removed the empty `fs` package.
- GitHub Actions runs the unit and end-to-end tests on every push (Node 22); the TestDriver workflow moves to Node 22.

## [4.1.0] - 2026-10-04

**Upgrading:** no changes needed. Reload open browser tabs after updating. Behind a reverse proxy, the browser now also sends `POST /api/actions/...` requests; they need the same host or `JUSTTPRINT_ALLOWED_ORIGINS` setup as before.

**Changes:**
- The web UI calls the server over an HTTP API instead of sending calls through the WebSocket. Each action is a defined endpoint (`POST /api/actions/<name>`, listed in `src/server/api-actions.js`) with login, same-origin, argument and library-path checks, and clear status codes (400 bad arguments, 403 path outside the library, 404 unknown action, 500 failed).
- Only the 130 actions the web UI uses can be called. Handlers it never calls (for example `is-server-mode`, `generate-tags`, `get-models-page`) are no longer reachable from browsers.
- Files and previews come back as raw bytes instead of base64 inside JSON.
- Long actions send keep-alive spaces every 15 seconds, so reverse proxies do not time them out.
- The WebSocket now only carries events, server dialogs and Puter AI requests, and reconnects indefinitely (it used to give up after 5 tries).
- `docker-compose.local.yml` names its compose project `justtprint`, whatever the checkout folder is called.

## [4.0.0] - 2026-10-04

**Printventory is now JusttPrint.** This is a clean break: the old names are no longer read, so existing installs need the steps below.

**Before upgrading (existing Printventory installs):**
1. Stop the container cleanly (`docker compose down`), so the database is fully written.
2. In your data folder, rename `data/printventory.db` to `data/justtprint.db`. If `printventory.db-wal` or `printventory.db-shm` files are still there, rename them the same way.
3. In your compose file or `docker run` command:
   - change the volume target from `/root/.config/printventory` to `/root/.config/justtprint` (the host folder stays the same);
   - rename every `PRINTVENTORY_*` environment variable to `JUSTTPRINT_*` (for example `PRINTVENTORY_PASSWORD` → `JUSTTPRINT_PASSWORD`);
   - use the image `justtprint:latest` (build it from this release) and, if you like, rename the service and container.
4. Start it and log in. The 3D preview's studio settings (kept in each browser) start fresh; all other settings are in the database and carry over. An installed web app (PWA) should be reinstalled.
5. **Send to Slicer helper:** download the helper again from **Settings → Slicer** and run its installer; it now registers `justtprint://`. To remove the old helper, run `node printventory-helper.js uninstall` in its folder (Windows `%APPDATA%\Printventory`, macOS `~/Library/Application Support/Printventory`, Linux `~/.config/printventory`).
6. **Browser extension:** reload it from the new `chrome-extension` folder and choose your data folder again. It now writes to `JusttPrintInbox`; move anything still waiting in `PrintventoryInbox` across.

**Changes:**
- New name everywhere: web UI, login page, PWA manifest, docs, package and Docker image (`justtprint`), data folder (`/root/.config/justtprint`), database (`justtprint.db`), environment variables (`JUSTTPRINT_*`), slicer helper (`justtprint-helper.js`, `justtprint://`), MCP server name, backup and export file names, and the browser extension
- The GitHub repository is now `ngolston/JusttPrint`; the update check uses it
- The original MIT copyright notice is kept in `LICENSE.txt`

## [3.1.2] - 2026-10-04

**Upgrading:** no changes needed. If you put Printventory behind a reverse proxy that sets its own `Content-Security-Policy`, make sure it does not replace Printventory's.

**Security:**
- The Content Security Policy now allows scripts only from Printventory's own files (`script-src 'self'`), so injected `<script>` tags and inline event handlers cannot run. Inline scripts and `onclick=` handlers in the page moved to `page-init.js`, and the server no longer inlines `server-bridge.js`. The 3D model parse worker also allows eval, which the STEP library needs.

**Changes:**
- Removed the non-working refresh button and "field not editable" hint from Add New Tag (an old desktop workaround)

## [3.1.1] - 2026-10-04

**Upgrading:** no changes needed. Send to Slicer keeps working through the helper; if you used it from the 3D preview and it failed to download, it works now.

**Security:**
- The server never starts a program for Send to Slicer. A logged-in browser could ask it to run any program in the container (the old `execute-client-command` channel); that channel and all server-side slicer launching are removed. The helper on your computer opens the slicer, as before.

**Fixes:**
- Send to Slicer from the 3D preview now includes a download token, so the helper can fetch the files on a server with a password

**Changes:**
- The slicer path in **Settings → Slicer** is the path on your computer (the placeholder says so). `slicer-launch.js` now lives in `helper/`

## [3.1.0] - 2026-10-04

**Upgrading:** no changes needed for Docker installs. The image's health check now runs `src/server/healthcheck.js`; if you override `HEALTHCHECK` in your own compose file, update the path.

**Security:**
- Removed the old `getSetting`, `saveSetting`, `quitApp` and `get-db` server channels. The first two skipped the protection on secret settings, so any logged-in browser could read the password hash and API token. `quitApp` let any logged-in browser stop the server.
- The Thangs page lookup only loads https links on thangs.com; before, the server would load any address a browser sent (internal services, `file://`). The unused MakerWorld page fetch is removed.
- Server source files that sat next to the web UI (Spoolman sync, print history, ZIP handling and others) could be downloaded from the web server. They now live under `src/`, which is never served.

**Changes:**
- Declining the Terms of Service logs that browser out instead of shutting down the server
- **Restore Database** checks the uploaded file first (it must be a readable Printventory database) and keeps the current database as `printventory.db.before-restore`; before, any file overwrote the library
- `main.js` is gone: the server is split into modules under `src/core/` and `src/server/` (`src/server/app.js` starts it), and server-only files moved out of the web root. No behavior change; Docker setups need no changes

## [3.0.0] - 2026-10-03

**Printventory is now a Docker-only web app.** The Electron desktop app and the Windows, macOS and Linux installers are gone.

**Before upgrading:**
- Desktop users: run Printventory in Docker instead (see the README). To keep your library, stop the desktop app and copy its `data/printventory.db` (Windows: `%LOCALAPPDATA%\Printventory\data`, macOS: `~/Library/Application Support/printventory/data`) into the container's data volume as `data/printventory.db`. Paths in that database must match the folders as mounted in the container.
- Send Support Logs, the Discord and Patreon menu items, slicer Auto Detect and the old website links are removed.
- Docker installs from 2.3.0 need no changes.

**Changes:**
- Confirmations and errors from the server (Pull Metadata, Purge Models, Tag from Folder, Send to Slicer errors and more) show in your browser and wait for your answer; before, they were answered Cancel or never shown
- Text prompts (Metadata Manager rename, group tags) open an in-page dialog; in Docker they opened an invisible native window and never returned
- Folder pickers (Organize Library Browse, Scan Directory) ask for a folder path inside the container
- Slicer **Browse** opens the browser's file chooser again (it did nothing on the Node-based image); **Auto Detect** is removed because it searched the container, not your computer
- The update check reads GitHub Releases of ngolston/Printventory (beta users include pre-releases), and the Update button opens the release page in your browser. The old project website is no longer used
- Removed the FAQ and Support Printventory menu items, which opened pages on the old website; the About link points to the GitHub repository
- Removed everything tied to the upstream project and its services: the beta release and community-chat announcement scripts and workflow, the push scripts for its GitHub repository, the community-chat and Patreon menu items, and Send Support Logs (it uploaded to that chat). GitHub links point to ngolston/Printventory
- `src/` is no longer served as static files (server code was downloadable)
- The release zip (`printventory-docker-<version>.zip`) contains every file the image needs (it was missing `.npmrc`, so `npm ci` failed) and unzips into its own folder
- `docker-compose.yml` mounts `./models` as the library by default instead of a leftover `C:/test_files` test path
- `npm start` runs the server on plain Node; the code no longer depends on Electron (`main.js` is about 2,000 lines shorter)
- `npm test` runs every unit test; `npm run test:e2e` starts the server with a fixture library and checks the API, security rules and the web UI in a browser (58 checks)

## [2.3.0] - 2026-10-03

**Before upgrading a Docker install:**
- Set `PRINTVENTORY_PASSWORD`, or read the generated password with `docker logs` after the first start.
- The container now runs as user 1000:1000. Set `PUID`/`PGID` to the owner of your library files if that differs.
- Reinstall the Send to Slicer helper from Settings → Slicer.
- Behind a reverse proxy that rewrites the host name, set `PRINTVENTORY_ALLOWED_ORIGINS`.

- Server Mode requires a login. Set the password with `PRINTVENTORY_PASSWORD`, or use the one printed in the server log on first start, and change it under Tools → Server Access
- MCP clients authenticate with an API token; the MCP client config includes it
- The file and download endpoints only serve files inside the library folders, plus backups and exports. The live database and certificates can no longer be downloaded
- The server no longer serves server code, `node_modules` or `package.json`
- WebSocket connections and state-changing requests from other websites are refused
- Send to Slicer links carry a short-lived download token. Reinstall the helper from Settings → Slicer
- Browser and MCP requests can only read, delete or move files inside the library folders. Scans and Organize Library cannot target system or app folders, and MCP backups and exports only write to the library or data folder
- Security headers on every response, and `X-Powered-By` removed
- Replaced the abandoned `xmldom` with `@xmldom/xmldom`, updated Puppeteer to 25, and applied the other dependency security fixes
- The Docker image builds from a clean clone of the repository
- Symlinks inside the library cannot be used to read or write files outside it
- `PRINTVENTORY_TRUST_PROXY` lets the login rate limit see real client addresses behind a reverse proxy
- Removed the legacy `/api/extension-upload` route and its upload-directory setting (`EXTENSION_UPLOAD_DIR`). The extension uses the inbox folder
- The Docker container runs as a regular user. Set `PUID`/`PGID` to the owner of your library files (default 1000:1000; `PUID=0` keeps root). The data folder is re-owned on first start
- The Docker image includes Electron instead of downloading it on every new container's first start
- Docker reports the container as healthy or unhealthy (`HEALTHCHECK`)
- New Docker settings: `PRINTVENTORY_ENABLE_ZIP`, `PRINTVENTORY_FILE_TYPES`, `PRINTVENTORY_SCAN_EXCLUDE` and `PRINTVENTORY_AI_*` (applied on every start)
- Setting values, including API keys, are no longer written to the log
- `docker stop` closes the database cleanly before exiting, and the quit backup is taken after a checkpoint
- `npm run docker:hub:multiarch` publishes one image for Intel/AMD and ARM (Raspberry Pi, Apple Silicon, many NAS boxes)
- The Docker image runs the server on plain Node.js instead of Electron (2.46 GB → 1.11 GB). Thumbnails render in headless Chromium inside the container; STL Home scans run in the server. Existing data volumes keep working
- Server mode on Linux and macOS hosts (outside Docker) accepts normal absolute paths; only Windows requires UNC paths
- Usage tracking (GoatCounter) is removed, and old tracking settings are deleted from the database
- The startup update check waits for the terms to be accepted, follows the beta channel for beta users, and can be turned off under About → Updates

## [2.2.16] - 2026-10-02

- Organize Library copies models from a scanned folder into a folder structure you choose, checks free space, and removes each original only after the copy is verified. Zip archives can move packed when zip support is on
- De-duplication can keep the copy that lives under a preferred directory, including files in subfolders

## [2.2.15] - 2026-10-02

- Startup repairs tag links that still point at a removed models table, and retries a tag save that failed for that reason
- Tag names are inserted as text, so a tag cannot inject markup into the page
- Tag rename and other text prompts open in a sandboxed window
- The details name no longer snaps back to the previous model when the filter or selection changes
- The grid keeps the selected model selected when it repaints
- Exporting the library and loading print history read each related table once
- Send Logs in installed builds reads a bundled support webhook. The webhook URL stays out of the repository

## [2.2.14] - 2026-10-02

- Tag from Folder can run on files a scan newly adds, using the folder levels from AI Configuration, without calling AI
- Scans say how many files were skipped because they are larger than the max file size
- Selecting a folder inside a zip matches entries stored with mixed slashes, and does not include a sibling folder with a similar name
- Thumbnail updates keep your place in the library
- The path tree shows distinct folder, file, and zip icons
- Server mode scan and database progress events reach the page
- Stopping the Docker container exits cleanly
- Switching between detailed and preview keeps the selected model selected and in view

## [2.2.13] - 2026-10-01

- Saving slicer settings says which name or path is already used when two entries match
- Server and Docker mode can Send to Slicer through a local helper. Slicer Settings downloads a package already set to this server. The installer registers a printventory:// protocol on Windows, macOS, and Linux, and downloads the official Node.js LTS release when Node is not already installed.
- STL Home accepts a list of directories, using the same add and remove controls as excluded directories
- Startup scans every STL Home directory, on the desktop and in Docker
- STL_HOME accepts one path or several, separated the same way as STL_HOME_EXCLUDE

## [2.2.12] - 2026-10-01

- Library scans skip folders that start with a dot, extra folder names you list, and directories excluded from STL Home
- Search can leave notes out of all-fields search
- AI tagging sends parent folder names and the model description, waits out rate limits, and Tag from Folder applies those folder names without calling the AI
- Open in Slicer starts another instance when that slicer is already running
- STL preview rejects files that are not a real STL
- Help menu can send a redacted support log
- Linux AppImage starts without the setuid sandbox helper

## [2.2.11] - 2026-09-29

- Printer Management: save printers, maintenance logs, and scheduled reminders
- Parts Stock inventory, deducted when a print is logged
- Markdown model notes
- Detect installed slicers from Settings
- Filament manager shows how many models use each spool, with a collapsible add form

## [2.2.10] - 2026-09-20

- ChiTuBox (`.chitubox`) and VOXL (`.voxl`) thumbnails/previews from embedded images when present
- Preview wall: open button labeled **Preview** and centered; `...` menu no longer sits under the selection check
- Studio disabled for image-only formats (F3D, ChiTuBox, VOXL)
- Stop infinite thumbnail retry hang when image-only files have no embedded preview

## [2.2.9] - 2026-09-19

- F3D thumbnails and 3D preview from Fusion’s embedded `Previews/small.png`
- File Type settings save no longer fails in Docker/server when unchecking a type (`getAdditionalFileTypesCatalog` missing)

## [2.2.8] - 2026-09-18

- STEP/STP thumbnails and 3D preview, including assemblies that only reference sibling part files
- LYS thumbnails from embedded `preview.png`, or by rendering the stored mesh when no preview image exists
- OBJ 3D preview (library thumbs already rendered OBJ)
- PLY and IGES thumbnails and 3D preview

## [2.2.7] - 2026-09-17

- 3D Preview Studio: lighting, materials, backdrops, reflections, shadows, and save image
- Multi-part 3MF part picker and click-to-focus in preview

## [2.2.6] - 2026-09-15

### Added

- **Tag Manager rename** — Click a tag to rename it across the library (for example a typo). Clear the name and press Enter to delete it.
- Multi-Edit **Edit Tags** opens Tag Manager. Untag from selected models stays on that panel.

### Changed

- Preview tiles show filenames without hovering.
- Click an expanded folder or ZIP group to collapse it. Click empty grid space to deselect the selected model.
- **AI Tagging** — Local OpenAI-compatible servers (Custom, Ollama, LM Studio, and similar) no longer require an API key.

### Fixed

- Tag Manager Full Screen resizes the dialog and keeps existing tags visible.
- The library grid no longer stays empty on launch until you switch views.

## [2.2.5] - 2026-09-11

### Added

- **List view columns** — Show/hide columns, drag header edges to resize, and drag headers to reorder. The layout is saved.
- Zip/group list rows use the same columns, with aggregated size, date added, parent directory, designer, parent model, print status, and tags.
- **AI Tagging: Claude** — Settings → AI Tagging includes Claude alongside OpenAI, Gemini, and Puter (default model `claude-haiku-4-5`).
- **MCP** — Additional library tools for tags, filaments, print events, parent models, metadata rename/delete, thumbnails, duplicates, and hash status.

### Changed

- List view **Printed** column is now **Print Status**.
- List sort headers show an arrow only (no background highlight).

## [2.2.4] - 2026-09-07

### Added

- **HTTPS / SSL settings** — Settings → HTTPS / SSL for server, Docker, and the desktop Browser Extension / MCP listener. Custom PEM paths, Let's Encrypt (HTTP-01), or a self-signed cert (defaults to localhost). Env `PRINTVENTORY_TLS_*` still overrides the UI.
- Server/Docker **HTTPS / SSL** settings include a listen port (default 5000) so the app can bind something other than DSM's port 5000. Map the same port on the host (`PRINTVENTORY_PORT` seeds the setting when empty).
- **PWA / mobile UI** — Server and Docker can be installed as a PWA; phones get a compact layout.
- **Browser Extension inbox** — Printventory Watcher can queue model pages/downloads without the app running; Settings imports from the inbox folder.

## [2.2.3] - 2026-09-05

### Added

- **Print lifecycle and history** — Status is no longer a Printed checkbox. Each model has Unprinted / Want / Queued / Printing / Printed / Failed, plus an append-only print log (date, Printed/Failed/Cancelled, quantity, notes, filaments used). Click a card badge to log a print (reprints increment `Printed ×N`); Shift-click changes status only. Details panel has a status dropdown, Log a print, and a deletable history list. Filters include each status plus Ever printed / Never printed (from successful logs). Sort by last printed, print count, or status. Existing `printed = 1` rows keep Printed with “No logged prints yet” — no fake history is invented. Send to Slicer does not auto-log a print.
- **Folder-tree library explorer** — A Folders filter (roots + recent) with a ☰ popover tree of scanned directories (counts, ZIP bundles highlighted). Click a folder to set the existing Directory chip. Optional Folders rail next to the grid for hopping between folders. The tree is a picker for a filter you already have; it does not replace the grid.
- **Sidebar layout** — Search and sort stay pinned. The long filter stack auto-collapses when model details open so the details panel can use the remaining height. Sidebar and Folders panel (popover and rail) are drag-resizable; last widths are remembered.
- **De-Dup on the current view** — De-Dup can hash/compare the current library filters (designer, tags, query builder, search, and other chips) instead of always scanning the entire collection.
- **Filament catalog and Spoolman** — Assign filaments to models (vendor, material, color). Filter the library by filament. Optional pull-only Spoolman sync of the filament catalog (URL + API token; Test Connection / Sync Now). Filament chips pre-fill on Log a print.
- **MCP Server (experimental)** — Connect a local AI agent (Cursor, Claude Desktop, VS Code, and similar) to the library over Streamable HTTP at `/mcp` while Printventory is running. Desktop: Tools → MCP Server enables a localhost listener (same port as the Browser Extension, default 5000); copy URL or client `mcpServers` JSON from the dialog. Docker/server mode: `/mcp` is always available on the host — no toggle. Tools: `search_models`, `get_model`, `update_model`, `get_library_stats`, `get_folder_tree`, `list_tags`, `add_tag`, `list_designers`, `list_licenses`, `get_models_missing_thumbnails`, `get_thumbnails`, `set_thumbnail`, `add_thumbnail`. Agents can list models missing thumbnails, render images locally, and write PNG/JPEG back with `set_thumbnail`. Any client that can reach the endpoint can read and change library data; use on trusted networks only.

### Fixed

- Invert Filters is no longer clipped at the bottom of the sidebar when More filters is expanded.
- The sidebar scrolls again so extra filters and model details are reachable instead of being clipped with no scrollbar.
- Nested `.3mf` models inside ZIP archives no longer fail hash generation with `Invalid local header` / `unexpected end of file`. Zip extraction is serialized per archive and falls back to fflate/JSZip when `node-stream-zip` cannot read an entry.
- Docker/server Dedup no longer reports that every file hash failed when models already have SHA256 hashes, when hash generation takes longer than the WebSocket timeout, or when Windows library paths need to be resolved to the container mount.

### Database

- New on `models`: `print_status`, `print_count`, `last_printed_at`. `printed` remains a derived flag so existing filters keep working.
- New tables: `print_events`, `print_event_filaments`, `filaments`, `model_filaments`.

## [2.2.2] - 2026-08-31

### Fixed

- MeshyAI and other Bambu Studio / Orca 3MF files now render thumbnails and 3D previews when the mesh is stored in a separate Production Extension part (`3D/Objects/*.model`) instead of failing with `Cannot read properties of undefined (reading 'mesh')`.

## [2.2.1] - 2026-08-21

### Fixed

- Fixed error in Slicer parameter — Open in Slicer no longer passes `--single-instance=0` to Bambu Studio / Orca / Snapmaker Orca (that flag is PrusaSlicer-only and caused "Invalid option --single-instance").
- Slicer Settings name field is editable before choosing a path; browsing for an executable also suggests a name when the name is empty.

## [2.2.0] - 2026-08-16

### Added

- Folder and ZIP bundle grouping — models that share a parent folder or ZIP archive appear as a single card with a details panel
- Bundle 3D preview — open every STL/3MF part in a folder or ZIP in one grid layout with per-part colors
- Send to Slicer from preview — send the current model or entire bundle to your configured slicer (new instance on macOS)
- Query Builder, new Preview view, and customizable list columns
- New models tagged "New" until edited, parent-model grouping, LYS/LTY file support, and library disk-usage stats
- Docker/server NVIDIA GPU support, in-container thumbnail generation, and thumbnail progress UI

### Fixed

- Bug fixes and performance optimization

## [2.1.21] - 2026-08-07

### Changed

- Replaced Google Analytics (GA4) with GoatCounter for usage reporting. Still gated by **Enable Usage Reporting** in About.

### Fixed

- First launch after install could leave Electron processes running with no visible window (kill in Task Manager, then relaunch worked). Main window now force-shows after a short timeout, second-instance focuses call `show()`, Chart.js/Fuse.js are vendored locally instead of blocking on a CDN, and UI load has a timeout with `file://` fallback.

## [2.1.20] - 2026-08-07

### Added

- Stats panel shows total library disk usage and per-type byte sizes (3MF / STL / Other) alongside counts.
- Grid multi-thumbnail carousel upgrades from list metadata (`hasMultipleThumbnails`) without loading full thumbnail blobs up front; default-thumbnail changes broadcast live so carousels stay in sync.

### Changed

- Bundle/archive details modal lists models instead of a contents table, with simpler layout and actions.

## [2.1.19] - 2026-08-03

### Fixed

- Directory labels in Detailed/List/details now show the full parent path (including drive letter) instead of only the leaf folder name, so thumbdrive/USB scans are not confused with similarly named folders on other drives. Files in the root of a drive show as `E:\` (not a bare `E:`). Zip entries include the zip's on-disk location.
- Grid thumbnail hydrate no longer logs `Failed to generate thumbnail` / `Render task pruned` when virtual-grid rebuilds or scroll drops off-screen queue jobs (expected). Also prevents a prune from clearing the pending slot while the same file is still mid-render, which could start duplicate concurrent loads.
- On-screen models without thumbnails are re-queued after scroll prune / queue soft-cap. Virtual-grid was keeping recycled DOM cells and never calling `createModelItem` again, so visible placeholders could stay stuck on `3d.png` even though priority favors the viewport.
- ZIP/folder group cards and Generate Missing Thumbnails no longer stay stuck on `3d.png`: detached `renderModelToPNG` callers now pass `retainDetached` so the post-load scroll-prune check does not abort after a successful load (regression from 2.1.17/2.1.18).

## [2.1.18] - 2026-08-03

### Fixed

- Desktop Scan Directory hung at `0 / N models` after 2.1.17: scroll-queue pruning treated scan dummy thumbnail containers as off-screen and discarded them (promises never resolved). Scan/batch jobs now keep detached tasks (`retainDetached`).
- Docker NVIDIA: stop calling `forceContextLoss` during thumbnail recycle/cleanup (it restarted Chromium’s GPU process and flooded logs with Skia OOM / `CreateSharedImage` errors). Soft-dispose instead, disable GPU compositing in the entrypoint, cap NVIDIA WebGL concurrency to 1, and filter residual Chromium GPU-recovery stderr.

## [2.1.17] - 2026-08-02

### Fixed

- Server mode: 3MF preview rendered blank (0×0×0 mm) because WebSocket JSON mangled Float32Array/Uint32Array geometry buffers (#72).
- Docker/server mode: scrolling the grid into models without thumbnails no longer floods `get3MFImages` / WebGL work — prune off-screen queue jobs, cap queue size, fetch only top-scoring compressed 3MF images, and quiet verbose extract logs.
- Docker: suppress Chromium `ERROR:dbus` / “Failed to connect to the bus” log spam (start system bus when possible; filter remaining noise).
- Docker: Generate Missing Thumbnails OOM (V8) — stream path chunks, concurrency 1, pause grid WebGL while bulk job runs, expose GC / cap heap under 4g container limit.
- Docker NVIDIA passthrough was ignored because the entrypoint always forced SwiftShader; hardware path now used when a device is detected (requires `NVIDIA_DRIVER_CAPABILITIES` including `graphics`).
- Server mode reported a hardcoded app version `1.22.5` (log/About); now uses `package.json` via `get-app-version`.
- Docker: V8 heap no longer hard-capped at 3072MB — auto-scales from the container cgroup limit (or 8192 when unlimited); override with `PRINTVENTORY_MAX_OLD_SPACE_MB`.

### Added

- System Report: show Client GPU (browser WebGL) and Server/App GPU (nvidia-smi + Electron renderer / GL backend).
- Docker: auto-select NVIDIA WebGL when a GPU is present (`PRINTVENTORY_GPU=auto|nvidia|swiftshader`); otherwise SwiftShader.

### Changed

- Preparing for 2.2 Public

## [2.1.16] - 2026-07-27

### Changed

- Docker/server mode: Generate Missing and Regenerate Thumbnails now run in the container (hidden Electron + SwiftShader WebGL) so progress continues when the browser tab is unfocused.

## [2.1.15] - 2026-07-25

### Added

- Show a modal progress bar for Regenerate Thumbnails and Generate Missing Thumbnails (including purge/load phases).

### Fixed

- Docker Fixes

### Changed

- Prepare for 2.2 Public Release

## [2.1.14] - 2026-07-25

### Fixed

- Fixed failed thumbnail regeneration

### Changed

- Prepare for 2.2 Public Release

## [2.1.13] - 2026-07-22

### Fixed

- Faster cold start: bundle column migration no longer rewrites every non-ZIP model on each launch (one-shot zip-only backfill), and extract-temp cleanup no longer blocks window creation or readdir’s the full OS TEMP folder at startup.

## [2.1.12] - 2026-07-21

### Fixed

- Fixed thumbnail generation for models inside ZIP archives: `get-file-stats` now reads entry size from the archive instead of `fs.stat` on the virtual `zip::` path (which caused ENOENT and left archive STLs on the default `3d.png` placeholder).

## [2.1.11] - 2026-07-21

### Fixed

- Fixed issue where directories were being grouped. Bundle grouping is limited to ZIP archives (and `parentModel` metadata groups); plain folder siblings stay as individual models. Legacy `folder:` bundle keys are cleared on startup.

## [2.1.10] - 2026-07-21

### Fixed

- Folder/ZIP group cards no longer aggregate every child thumbnail into a runaway `1/539`-style carousel; carousel is capped (12), uses one primary image per part, and hydrates without per-child badge updates or `getAllThumbnails` storms (also speeds up startup on large libraries).
- Bundle group card meta text no longer appends the long “right-click Preview” hint inline; overflow is clipped cleanly in list/detailed/preview layouts.
- Bundle details sidebar spacing no longer inherits the blanket `.model-details div` margin on every nested element.
- Folder/ZIP group **icons** no longer stay stuck on the generic `3d.png` placeholder: grid rows omit thumbnail blobs, so groups now prioritize `hasThumbnail` children, fetch the first wave in parallel, and cache results across virtual-grid recycles (fixes blank zip/folder icons and reduces long startup churn).
- Large flat STLs (e.g. ~400mm plates) no longer save blank/transparent grid thumbnails: thumbnail camera far plane now matches preview, framing centers after orientation, and clipped empty thumbs are detected and regenerated.
- Docker image now includes `bundle-keys.js` (required for folder/ZIP bundle grouping in server mode).

## [2.1.9] - 2026-07-19

### Fixed

- ZIP model extracts now always land under the OS temp folder (`printventory-extracts/`), never beside library files, and are cleaned up after preview/read, slicer launch, open, download, app quit, and on startup.

## [2.1.8] - 2026-07-19

### Added

- **Folder and ZIP bundle grouping** — When scanning, models that share the same parent folder or the same ZIP archive (2+ files) are grouped into a single row in List, Preview, and Detailed views. Single-file folders stay as individual entries.
- **Bundle 3D preview** — Click a folder or ZIP bundle to open one preview dialog showing every STL/3MF part laid out on a grid, with per-part colors for clarity. Up to 32 previewable parts per bundle.
- **Bundle details panel** — Double-click a bundle (or use **Open 3D preview** from the panel) to see path, combined size, print status, and a sortable file list. Chevron still expands/collapses the bundle in the grid.
- **Send to Slicer in preview** — The 3D preview dialog includes a **Send to Slicer** button. Works for single models and full bundles (all STL/3MF paths). If multiple slicers are configured, a picker is shown.
- **New slicer instance on send** — macOS launches slicers with `open -n` so a new window opens even when the slicer is already running. Prusa-family binaries also receive `--single-instance=0` when launched directly.
- **`bundle-keys.js`** — Shared logic to derive `bundleKey`, `bundleLabel`, and `bundleKind` from file paths (including `zipPath::entry` paths).
- **`npm run test:bundle`** — Unit tests for bundle key derivation.

### Changed

- Scan insert/update and `saveModel` persist bundle metadata (`bundleKey`, `bundleLabel`, `bundleKind`) with automatic migration on startup.
- Context menu **Open in Slicer** and preview **Send to Slicer** share the same launch helper (`buildSlicerLaunchCommand` / `open-file-in-slicer` IPC).
- `window.openSlicerSettings` is exposed from `slicer.js` for use from the preview flow.

### Database

- New optional columns on `models`: `bundleKey`, `bundleLabel`, `bundleKind` (backfilled on existing databases).
