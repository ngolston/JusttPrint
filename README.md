# JusttPrint

**Version 5.0.0**

JusttPrint is a self-hosted web app for your 3D printing model collection. It runs in Docker on a NAS, home server or PC, and you use it from any browser on your network, including phones and tablets.

![The JusttPrint library: sidebar, model cards and the details panel](docs/images/library.png)

## Features

- **A home for your printing**: Home shows your figures, recent prints and printers; the Library has tabs for Printed, Unprinted, Queue and Favorites
- **Print queue, printers and filament** pages: what is printing and up next, your printers with their web pages and maintenance reminders, and your filament spools
- **Works on phones and tablets**: a bottom bar and full-screen details on phones, an icon rail on tablets
- **Automatic scanning** of STL, 3MF, ZIP and other model files, with thumbnails rendered on the server
- **3D preview** of single models or every part in a folder or ZIP bundle
- **Tags, designers, licenses, notes and source links** for every model
- **Print status and history**: Unprinted, Want, Queued, Printing, Printed, Failed, with dated print logs
- **Filament catalog**, with optional sync from Spoolman
- **Search and filters** by name, folder, tag, designer, status, filament and more
- **Multi-edit** to change many models at once
- **Duplicate finder** based on file contents
- **AI tagging** with OpenAI, Claude, Gemini, Puter or a local server such as Ollama
- **MCP server** so AI agents can search and update your library
- **Send to Slicer** from the preview, through a small helper on your computer
- **Backup and restore** of the library database from the browser
- **Print Roulette** to pick a random model

See [GUIDE.md](GUIDE.md) for how to use each feature and [CHANGELOG.md](CHANGELOG.md) for what changed.

| Home | On a phone |
|------|------------|
| ![Home: greeting, library figures, recent activity and printers](docs/images/home.png) | ![The library on a phone, two cards per row and a bottom bar](docs/images/phone-library.png) |

<a id="server-mode"></a>

## Quick Start

You need [Docker](https://www.docker.com/get-started) (Docker Desktop on Windows and Mac).

1. Create a folder for JusttPrint, for example `justtprint`, and open a terminal in it.
2. Create a file named `docker-compose.yml` in that folder with this content. Change the two lines marked `CHANGE`:

   ```yaml
   services:
     justtprint:
       image: ace2123/justtprint:latest
       container_name: justtprint-server
       ports:
         - "5000:5000"
       volumes:
         - ./data:/root/.config/justtprint
         - /path/to/your/models:/mnt/models:ro     # CHANGE: your models folder
       environment:
         - STL_HOME=/mnt/models
         - JUSTTPRINT_PASSWORD=choose-a-password   # CHANGE: your login password
         - PUID=1000
         - PGID=1000
       restart: unless-stopped
       mem_limit: 8g
       mem_reservation: 1g
   ```

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Open `http://<server-ip>:5000` (or `http://localhost:5000` on the same computer) and log in with your password.

JusttPrint scans `/mnt/models` right away and then every 60 minutes. Thumbnails are made in the background.

## Docker Run

If you prefer one command instead of a Compose file:

```bash
docker run -d --name justtprint-server \
  -p 5000:5000 \
  -v ./data:/root/.config/justtprint \
  -v /path/to/your/models:/mnt/models:ro \
  -e STL_HOME=/mnt/models \
  -e JUSTTPRINT_PASSWORD='choose-a-password' \
  --memory 8g \
  --restart unless-stopped \
  ace2123/justtprint:latest
```

On Windows, write the models path like `C:/Users/you/Models:/mnt/models:ro`.

## Docker Compose options explained

| Option | What it does |
|--------|--------------|
| `image` | The JusttPrint image from Docker Hub. `latest` is the newest release; use a version such as `ace2123/justtprint:5.0.0` to stay on one. Works on Intel/AMD and ARM. |
| `container_name` | A fixed name, so commands like `docker logs justtprint-server` work. |
| `ports` | `host:container`. Open the app at the host port. If 5000 is taken (Synology DSM, macOS AirPlay), use `"5055:5000"` and open port 5055. |
| `./data:/root/.config/justtprint` | Where the database, thumbnails, backups and settings are saved on your computer. **Keep this folder**; it holds your library. |
| `/path/to/your/models:/mnt/models:ro` | Makes your models folder visible inside the container as `/mnt/models`. `:ro` is read-only; remove it to allow delete, move and Organize Library. Add more lines for more folders. |
| `environment` | Settings, see [Environment variables](#environment-variables). |
| `restart: unless-stopped` | Starts JusttPrint again after a reboot or crash. |
| `mem_limit` / `mem_reservation` | Most RAM the container may use / RAM kept for it. 4 GB or more is recommended for large libraries. |

**Important:** inside JusttPrint, always use the container path (`/mnt/models/...`), never the path on your computer.

## Environment variables

All are optional. You can change most of these later under **Settings** in the app.

| Variable | What it does |
|----------|--------------|
| `JUSTTPRINT_PASSWORD` | Login password. Applied on every start, which is also how to reset a forgotten one. If unset, a random password is printed once in `docker logs justtprint-server`. |
| `STL_HOME` | Folders to scan automatically, as container paths. Several: `/mnt/models,/mnt/archive`. |
| `STL_HOME_EXCLUDE` | Folders inside STL Home to skip, for example `/mnt/models/cache`. |
| `PUID` / `PGID` | User and group the app runs as. Match the owner of your models folder (`id -u` and `id -g`; Synology is often `1026`/`100`). Default `1000`/`1000`. |
| `JUSTTPRINT_ENABLE_ZIP` | `true` or `false`: also scan models inside ZIP files. |
| `JUSTTPRINT_FILE_TYPES` | Extra file types to scan, for example `obj,step,ply,gcode`. |
| `JUSTTPRINT_SCAN_EXCLUDE` | Folder names to skip while scanning, for example `cache,renders`. |
| `JUSTTPRINT_AI_SERVICE` | AI tagging service: `openai`, `claude`, `gemini`, `puter` or `custom`. |
| `JUSTTPRINT_AI_API_KEY` | API key for that service (never written to the log). |
| `JUSTTPRINT_AI_MODEL` | AI model name, for example `gpt-5-nano`. |
| `JUSTTPRINT_AI_ENDPOINT` | Server address for `custom`, for example a local Ollama server. |
| `JUSTTPRINT_PORT` | Port inside the container (default `5000`). Change the `ports` line to match. |
| `JUSTTPRINT_ALLOWED_ORIGINS` | Your public address when behind a reverse proxy, for example `https://library.example.com`. |
| `JUSTTPRINT_TRUST_PROXY` | Number of reverse proxies in front (usually `1`). Leave unset without a proxy. |
| `JUSTTPRINT_GPU` | Thumbnail rendering: `auto` (default), `nvidia` or `swiftshader` (CPU). |
| `JUSTTPRINT_MAX_OLD_SPACE_MB` | Raise if the log shows `OOM error in V8`. |
| `JUSTTPRINT_TLS_CERT` / `_KEY` / `_CA` | Certificate files for HTTPS. Easier: **Settings → Server → HTTPS / SSL**. |

`JUSTTPRINT_PASSWORD`, the scan settings and the AI settings win over the app's settings on every start. `STL_HOME`, `STL_HOME_EXCLUDE` and `JUSTTPRINT_PORT` only fill an empty setting, so changes made in the app are kept (set `JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1` to apply them every start).

## Using the Web App

The sidebar holds every page: **Home**, **Library**, **Queue**, **Printers**, **Filament**, **Tags**, **Duplicates**, **Organize**, **Scan Library**, **AI Tagging**, **Settings** and **Help**. On a phone, open it with **Menu** in the bottom bar. Search from the top bar (Ctrl/⌘ K).

- **Log in** with your password. Browsers stay logged in for 30 days. Change the password under **Settings → Authentication → Server Access** (this logs out every browser).
- **STL Home**: under **Settings → Scanning → STL Home**, add the folders to scan (container paths such as `/mnt/models`) and how often (default 60 minutes). New files then show up on their own, and **Scan Library** in the sidebar scans them right away. Remove every folder to stop automatic scans.
- **Scan a folder once**: **Settings → Scanning → Scan a Folder**, then enter a container path.
- **HTTPS**: open **Settings → Server → HTTPS / SSL** for a self-signed certificate, Let's Encrypt (also publish port `80:80`) or your own certificate files. Use HTTPS if JusttPrint can be reached from outside your network.
- **Send to Slicer**: install the helper on your computer from **Settings → Slicer → Slicers**.

## AI Tagging

AI tagging looks at a model's thumbnail and name and suggests tags. You review them before they are saved.

1. Click **AI Tagging** in the sidebar (or open **Settings → AI**).
2. Pick a service and enter its API key (OpenAI, Claude, Gemini). Puter needs no key: click **Sign In** and log in to your Puter account in the popup (allow popups for JusttPrint); usage counts against that account. For a local server such as Ollama or LM Studio, pick `custom`, enter its address (for example `http://<server-ip>:11434/v1` for Ollama) and leave the key blank.
3. Pick a model, and save.
4. Select models, right-click and choose **Generate Tags**, then tick the tags you want and apply.

You can also set this up with the `JUSTTPRINT_AI_*` [environment variables](#environment-variables). When you use AI tagging, the thumbnail, file name and folder names are sent to the service you picked.

## MCP Server

AI apps can connect to JusttPrint over MCP (Model Context Protocol) to search the library, edit tags and metadata, log prints and more. For example, ask "tag everything in the Kitchen folder as kitchen".

1. Open **Settings → Integrations → MCP Server**.
2. Pick your app under **Set up in**: Claude Code, Claude Desktop, Cursor, VS Code, or another MCP client.
3. Copy the command or config it shows (the address and your API token are filled in) and follow the line above it.

The address is `http://<server-ip>:5000/mcp`. Claude Desktop connects through `mcp-remote`, which needs [Node.js](https://nodejs.org/) on that computer.

This feature is experimental. Anyone with the API token can read and change your library; you can replace the token under **Settings → Authentication → Server Access**.

## Network Shares

Mount the share on the host first, then add it as a volume, and use the container path in JusttPrint.

**Windows:** map the share to a drive letter, then mount the drive:

```bash
net use Z: \\server\share /persistent:yes
```
```yaml
      - Z:/:/mnt/share:ro
```

**Linux:** mount the share on the host (needs `cifs-utils`), then mount that folder:

```bash
sudo mkdir -p /mnt/share
sudo mount -t cifs //server/share /mnt/share -o username=user,password=pass,uid=1000,gid=1000
```
```yaml
      - /mnt/share:/mnt/share:ro
```

Then set `STL_HOME=/mnt/share/models` (or add it under **Settings → STL Home**). Windows paths like `Z:\models` or `\\server\share` do not work inside JusttPrint.

## NVIDIA GPU (optional)

Thumbnails render on the CPU by default. To use an NVIDIA card, install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host and add this to your service:

```yaml
    gpus: all
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
```

`graphics` is required. Recreate the container (`docker compose up -d --force-recreate`) and check **Help → System Report**.

## Managing the Container

Run these in the folder with `docker-compose.yml`:

| Task | Command |
|------|---------|
| Update to the newest version | `docker compose pull && docker compose up -d` |
| See the log | `docker compose logs -f` |
| Stop | `docker compose down` |
| Start | `docker compose up -d` |
| Restart | `docker compose restart` |

With Docker Run, update by pulling the image (`docker pull ace2123/justtprint:latest`), removing the container (`docker rm -f justtprint-server`) and running the same `docker run` command again. Your library is safe in `./data`.

**Backups:** use **Settings → Backup → Backup and Restore** in the app, or copy the `./data` folder while the container is stopped.

## Upgrading to 5.0

JusttPrint 5 is a new interface; your library, settings and data folder are unchanged, so pulling the new image is all it takes. The old menu bar is gone: everything it had is on the sidebar's pages, under **Settings** or under **Help** (see **Upgrading** under 5.0.0 in [CHANGELOG.md](CHANGELOG.md)).

## Upgrading from Printventory

JusttPrint 4.0.0 is the renamed Printventory. The data folder, database file and environment variables have new names, so an existing install needs a few one-time steps. See **Before upgrading** under 4.0.0 in [CHANGELOG.md](CHANGELOG.md).

## Troubleshooting

- **Can't open the page:** check the container is running (`docker ps`), the port is free, and your firewall allows it.
- **Forgot the password:** set `JUSTTPRINT_PASSWORD` and restart the container.
- **No models found:** the path in JusttPrint must be the container path (`/mnt/models`), and that folder must be mounted. Check with `docker exec justtprint-server ls /mnt/models`.
- **Permission errors when moving or deleting:** remove `:ro` from the mount and set `PUID`/`PGID` to the owner of your files.
- **Disconnects or `OOM error in V8` in the log:** give the container more memory (`mem_limit`), and raise `JUSTTPRINT_MAX_OLD_SPACE_MB` if needed.
- **Behind a reverse proxy, actions fail:** set `JUSTTPRINT_ALLOWED_ORIGINS` to your public address and allow WebSocket upgrades on the proxy.

## Privacy

JusttPrint does not collect usage data. It only contacts outside services to check GitHub for updates (turn off under **Settings → About → About JusttPrint**), for AI tagging, page imports and Spoolman when you use them.

## License

MIT License, see [LICENSE.txt](LICENSE.txt).

## Support

Open an issue at [github.com/ngolston/JusttPrint](https://github.com/ngolston/JusttPrint/issues), or see [GUIDE.md](GUIDE.md).
