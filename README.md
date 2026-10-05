# JusttPrint

**Version 4.4.0**

JusttPrint is a self-hosted web app for managing your 3D printing model collection. It runs in Docker on a NAS, home server or PC, and you use it from any browser on your network. It catalogs STL, 3MF and other model files, renders thumbnails, and handles tags, metadata, print history and duplicates.

![JusttPrint Logo](logo.png)

## Features

### Core Functionality
- **Directory Scanning**: Automatically scan and catalog STL and 3MF files (up to 50MB per file)
- **3D Model Preview**: View thumbnails of your 3D models with customizable background colors
- **File Management**: Quick access to file locations, delete files with database cleanup
- **Database Backup & Restore**: Back up the library database and restore it from the browser; a restore checks the file first and keeps the previous database

### Organization & Metadata
- **Tagging System**: Organize models with custom tags and categories
- **Designer Tracking**: Assign and track designer information for each model
- **Print Status & History**: Track Unprinted / Want / Queued / Printing / Printed / Failed, log reprints with date and notes, and filter by last printed or ever printed
- **Filament catalog**: Assign filaments to models and optionally sync the catalog from Spoolman (pull-only)
- **Source URLs**: Store links to where you found or purchased models
- **Notes**: Add custom notes to any model
- **Parent/Child Relationships**: Link related models together
- **Folder & ZIP bundle grouping**: Automatically group models from the same subfolder or ZIP archive; preview all parts in one 3D view
- **License Tracking**: Assign licenses to models

### Advanced Features
- **Web app**: Use your library from any browser on your network, including phones and tablets
- **MCP Server**: Connect a local AI agent to search the library, read model details, and write thumbnails (see [MCP Server](#mcp-server))
- **Multi-Edit Mode**: Select and edit multiple models simultaneously for batch operations
- **Duplicate Detection**: Find duplicate files based on content hash with visual comparison, optionally limited to the current library filters
- **Print Roulette**: Randomly select models from your collection
- **AI Tagging**: Automated tag suggestions using AI
- **3D bundle preview**: Open every STL/3MF in a folder or ZIP in a single preview layout
- **Send to Slicer from preview**: Open the current model or entire bundle in the slicer on your computer, through the JusttPrint helper (new instance when already running)
- **Search & Filter**: Real-time search by filename and filter by designer, folders, tags, print status, filament, parent model, or license
- **Tag Manager**: Comprehensive tag management interface
- **Metadata Editor**: Bulk metadata editing capabilities
- **Thumbnail Management**: Generate, regenerate, or purge model thumbnails

### User Interface
- **Responsive Grid Layout**: Browse models in an intuitive grid view
- **Context Menu**: Quick actions via right-click menu
- **Sort Options**: Sort by name, size, or date
- **Auto-save**: Changes are automatically saved

For a complete list of features and detailed usage instructions, see the [GUIDE.md](GUIDE.md) file.

See [CHANGELOG.md](CHANGELOG.md) for recent feature additions and migration notes.

## Upgrading from Printventory

JusttPrint 4.0.0 is the renamed Printventory. The data folder, database file, environment variables and slicer helper link have new names, so an existing install needs a few one-time steps (rename the database file, update the volume path and `PRINTVENTORY_*` variables, reinstall the slicer helper). See **Before upgrading** under 4.0.0 in [CHANGELOG.md](CHANGELOG.md).

## Running JusttPrint

JusttPrint runs as a Docker container. Build the image from this repository and start it with your models folder mounted:

```bash
docker build -t justtprint:latest .
docker run -d --name justtprint-server \
  -p 5000:5000 \
  -v ./data:/root/.config/justtprint \
  -v /path/to/your/models:/mnt/models:ro \
  -e STL_HOME=/mnt/models \
  -e JUSTTPRINT_PASSWORD='choose-a-password' \
  --restart unless-stopped \
  justtprint:latest
```

Then open `http://<server-ip>:5000` and log in. See [Docker Deployment](#docker-deployment-linux-server-mode) for Compose, network shares, HTTPS, GPUs and all settings.

### Data Storage

Everything the app stores (database, thumbnails, backups, certificates) lives in the container's data folder, `/root/.config/justtprint`. Mount it as a volume (`./data` above) so it survives updates and container rebuilds.

### Network Connections

JusttPrint does not collect usage data. It only connects to outside services in these cases:

- **Update check**: on startup, after the terms are accepted, it asks GitHub for the latest release of `ngolston/JusttPrint`. Turn this off under **About → Updates**.
- **AI tagging**: when you use it, the model's thumbnail, file name and folder names go to the AI service you configured (OpenAI-compatible endpoint or Puter).
- **Page imports and Spoolman**: when you import from a model website or sync filaments, it contacts that site or your Spoolman server.

## Using the Web App

JusttPrint serves its interface over HTTP on port 5000 (or HTTPS when enabled), so every device on your network can use the same library.

### Logging In

Server Mode requires a password. Browsers log in once and stay logged in for 30 days.

- **First start**: if no password is set, JusttPrint creates one and prints it in the server log (`docker logs justtprint`). It is shown only once.
- **Set it yourself**: start with the `JUSTTPRINT_PASSWORD` environment variable. It replaces the stored password on every start, which is also how to reset a forgotten password.
- **Change it**: **Tools → Server Access** (password at least 8 characters). Changing it logs out every browser.
- **MCP clients and scripts**: send `Authorization: Bearer <API token>`. The token is shown under **Tools → Server Access**, and the client config under **MCP Server → Settings** already includes it.
- **Send to Slicer helper**: links carry a download token that expires after 15 minutes. Helpers installed before login was added must be reinstalled from **Settings → Slicer**.
- **Login rate limit behind a proxy**: set `JUSTTPRINT_TRUST_PROXY=1` (number of proxies in front, or their addresses such as `loopback, 10.0.0.0/8`) so failed logins are counted per real client. Leave it unset when the container is reached directly.
- **Reverse proxies**: pass the original host (`X-Forwarded-Host`, or keep the `Host` header), or list your public address in `JUSTTPRINT_ALLOWED_ORIGINS` (comma separated, e.g. `https://library.example.com`). Otherwise the browser's actions and WebSocket are refused as cross-site. Long actions (scans, hashing, large previews) keep their connection alive by sending a space every 15 seconds, so the proxy's default read timeout does not cut them off.

The file endpoints only serve files inside your library folders (scanned directories and STL Home), plus backups and exports the server creates. From the browser and MCP, deleting, moving and reading files works only inside the library, and system folders (such as `/etc`, `/usr` or the app's own folders) cannot be scanned or used as an Organize Library destination.

### Important Requirements

- **Paths**: model paths are paths inside the container, such as `/mnt/models/part.stl`. Mount network shares on the host and into the container (see [Docker Deployment](#docker-deployment-linux-server-mode)).
- **Network Access**: the server listens on all network interfaces on port 5000. You may need to allow it through your firewall.
- **Network Security**: JusttPrint is designed for your local network. It requires a login (see [Logging In](#logging-in)), but use HTTPS whenever it is reachable from outside your network.
- **HTTPS / SSL**: open **Settings → HTTPS / SSL** to use custom PEM files, a self-signed LAN certificate, or Let's Encrypt (public DNS + inbound port 80). You can also set the **listen port** (default 5000; `https://` and `wss://` on that port). `JUSTTPRINT_PORT` seeds the port when unset. `JUSTTPRINT_TLS_*` environment variables override the certificate UI. Reverse proxies should leave in-app TLS off and upgrade WebSockets.

### STL Home Setting

STL Home folders are scanned when the server starts and then on a schedule, so new files show up on their own.

1. Open **Settings → STL Home** (or set `STL_HOME`, see [Environment variables](#environment-variables))
2. Add each folder as a container path (e.g. `/mnt/models`); add a row for each extra library
3. Set the **Update Frequency** (default 60 minutes; 1 to 1440)
4. Click **Save**

New models found by a scan get thumbnails in the background. To stop automatic scanning, remove every folder from the list and save.

## MCP Server

JusttPrint exposes a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) endpoint so an AI agent (Cursor, Claude Desktop, VS Code Copilot, and similar) can search the library, manage tags and filaments, find duplicates, scan folders, update metadata, record print history, and write thumbnails.

This is an **experimental** feature. By using it, you assume the risk: the API may change or break, and any client with the API token can read and change library data.

The transport is **Streamable HTTP** at `/mcp`, always available while the server runs:

```
http://<your-host>:5000/mcp
```

Open **Tools → MCP Server** for the URL and a client config that already includes the API token.

### Tools

Agents can call the library, tag, filament, print-history, thumbnail, DeDup, scan, metadata, slicer, and backup tools listed in **Tools → MCP Server**. Destructive actions (`remove_model`, `trash_file`, `move_files`) require `confirm: true`.

To generate thumbnails outside JusttPrint: list models with `get_models_missing_thumbnails`, open each `filePath` on disk, render an image, then call `set_thumbnail` with a PNG or JPEG data URL or raw base64.

## Development

Requires [Node.js](https://nodejs.org/) 22 or later and a C++ toolchain for `better-sqlite3`.

```bash
git clone https://github.com/ngolston/JusttPrint.git
cd JusttPrint
npm install
npm run build:web
JUSTTPRINT_PASSWORD=dev-password STL_HOME=/path/to/models npm start
```

`npm start` runs the server on plain Node (`src/server/index.js`) at `http://localhost:5000`. Thumbnails need a Chromium-based browser; set `JUSTTPRINT_CHROMIUM` to its path if Puppeteer's own download is missing.

- `npm run build:web` type-checks and builds the React screens (`src/web/`) into `web-build/app.js`, which the page loads. `npm run dev:web` rebuilds on every change; reload the page to see it. The Docker image builds them itself.
- `npm test` runs every unit test (`*.test.js`).
- `npm run test:e2e` builds the React screens, starts the server with `tests/fixtures/library` and checks the API, security rules and the web UI in a browser (`CHROME_PATH` selects the browser; on macOS Google Chrome is found automatically).

## Testing Locally

`docker-compose.local.yml` builds the image from your checkout and runs it on your computer. It reads its settings from `~/justtprint-test/local.env`:

```
JUSTTPRINT_MODELS=/Users/you/justtprint-test/models   # your models folder
JUSTTPRINT_MODELS_MODE=ro                               # rw to test delete, move and organize
JUSTTPRINT_DATA=/Users/you/justtprint-test/data       # database and thumbnails
JUSTTPRINT_PASSWORD=choose-a-password                   # web UI login
JUSTTPRINT_HOST_PORT=5055                               # 5000 is taken by AirPlay on macOS
```

```bash
npm run docker:local          # build and start, then open http://localhost:5055
npm run docker:local:logs     # follow the server log
npm run docker:local:down     # stop and remove the container (data is kept)
```

Run `npm run docker:local` again after code changes to rebuild. Use a copy of your models when the mode is `rw`, since delete and move change the real files.

## Docker Deployment (Linux Server Mode)

JusttPrint can be deployed as a Docker container for easy server mode deployment on Linux systems. This is ideal for headless servers or containerized environments.

The image runs the server on plain Node.js (no Electron, no virtual display). Thumbnails are rendered by a headless Chromium inside the container, using software WebGL by default or an NVIDIA GPU (see below).

### Distribution Options

**Option 1: Release package (recommended)**
- Download `justtprint-docker-<version>.zip` from [GitHub Releases](https://github.com/ngolston/JusttPrint/releases) and unzip it
- Put your models in the `models` folder next to `docker-compose.yml` (or change that mount to your models folder), and set `JUSTTPRINT_PASSWORD` in `docker-compose.yml`
- Run `docker compose up -d --build`, then open `http://<server-ip>:5000`

**Option 2: Build from source**
- Clone the repository and build the image yourself (see [Building the Image](#building-the-image))

**Option 3: Your own Docker Hub image**
- Publish the image to your Docker Hub account for Intel/AMD and ARM with `npm run docker:hub:multiarch`, then pull it on your servers

### Getting the Image

#### Prerequisites

- [Docker](https://www.docker.com/get-started) installed
- Docker Desktop running (if on Windows/Mac)

#### Building the Image

From a clone of the repository:
```bash
docker build -t justtprint:latest .
```

The examples below run `justtprint:latest`. To publish the image to your own Docker Hub account for Intel/AMD and ARM, set `DOCKER_HUB_USERNAME` and run `npm run docker:hub:multiarch`; then use `<your-username>/justtprint:latest` in place of `justtprint:latest`.

#### Running with Docker Run

**Basic run command:**
```bash
docker run -d \
  --name justtprint-server \
  -p 5000:5000 \
  -v ./data:/root/.config/justtprint \
  --restart unless-stopped \
  justtprint:latest
```

**With network share mounted (Windows - mapped drive):**
```bash
# Step 1: Map the network share to a drive letter on Windows
net use Z: \\server\share /persistent:yes

# Step 2: Run container with volume mount and STL_HOME environment variable
# Maps Windows Z: drive to /mnt/network-share inside container
docker run -d \
  --name justtprint-server \
  -p 5000:5000 \
  -v ./data:/root/.config/justtprint \
  -v Z:/:/mnt/network-share:ro \
  -e STL_HOME=/mnt/network-share/models \
  --restart unless-stopped \
  justtprint:latest

# Step 3: Use Linux-style paths in JusttPrint
# Example: /mnt/network-share/models/myfile.stl
# STL Home is automatically configured via STL_HOME environment variable
```

**With network share mounted (Linux - SMB/CIFS):**
```bash
# Step 1: Mount the network share on the Linux host
sudo mkdir -p /mnt/network-share
sudo mount -t cifs //server/share /mnt/network-share -o username=user,password=pass,uid=$(id -u),gid=$(id -g)

# Step 2: Run container with volume mount and STL_HOME environment variable
# Maps host /mnt/network-share to /mnt/network-share inside container
docker run -d \
  --name justtprint-server \
  -p 5000:5000 \
  -v ./data:/root/.config/justtprint \
  -v /mnt/network-share:/mnt/network-share:ro \
  -e STL_HOME=/mnt/network-share/models \
  --restart unless-stopped \
  justtprint:latest

# Step 3: Use Linux-style paths in JusttPrint
# Example: /mnt/network-share/models/myfile.stl
# STL Home is automatically configured via STL_HOME environment variable
```

#### Running with Docker Compose

Create a `docker-compose.yml` file (or use the one from the repo / distribution zip):

```yaml
version: '3.8'

services:
  justtprint:
    image: justtprint:latest
    # Built from this repository's Dockerfile
    build:
      context: .
      dockerfile: Dockerfile
    container_name: justtprint-server
    ports:
      - "5000:5000"
      # Let's Encrypt (Settings → HTTPS / SSL) needs port 80:
      # - "80:80"
      # Optional: map 443 to the app when TLS is on:
      # - "443:5000"
    volumes:
      # Persist DB and app data (host ./data → container config dir)
      - ./data:/root/.config/justtprint

      # Mount model files (pick one). Use the *container* path in JusttPrint / STL_HOME.
      # Windows mapped drive: net use Z: \\server\share /persistent:yes
      # - Z:/:/mnt/network-share:ro
      # Linux SMB/CIFS (mount on host first):
      # - /mnt/network-share:/mnt/network-share:ro
      # Local host directory:
      # - /home/user/models:/mnt/models:ro
      # Custom PEM files (optional). Let's Encrypt / self-signed certs live in ./data.
      # - ./certs:/certs:ro
    environment:
      - DBUS_FATAL_WARNINGS=0

      # Auto-configure STL Home (must match a mounted volume).
      # Several directories: comma, semicolon, or newline separated, or a JSON array.
      # - STL_HOME=/mnt/models,/mnt/archive
      # Directories to skip under STL Home (comma-separated container paths)
      # - STL_HOME_EXCLUDE=/mnt/models/cache,/mnt/models/derivatives

      # Preview / memory tuning (optional)
      # - JUSTTPRINT_PREVIEW_3MF_WORKER_MEMORY_MB=512
      # - JUSTTPRINT_PREVIEW_3MF_MAX_FILE_SIZE_MB=200
      # - JUSTTPRINT_MAX_OLD_SPACE_MB=8192

      # Server-side thumbnail GPU: auto (default) | nvidia | swiftshader
      # - JUSTTPRINT_GPU=auto

      # HTTPS: prefer Settings → HTTPS / SSL in the UI. These env vars override the UI.
      # - JUSTTPRINT_TLS_CERT=/certs/fullchain.pem
      # - JUSTTPRINT_TLS_KEY=/certs/privkey.pem
      # - JUSTTPRINT_TLS_CA=/certs/chain.pem

      # NVIDIA (only when using a host GPU — see section below)
      # - NVIDIA_VISIBLE_DEVICES=all
      # - NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
    restart: unless-stopped
    # Container memory (host RAM is unused if this is too low)
    mem_limit: 8g
    mem_reservation: 1g
    # NVIDIA GPU passthrough (uncomment with NVIDIA_* env vars above)
    # gpus: all
```

Then run:
```bash
docker compose up -d
```

##### Docker Compose options explained

| Option | What it does |
|--------|----------------|
| `image` | Image name (`justtprint:latest` when built locally, or `<your-username>/justtprint:latest` when published). |
| `build` | Build from the local `Dockerfile`. |
| `container_name` | Fixed container name (`justtprint-server`) for easy `docker logs` / `docker exec`. |
| `ports` | Maps host → container. `5000:5000` is the app (HTTP or HTTPS). Publish `80:80` for Let's Encrypt HTTP-01. Optional `443:5000` when TLS is on. |
| `volumes` → `./data:...` | Persists the SQLite DB and app config on the host so updates/recreates keep your library. |
| `volumes` → model mounts | Exposes host/network files inside the container. Always use the **container** path (e.g. `/mnt/models`) in the UI and in `STL_HOME`. `:ro` is read-only. |
| `volumes` → `./certs:...` | Optional PEM directory for custom certificates. Let's Encrypt and self-signed files are stored in `./data`. |
| `restart: unless-stopped` | Restarts the container after reboot or crash, unless you stopped it manually. |
| `mem_limit` / `mem_reservation` | Caps / reserves container RAM. Recommend **4GB+** (8g in the example) for large libraries. Host RAM alone does not help if the container is capped low. |
| `gpus: all` | Passes host NVIDIA GPUs into the container (requires NVIDIA Container Toolkit). |

##### Environment variables

Variables marked **every start** win over the UI each time the container starts. The rest only fill a setting that is empty, unless `JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1`.

| Variable | Purpose |
|----------|---------|
| `PUID` / `PGID` | User and group the app runs as, and the owner of files it writes. Match the owner of your library (`id -u`, `id -g`). Default `1000`/`1000`; `PUID=0` runs as root. |
| `JUSTTPRINT_PASSWORD` | Web UI login password (**every start**). Unset: a random one is printed once in the log. |
| `JUSTTPRINT_PORT` | Listen port inside the container (default `5000`). Map the same port in `ports:`. |
| `JUSTTPRINT_ALLOWED_ORIGINS` | Extra browser addresses allowed to connect, comma separated (reverse proxies that rewrite `Host`). |
| `JUSTTPRINT_TRUST_PROXY` | Number of reverse proxies in front (`1`), `true`, or their addresses, so the login rate limit sees real client addresses. |
| `JUSTTPRINT_ENABLE_ZIP` | `true`/`false`: scan models inside zip archives (**every start**). |
| `JUSTTPRINT_FILE_TYPES` | Extra file types to scan, comma separated: `obj`, `step`, `ply`, `3ds`, `amf`, `blender`, `chitubox`, `dae`, `dwg`, `dxf`, `f3d`, `f3z`, `fbx`, `gcode`, `igs`, `lys`, `svg`, `voxl`, `x3d` (**every start**). |
| `JUSTTPRINT_SCAN_EXCLUDE` | Folder names to skip while scanning, comma separated (**every start**). |
| `JUSTTPRINT_AI_SERVICE` | AI tagging service: `openai`, `claude`, `gemini`, `puter` or `custom` (**every start**). |
| `JUSTTPRINT_AI_API_KEY` | API key for that service (**every start**; never written to the log). |
| `JUSTTPRINT_AI_MODEL` / `JUSTTPRINT_AI_ENDPOINT` | AI model name, and endpoint URL for `custom` or self-hosted services (**every start**). |
| `STL_HOME` | STL Home scan directories on start (Linux paths inside the container). One path, or several separated by commas, semicolons, or newlines, or a JSON array. |
| `STL_HOME_EXCLUDE` | Directories STL Home scans skip. Comma, semicolon, or newline separated container paths, or a JSON array. Same empty-vs-override rules as `STL_HOME`. |
| `JUSTTPRINT_ENV_OVERRIDES_SETTINGS` | Set to `1` to re-apply env settings on every start (legacy). By default, env fills unset DB settings only. |
| `JUSTTPRINT_GPU` | Server thumbnail WebGL backend: `auto` (default), `nvidia`, or `swiftshader` (CPU). |
| `JUSTTPRINT_PREVIEW_3MF_WORKER_MEMORY_MB` | Memory budget for 3MF preview workers (keep below container RAM). |
| `JUSTTPRINT_PREVIEW_3MF_MAX_FILE_SIZE_MB` | Skip / limit very large 3MF files during preview. |
| `JUSTTPRINT_MAX_OLD_SPACE_MB` | V8 heap size in MB. Defaults scale from the container memory limit; raise if logs show `OOM error in V8: Zone Allocation failed`. |
| `JUSTTPRINT_DB_PATH` | Optional override for the SQLite DB path inside the container. |
| `JUSTTPRINT_TLS_CERT` / `JUSTTPRINT_TLS_KEY` / `JUSTTPRINT_TLS_CA` | Ops override for in-container HTTPS (wins over **Settings → HTTPS / SSL**). Browser uses `https://` and `wss://`. If you terminate TLS at Traefik/Caddy/nginx instead, leave these unset, leave the UI on Off, and configure WebSocket upgrade on the proxy. |
| `NVIDIA_VISIBLE_DEVICES` | Which GPUs the container can see (`all` or a device index). |
| `NVIDIA_DRIVER_CAPABILITIES` | Must include **`graphics`** for WebGL (`graphics,compute,utility`). `compute,utility` alone is enough for `nvidia-smi` but not Chromium. |

**Memory note:** Host RAM (e.g. 96GB) is not used automatically. Unraid/Compose often caps the container. Raise `mem_limit` and, if needed, `JUSTTPRINT_MAX_OLD_SPACE_MB`. Logs showing `OOM error in V8: Zone Allocation failed` are the V8 heap limit, not the host running out of RAM.

#### NVIDIA GPU (optional)

Server-side thumbnail jobs render with WebGL inside the container. By default the image uses **SwiftShader** (CPU). To use a host NVIDIA GPU:

1. Install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host.
2. Pass the GPU into the container **and** enable the `graphics` driver capability (required for WebGL — `compute,utility` alone is not enough):

```yaml
services:
  justtprint:
    image: justtprint:latest
    gpus: all
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility
      - JUSTTPRINT_GPU=auto   # or nvidia | swiftshader
```

Alternative Swarm / `deploy` syntax (Compose V2 on a normal Docker Engine host should prefer `gpus: all` plus the env vars above — `deploy.devices` alone does not always enable `graphics`):

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

3. Recreate the container (`docker compose up -d --force-recreate`), then open **Help → System Report**:
   - **Client GPU** = your browser (previews)
   - **Server / App GPU** = container WebGL backend + `nvidia-smi`

If System Report still shows SwiftShader while `nvidia-smi` lists a card, `graphics` is usually missing from `NVIDIA_DRIVER_CAPABILITIES`, or the image predates GPU auto-detect.

#### Accessing the Server

Once the container is running, access JusttPrint from your browser:

- **Local machine:** `http://localhost:5000`
- **Network access:** `http://<your-ip>:5000`

#### Managing the Container

**View logs:**
```bash
docker logs justtprint-server
# Follow logs in real-time:
docker logs -f justtprint-server
```

**Stop the container:**
```bash
docker stop justtprint-server
```

**Start the container:**
```bash
docker start justtprint-server
```

**Restart the container:**
```bash
docker restart justtprint-server
```

**Remove the container:**
```bash
docker stop justtprint-server
docker rm justtprint-server
```

**Update to the latest version:**
```bash
git pull
docker build -t justtprint:latest .
docker stop justtprint-server
docker rm justtprint-server
docker run -d --name justtprint-server -p 5000:5000 -v ./data:/root/.config/justtprint --restart unless-stopped justtprint:latest
```

#### Using Network Paths

When running in Docker, remember:
- **Windows UNC paths** (`\\server\share\path`) won't work directly
- **Mount network shares** into the container first (see [Path Mapping Guide](#path-mapping-guide) above)
- **Use Linux-style paths** inside the container: `/mnt/network-share/path/to/file`
- **For automatic scanning**: Configure STL Home using the container path (see [STL Home Setting](#stl-home-setting) section)

### Prerequisites

- [Docker](https://www.docker.com/get-started) installed on your Linux system
- [Docker Compose](https://docs.docker.com/compose/install/) (optional, for easier deployment)

### Building the Docker Image

**From distribution package:**
```bash
# Extract the zip file
unzip justtprint-docker-*.zip
cd justtprint-docker-*

# Build the image
docker build -t justtprint:latest .
```

**From source repository:**
```bash
# Build the image from project root
docker build -t justtprint:latest .
```

### Running with Docker

#### Using Docker Run

```bash
docker run -d \
  --name justtprint-server \
  -p 5000:5000 \
  -v ./data:/root/.config/justtprint \
  --restart unless-stopped \
  justtprint:latest
```

#### Using Docker Compose (Recommended)

```bash
docker-compose up -d
```

This will:
- Build the image (if not already built)
- Start the container in detached mode
- Map port 5000 to your host
- Create a persistent volume for database and application data
- Configure automatic restart

### Accessing the Server

Once the container is running, access JusttPrint from any browser:

```
http://<your-server-ip>:5000
```

Or if running locally:

```
http://localhost:5000
```

### STL Home Setting

The STL Home setting allows automatic scanning of one or more directories on startup and periodic scanning for new files in Docker mode. This is ideal for keeping your library synchronized with a network share or mounted directory.

#### Setting STL Home in Docker Mode

There are two ways to configure STL Home in Docker:

**Option 1: Using Environment Variable (Recommended for Docker)**

You can set STL Home directories directly in your `docker-compose.yml` using the `STL_HOME` environment variable:

```yaml
environment:
  - STL_HOME=/mnt/network-share/models,/mnt/network-share/archive
  - STL_HOME_EXCLUDE=/mnt/network-share/models/cache,/mnt/network-share/models/derivatives
```

A single path still works (`STL_HOME=/mnt/network-share/models`). For several directories, separate paths with commas, semicolons, or newlines, or pass a JSON array. This configures STL Home when the container starts. The list is visible under **Settings → STL Home**.

`STL_HOME` is saved when the directory list is still empty. After you change it in the web UI, that saved list is kept on restart unless `JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1`.

`STL_HOME_EXCLUDE` is the same excluded-directories list as in that dialog. Separate paths the same way, or pass a JSON array. A path can be absolute inside the container or relative to the STL Home directory being scanned. The list is saved when it is still empty (`[]`). After you change it in the web UI, that saved list is kept on restart unless `JUSTTPRINT_ENV_OVERRIDES_SETTINGS=1`.

**Option 2: Using the Web Interface**

1. **Ensure your files are mounted** into the container (see [Path Mapping Guide](#path-mapping-guide) above)
2. **Access the JusttPrint web interface** at `http://<your-server-ip>:5000` or `http://localhost:5000`
3. **Navigate to Settings → STL Home**
4. **Add each directory using the container path format:**
   - Use Linux-style absolute paths (e.g., `/mnt/network-share/models`)
   - Each path must match a mounted volume in your Docker configuration
   - Example: If you mounted `Z:/:/mnt/network-share:ro`, use `/mnt/network-share/path/to/models`
   - Add another row for each extra library
5. **Configure the Update Frequency** (default: 60 minutes):
   - This determines how often the STL Home directories are automatically scanned for new files
   - Range: 1-1440 minutes (1 minute to 24 hours)
   - Recommended: 60-120 minutes for most use cases
6. **Click Save**

**Note**: If you set `STL_HOME` via environment variable, you can still adjust the Update Frequency through the web interface. The environment variable fills the directory list when it is still empty.

#### How It Works in Docker

- **On Container Startup**: When the JusttPrint container starts, it automatically scans every STL Home directory that is configured
- **Periodic Scanning**: The container scans each STL Home directory at the configured interval
- **Path Requirements**: 
  - Must use Linux-style absolute paths starting with `/`
  - Path must correspond to a mounted volume in your Docker configuration
  - Example: If volume mount is `- Z:/:/mnt/network-share:ro`, use `/mnt/network-share/path` in STL Home
- **Background Scanning**: Periodic scans run in the background and won't disrupt the web interface
- **Path Validation**: Paths are validated when saved - ensure the path exists inside the container

#### Example Configuration

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  justtprint:
    image: justtprint:latest
    container_name: justtprint-server
    ports:
      - "5000:5000"
    volumes:
      - ./data:/root/.config/justtprint
      - Z:/:/mnt/network-share:ro  # Windows mapped drive
    environment:
      - STL_HOME=/mnt/network-share/models,/mnt/network-share/archive
      - STL_HOME_EXCLUDE=/mnt/network-share/models/cache,/mnt/network-share/models/derivatives
    restart: unless-stopped
```

**Result:**
- STL Home is automatically set to `/mnt/network-share/models` and `/mnt/network-share/archive` on container startup
- The setting will be visible in **Settings → STL Home** in the web interface
- Update Frequency can be configured via the web interface (default: 60 minutes)
- This scans `Z:\models` and `Z:\archive` on the Windows host every 60 minutes (or your configured interval)

#### Clearing STL Home

To disable automatic scanning, remove every directory from the list and save. This stops both startup and periodic scanning.

### Managing the Container

**View logs:**
```bash
docker logs justtprint-server
# or with docker-compose:
docker-compose logs -f
```

**Stop the container:**
```bash
docker stop justtprint-server
# or with docker-compose:
docker-compose down
```

**Start the container:**
```bash
docker start justtprint-server
# or with docker-compose:
docker-compose up -d
```

**Restart the container:**
```bash
docker restart justtprint-server
# or with docker-compose:
docker-compose restart
```

### Data Persistence

The Docker setup uses a local bind mount (`./data`) to persist your database and application data on the host filesystem. This ensures your data survives container restarts and image updates, and gives you direct access to the database files.

**Database location:**
- The database is stored in the `./data` directory (relative to your `docker-compose.yml` file)
- This directory is created automatically when you start the container
- All database files and application data are stored here

**Backup the data:**
```bash
# On Linux/Mac
tar czf justtprint-backup.tar.gz -C ./data .

# On Windows (PowerShell)
Compress-Archive -Path .\data\* -DestinationPath justtprint-backup.zip
```

**Restore from backup:**
```bash
# On Linux/Mac
mkdir -p ./data
tar xzf justtprint-backup.tar.gz -C ./data

# On Windows (PowerShell)
Expand-Archive -Path justtprint-backup.zip -DestinationPath .\data
```

**Migrating from named volume to local directory:**
If you previously used a named volume and want to migrate to the local directory:
```bash
# Stop the container
docker-compose down

# Copy data from old volume to new location
docker run --rm -v justtprint-data:/source -v ${PWD}/data:/dest alpine sh -c "cp -r /source/. /dest/"

# Start with new configuration
docker-compose up -d
```

### Path Mapping Guide

Docker volumes allow you to map paths from your host machine (or network shares) into the container. Understanding this mapping is crucial for configuring JusttPrint to access your files.

#### Understanding Volume Mounts

Docker volume mounts use the format: `host-path:/container-path:options`

- **host-path**: The path on your host machine (or a mapped network drive)
- **/container-path**: The path inside the container where files will appear
- **options**: Mount options like `ro` (read-only) or `rw` (read-write)

**Important**: When using paths in JusttPrint, you must use the **container path** (`/container-path`), not the host path. The container path is what JusttPrint sees inside the Docker environment.

#### Quick Reference Table

| Host Path Type | Docker Volume Syntax | Container Path to Use in JusttPrint |
|----------------|---------------------|--------------------------------------|
| Windows mapped drive (Z:) | `- Z:/:/mnt/network-share:ro` | `/mnt/network-share/path/to/file` |
| Linux mounted SMB share | `- /mnt/network-share:/mnt/network-share:ro` | `/mnt/network-share/path/to/file` |
| Local Linux directory | `- /host/path:/mnt/models:ro` | `/mnt/models/path/to/file` |
| Windows local directory | `- C:/models:/mnt/models:ro` | `/mnt/models/path/to/file` |

#### Step-by-Step: Windows Docker Desktop

1. **Map the network share to a drive letter:**
   ```bash
   net use Z: \\server\share /persistent:yes
   ```
   This makes the network share available as drive `Z:` on Windows.

2. **Add the volume mount to docker-compose.yml:**
   ```yaml
   volumes:
     - ./data:/root/.config/justtprint
     - Z:/:/mnt/network-share:ro
   ```
   This maps Windows drive `Z:` to `/mnt/network-share` inside the container.

3. **Use the container path in JusttPrint:**
   - When scanning or setting STL Home, use: `/mnt/network-share/path/to/files`
   - Do not use the Windows path (`Z:\path\to\files`) or UNC path (`\\server\share\path`)

#### Step-by-Step: Linux Host

1. **Install CIFS utilities (if mounting SMB shares):**
   ```bash
   sudo apt-get update
   sudo apt-get install cifs-utils
   ```

2. **Mount the network share on the host:**
   ```bash
   sudo mkdir -p /mnt/network-share
   sudo mount -t cifs //server/share /mnt/network-share -o username=user,password=pass,uid=$(id -u),gid=$(id -g)
   ```

3. **Add the volume mount to docker-compose.yml:**
   ```yaml
   volumes:
     - ./data:/root/.config/justtprint
     - /mnt/network-share:/mnt/network-share:ro
   ```
   This maps the host mount point to the same path inside the container.

4. **Use the container path in JusttPrint:**
   - When scanning or setting STL Home, use: `/mnt/network-share/path/to/files`
   - The path inside the container matches the host path in this example

### Network Shares and File Access

**In Docker containers**, you cannot directly access Windows UNC paths (`\\server\share\path`). Instead, you need to mount network shares into the container.

#### Option 1: Mount SMB/CIFS Share (Recommended)

1. **Install CIFS utilities on the Docker host:**
   ```bash
   sudo apt-get update
   sudo apt-get install cifs-utils
   ```

2. **Create a mount point and mount the share:**
   ```bash
   sudo mkdir -p /mnt/network-share
   sudo mount -t cifs //server/share /mnt/network-share -o username=youruser,password=yourpass,uid=$(id -u),gid=$(id -g)
   ```

3. **Add the mount to docker-compose.yml:**
   ```yaml
   volumes:
     - ./data:/root/.config/justtprint
     - /mnt/network-share:/mnt/network-share:ro
   ```

4. **Use Linux-style paths** in JusttPrint:
   - Format: `/mnt/network-share/path/to/files`
   - The application will automatically detect Docker and accept absolute paths

#### Option 2: Mount Local Directory

If your files are on the Docker host machine:

```yaml
volumes:
  - ./data:/root/.config/justtprint
  # Maps host /host/path/to/models to /mnt/models inside container
  - /host/path/to/models:/mnt/models:ro
```

**Usage in JusttPrint:**
- Use the container path: `/mnt/models/subdirectory`
- Do not use the host path (`/host/path/to/models/subdirectory`)

#### Option 3: Persistent SMB Mount (Auto-mount on boot)

To automatically mount on host reboot, add to `/etc/fstab`:

```
//server/share /mnt/network-share cifs username=user,password=pass,uid=1000,gid=1000,iocharset=utf8,file_mode=0777,dir_mode=0777 0 0
```

**Note:** When running in Docker, the application automatically detects the container environment and accepts Linux-style absolute paths (starting with `/`) instead of requiring UNC paths.

#### Troubleshooting Path Mapping Issues

**Files not found in JusttPrint:**
- Verify the volume mount is correct: `docker inspect justtprint-server | grep -A 10 Mounts`
- Check that the container path matches what you're using in JusttPrint
- Ensure the host path exists and is accessible
- For network shares, verify the share is mounted on the host before starting the container

**Permission errors:**
- Check file permissions on the host: `ls -la /mnt/network-share`
- Ensure the mount includes appropriate `uid` and `gid` options for Linux mounts
- For read-only mounts, verify `:ro` flag is set if you only need read access

**Path format errors:**
- Remember: Always use the **container path** (e.g., `/mnt/network-share/path`), not the host path
- Container paths must start with `/` (Linux-style absolute paths)
- UNC paths (`\\server\share`) will not work inside Docker containers

### Troubleshooting

**Container won't start:**
- Check logs: `docker logs justtprint-server`
- Verify port 5000 is not in use: `netstat -tuln | grep 5000`
- Ensure Docker has sufficient resources (memory, CPU)

**Can't access the web interface:**
- Verify the container is running: `docker ps`
- Check firewall rules allow port 5000
- Verify port mapping: `docker port justtprint-server`

**Database issues:**
- Ensure the `./data` directory has write permissions
- Check that the directory exists: `ls -la ./data` (Linux/Mac) or `dir .\data` (Windows)
- Verify the bind mount: `docker inspect justtprint-server | grep -A 10 Mounts`

### Resource Requirements

- **Minimum**: 512MB RAM, 1 CPU core
- **Recommended**: 2GB RAM, 2 CPU cores
- **Disk**: At least 1GB for the image and dependencies, plus space for your database

## Application Structure

### Server (`src/server/`)
- `index.js` - Entry point (`npm start`); `app.js` - startup and shutdown
- `http.js` - HTTP/WebSocket server, TLS and listen ports
- `api.js`, `api-actions.js` - The HTTP API the web UI calls (`POST /api/actions/<name>` with `{ "args": [...] }`), and the list of actions with the arguments each one takes. Every call is checked for login, same origin, argument types and library paths. The WebSocket only carries what the server pushes: events and dialogs
- `ipc/` - One module per area (models, tags, thumbnails, backup, organize, slicers, ...); each registers the handlers behind the actions. `ipc/index.js` loads them all
- `mcp-server.js`, `mcp-tools.js` - MCP endpoint and its tools
- `auth.js`, `server-auth.js` - Login, API token and download tokens
- `server-paths.js`, `path-context.js` - Which files the server may serve, read, move or write
- `thumbnail-worker.js` - Headless Chromium that renders thumbnails
- `events.js` - Events pushed to every connected browser; `client-dialogs.js` - message boxes and prompts shown in the browser
- `runtime.js` - Data paths, lifecycle events, the IPC handler registry and Move to Trash
- `scan-worker.js`, `preview-3mf-worker-node.js` - Worker threads for scans and 3MF previews
- `healthcheck.js` - Docker `HEALTHCHECK`

### Library logic (`src/core/`)
- `database.js`, `db-init.js`, `db-path.js` - The SQLite connection, schema and migrations
- `models.js`, `model-filters.js`, `thumbnails.js`, `library-paths.js` - Model records, search and filter SQL, thumbnail storage, library folders
- `print-events.js`, `printer-manager.js`, `spoolman.js` - Print history, printers, filament sync
- `env-settings.js`, `env-settings-apply.js` - Settings from environment variables
- File formats: `zip-extract.js`, `three-mf.js`, `extract-*-preview.js`

### Tests
- `tests/` - Unit tests (`npm test`) and the end-to-end suite (`tests/e2e/run.js`, `npm run test:e2e`)
- `.github/workflows/tests.yml` - Runs both on GitHub Actions for every push (Node 22, Google Chrome)

### Web UI
- `index.html`, `styles.css` - Page structure and styling
- `renderer.js` - UI logic (being replaced screen by screen with React + TypeScript)
- `src/web/` - React + TypeScript, built with Vite into `web-build/` and mounted into the page (`main.tsx`). `api.ts` calls the HTTP API, `page.ts` holds the hooks into the rest of the page, `components/` the shared pieces. The dialogs and managers; the library grid (`grid/`) and its selection (`selection.ts`); the details, ZIP bundle and multi-edit panels (`details/`); print status, history and the Log Print dialog (`print/`); notes Markdown (`notes/`); the 3D preview (`preview/`); grid thumbnails (`thumbnails/`); and the model parse worker (`parse/worker.ts`, built to `web-build/parse-worker.js`). three.js is its own chunk, loaded with the first preview or thumbnail
- `server-bridge.js` - Connects the UI to the server: actions over the HTTP API, events over a WebSocket
- `page-init.js` - Wires up buttons declared with `data-close-dialog` and the toolbar buttons. The page has no inline scripts or `onclick=` handlers: the Content Security Policy only runs script files from the server
- `search.js`, `query-builder.js`, `folder-tree.js`, `mobile-ui.js`, `guide.js` - Search and filters, folder tree, phone layout, guide

### Configuration
- `package.json` - Dependencies and scripts
- `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml` - Container image and setup

## Technology Stack

- **Node.js** 22 - Server runtime (Docker image)
- **Express** and **ws** - HTTP server, API and WebSocket
- **React** + **TypeScript**, built with **Vite** - New web UI screens
- **better-sqlite3** - SQLite database
- **three.js** (0.181) - 3D previews, thumbnails and model parsing
- **Puppeteer** + Chromium - Thumbnail rendering in the container and page imports
- **Fuse.js** - Fuzzy search
- **OpenAI SDK** - AI tagging

## Database

JusttPrint uses SQLite (via `better-sqlite3`) for data storage. The database file (`justtprint.db`) is created in the user's application data directory and stores:
- Model metadata (name, path, size, dates)
- Thumbnails (as base64 or file references)
- Tags, designers, print status, notes, and other custom fields
- Relationships between models

## File Support

- **STL files** - Standard Triangle Language format
- **3MF files** - 3D Manufacturing Format
- **ZIP Archives** - Models within Zip files
- **Size limit**: 50MB per file (Edit in Settings)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. When contributing:
- Follow existing code style and patterns
- Test your changes thoroughly
- Update documentation as needed

## License

This project is licensed under the MIT License - see the [LICENSE.txt](LICENSE.txt) file for details.

## Support

If you encounter any issues or have questions:
- File an issue on the GitHub repository
- Check the [GUIDE.md](GUIDE.md) for detailed usage instructions

---

**Note**: Always create a manual backup before uninstalling the application to preserve your data.