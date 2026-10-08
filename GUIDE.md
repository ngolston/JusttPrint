# JusttPrint Guide

JusttPrint is a self-hosted web app for your 3D printing model collection. It runs in Docker, and you use it from any browser on your network: computer, tablet or phone. This guide shows how to use it; [README.md](README.md) covers installing and setup.

![The library with a model selected](docs/images/library.png)

## Finding your way around

The sidebar on the left holds every page:

| Section | Pages |
|---------|-------|
| (top) | **Home**, **Library**, **Collections** |
| Printing | **Queue**, **Printers**, **Statistics** |
| Manage | **Tags**, **Duplicates**, **Organize**, **Scan Library**, **AI Tagging** |
| System | **Settings**, **Help** |

The top bar has the search box (**Ctrl/⌘ K** focuses it from anywhere) and the account menu, which shows who is logged in (**Change Password**, **Log Out**, and for admins **Users** and **JusttPrint Backend Access**). Each person sees only the pages their role can use (see [Users and roles](#users-and-roles)). **Library Storage** at the bottom of the sidebar shows how full the disk holding your models is; scan and thumbnail progress appear just above it while they run.

On a **laptop** screen the details panel opens as a drawer from the right. On a **tablet** the sidebar shrinks to icons. On a **phone** a bottom bar holds Home, Library, Queue, Printers and **Menu** (the full sidebar), cards show two per row, and the details fill the screen.

## Getting started

1. Start the container, open `http://<docker-host-ip>:5000` and log in as `admin` with the `JUSTTPRINT_PASSWORD` password (or the one printed in `docker logs`).
2. Add your models folder under **Settings → Scanning → STL Home** (or upload models, see [Uploading models](#uploading-models)): **Browse…** shows the folders mounted into the container (such as `/mnt/models`), or type the container path. JusttPrint scans it right away, watches it so new and deleted files show up within seconds, and scans it again on a schedule (every 60 minutes unless you change it) for anything watching misses, such as changes on a network share. **Scan Library** in the sidebar scans again at any time.
3. Thumbnails are rendered in the background; you can use the library while they appear.
4. Optional: pick an accent color under **Settings → Appearance → Theme**, set up **AI Tagging**, add your slicers under **Settings → Slicer** and your printers on **Printers**.

**Help → Quick Start Guide** shows a short tour in the app.

## Home

![Home](docs/images/home.png)

Home greets you with your library's figures (models, printed, in queue, printers; click one to open it), a render of the model you printed last, **Recent Activity** (logged prints and newly added models), **Your Printers** with maintenance reminders that are due, and the models added most recently.

## Library

The library shows your models as cards: preview, name, designer (or folder), file type and print status. Hover a card for **Favorite**, **More** (the model menu) and the star rating.

- **Tabs**: **All Models**, **Printed**, **Unprinted**, **Queue** (queued or printing) and **Favorites**. The count next to them is the number of models shown.
- **Views**: **Grid** (cards), **Wall** (large previews only; the tile size is next to the view buttons) and **List** (one row per model with columns you can show, hide and resize).
- **Folders**: the folder button opens a folder panel beside the grid; click a folder to show only its models.
- **Selecting**: click a card to show it in the details panel. Ctrl/⌘-click or Shift-click selects several, which opens multi-edit. The arrow keys move the selection, Ctrl/⌘ A selects everything shown.
- **The model menu**: right-click a card (or press the Menu key, or Shift+F10) for Open in Slicer, 3D preview, move, rename, delete, Generate Tags and more.
- **Print status**: click a card's status badge to log a print; Shift-click it to change the status without logging.

### Search and filters

![The Filter popover](docs/images/filters.png)

Type in the top bar to search names, designers, tags and (optionally) notes. **Filter** opens every filter: folder, designer, parent model, license, tags, print status, new models, favorites, rating, file type and sort order. Active filters show as chips under the tabs; click a chip's × to remove one, or **Clear all**.

### Folder and ZIP bundles

When a scan finds two or more model files in the same folder or ZIP file, they show as one **bundle** card.

| Action | Result |
|--------|--------|
| Click the bundle | Expand or collapse its files in the grid, and show the bundle's details |
| Right-click → **Preview** | 3D preview with every part laid out side by side (up to 32 parts) |
| **Send to Slicer** (in the preview) | Sends every part to your slicer |

Single files in a folder are not grouped.

## Model details

![The details panel](docs/images/details.png)

Click a model to see it in the details panel:

- **Preview**: click it (or **3D**) for the 3D preview. Thumbnails of the model's images run underneath.
- **Name and designer**, then the **tags** (× removes one; the picker adds one, + creates a new tag).
- **Open in Slicer** sends the model to your first slicer; the arrow lists the others. **Log Print** records a print.
- **Details**: file, format, size, print status, source link, designer, parent model, license, location (click a folder to show it), date added and rating. Fields save as you change them.
- **Notes** (Markdown) and **Print History** (each logged print with date, printer and outcome).

### Editing several models

Select several cards (Ctrl/⌘-click or Shift-click) to open the multi-edit panel. Changes there apply to every selected model as soon as you make them: print status, source, designer, parent model and license, and adding or removing a tag. **Log a Print on Selected** records one print for all of them.

### Print status and history

Each model has a status (Unprinted, Want, Queued, Printing, Printed, Failed) and a print log. Logging a print (date, outcome, quantity, printer, parts used, notes) sets the status and adds a dated entry to the history; a successful print counts as a reprint after the first. The **Printed** and **Unprinted** tabs go by the logged prints, not the status alone.

## Printing

![Print Queue](docs/images/queue.png)

- **Queue** lists **Printing now**, **Up next** (queued models; **Start** sets one to Printing, × takes it out of the queue) and **Completed** (recent successful prints; ↻ queues one again).
- **Printers** keeps your printers: make and model, type, firmware, print count and last print. Select one for its web page (**Open Web UI**), maintenance reminders and log, and recent prints. **Add Printer**, **Edit** and **Maintenance** open the printer forms; **Parts** opens the Parts Manager (screws, bearings and other stock that logged prints use up).

![Printers](docs/images/printers.png)

### Statistics

**Statistics** in the sidebar shows what your print log says over the last 6 or 12 months, 2 years or all time: how many prints, the success rate (printed out of printed and failed; cancelled prints are counted on their own), failed and cancelled prints, and the models added. **Prints per month** stacks printed, failed and cancelled prints per month; point at a month for its numbers, or **Show table** for all of them. Below: the designers, models and printers printed most. Everyone can open Statistics.

## Uploading models

Editors and admins can add models from the browser:

- Drop model files anywhere on the page, or click **Upload** in the Library.
- **Choose Folder** picks the library folder to save into. It starts at the folder the library shows, else the last one you used, else your first STL Home folder.
- Files of a type the library does not scan are skipped before anything is sent (turn more types on under **Settings → Scanning → File Types**), and so are files over the size limit (2 GB unless `JUSTTPRINT_MAX_UPLOAD_MB` says otherwise).
- Big files are fine: they go in pieces, with how much has arrived under the progress bar. A piece that fails is sent again; if the connection stays lost, the file shows an error, and **Upload** (or adding the same file again, even after reloading the page) continues where it stopped. Unfinished uploads are deleted after a day.
- Scans skip files over the size limit under **Settings → General → Performance** (50 MB unless changed). The dialog warns about such files: they are saved, and appear once an admin raises the limit and scans again.
- Nothing is replaced: when a name is taken, the upload is saved as `Name (2).stl`.
- After the upload, the folder is scanned, so the models appear with thumbnails.

## Collections

A collection groups models from any folders: a project, a gift list, the spare parts for one printer. A model can be in several collections, and stays where it is on disk.

- **Add to Collection…** in a model's menu (right-click, or **…** on a card) adds it, or every selected model, to the collections you tick; **Create and Add** makes a new one on the spot. A dash means some of the selected models are in that collection already.
- **Collections** in the sidebar shows them as cards with a picture of the latest model added. Open one to see its models; click a model to show it in the Library, or **×** to take it out of the collection.
- **Rename**, **Description**, **Share** and the bin (delete) are at the top of a collection. Deleting a collection keeps the models and turns off its share links.

Everyone can look at collections; editors and admins make and change them.

## Sharing

**Share…** in a model's menu, or **Share** on a collection, makes a read-only link to send to someone without an account:

- Choose whether the files may be downloaded, and when the link expires (never, or after 1 to 90 days). **Create Link** shows the link and its QR code: **Copy Link**, or **Save QR Code** to print it.
- The page shows the name, pictures, designer, license, tags and source link of each model, and the collection's description. It never shows notes, file locations or print history. A shared collection also shows the models added to it later.
- Anyone with the link can open it, as long as they can reach your JusttPrint backend; to share outside your network, JusttPrint must be reachable from the internet (use HTTPS).
- The Share dialog lists the links to that item; **Settings → Sharing** lists every link with how often it was opened. The bin or **Turn Off** ends a link at once.

## Users and roles

An admin adds people under **Settings → Authentication → Users** with a user name, a password and a role:

| Role | Can |
|------|-----|
| Viewer | Browse, search, preview, download, open in a slicer, see Statistics |
| Editor | Also edit models, tags, notes and the print log, upload, move, trash and delete files, scan, find duplicates |
| Admin | Also every setting, backups and restore, Organize, AI setup, HTTPS, the API token and the user accounts |

Change a role with its menu; **Set Password** gives someone a new password and logs them out everywhere; **Delete** removes the account. There is always at least one admin, and the `JUSTTPRINT_PASSWORD` account stays an admin. Everyone changes their own password from the account menu. Each person keeps their own display preferences: grid or list view, sort order, columns, panel widths, the folder panel and the color scheme (**Settings → Appearance → Theme**). New users start with the JusttPrint backend's current ones. Everything else under Settings, including the thumbnail colors, is the same for everyone. Viewers see the details panel without edit controls. MCP clients use the API token, which acts as an admin.

## Managing the library

- **Tags** lists every tag with how many models use it. Create, rename (renaming onto an existing tag merges the two), delete, or show a tag's models.
- **Duplicates** finds identical files by their contents and shows each group side by side. **Keep this** marks the other copies for deletion; **Easy** keeps one copy of each group for you (preferring a folder you choose). Nothing is deleted until you confirm **Delete Selected**. You can limit the search to the models currently shown.
- **Organize** moves the models in a scanned folder into a folder structure you choose (up to four levels, such as designer / parent model / license). **Preview** shows what will happen first; each original is removed only after its copy is checked, and files that are not in the library stay where they are. The models folder must be mounted without `:ro`.
- **AI Tagging** sets up the AI service; then select models, right-click and choose **Generate Tags**, and tick the tags to keep. See [AI tagging](#ai-tagging).
- **Settings → Library** has the Metadata Manager (rename or remove designers, licenses and parent models everywhere), Library Stats, Print Roulette (random models to print), Clear New Flag and Purge Models.

## AI tagging

AI tagging looks at a model's thumbnail, name and folder names and suggests tags. You review them before they are saved.

1. Click **AI Tagging** in the sidebar.
2. Pick a service: OpenAI, Claude or Gemini need an API key; **Puter** signs in to your Puter account instead; **custom** works with a local OpenAI-compatible server such as Ollama or LM Studio (no key).
3. Pick a model and the tagging options (number of tags, replace / merge / append, categories, detail level), then save.
4. Select models, right-click and choose **Generate Tags**. **Tag from Folder** copies folder names onto the models as tags without asking the AI.

Tips: start with a few models, use **merge** to keep the tags you already have, and review the suggestions before applying them.

## Settings

![Settings](docs/images/settings.png)

**Settings** is one page with an index on the left. Viewers and editors see only the few entries their role can use:

| Group | What is there |
|-------|---------------|
| General | Performance: the largest file a scan processes |
| Appearance | Theme: accent color, and the background, model color and lighting of thumbnails |
| Library | Metadata Manager, Library Stats, View Entire Library, Print Roulette, Clear New Flag, Purge Models |
| Scanning | STL Home, File Types (ZIP files, extra types, skipped folders), Scan a Folder |
| Slicer | Your slicers, and the helper for Send to Slicer |
| Printers | A link to that page, and the Parts Manager |
| Integrations | MCP Server: connect an AI app to your library |
| AI | AI tagging settings |
| JusttPrint Backend | HTTPS / SSL and the listen port, Restart JusttPrint Backend |
| Authentication | Users (admins), Change Password, JusttPrint Backend Access (the API token), Log Out |
| Backup | Automatic backups, download a backup, export the library, restore |
| Advanced | Regenerate Thumbnails, Generate Missing Thumbnails, System Report |
| About | Version, update check, license |

Most forms are shown right on the page: change the values and click **Save**.

### Send to Slicer

Slicers run on your computer, not in the JusttPrint backend. **Open in Slicer** (details panel, model menu) and **Send to Slicer** (3D preview) open the model there.

- **OrcaSlicer, no helper:** under **Settings → Slicer**, click **Add OrcaSlicer (no helper)** and **Save**. Open in Slicer then hands OrcaSlicer a link: it downloads the model from JusttPrint (into its download folder, OrcaSlicer → Preferences) and puts it on the plate, in the window that is already open. Works with OrcaSlicer 2.x on Windows and macOS out of the box; on Linux, turn on OrcaSlicer's desktop integration (AppImage) so the link opens it. Up to 1 GB per file and 10 files at a time (they arrive one after another). The browser may ask once whether to open OrcaSlicer: allow it. The computer must reach the JusttPrint backend at the address in the browser, and with HTTPS the certificate must be trusted (OrcaSlicer refuses self-signed ones; use plain HTTP on the home network, or a real certificate). Each download address works for 30 minutes and only for that file.
- **Other slicers (and OrcaSlicer with options of your own):** add each slicer with its path on your computer, then download and run the JusttPrint helper there once. On a Mac the helper opens a new slicer window for each send.

### MCP server

AI apps (Claude Code, Claude Desktop, Cursor, VS Code and others) can connect to JusttPrint at `http://<docker-host-ip>:5000/mcp` to search the library, edit tags and metadata, log prints and set thumbnails. **Settings → Integrations → MCP Server** shows the setup for the app you pick, with the address and API token filled in. Anyone with the token can read and change your library.

## Keyboard

**Help → Keyboard Shortcuts** lists them all. The main ones: **Ctrl/⌘ K** search, **Tab** moves between cards (each card is one stop), **Enter** or **Space** selects, the arrow keys move the selection, **Ctrl/⌘ A** selects all, **Ctrl/⌘ E** multi-edit, **Escape** closes a dialog, drawer or popover. A **Skip to content** link is the first Tab stop on every page.

## Your data

- The database, thumbnails and settings live in the container's data folder (`/root/.config/justtprint`); mount it as a volume so it survives updates.
- A backup copy (`backup_justtprint.db`) is written every time the JusttPrint backend stops.
- **Settings → Backup → Automatic Backups** copies the database on a schedule (every day unless you change it) and keeps the newest copies (7 unless you change it). They go to `backups` in the data folder, or to a folder you choose with **Browse…**; a folder on another disk also protects against a disk failure. Each backup in the list can be downloaded or restored.
- **Settings → Backup** also downloads a backup by hand or restores one from a file. Keep a backup before removing the container or its data volume.

## Tips

- Use tags, designers and parent models consistently; the Metadata Manager and the Tags page clean them up later.
- Generate Missing Thumbnails is much faster than regenerating all of them.
- Check **Duplicates** now and then, limited to the models in view for a large library.
- Print Roulette (**Settings → Library**) finds forgotten models worth printing.
