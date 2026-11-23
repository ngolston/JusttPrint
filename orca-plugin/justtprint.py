# /// script
# requires-python = ">=3.12"
# dependencies = []
#
# [tool.orcaslicer.plugin]
# name = "JusttPrint"
# description = "Your JusttPrint library in OrcaSlicer: open models on the plate, check your spools, send sliced files and projects back."
# author = "JusttPrint"
# version = "1.3.0"
# ///
"""JusttPrint for OrcaSlicer.

Adds a JusttPrint tab to OrcaSlicer's main window:

- Library: browse and search all your JusttPrint models (filter by print status, sort), and open
  one on the plate.
- Filament: all your spools, with their colors, grams left, where they are and which are low.
- Printers: what is loaded in each printer's AMS slots and holder; click a slot to load a spool.
- This print: check the project's filaments (and the grams of the last slice) against your spools,
  take the slice's filament off your spools when OrcaSlicer sends a print to a printer (Undo gives
  it back), send an exported sliced project (.gcode.3mf) to JusttPrint, which files it beside its model and
  queues it (by hand, or every time with Auto-send), and save the project into JusttPrint's Upload
  folder.

It signs in with an API key: in JusttPrint, Settings, Authentication, API keys, make one (Editor,
to send files back).
Paste it, with the server address, into the Settings part of the tab.

Install: OrcaSlicer, Plugins, Browse plugins, Install local plugin, then choose this file.
Needs an OrcaSlicer build with plugins (releases after 2.4.2, or a nightly build).

The plugin talks to your server only. OrcaSlicer asks once before it connects to the server, once
before it reads a project file to upload, and once before it opens a link with your system (which
is how a model gets on the plate: OrcaSlicer downloads it from an orcaslicer:// link).
"""

import http.client
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.parse

try:
    import orca
except ImportError:  # Outside OrcaSlicer (the tests): only the helpers below are used.
    orca = None

# Keep in step with the version in the header above; the server offers this file and reads it here.
PLUGIN_VERSION = "1.3.0"
# The oldest JusttPrint this plugin works fully with (filters and changes from the details windows came in 10.21.0).
MIN_SERVER_VERSION = "10.21.0"
TIMEOUT = 30
UPLOAD_TIMEOUT = 300
HEAD_BYTES = 256 * 1024
TAIL_BYTES = 1024 * 1024

DEFAULT_SETTINGS = {
    "server": "",
    "api_key": "",
    "auto_send": False,
    "verify_tls": True,
    "export_folder": "",
    # Take the slice's filament off the spools when OrcaSlicer sends a print to a printer.
    "take_off": True,
    # The JusttPrint printer this OrcaSlicer prints on, when OrcaSlicer does not say (its device id).
    "printer_id": None,
}
# What the tab remembers between OrcaSlicer sessions (its tab, searches, filters and sorts), and how.
VIEW_FIELDS = {
    "tab": ("library", "filament", "printers", "print", "settings"),
    "q": str, "status": ("", "unprinted", "queued", "printed"), "sort": ("newest", "oldest", "name"),
    "favorite": bool, "tag": str, "category": int,
    "sq": str, "material": str, "ssort": ("material", "color", "most", "least"), "project": bool,
}


def clean_view(view):
    """The view fields the page sent, checked: unknown keys and bad values are left out, text kept short."""
    out = {}
    for key, kind in VIEW_FIELDS.items():
        value = (view or {}).get(key) if isinstance(view, dict) else None
        if value is None:
            continue
        if isinstance(kind, tuple):
            if value in kind:
                out[key] = value
        elif kind is bool:
            out[key] = bool(value)
        elif kind is int:
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**31:
                out[key] = value
        elif isinstance(value, str):
            out[key] = value[:200]
    return out


# A file changed this recently may still be being written.
SETTLE_SECONDS = 3

# Shared by the capabilities: the slicing step runs on the slicing thread and only records here;
# the page reads it on the UI thread.
STATE = {
    "last_slice": None,  # {"filaments": [...], "output_name": str}
    "last_export": None,  # {"path": str, "sent": bool, "result": str | None}
    "project_path": None,
    "opened_model": None,  # {"id": int, "name": str}: the model last opened from the library
    "device_id": None,  # the printer selected in OrcaSlicer's Device tab (a Bambu serial)
    "print_sent": None,  # {"kind": "print" | "upload", "name": str, "device_id": str, "at": float, "done": bool}
    "last_print": None,  # what the server took off: {"status", "eventId", "used", "missing", "model", "printer", "undone"}
}


# --- Helpers (no OrcaSlicer needed) ---


def normalize_server(address):
    """'nas.local:5000' -> 'http://nas.local:5000'; keeps https, drops a trailing slash and path."""
    text = str(address or "").strip()
    if not text:
        return ""
    if "://" not in text:
        text = "http://" + text
    parts = urllib.parse.urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("The server address should look like http://nas.local:5000")
    return f"{parts.scheme}://{parts.netloc}"


def orca_open_link(server, path):
    """The link OrcaSlicer opens to download a file from JusttPrint and put it on the plate."""
    return "orcaslicer://open?file=" + urllib.parse.quote(normalize_server(server) + path, safe="")


def _split_values(value):
    """A G-code or preset value with one entry per filament: 'PLA;PETG', '1.2, 3.4' or a list."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v).strip().strip('"') for v in value]
    text = str(value).strip()
    sep = ";" if ";" in text else ","
    return [part.strip().strip('"') for part in text.split(sep)] if text else []


def _color(value):
    text = str(value or "").strip()
    if len(text) == 9 and text.startswith("#"):  # #RRGGBBAA
        text = text[:7]
    if len(text) == 7 and text.startswith("#"):
        try:
            int(text[1:], 16)
            return text.lower()
        except ValueError:
            return None
    return None


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # not NaN


def parse_gcode_settings(text):
    """The '; key = value' lines OrcaSlicer writes in a G-code file's header and footer."""
    found = {}
    for line in text.splitlines():
        if not line.startswith(";") or "=" not in line:
            continue
        key, _, value = line[1:].partition("=")
        key = key.strip()
        if key and key not in found:
            found[key] = value.strip()
    return found


def filaments_from_gcode(text):
    """Each filament a sliced G-code uses: slot, material, color, grams, preset (0 g ones left out)."""
    settings = parse_gcode_settings(text)
    grams = [_number(g) for g in _split_values(settings.get("filament used [g]") or settings.get("total filament used [g]"))]
    types = _split_values(settings.get("filament_type"))
    colors = _split_values(settings.get("filament_colour"))
    presets = _split_values(settings.get("filament_settings_id"))
    count = max(len(grams), len(types), len(colors))
    filaments = []
    for i in range(count):
        g = grams[i] if i < len(grams) else None
        if g is not None and g <= 0:
            continue
        filaments.append(
            {
                "slot": i + 1,
                "material": types[i] if i < len(types) and types[i] else None,
                "color": _color(colors[i]) if i < len(colors) else None,
                "grams": round(g, 1) if g is not None else None,
                "preset": presets[i] if i < len(presets) and presets[i] else None,
            }
        )
    return filaments


def read_gcode_ends(path):
    """The start and end of a G-code file (where OrcaSlicer writes its settings), as text."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(HEAD_BYTES)
        if size > HEAD_BYTES + TAIL_BYTES:
            f.seek(size - TAIL_BYTES)
            tail = f.read()
        else:
            tail = f.read()
    return (head + b"\n" + tail).decode("utf-8", "replace")


def newest_export(folder, since, now):
    """The newest whole .gcode.3mf in `folder` changed after `since`: (path, mtime), or None.

    OrcaSlicer tells plugins nothing when you use Export plate sliced file, so the plugin looks in
    the folder you export to. A file changed in the last few seconds may still be being written.
    """
    if not folder or not os.path.isdir(folder):
        return None
    best = None
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if entry.name.startswith(".") or not entry.name.lower().endswith(".gcode.3mf") or not entry.is_file():
                    continue
                mtime = entry.stat().st_mtime
                if mtime <= since or now - mtime < SETTLE_SECONDS:
                    continue
                if best is None or mtime > best[1]:
                    best = (entry.path, mtime)
    except OSError:
        return None
    return best


def read_slice(gcode_path):
    """Record what a slice uses (filament, grams) from its G-code, for the filament check.

    OrcaSlicer runs a plugin's slicing step only when the print preset lists it, so the plugin
    reads the G-code OrcaSlicer reports after each slice (GCodeExportFinished) instead.
    """
    try:
        filaments = filaments_from_gcode(read_gcode_ends(gcode_path))
    except OSError as error:
        log(f"Could not read the slice's G-code {gcode_path}: {error}")
        return None
    STATE["last_slice"] = {"filaments": filaments, "output_name": ""}
    if STATE.get("last_print"):
        STATE["last_print"]["this_slice"] = False
    log(f"Slice read: {filaments}")
    return filaments


def needs_from_presets(presets, last_slice=None, project_colors=None):
    """The filament check's needs: the project's filament presets, with grams from the last slice.

    A preset's own colour is its default; the project's colours (one per slot, from the full
    config) are the ones on the plate, so they win.
    """
    sliced = {f["slot"]: f for f in (last_slice or {}).get("filaments", [])}
    colors = _split_values(project_colors)
    needs = []
    for i, preset in enumerate(presets):
        if preset is None:
            continue
        slot = i + 1
        value = getattr(preset, "config_value", None)
        material = _split_values(value("filament_type"))[:1] if value else []
        color = _split_values(value("filament_colour"))[:1] if value else []
        need = {
            "slot": slot,
            "material": material[0] if material else None,
            "color": (_color(colors[i]) if i < len(colors) else None) or (_color(color[0]) if color else None),
            "grams": None,
            "preset": getattr(preset, "name", None),
        }
        if slot in sliced:
            need["grams"] = sliced[slot]["grams"]
            need["material"] = sliced[slot]["material"] or need["material"]
            need["color"] = sliced[slot]["color"] or need["color"]
        elif sliced:
            continue  # The last slice did not use this filament.
        needs.append(need)
    if not needs and sliced:
        needs = list(sliced.values())
    return needs


class JusttPrintError(Exception):
    pass


def version_key(text):
    """(10, 20, 0) for "10.20.0"; None when it is not a version."""
    parts = str(text or "").strip().split("-")[0].split(".")
    try:
        return tuple(int(p) for p in parts) if parts and all(p.isdigit() for p in parts) else None
    except ValueError:
        return None


def is_newer(version, than):
    """Whether `version` is newer than `than` (False when either is not a version)."""
    a, b = version_key(version), version_key(than)
    return bool(a and b and a > b)


def version_notices(hello):
    """What the tab says about versions after connecting: a newer plugin on the server, or a server too old for this plugin."""
    notices = {}
    if is_newer(hello.get("pluginVersion"), PLUGIN_VERSION):
        notices["pluginUpdate"] = hello["pluginVersion"]
    if is_newer(MIN_SERVER_VERSION, hello.get("version")):
        notices["serverTooOld"] = MIN_SERVER_VERSION
    return notices


def downloads_folder():
    """Where a downloaded plugin goes: the Downloads folder, else the home folder."""
    home = os.path.expanduser("~")
    downloads = os.path.join(home, "Downloads")
    return downloads if os.path.isdir(downloads) else home


def plugin_save_path(folder, version):
    """justtprint.py in `folder`, replacing an older JusttPrint plugin there but no other file."""
    path = os.path.join(folder, "justtprint.py")
    try:
        with open(path, "rb") as f:
            ours = b"PLUGIN_VERSION = " in f.read(HEAD_BYTES)
    except OSError:
        return path
    return path if ours else os.path.join(folder, f"justtprint-{version}.py")


class Client:
    """JusttPrint's plugin routes (src/server/orca-plugin.js), signed in with an API key."""

    def __init__(self, server, api_key, verify_tls=True):
        self.server = normalize_server(server)
        self.api_key = str(api_key or "").strip()
        if not self.server:
            raise JusttPrintError("Enter your JusttPrint server address in Settings")
        if not self.api_key:
            raise JusttPrintError("Enter a JusttPrint API key in Settings (in JusttPrint: Settings, Authentication, API keys)")
        self.verify_tls = verify_tls

    def _connection(self, timeout):
        parts = urllib.parse.urlsplit(self.server)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if parts.scheme == "https":
            context = ssl.create_default_context()
            if not self.verify_tls:
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
            return http.client.HTTPSConnection(parts.hostname, port, timeout=timeout, context=context)
        return http.client.HTTPConnection(parts.hostname, port, timeout=timeout)

    def request(self, method, path, query=None, body=None, content_type=None, size=None, timeout=TIMEOUT):
        if query:
            path = path + "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
        headers = {
            "Authorization": "Bearer " + self.api_key,
            "Accept": "application/json",
            "User-Agent": f"JusttPrint-OrcaSlicer/{PLUGIN_VERSION}",
        }
        if body is not None and not hasattr(body, "read"):
            body = json.dumps(body).encode("utf-8")
            content_type = "application/json"
            size = len(body)
        if content_type:
            headers["Content-Type"] = content_type
        if size is not None:
            headers["Content-Length"] = str(size)
        conn = self._connection(timeout)
        try:
            conn.request(method, path, body=body, headers=headers)
            response = conn.getresponse()
            raw = response.read()
        except (OSError, http.client.HTTPException) as error:
            raise JusttPrintError(f"Could not reach JusttPrint at {self.server}: {error}") from error
        finally:
            conn.close()
        try:
            data = json.loads(raw.decode("utf-8") or "null")
        except ValueError:
            data = None
        if response.status == 401:
            raise JusttPrintError("JusttPrint did not accept the API key. Make a new one in JusttPrint and paste it in Settings.")
        if response.status == 404 and data is None:
            if path.startswith("/api/orca/hello"):
                raise JusttPrintError("This JusttPrint server has no plugin support yet. Update JusttPrint.")
            raise JusttPrintError(f"Your JusttPrint server is too old for this. Update JusttPrint to {MIN_SERVER_VERSION} or newer.")
        if response.status >= 400:
            message = data.get("error") if isinstance(data, dict) else None
            raise JusttPrintError(message or f"JusttPrint answered {response.status}")
        if not isinstance(data, dict):
            log(f"{method} {path.split('?')[0]}: HTTP {response.status}, {response.getheader('Content-Type')!r}, {len(raw)} bytes: {raw[:120]!r}")
            raise JusttPrintError(f"JusttPrint at {self.server} sent an answer the plugin cannot read (HTTP {response.status}). Try again; the Python log has the details.")
        return data

    def hello(self):
        return self.request("GET", "/api/orca/hello")

    def download_plugin(self):
        """The plugin file the server offers (bytes)."""
        conn = self._connection(TIMEOUT)
        try:
            conn.request("GET", "/api/orca/plugin.py", headers={"Authorization": "Bearer " + self.api_key, "User-Agent": f"JusttPrint-OrcaSlicer/{PLUGIN_VERSION}"})
            response = conn.getresponse()
            raw = response.read()
        except (OSError, http.client.HTTPException) as error:
            raise JusttPrintError(f"Could not reach JusttPrint at {self.server}: {error}") from error
        finally:
            conn.close()
        if response.status != 200 or b"PLUGIN_VERSION = " not in raw:
            raise JusttPrintError(f"Could not download the plugin from JusttPrint (HTTP {response.status})")
        return raw

    def models(self, query="", sort="newest", status="", offset=0, limit=30, favorite=False, tag="", category=None):
        """A page of the library: {"models": [...], "total": int, "offset": int}. favorite, tag and category narrow it."""
        query = {"q": query, "sort": sort, "status": status, "offset": int(offset or 0), "limit": int(limit or 30)}
        if favorite:
            query["favorite"] = 1
        if tag:
            query["tag"] = tag
        if category:
            query["category"] = int(category)
        return self.request("GET", "/api/orca/models", query)

    def filters(self):
        """What the Library can be filtered by: {"tags": [...], "categories": [...], "favorites": int}."""
        return self.request("GET", "/api/orca/filters")

    def edit_model(self, model_id, changes):
        """Change printStatus, rating, favorite or notes; answers the model's details."""
        return self.request("POST", f"/api/orca/models/{int(model_id)}/edit", body=changes)["model"]

    def log_print(self, model_id, outcome="printed", quantity=1, notes="", printer_id=None):
        body = {"outcome": outcome, "quantity": int(quantity or 1), "notes": notes, "printerId": printer_id}
        return self.request("POST", f"/api/orca/models/{int(model_id)}/log-print", body=body)["model"]

    def weigh_spool(self, spool_id, weight, with_spool=True):
        return self.request("POST", f"/api/orca/spools/{int(spool_id)}/weigh", body={"weight": weight, "withSpool": bool(with_spool)})["spool"]

    def drying(self, spool_id, action, temp=None, hours=None):
        return self.request("POST", f"/api/orca/spools/{int(spool_id)}/drying", body={"action": action, "temp": temp, "hours": hours})["spool"]

    def model(self, model_id):
        """One model with what the website's Model Details shows, its pictures and print history."""
        return self.request("GET", f"/api/orca/models/{int(model_id)}")["model"]

    def spool(self, spool_id):
        """One spool with what the website's spool window shows."""
        return self.request("GET", f"/api/orca/spools/{int(spool_id)}")["spool"]

    def printers(self):
        return self.request("GET", "/api/orca/printers")["printers"]

    def load_spool(self, slot_id=None, printer_id=None, spool_id=None):
        """Put a spool in an AMS slot or on a printer's holder (spool_id None empties it)."""
        return self.request("POST", "/api/orca/printers/load", body={"slotId": slot_id, "printerId": printer_id, "spoolId": spool_id})["printers"]

    def print_started(self, needs, model_id=None, printer_id=None, device_id=None, name=None):
        body = {"needs": needs, "modelId": model_id, "printerId": printer_id, "deviceId": device_id, "name": name}
        return self.request("POST", "/api/orca/print-started", body=body)

    def undo_print(self, last_print):
        if last_print.get("eventId"):
            return self.request("POST", "/api/orca/print-started/undo", body={"eventId": last_print["eventId"]})
        used = [{"spoolId": u["spoolId"], "grams": u["grams"]} for u in last_print.get("used", [])]
        return self.request("POST", "/api/orca/print-started/undo", body={"used": used})

    def search(self, query, limit=30):
        return self.models(query, limit=limit)["models"]

    def spools(self):
        return self.request("GET", "/api/orca/spools")["spools"]

    def open_links(self, model_id):
        return self.request("POST", f"/api/orca/models/{int(model_id)}/open", body={})

    def filament_check(self, needs):
        return self.request("POST", "/api/orca/filament-check", body={"needs": needs})

    def upload(self, route, file_path, query):
        size = os.path.getsize(file_path)
        with open(file_path, "rb") as f:
            return self.request("POST", route, query, body=f, content_type="application/octet-stream", size=size, timeout=UPLOAD_TIMEOUT)

    def send_sliced(self, file_path, model_id=None):
        return self.upload("/api/orca/sliced", file_path, {"name": os.path.basename(file_path), "modelId": model_id})

    def save_project(self, file_path):
        return self.upload("/api/orca/project", file_path, {"name": os.path.basename(file_path)})


def log(text):
    """A line in OrcaSlicer's Python log (log/python_*.log in OrcaSlicer's data folder)."""
    print(f"[JusttPrint] {text}", file=sys.stderr, flush=True)


def open_with_system(link):
    """Hand an orcaslicer:// link to the system, which gives it to OrcaSlicer."""
    if sys.platform.startswith("win"):
        os.startfile(link)  # noqa: S606 - the link is one JusttPrint made for this file
    elif sys.platform == "darwin":
        subprocess.run(["open", link], check=True)
    else:
        subprocess.run(["xdg-open", link], check=True)


# --- The page ---

PAGE = r"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
:root {
  --bg: var(--orca-bg, #1c1f23); --panel: rgba(255,255,255,.035); --panel-2: rgba(255,255,255,.06);
  --fg: var(--orca-fg, #e8e9ea); --muted: rgba(232,233,234,.62); --accent: var(--orca-accent, #009688);
  --border: var(--orca-border, rgba(255,255,255,.1)); --ok: #4caf50; --bad: #ef5350; --warn: #ffb300;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root { --bg: var(--orca-bg, #f6f7f8); --panel: #fff; --panel-2: rgba(0,0,0,.04); --fg: var(--orca-fg, #1f2328);
    --muted: rgba(31,35,40,.6); --border: var(--orca-border, rgba(0,0,0,.12)); color-scheme: light; }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; flex-direction: column; }
button, input, select { font: inherit; color: inherit; }
button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; white-space: nowrap; }
button:hover:not(:disabled) { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover:not(:disabled) { filter: brightness(1.1); }
button:disabled { opacity: .45; cursor: default; }
button.link { background: none; border: none; color: var(--accent); padding: 0; }
input[type=text], input[type=password], input[type=search], select {
  padding: 6px 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--panel); outline: none; }
input:focus, select:focus { border-color: var(--accent); }
.muted { color: var(--muted); }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }

/* Header and tabs */
header { display: flex; align-items: center; gap: 14px; padding: 0 16px; border-bottom: 1px solid var(--border); flex: none; }
.brand { font-weight: 700; font-size: 14px; letter-spacing: .2px; display: flex; align-items: center; gap: 7px; }
.brand i { width: 10px; height: 10px; border-radius: 3px; background: var(--accent); display: inline-block; }
nav { display: flex; gap: 2px; flex: 1; }
nav button { border: none; background: none; border-radius: 0; padding: 12px 12px 10px; border-bottom: 2px solid transparent; color: var(--muted); }
nav button:hover:not(:disabled) { color: var(--fg); }
nav button.on { color: var(--fg); border-bottom-color: var(--accent); }
nav .count { font-size: 11px; padding: 1px 6px; border-radius: 9px; background: var(--panel-2); margin-left: 4px; }
.pill { font-size: 12px; padding: 3px 9px; border-radius: 12px; background: var(--panel-2); display: flex; align-items: center; gap: 6px; cursor: pointer; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.pill.ok::before { background: var(--ok); } .pill.bad::before { background: var(--bad); }
.pill.ok, .pill.bad { color: var(--fg); }

main { flex: 1; overflow: auto; padding: 14px 16px 60px; }
.view { display: none; } .view.on { display: block; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; position: sticky; top: -14px; padding: 10px 0; margin-top: -10px; background: var(--bg); z-index: 2; }
.toolbar .search { flex: 1; min-width: 180px; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; }
.chip { padding: 4px 10px; border-radius: 14px; font-size: 12px; }
.chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.summary { color: var(--muted); margin: 0 0 10px; font-size: 12px; }

/* Model cards */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.card { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; background: var(--panel); transition: border-color .12s, transform .12s; }
.card:hover { border-color: var(--accent); }
.pic { aspect-ratio: 1; background: var(--panel-2) center / cover no-repeat; position: relative; display: flex; align-items: center; justify-content: center; }
.pic .none { font-size: 11px; font-weight: 700; letter-spacing: 1px; color: var(--muted); }
.pic .open { position: absolute; inset: auto 8px 8px 8px; opacity: 0; transition: opacity .12s; }
.card:hover .pic .open, .pic .open:focus { opacity: 1; }
.badge { position: absolute; top: 6px; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 9px; background: rgba(0,0,0,.6); color: #fff; text-transform: uppercase; letter-spacing: .4px; }
.badge.type { left: 6px; } .badge.status { right: 6px; }
.badge.printed { background: rgba(46,125,50,.9); } .badge.queued, .badge.printing { background: rgba(0,121,107,.9); }
.card .body { padding: 7px 9px 9px; }
.card .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card.opened { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }

/* Spools */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 14px; }
.stat { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--panel); }
.stat b { display: block; font-size: 20px; font-weight: 650; }
.stat span { font-size: 12px; color: var(--muted); }
.spools { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.spool { border: 1px solid var(--border); border-radius: 10px; padding: 10px; display: flex; gap: 11px; background: var(--panel); align-items: center; }
.spool.match { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.disc { width: 44px; height: 44px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px var(--panel-2), 0 0 0 3px var(--border); position: relative; }
.disc::after { content: ""; position: absolute; inset: 15px; border-radius: 50%; background: var(--bg); border: 1px solid var(--border); }
.spool .info { flex: 1; min-width: 0; }
.spool .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spool .sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; margin: 6px 0 3px; }
.bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.bar.low i { background: var(--warn); } .bar.out i { background: var(--bad); }
.grams { font-size: 12px; display: flex; justify-content: space-between; gap: 6px; }
.grams > span:last-child { text-align: right; }
.tag { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 8px; background: var(--panel-2); color: var(--muted); text-transform: uppercase; letter-spacing: .3px; margin-left: 4px; }
.tag.loaded { background: rgba(0,150,136,.2); color: var(--accent); } .tag.low { background: rgba(255,179,0,.18); color: var(--warn); }

/* This print */
.panel { border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 12px; background: var(--panel); }
.panel h3 { margin: 0 0 4px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.panel .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.status-line { padding: 8px 10px; border-radius: 7px; background: var(--panel-2); margin-top: 10px; }
.status-line.ok { background: rgba(76,175,80,.14); } .status-line.bad { background: rgba(239,83,80,.14); } .status-line.warn { background: rgba(255,179,0,.14); }
.needs { display: grid; gap: 6px; margin-top: 10px; }
.need { display: grid; grid-template-columns: 28px 1fr 70px 1.3fr 110px; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
.need .slot { width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 0 2px #000; }
.need .result { text-align: right; font-weight: 600; }
.file { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px dashed var(--border); border-radius: 8px; margin-top: 10px; }
.file .icon { width: 30px; height: 30px; border-radius: 6px; background: var(--panel-2); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--muted); flex: none; }
.file .what { flex: 1; min-width: 0; } .file .what div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Printers */
.printer { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); margin-bottom: 12px; overflow: hidden; }
.printer.here { border-color: var(--accent); }
.printer header { border: none; padding: 10px 14px; gap: 10px; background: var(--panel-2); flex-wrap: wrap; }
.printer header b { font-size: 14px; }
.printer .units { padding: 12px 14px; display: grid; gap: 12px; }
.unit-name { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
.slot { display: flex; gap: 9px; align-items: center; text-align: left; padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); min-width: 0; }
.slot .disc { width: 32px; height: 32px; }
.slot .disc::after { inset: 11px; }
.slot .label { font-size: 11px; font-weight: 700; color: var(--muted); }
.slot .txt { min-width: 0; flex: 1; }
.slot .txt div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot.free .txt { color: var(--muted); }
.slot .txt div.hint { font-size: 11px; color: var(--warn); white-space: normal; }
.pick-printer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }

/* Spool picker */
#picker { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: center; justify-content: center; z-index: 20; padding: 20px; }
#picker.on { display: flex; }
#picker .box { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; width: min(560px, 100%); max-height: 100%; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
#picker .head { padding: 14px; border-bottom: 1px solid var(--border); display: grid; gap: 10px; }
#picker .list { overflow: auto; padding: 8px; display: grid; gap: 6px; }
#picker .foot { padding: 10px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: space-between; }
.choice { display: flex; gap: 10px; align-items: center; text-align: left; padding: 8px 10px; border-radius: 8px; width: 100%; }
.choice .disc { width: 30px; height: 30px; } .choice .disc::after { inset: 10px; }
.choice .txt { flex: 1; min-width: 0; } .choice .txt div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.choice.current { border-color: var(--accent); }

/* Details window (a model or a spool) */
#details { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: none; align-items: center; justify-content: center; z-index: 15; padding: 20px; }
#details.on { display: flex; }
#details .box { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; width: min(760px, 100%); max-height: 100%; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
#details .head { padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; gap: 10px; align-items: center; }
#details .head b { flex: 1; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#details .content { overflow: auto; padding: 14px; }
.detail { display: grid; grid-template-columns: minmax(180px, 280px) 1fr; gap: 16px; }
@media (max-width: 560px) { .detail { grid-template-columns: 1fr; } }
.detail .side { display: grid; gap: 10px; align-content: start; }
.detail .hero { aspect-ratio: 1; border-radius: 10px; border: 1px solid var(--border); background: var(--panel-2) center / contain no-repeat; display: flex; align-items: center; justify-content: center; color: var(--muted); font-weight: 700; letter-spacing: 1px; }
.thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
.thumbs button { width: 44px; height: 44px; padding: 0; border-radius: 6px; background: var(--panel-2) center / cover no-repeat; }
.thumbs button.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.detail .actions { display: flex; gap: 6px; flex-wrap: wrap; }
.props { display: grid; grid-template-columns: max-content 1fr; gap: 5px 14px; align-items: baseline; }
.props > span:nth-child(odd) { color: var(--muted); font-size: 12px; }
.props > span:nth-child(even) { overflow-wrap: anywhere; }
.props .stars { color: var(--warn); letter-spacing: 1px; }
.detail h4 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
.detail .text { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--panel-2); }
.log { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.log li { display: grid; grid-template-columns: 100px 1fr; gap: 10px; padding: 6px 8px; border-radius: 6px; background: var(--panel-2); font-size: 12px; }
.log li .muted { grid-column: 2; }
.dots { display: inline-flex; gap: 4px; vertical-align: -2px; margin-right: 6px; }
.dots i { width: 13px; height: 13px; border-radius: 50%; border: 1px solid var(--border); display: inline-block; }
.big-disc { width: 84px; height: 84px; } .big-disc::after { inset: 28px; }
.spool-head { display: flex; gap: 14px; align-items: center; }
.spool-head .left { font-size: 22px; font-weight: 650; }
.detail .photo { width: 100%; border-radius: 10px; border: 1px solid var(--border); }
.card, .spool { cursor: pointer; }
.card:focus-visible, .spool:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.shots { grid-column: 2; display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.shot { width: 56px; height: 56px; padding: 0; border-radius: 6px; background: var(--panel-2) center / cover no-repeat; }
#lightbox { position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,.85); display: none; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 20px; cursor: zoom-out; }
#lightbox.on { display: flex; }
#lightbox img { max-width: 100%; max-height: calc(100% - 40px); border-radius: 8px; }
#lightbox div { color: #fff; }
.project { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: -4px 0 10px; font-size: 12px; }
.project .pneed { display: inline-flex; gap: 5px; align-items: center; padding: 3px 8px; border-radius: 12px; background: var(--panel-2); }
.tag.like { background: rgba(0,150,136,.2); color: var(--accent); }
.edit { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
.edit .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.edit input[type=number] { width: 80px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--panel); }
.edit input[type=text], .edit select { flex: 1; min-width: 120px; }
.detail textarea { width: 100%; min-height: 80px; resize: vertical; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); font: inherit; color: inherit; }
.rate { display: inline-flex; }
.rate button { border: none; background: none; padding: 0 2px; font-size: 17px; line-height: 1; color: var(--muted); }
.rate button.on { color: var(--warn); }
button.fav.on { color: #e5484d; border-color: #e5484d; }
.props select { padding: 3px 6px; }

/* Version notice, under the tabs */
#notice { flex: none; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 16px; border-bottom: 1px solid var(--border); background: rgba(0,150,136,.12); }
#notice[hidden] { display: none; }
#notice.caution { background: rgba(255,179,0,.14); }
#notice .what { flex: 1; min-width: 200px; }
#notice code { font: 12px ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }

/* Settings */
.form { max-width: 560px; }
.form label.field { display: block; margin: 12px 0 4px; font-weight: 600; }
.form .hint { font-size: 12px; color: var(--muted); margin-top: 3px; }
.form input[type=text], .form input[type=password] { width: 100%; }
.check { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; }
.check input { margin-top: 3px; }

.empty { text-align: center; padding: 40px 20px; color: var(--muted); }
.empty b { display: block; color: var(--fg); font-size: 14px; margin-bottom: 4px; }
.empty button { margin-top: 12px; }
.spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: spin .8s linear infinite; display: inline-block; vertical-align: -3px; }
@keyframes spin { to { transform: rotate(360deg); } }
#toast { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); padding: 9px 16px; border-radius: 8px; background: #2d3238; color: #fff; display: none; max-width: 90%; box-shadow: 0 4px 16px rgba(0,0,0,.35); z-index: 10; }
#toast.error { background: #c62828; }
</style></head><body>

<header>
  <div class="brand"><i></i>JusttPrint</div>
  <nav id="tabs">
    <button data-tab="library" class="on">Library<span class="count" id="n-models" hidden></span></button>
    <button data-tab="filament">Filament<span class="count" id="n-spools" hidden></span></button>
    <button data-tab="printers">Printers<span class="count" id="n-printers" hidden></span></button>
    <button data-tab="print">This print<span class="count" id="n-print" hidden></span></button>
    <button data-tab="settings">Settings</button>
  </nav>
  <span id="conn" class="pill" title="Settings">Not connected</span>
</header>

<div id="notice" hidden></div>

<main>
  <section class="view on" id="view-library">
    <div class="toolbar">
      <input id="q" class="search" type="search" placeholder="Search models by name, title or designer">
      <div class="chips" id="status-chips">
        <button class="chip on" data-status="">All</button>
        <button class="chip" data-status="unprinted">Not printed</button>
        <button class="chip" data-status="queued">Queued</button>
        <button class="chip" data-status="printed">Printed</button>
      </div>
      <button class="chip" id="fav" title="Only your favorites">♥ Favorites</button>
      <select id="tag" title="Tag" hidden></select>
      <select id="category" title="Category" hidden></select>
      <select id="sort" title="Sort">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name A–Z</option>
      </select>
    </div>
    <p class="summary" id="lib-summary"></p>
    <div class="grid" id="grid"></div>
    <div id="lib-more" class="summary" style="text-align:center;margin-top:12px"></div>
    <div id="lib-empty"></div>
  </section>

  <section class="view" id="view-filament">
    <div class="stats" id="stats"></div>
    <div class="toolbar">
      <input id="sq" class="search" type="search" placeholder="Search spools by name, brand or material">
      <button class="chip" id="project-chip" title="Only spools of the open project's materials, closest color first">This project</button>
      <div class="chips" id="material-chips"></div>
      <select id="ssort" title="Sort">
        <option value="material">Material</option>
        <option value="color">Color</option>
        <option value="most">Most left</option>
        <option value="least">Least left</option>
      </select>
      <button id="srefresh" title="Load the spools again">Refresh</button>
    </div>
    <p class="summary" id="spool-summary"></p>
    <div class="project" id="project-needs" hidden></div>
    <div class="spools" id="spools"></div>
    <div id="spool-empty"></div>
  </section>

  <section class="view" id="view-printers">
    <div class="pick-printer">
      <span>When OrcaSlicer does not say, this OrcaSlicer prints on</span>
      <select id="my-printer"><option value="">No printer</option></select>
      <span class="muted" id="printer-note"></span>
      <span style="flex:1"></span>
      <button id="prefresh">Refresh</button>
    </div>
    <div id="printers"></div>
    <div id="printers-empty"></div>
  </section>

  <section class="view" id="view-print">
    <div class="panel">
      <h3>Filament used</h3>
      <div class="muted" id="used-help">When OrcaSlicer sends a print to a printer, the slice's grams come off the spools it uses.</div>
      <div id="used-info"></div>
      <div class="row"><button id="take-off" disabled>Take this slice off my spools</button><button id="undo" hidden>Undo</button></div>
    </div>
    <div class="panel">
      <h3>Filament check</h3>
      <div class="muted" id="slice-info">Checks the project's filaments against your spools. Slice to check the grams too.</div>
      <div class="row"><button class="primary" id="check">Check my spools</button><span id="check-busy" hidden><span class="spinner"></span></span></div>
      <div id="check-result"></div>
    </div>
    <div class="panel">
      <h3>Sliced file</h3>
      <div class="muted">After Export plate sliced file, send it to JusttPrint: it is filed beside its model and queued.</div>
      <div id="export-info"></div>
      <div class="row"><button class="primary" id="send" disabled>Send to JusttPrint</button></div>
    </div>
    <div class="panel">
      <h3>Project</h3>
      <div class="muted">Save this OrcaSlicer project into JusttPrint's Upload folder, where it becomes a new model.</div>
      <div id="project-info"></div>
      <div class="row"><button id="project" disabled>Save project to JusttPrint</button></div>
    </div>
  </section>

  <section class="view" id="view-settings">
    <div class="form">
      <label class="field" for="server">JusttPrint address</label>
      <input id="server" type="text" placeholder="http://nas.local:5000">
      <label class="field" for="key">API key</label>
      <input id="key" type="password" placeholder="jpk_…">
      <div class="hint">In JusttPrint: Settings, Authentication, API keys. Make an Editor key to send files back.</div>
      <label class="field" for="folder">Folder you export sliced files to</label>
      <input id="folder" type="text" placeholder="/Users/you/Downloads">
      <div class="hint">The tab watches it for new .gcode.3mf files.</div>
      <label class="check"><input id="auto" type="checkbox"><span>Send every exported sliced file to JusttPrint</span></label>
      <label class="check"><input id="takeoff" type="checkbox"><span>Take the filament off my spools when OrcaSlicer sends a print<br><span class="muted">The grams of the last slice, from the spools the filament check picks (loaded in that printer first). A Bambu Lab printer JusttPrint follows live logs its prints by itself.</span></span></label>
      <label class="check"><input id="tls" type="checkbox"><span>Check the server's HTTPS certificate<br><span class="muted">Turn off only for a self-signed certificate.</span></span></label>
      <div class="row" style="margin-top:16px"><button class="primary" id="save">Save and connect</button></div>
      <div id="conn-detail" class="status-line" hidden></div>
    </div>
  </section>
</main>

<div id="picker"><div class="box">
  <div class="head"><b id="picker-title">Load a spool</b><input id="picker-q" type="search" placeholder="Search spools"></div>
  <div class="list" id="picker-list"></div>
  <div class="foot"><button id="picker-empty">Empty this slot</button><button id="picker-cancel">Cancel</button></div>
</div></div>

<div id="details"><div class="box" role="dialog" aria-modal="true" aria-labelledby="details-title">
  <div class="head"><b id="details-title"></b><button id="details-close" title="Close (Esc)">Close</button></div>
  <div class="content" id="details-body"></div>
</div></div>

<div id="lightbox" title="Click or press Esc to close"><img id="lightbox-img" alt=""><div id="lightbox-caption"></div></div>

<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const send = (msg) => orca.postMessage(msg);
// The server sends up to 60 at a time; the next page is asked for when the end of the list comes near.
const PAGE_SIZE = 60;
const ui = { tab: 'library', q: '', status: '', sort: 'newest', models: [], total: 0, loading: false, seq: 0, viewRestored: false, project: false, projectNeeds: null, favorite: false, tag: '', category: 0, filters: null,
  spools: null, sq: '', material: '', ssort: 'material', state: null, printers: null, picking: null, matched: new Set(), lastSliceKey: null, opening: null };

let toastTimer = null;
function toast(text, level) {
  const el = $('toast');
  el.textContent = text; el.className = level === 'error' ? 'error' : ''; el.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
  if (ui.opening) { ui.opening = null; renderModels(); }
}
function esc(text) { return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function base(path) { const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return i >= 0 ? path.slice(i + 1) : path; }
function grams(g) { return g >= 1000 ? (g / 1000).toFixed(g >= 10000 ? 0 : 1) + ' kg' : Math.round(g) + ' g'; }
function connected() { const c = ui.state && ui.state.connection; return !!(c && c.ok); }
function count(id, n) { const el = $(id); el.hidden = n == null; el.textContent = n == null ? '' : n; }
function emptyBox(title, text, action) {
  return `<div class="empty"><b>${esc(title)}</b>${esc(text)}${action ? `<br><button data-go="${action[0]}">${esc(action[1])}</button>` : ''}</div>`;
}
function paint(colors) {
  if (!colors || !colors.length) return 'repeating-linear-gradient(45deg, rgba(127,127,127,.25) 0 4px, transparent 4px 8px)';
  if (colors.length === 1) return colors[0];
  const step = 360 / colors.length;
  return `conic-gradient(${colors.map((c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`).join(', ')})`;
}
function hue(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 999;
  const n = parseInt(m[1], 16); const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return 400 + (1 - max) * 100; // grays last, light to dark
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// --- Tabs ---
function markTab(tab) {
  ui.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + tab));
}
function showTab(tab) {
  markTab(tab);
  saveView();
  if (tab === 'filament' && ui.project) send({ type: 'project-filaments' });
  if (tab === 'filament' && ui.spools === null && connected()) loadSpools();
  if (tab === 'library' && !ui.models.length && connected()) loadModels(false);
  if (tab === 'library') maybeMore();
  if (tab === 'printers' && connected()) { send({ type: 'printers' }); if (ui.spools === null) loadSpools(); }
}
$('tabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); };
$('conn').onclick = () => showTab('settings');
document.body.addEventListener('click', (e) => { const b = e.target.closest('button[data-go]'); if (b) showTab(b.dataset.go); });

// --- The view is remembered with the plugin's settings: tab, searches, filters, sorts ---
let viewTimer = null;
function saveView() {
  if (!ui.viewRestored) return;
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => send({ type: 'save-view', view: { tab: ui.tab, q: ui.q, status: ui.status, sort: ui.sort, favorite: ui.favorite, tag: ui.tag,
    category: ui.category, sq: ui.sq, material: ui.material, ssort: ui.ssort, project: ui.project } }), 600);
}
function restoreView(v) {
  ui.q = v.q || ''; ui.status = v.status || ''; ui.sort = v.sort || 'newest'; ui.favorite = !!v.favorite; ui.tag = v.tag || ''; ui.category = v.category || 0;
  ui.sq = v.sq || ''; ui.material = v.material || ''; ui.ssort = v.ssort || 'material'; ui.project = !!v.project;
  $('q').value = ui.q; $('sort').value = ui.sort; $('sq').value = ui.sq; $('ssort').value = ui.ssort;
  document.querySelectorAll('#status-chips .chip').forEach((c) => c.classList.toggle('on', c.dataset.status === ui.status));
  $('project-chip').classList.toggle('on', ui.project);
  renderFilters();
  if (v.tab && v.tab !== 'settings') markTab(v.tab);
  ui.viewRestored = true;
}

// --- Library ---
function loadModels(append) {
  if (!connected()) return renderModels();
  if (!append) { ui.seq += 1; saveView(); } // a new search or filter: answers to the old one are dropped
  ui.loading = true; renderModels();
  send({ type: 'models', q: ui.q, status: ui.status, sort: ui.sort, favorite: ui.favorite, tag: ui.tag, category: ui.category,
    offset: append ? ui.models.length : 0, limit: PAGE_SIZE, seq: ui.seq });
}
// The next page when the end of the list is within a screen of view (on scroll, and after each page).
function maybeMore() {
  if (ui.tab !== 'library' || ui.loading || !connected() || ui.models.length >= ui.total) return;
  const main = document.querySelector('main');
  if ($('lib-more').getBoundingClientRect().top < main.getBoundingClientRect().bottom + main.clientHeight) loadModels(true);
}
document.querySelector('main').addEventListener('scroll', maybeMore, { passive: true });
window.addEventListener('resize', maybeMore);
function renderFilters() {
  const f = ui.filters;
  $('fav').classList.toggle('on', ui.favorite);
  $('fav').hidden = !f || (!f.favorites && !ui.favorite);
  const tags = f ? f.tags : [];
  if (ui.tag && !tags.some((t) => t.name === ui.tag)) tags.unshift({ name: ui.tag, count: 0 });
  $('tag').hidden = !tags.length;
  $('tag').innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${esc(t.name)}"${t.name === ui.tag ? ' selected' : ''}>${esc(t.name)} (${t.count})</option>`).join('');
  const cats = f ? f.categories : [];
  $('category').hidden = !cats.length;
  $('category').innerHTML = '<option value="0">All categories</option>' + cats.map((c) => `<option value="${c.id}"${c.id === ui.category ? ' selected' : ''}>${esc(c.name)} (${c.count})</option>`
    + c.subcategories.map((x) => `<option value="${x.id}"${x.id === ui.category ? ' selected' : ''}>&nbsp;&nbsp;&nbsp;${esc(x.name)} (${x.count})</option>`).join('')).join('');
}
$('fav').onclick = () => { ui.favorite = !ui.favorite; renderFilters(); loadModels(false); };
$('tag').onchange = () => { ui.tag = $('tag').value; loadModels(false); };
$('category').onchange = () => { ui.category = Number($('category').value) || 0; loadModels(false); };
function renderModels() {
  const grid = $('grid'), opened = ui.state && ui.state.opened_model;
  if (!connected()) {
    grid.innerHTML = ''; $('lib-summary').textContent = ''; $('lib-more').textContent = '';
    $('lib-empty').innerHTML = emptyBox('Connect to JusttPrint', 'Enter your server address and an API key to see your library here.', ['settings', 'Open Settings']);
    return;
  }
  const focused = focusedId(grid, '.card');
  grid.innerHTML = ui.models.map((m) => {
    const status = m.printStatus && m.printStatus !== 'unprinted' ? `<span class="badge status ${esc(m.printStatus)}">${esc(m.printStatus)}</span>` : '';
    const opening = ui.opening === m.id;
    return `<div class="card${opened && opened.id === m.id ? ' opened' : ''}" data-id="${m.id}" tabindex="0" title="Click or Enter for details; double-click or Shift+Enter to open on the plate">
      <div class="pic" style="${m.thumbnail ? `background-image:url('${m.thumbnail}')` : ''}">
        ${m.thumbnail ? '' : `<span class="none">${esc(m.fileType.toUpperCase())}</span>`}
        <span class="badge type">${esc(m.fileType)}</span>${status}
        <button class="primary open" data-open="${m.id}"${opening ? ' disabled' : ''}>${opening ? 'Opening…' : 'Open on plate'}</button>
      </div>
      <div class="body">
        <div class="name">${esc(m.name)}</div>
        <div class="sub">${esc(m.designer || m.fileName)}${m.printCount ? ` · printed ${m.printCount}×` : ''}</div>
      </div>
    </div>`;
  }).join('');
  $('lib-summary').innerHTML = ui.loading && !ui.models.length ? '<span class="spinner"></span> Loading your library…'
    : ui.total ? `${ui.total} model${ui.total === 1 ? '' : 's'}${ui.q ? ` matching “${esc(ui.q)}”` : ''}` : '';
  refocus(grid, '.card', focused);
  $('lib-more').innerHTML = ui.models.length && ui.models.length < ui.total
    ? (ui.loading ? '<span class="spinner"></span> Loading more…' : `${ui.models.length} of ${ui.total} shown · scroll for more`) : '';
  $('lib-empty').innerHTML = !ui.loading && !ui.models.length
    ? emptyBox('No models found', ui.q || ui.status || ui.favorite || ui.tag || ui.category ? 'Try another search or filter.' : 'Models OrcaSlicer can open (STL, 3MF, OBJ, STEP…) show here.') : '';
  count('n-models', ui.total || null);
}
function openModel(id) {
  const m = ui.models.find((x) => x.id === id); if (!m || ui.opening) return;
  ui.opening = id; renderModels();
  send({ type: 'open', id, name: m.name });
}
let searchTimer = null;
$('q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { ui.q = $('q').value.trim(); loadModels(false); }, 300); };
$('q').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); ui.q = $('q').value.trim(); loadModels(false); } };
$('status-chips').onclick = (e) => {
  const b = e.target.closest('button[data-status]'); if (!b) return;
  ui.status = b.dataset.status; document.querySelectorAll('#status-chips .chip').forEach((c) => c.classList.toggle('on', c === b)); loadModels(false);
};
$('sort').onchange = () => { ui.sort = $('sort').value; loadModels(false); };
// A click shows the model's details; a double-click (or Open on plate) puts it on the plate.
let clickTimer = null;
$('grid').onclick = (e) => {
  const b = e.target.closest('button[data-open]'); if (b) return openModel(Number(b.dataset.open));
  const c = e.target.closest('.card'); if (!c) return;
  clearTimeout(clickTimer); clickTimer = setTimeout(() => showDetails('model', Number(c.dataset.id)), 250);
};
// Keys: arrows move between cards, Enter opens the details, Shift+Enter puts the model on the plate.
function focusedId(container, selector) { const el = document.activeElement; return el && el.matches && el.matches(selector) && container.contains(el) ? el.dataset.id : null; }
function refocus(container, selector, id) { if (id == null) return; const el = container.querySelector(`${selector}[data-id="${id}"]`); if (el) el.focus({ preventScroll: true }); }
function moveFocus(container, selector, e) {
  const items = [...container.querySelectorAll(selector)], i = items.indexOf(document.activeElement);
  if (i < 0) return false;
  const top = items[0].offsetTop; let cols = items.findIndex((el) => el.offsetTop !== top); if (cols < 1) cols = items.length;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: items.length - 1 - i }[e.key];
  if (step === undefined) return false;
  e.preventDefault();
  const next = items[Math.max(0, Math.min(items.length - 1, i + step))];
  next.focus(); next.scrollIntoView({ block: 'nearest' });
  return true;
}
$('grid').onkeydown = (e) => {
  if (moveFocus($('grid'), '.card', e)) return maybeMore();
  const c = e.target.classList && e.target.classList.contains('card') ? e.target : null;
  if (c && e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) openModel(Number(c.dataset.id)); else showDetails('model', Number(c.dataset.id)); }
};
$('grid').ondblclick = (e) => { const c = e.target.closest('.card'); if (c) { clearTimeout(clickTimer); openModel(Number(c.dataset.id)); } };

// --- Filament ---
function loadSpools() { if (!connected()) return renderSpools(); send({ type: 'spools' }); $('spool-summary').innerHTML = '<span class="spinner"></span> Loading your spools…'; }
function isLow(s) { return s.remaining <= 0 ? 'out' : (s.remaining < 150 || (s.initial && s.remaining / s.initial < 0.15)) ? 'low' : ''; }
function renderSpools() {
  if (!connected()) {
    $('stats').innerHTML = ''; $('spools').innerHTML = ''; $('material-chips').innerHTML = ''; $('spool-summary').textContent = '';
    $('spool-empty').innerHTML = emptyBox('Connect to JusttPrint', 'Your spools show here once the tab is connected.', ['settings', 'Open Settings']);
    return;
  }
  const all = ui.spools || [];
  count('n-spools', ui.spools ? all.length : null);
  const total = all.reduce((t, s) => t + s.remaining, 0);
  const low = all.filter((s) => isLow(s)).length, loaded = all.filter((s) => s.loaded).length;
  $('stats').innerHTML = [[all.length, 'spools'], [grams(total), 'filament on hand'], [loaded, 'loaded in printers'], [low, 'low or empty']]
    .map(([v, l], i) => `<div class="stat"><b class="${i === 3 && low ? 'warn' : ''}">${v}</b><span>${l}</span></div>`).join('');
  const materials = [...new Set(all.map((s) => s.material || 'Other'))].sort();
  if (ui.material && !materials.includes(ui.material)) ui.material = '';
  $('material-chips').innerHTML = materials.length > 1 ? ['', ...materials].map((m) => `<button class="chip${ui.material === m ? ' on' : ''}" data-material="${esc(m)}">${esc(m || 'All')}</button>`).join('') : '';
  const words = ui.sq.toLowerCase().split(/\s+/).filter(Boolean);
  const needs = ui.project ? ui.projectNeeds : null;
  $('project-needs').hidden = !ui.project;
  $('project-needs').innerHTML = !ui.project ? '' : needs === null ? '<span class="spinner"></span> Reading the project…'
    : needs.length ? '<span class="muted">This project:</span>' + needs.map((n) => `<span class="pneed">${dots(n.color ? [n.color] : [])}${n.slot}: ${esc(n.material || '?')}${n.grams ? ` · ${grams(n.grams)}` : ''}</span>`).join('')
    : '<span class="muted">This project has no filaments yet: choose them in OrcaSlicer, then Refresh.</span>';
  const shown = all.filter((s) => (!ui.project || (needs && nearestNeed(s))) && (!ui.material || (s.material || 'Other') === ui.material)
    && words.every((w) => [s.name, s.brand, s.material, s.materialType, s.where].join(' ').toLowerCase().includes(w)));
  const by = { material: (a, b) => (a.material || '~').localeCompare(b.material || '~') || hue(a.colors[0]) - hue(b.colors[0]),
    color: (a, b) => hue(a.colors[0]) - hue(b.colors[0]), most: (a, b) => b.remaining - a.remaining, least: (a, b) => a.remaining - b.remaining };
  shown.sort(ui.project && needs ? (a, b) => nearestNeed(a).d - nearestNeed(b).d || b.remaining - a.remaining : by[ui.ssort] || by.material);
  saveView();
  const focused = focusedId($('spools'), '.spool');
  $('spools').innerHTML = shown.map((s) => {
    const level = isLow(s), pct = s.initial ? Math.max(0, Math.min(100, (s.remaining / s.initial) * 100)) : 0;
    const held = s.remaining - s.available;
    const like = ui.project ? nearestNeed(s) : null;
    return `<div class="spool${ui.matched.has(s.id) ? ' match' : ''}" data-id="${s.id}" tabindex="0" title="Click or Enter for details">
      <div class="disc" style="background:${paint(s.colors)}"></div>
      <div class="info">
        <div class="name">${esc(s.name)}${like && like.close ? `<span class="tag like" title="Close to the color of filament ${like.need.slot} in this project">Filament ${like.need.slot}</span>` : ''}${s.loaded ? '<span class="tag loaded">Loaded</span>' : ''}${level ? `<span class="tag low">${level === 'out' ? 'empty' : 'low'}</span>` : ''}</div>
        <div class="sub">${esc([s.brand, s.material, s.materialType].filter(Boolean).join(' · ') || 'No details')}</div>
        <div class="bar ${level}"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="grams"><span><b>${grams(s.remaining)}</b> <span class="muted">of ${grams(s.initial)}</span></span>
          <span class="muted">${held > 0 ? `${grams(held)} held for the queue` : esc(s.where || (s.status === 'storage' ? 'In storage' : ''))}</span></div>
      </div>
    </div>`;
  }).join('');
  refocus($('spools'), '.spool', focused);
  $('spool-summary').textContent = ui.spools ? (shown.length === all.length ? `${all.length} spool${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} spools`) + (ui.matched.size ? ' · highlighted: picked for this print' : '') : '';
  $('spool-empty').innerHTML = ui.spools && !all.length ? emptyBox('No spools yet', 'Add your spools in JusttPrint (Filament) to see them here and check prints against them.')
    : ui.spools && !shown.length && !(ui.project && needs === null) ? emptyBox('No spools match', ui.project ? 'None of your spools is a material this project uses.' : 'Try another search or material.') : '';
}
let spoolTimer = null;
$('sq').oninput = () => { clearTimeout(spoolTimer); spoolTimer = setTimeout(() => { ui.sq = $('sq').value.trim(); renderSpools(); }, 150); };
$('material-chips').onclick = (e) => { const b = e.target.closest('button[data-material]'); if (b) { ui.material = b.dataset.material; renderSpools(); } };
$('ssort').onchange = () => { ui.ssort = $('ssort').value; renderSpools(); };
$('srefresh').onclick = () => { loadSpools(); if (ui.project) send({ type: 'project-filaments' }); };
$('spools').onkeydown = (e) => {
  if (moveFocus($('spools'), '.spool', e)) return;
  const c = e.target.classList && e.target.classList.contains('spool') ? e.target : null;
  if (c && e.key === 'Enter') { e.preventDefault(); showDetails('spool', Number(c.dataset.id)); }
};
// "/" jumps to the search of the Library or Filament view.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select') || document.querySelector('#details.on, #picker.on, #lightbox.on')) return;
  const box = ui.tab === 'library' ? $('q') : ui.tab === 'filament' ? $('sq') : null;
  if (box) { e.preventDefault(); box.focus(); box.select(); }
});

// --- This project: spools of the open project's materials, closest color first ---
const norm = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function rgb(hex) { const m = /^#?([0-9a-f]{6})/i.exec(hex || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function colorDistance(a, b) { const x = rgb(a), y = rgb(b); return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 999; }
/** The project's filament this spool is the material of, with how close its color is (close: under 60 of 441). */
function nearestNeed(s) {
  let best = null;
  for (const need of ui.projectNeeds || []) {
    if (!need.material || norm(need.material) !== norm(s.material)) continue;
    const d = Math.min(...(s.colors.length ? s.colors : [null]).map((c) => colorDistance(c, need.color)));
    if (!best || d < best.d) best = { need, d };
  }
  return best && { ...best, close: best.d < 60 };
}
$('project-chip').onclick = () => {
  ui.project = !ui.project; $('project-chip').classList.toggle('on', ui.project);
  if (ui.project) send({ type: 'project-filaments' });
  renderSpools();
};
$('spools').onclick = (e) => { const c = e.target.closest('.spool[data-id]'); if (c) showDetails('spool', Number(c.dataset.id)); };

// --- Version notice: a newer plugin on the server, or a server too old for this plugin ---
function renderNotice() {
  const c = ui.state && ui.state.connection, el = $('notice');
  const hidden = ui.noticeHidden === (c && (c.pluginUpdate || c.serverTooOld));
  if (!c || !c.ok || hidden || !(c.pluginUpdate || c.serverTooOld)) { el.hidden = true; return; }
  el.hidden = false;
  if (c.pluginUpdate && ui.downloaded) {
    el.className = '';
    el.innerHTML = `<div class="what"><b>Plugin ${esc(c.pluginUpdate)} saved</b> to <code>${esc(ui.downloaded)}</code>. Install it as before: in OrcaSlicer, Plugins, Browse plugins, Install local plugin, and choose this file.</div><button data-notice="hide">OK</button>`;
  } else if (c.pluginUpdate) {
    el.className = '';
    el.innerHTML = `<div class="what"><b>A newer JusttPrint plugin is available:</b> ${esc(c.pluginUpdate)} (you have ${esc(c.pluginVersion)}).</div><button class="primary" data-notice="download">Download</button><button data-notice="hide">Later</button>`;
  } else {
    el.className = 'caution';
    el.innerHTML = `<div class="what"><b>Update JusttPrint on your server</b> to ${esc(c.serverTooOld)} or newer (it runs ${esc(c.version)}). Until then, some parts of this tab (filters, details, changes) do not work.</div><button data-notice="hide">OK</button>`;
  }
}
$('notice').onclick = (e) => {
  const b = e.target.closest('button[data-notice]'); if (!b) return;
  const c = ui.state.connection;
  if (b.dataset.notice === 'download') { b.disabled = true; b.textContent = 'Downloading…'; send({ type: 'download-plugin' }); }
  else { ui.noticeHidden = c.pluginUpdate || c.serverTooOld; renderNotice(); }
};

// --- A print photo, large ---
function closeLightbox() { $('lightbox').classList.remove('on'); $('lightbox-img').removeAttribute('src'); }
$('lightbox').onclick = closeLightbox;
// Esc closes the photo first, not the window under it.
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('lightbox').classList.contains('on')) { e.stopPropagation(); closeLightbox(); } }, true);

// --- Details window ---
const OUTCOMES = { printed: 'Printed', failed: 'Failed', cancelled: 'Cancelled' };
const STATUS_NAMES = { unprinted: 'Not printed', want: 'Want', queued: 'Queued', printing: 'Printing', printed: 'Printed', failed: 'Failed' };
// A date alone ("2026-02-01") is that day here, not midnight UTC.
function day(v) { const t = String(v || '').replace(' ', 'T'); const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? t + 'T12:00:00' : t); return v && !isNaN(d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''; }
function bytes(n) { return !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB'; }
function duration(sec) { if (!sec) return ''; const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; }
function money(n, code) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code || 'USD' }).format(n); } catch (_) { return String(n); } }
function props(rows) { return `<div class="props">${rows.filter((r) => r && r[1] !== '' && r[1] != null).map(([l, v]) => `<span>${esc(l)}</span><span>${v}</span>`).join('')}</div>`; }
function dots(colors) { return colors && colors.length ? `<span class="dots">${colors.map((c) => `<i style="background:${esc(c)}"></i>`).join('')}</span>` : ''; }
function link(text, attrs) { return `<button class="link" ${attrs}>${esc(text)}</button>`; }

function canEdit() { const c = ui.state && ui.state.connection; return !!(c && c.ok && (c.role === 'editor' || c.role === 'admin')); }
/** Show the window's item again (after a change, or a failed one), keeping where it was scrolled to. */
function renderDetails() {
  const d = ui.details; if (!d || !d.item) return;
  const body = $('details-body'), top = body.scrollTop;
  $('details-title').textContent = d.item.name;
  body.innerHTML = d.kind === 'model' ? renderModelDetails(d.item) : renderSpoolDetails(d.item);
  body.scrollTop = top;
}
/** Send a change from the details window; its buttons wait until the answer (or an error) comes. */
function change(msg) {
  document.querySelectorAll('#details-body button, #details-body select, #details-body input, #details-body textarea').forEach((el) => { el.disabled = true; });
  send({ ...msg, id: ui.details.id });
}
function showDetails(kind, id) {
  if (!connected()) return;
  if (kind === 'spool' && !ui.printers && canEdit()) send({ type: 'printers' });
  ui.details = { kind, id, item: null };
  $('details-title').textContent = kind === 'model' ? ((ui.models.find((m) => m.id === id) || {}).name || 'Model') : ((ui.spools || []).find((s) => s.id === id) || {}).name || 'Spool';
  $('details-body').innerHTML = '<p class="summary"><span class="spinner"></span> Loading…</p>';
  $('details').classList.add('on');
  $('details-close').focus();
  send({ type: kind, id });
}
function closeDetails() {
  const was = ui.details; ui.details = null; $('details').classList.remove('on');
  // Back to the card or spool it was opened from (keyboard users carry on there).
  if (was) refocus(was.kind === 'model' ? $('grid') : $('spools'), was.kind === 'model' ? '.card' : '.spool', was.id);
}
$('details-close').onclick = closeDetails;
$('details').onclick = (e) => {
  if (e.target === $('details')) return closeDetails();
  const t = e.target.closest('[data-pic]');
  if (t) { $('details-hero').style.backgroundImage = `url('${ui.details.item.pictures[Number(t.dataset.pic)]}')`; document.querySelectorAll('.thumbs button').forEach((b) => b.classList.toggle('on', b === t)); return; }
  const page = e.target.closest('[data-page]'); if (page) return send({ type: 'open-link', page: page.dataset.page });
  const url = e.target.closest('[data-url]'); if (url) return send({ type: 'open-link', url: url.dataset.url });
  const open = e.target.closest('[data-plate]'); if (open) { closeDetails(); showTab('library'); return openModel(Number(open.dataset.plate)); }
  const shot = e.target.closest('[data-shot]');
  if (shot) { $('lightbox-img').src = shot.dataset.shot; $('lightbox-caption').textContent = shot.dataset.caption; $('lightbox').classList.add('on'); return; }
  const b = e.target.closest('button[data-do]'); if (!b || b.disabled) return;
  const item = ui.details.item, what = b.dataset.do;
  if (what === 'rate') change({ type: 'edit-model', rating: Number(b.dataset.n) === item.rating ? 0 : Number(b.dataset.n) });
  else if (what === 'fav') change({ type: 'edit-model', favorite: !item.favorite });
  else if (what === 'notes') change({ type: 'edit-model', notes: $('d-notes').value });
  else if (what === 'log') change({ type: 'log-print', outcome: $('d-outcome').value, quantity: Number($('d-qty').value) || 1, printerId: Number($('d-printer').value) || null, notes: $('d-lognotes').value });
  else if (what === 'weigh') {
    const g = Number($('d-weight').value); if (!$('d-weight').value || !(g >= 0)) return toast('Enter what the scale shows, in grams', 'error');
    change({ type: 'weigh', weight: g, withSpool: $('d-withspool').checked });
  } else if (what === 'dry-start') change({ type: 'drying', action: 'start', temp: Number($('d-drytemp').value) || null, hours: Number($('d-dryhours').value) || null });
  else if (what === 'dry-finish') change({ type: 'drying', action: 'finish' });
  else if (what === 'load') {
    const v = $('d-slot').value; if (!v) return;
    const [k, n] = v.split(':');
    change({ type: 'load-spool', spoolId: item.id, ...(k === 's' ? { slotId: Number(n) } : { printerId: Number(n) }) });
    send({ type: 'spool', id: item.id });
  }
};
$('details').onchange = (e) => { if (e.target.id === 'd-status') change({ type: 'edit-model', printStatus: e.target.value }); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('details').classList.contains('on')) closeDetails(); });

function renderModelDetails(m) {
  const pics = m.pictures || [];
  const source = m.source ? (/^https?:\/\//i.test(m.source) ? link(m.source.replace(/^https?:\/\/(www\.)?/i, ''), `data-url="${esc(m.source)}" title="${esc(m.source)}"`) : esc(m.source)) : '—';
  const edit = canEdit();
  const stars = edit ? `<span class="rate" title="Rating">${[1, 2, 3, 4, 5].map((n) => `<button data-do="rate" data-n="${n}" class="${n <= m.rating ? 'on' : ''}" title="${n} star${n === 1 ? '' : 's'}${n === m.rating ? ' (click again to clear)' : ''}">${n <= m.rating ? '★' : '☆'}</button>`).join('')}</span>`
    : m.rating ? `<span class="stars" title="${m.rating} of 5">${'★'.repeat(m.rating)}${'☆'.repeat(5 - m.rating)}</span>` : '—';
  const status = edit ? `<select id="d-status">${Object.entries(STATUS_NAMES).map(([k, v]) => `<option value="${k}"${k === m.printStatus ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`
    : esc(STATUS_NAMES[m.printStatus] || m.printStatus);
  const printers = (ui.printers || []).map((p) => `<option value="${p.id}"${ui.state && ui.state.settings.printer_id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const logForm = edit ? `<h4>Log a print</h4><div class="edit">
      <div class="row"><select id="d-outcome"><option value="printed">Printed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select>
        <input id="d-qty" type="number" min="1" max="1000" value="1" title="How many"><select id="d-printer"><option value="">No printer</option>${printers}</select></div>
      <div class="row"><input id="d-lognotes" type="text" placeholder="Notes (optional)"><button class="primary" data-do="log">Log print</button></div></div>` : '';
  const printed = m.printCount ? `${m.printCount}×${m.lastPrinted ? `, last ${esc(day(m.lastPrinted))}` : ''}` : '';
  const history = (m.history || []).map((e) => `<li><span>${esc(day(e.printedAt))}</span><span><b>${esc(OUTCOMES[e.outcome] || e.outcome)}</b>${e.quantity > 1 ? ` ×${e.quantity}` : ''}${e.printer ? ` · ${esc(e.printer)}` : ''}${e.duration ? ` · ${esc(duration(e.duration))}` : ''}${(e.spools || []).length ? ` · ${e.spools.map((s) => `${dots(s.color ? [s.color] : [])}${esc(s.name)} ${grams(s.grams)}`).join(', ')}` : ''}</span>${e.notes ? `<span class="muted">${esc(e.notes)}</span>` : ''}${(e.photos || []).length ? `<span class="shots">${e.photos.map((p) => `<button class="shot" data-shot="${esc(p.src)}" data-caption="${esc(p.caption || '')}" style="background-image:url('${esc(p.src)}')" title="${esc(p.caption || 'Print photo')}"></button>`).join('')}</span>` : ''}</li>`).join('');
  return `<div class="detail">
    <div class="side">
      <div class="hero" id="details-hero" style="${pics[0] ? `background-image:url('${pics[0]}')` : ''}">${pics[0] ? '' : esc(m.fileType.toUpperCase())}</div>
      ${pics.length > 1 ? `<div class="thumbs">${pics.map((p, i) => `<button data-pic="${i}" class="${i ? '' : 'on'}" style="background-image:url('${p}')" title="Picture ${i + 1}"></button>`).join('')}</div>` : ''}
      <div class="actions"><button class="primary" data-plate="${m.id}">Open on plate</button>${edit ? `<button class="fav${m.favorite ? ' on' : ''}" data-do="fav" title="${m.favorite ? 'Remove from favorites' : 'Add to favorites'}">${m.favorite ? '♥ Favorite' : '♡ Favorite'}</button>` : ''}<button data-page="${esc(m.page)}" title="The model's page on the JusttPrint website">Open in JusttPrint</button></div>
    </div>
    <div>
      ${props([
        ['File', esc(m.fileName)], ['Format', esc(m.fileType.toUpperCase())], ['Size', esc(bytes(m.size)) || '—'],
        ['Print status', status], ['Printed', printed], ['Rating', stars],
        ['Favorite', !edit && m.favorite ? '♥ Yes' : ''], ['Designer', esc(m.designer || '—')], ['Source', source], ['License', esc(m.license || '—')],
        ['Tags', m.tags.length ? m.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') : '—'],
        ['Category', esc(m.category || '—')], ['Subcategory', esc(m.subcategory || '')], ['Folder', esc(m.folder)], ['Added', esc(day(m.dateAdded)) || '—']])}
      ${m.description ? `<h4>Description</h4><div class="text">${esc(m.description)}</div>` : ''}
      ${edit ? `<h4>Notes</h4><textarea id="d-notes" placeholder="Your notes on this model">${esc(m.notes || '')}</textarea><div class="actions" style="margin-top:6px"><button data-do="notes">Save notes</button></div>`
        : m.notes ? `<h4>Notes</h4><div class="text">${esc(m.notes)}</div>` : ''}
      ${logForm}
      <h4>Print history</h4>${history ? `<ul class="log">${history}</ul>` : '<div class="muted">Not printed yet.</div>'}
    </div>
  </div>`;
}

function renderSpoolDetails(s) {
  const level = isLow(s), pct = s.initial ? Math.max(0, Math.min(100, (s.remaining / s.initial) * 100)) : 0;
  const held = s.remaining - s.available;
  const where = s.loadedIn.length ? s.loadedIn.join(', ') : s.place || (s.status === 'archived' ? 'Archived' : 'No place');
  const forecast = s.forecast ? (() => { const d = Math.round(s.forecast.daysLeft); return `${d < 1 ? 'Runs out today' : d === 1 ? 'Runs out in about a day' : `Runs out in about ${d} days`} (${esc(day(s.forecast.runsOut))}) at ${s.forecast.perDay < 1 ? 'under 1 g' : grams(s.forecast.perDay)} a day`; })() : '';
  const weighings = s.weighings.map((w) => `<li><span>${esc(day(w.at))}</span><span><b>${grams(w.grams)}</b></span>${w.notes ? `<span class="muted">${esc(w.notes)}</span>` : ''}</li>`).join('');
  const edit = canEdit() && s.status !== 'archived';
  const slots = [];
  for (const p of ui.printers || []) {
    slots.push([`p:${p.id}`, `${p.name} · Holder`, p.direct]);
    for (const u of p.units) for (const slot of u.slots) slots.push([`s:${slot.id}`, `${p.name} · ${slot.label}`, slot.spool]);
  }
  const loadForm = !edit ? '' : !ui.printers ? '<div class="muted">Loading your printers…</div>' : !slots.length ? '<div class="muted">No printers in JusttPrint.</div>'
    : `<div class="row"><select id="d-slot"><option value="">Choose a slot…</option>${slots.map(([v, label, sp]) => `<option value="${v}"${sp && sp.id === s.id ? ' disabled' : ''}>${esc(label)}${sp ? (sp.id === s.id ? ' (this spool)' : ` (has ${esc(sp.name)})`) : ' (empty)'}</option>`).join('')}</select><button data-do="load">Load</button></div>`;
  const tools = edit ? `<h4>Weigh</h4><div class="edit">
      <div class="row"><input id="d-weight" type="number" min="0" step="1" placeholder="grams"><label class="row" title="${s.emptySpool == null ? 'Enter the empty spool weight in JusttPrint first' : 'The scale shows the spool with its filament'}" style="flex:1"><input id="d-withspool" type="checkbox"${s.emptySpool != null ? ' checked' : ' disabled'}> with the spool${s.emptySpool != null ? ` (${grams(s.emptySpool)} empty)` : ''}</label><button class="primary" data-do="weigh">Weigh</button></div></div>
    <h4>Drying</h4><div class="edit">${s.drying ? `<div class="row"><span style="flex:1">Drying since ${esc(day(s.drying.startedAt))}</span><button data-do="dry-finish">Finish drying</button></div>`
      : `<div class="row"><input id="d-drytemp" type="number" min="20" max="150" value="${esc((s.dryingDefaults || {}).temp || '')}" title="°C" placeholder="°C"> °C <input id="d-dryhours" type="number" min="0.25" max="200" step="0.25" value="${esc((s.dryingDefaults || {}).hours || '')}" title="Hours" placeholder="h"> h <span style="flex:1"></span><button data-do="dry-start">Start drying</button></div>`}</div>
    <h4>Load into a printer</h4><div class="edit">${loadForm}</div>` : '';
  const dryings = s.dryings.map((d) => `<li><span>${esc(day(d.at))}</span><span><b>${esc(d.temp)} °C · ${esc(d.hours)} h</b>${d.finished ? '' : ' · running'}${d.humidityBefore != null || d.humidityAfter != null ? ` · ${esc(d.humidityBefore ?? '?')}% → ${esc(d.humidityAfter ?? '?')}%` : ''}</span></li>`).join('');
  return `<div class="detail">
    <div class="side">
      <div class="spool-head"><div class="disc big-disc" style="background:${paint(s.colors)}"></div>
        <div><div class="left">${grams(s.remaining)}</div><div class="muted">of ${grams(s.initial)} · ${esc(where)}</div></div></div>
      <div class="bar ${level}"><i style="width:${pct.toFixed(1)}%"></i></div>
      ${forecast ? `<div class="muted">${forecast}</div>` : ''}
      ${s.drying ? `<div class="warn">Drying at ${esc(s.drying.temp)} °C for ${esc(s.drying.hours)} h, since ${esc(day(s.drying.startedAt))}</div>` : ''}
      ${s.photo ? `<img class="photo" src="${s.photo}" alt="">` : ''}
      <div class="actions"><button data-page="${esc(s.page)}" title="The Filament page on the JusttPrint website">Open in JusttPrint</button></div>
    </div>
    <div>
      ${props([
        ['Place', esc(s.place || (s.loadedIn.length ? '' : 'No place'))], ['In printer', esc(s.loadedIn.join(', '))],
        ['Held for the queue', held > 0 ? grams(held) : ''], ['Brand', esc(s.brand || '')],
        ['Material', esc([s.material, s.materialType].filter(Boolean).join(' · '))],
        ['Color', s.colors.length ? `${dots(s.colors)}${esc(s.colorName || s.colors.join(', '))}` : ''], ['Filament', esc(s.profile || '')],
        ['Nozzle', esc(s.printTemp || '')], ['Bed', esc(s.bedTemp || '')], ['Drying', esc(s.dryingTemp || '')],
        ['Empty spool', s.emptySpool != null ? grams(s.emptySpool) : ''], ['Price', s.price != null ? esc(money(s.price, s.currency)) : ''],
        ['Shop', esc(s.supplier || '')], ['Bought', esc(day(s.bought))], ['Lot', esc(s.lot || '')], ['Added', esc(day(s.added))],
        ['Last used', esc(day(s.lastUsed))], ['Product', s.productUrl ? link('Product page', `data-url="${esc(s.productUrl)}" title="${esc(s.productUrl)}"`) : '']])}
      ${s.notes ? `<h4>Notes</h4><div class="text">${esc(s.notes)}</div>` : ''}
      ${tools}
      ${weighings ? `<h4>Weighings</h4><ul class="log">${weighings}</ul>` : ''}
      ${dryings ? `<h4>Drying</h4><ul class="log">${dryings}</ul>` : ''}
    </div>
  </div>`;
}

// --- Printers ---
function slotTile(where, label, spool, tray) {
  const hint = tray && spool && tray.color && spool.color && tray.color.slice(0, 7).toLowerCase() !== spool.color.toLowerCase()
    ? `<div class="hint">Printer sees ${esc(tray.type || '')} ${esc(tray.color.slice(0, 7))}</div>`
    : tray && !spool ? `<div class="hint">Printer sees ${esc(tray.type || 'a spool')}</div>` : '';
  return `<button class="slot${spool ? '' : ' free'}" data-where='${esc(JSON.stringify(where))}' data-label="${esc(label)}" data-spool="${spool ? spool.id : ''}" title="Click to load a spool">
    <div class="disc" style="background:${spool ? paint(spool.color ? [spool.color] : []) : 'transparent'};${spool ? '' : 'border:1px dashed var(--border)'}"></div>
    <div class="txt"><div class="label">${esc(label)}</div>${spool
      ? `<div><b>${esc(spool.name)}</b></div><div class="muted">${esc(spool.material || '')} · ${grams(spool.remaining)} left</div>`
      : '<div>Empty</div><div>Click to load</div>'}${hint}</div>
  </button>`;
}
function renderPrinters() {
  const list = ui.printers, s = ui.state;
  if (!connected()) { $('printers').innerHTML = ''; $('printers-empty').innerHTML = emptyBox('Connect to JusttPrint', 'Your printers show here once the tab is connected.', ['settings', 'Open Settings']); return; }
  if (!list) { $('printers').innerHTML = '<p class="summary"><span class="spinner"></span> Loading your printers…</p>'; return; }
  count('n-printers', list.length || null);
  const mine = s && s.settings.printer_id, device = s && s.device_id;
  $('my-printer').innerHTML = '<option value="">No printer</option>' + list.map((p) => `<option value="${p.id}"${mine === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  const here = currentPrinter();
  const viaDevice = here && device && here.serial && here.serial.toLowerCase() === String(device).toLowerCase();
  $('printer-note').textContent = here ? `This print: ${here.name}${viaDevice ? ' (selected in OrcaSlicer)' : ''}` : device ? 'OrcaSlicer\'s printer is not in JusttPrint (add its serial number there)' : '';
  $('printers').innerHTML = list.map((p) => `<div class="printer${here && here.id === p.id ? ' here' : ''}">
      <header><b>${esc(p.name)}</b><span class="muted">${esc(p.model || '')}</span>
        ${p.status ? `<span class="tag">${esc(p.status)}</span>` : ''}${p.logsItself ? '<span class="tag loaded" title="JusttPrint follows it live and logs its prints, with their filament, when they end">Logs prints by itself</span>' : ''}
        ${here && here.id === p.id ? '<span class="tag loaded">This print</span>' : ''}</header>
      <div class="units">
        <div><div class="unit-name">On the printer</div><div class="slots">${slotTile({ printerId: p.id }, 'Holder', p.direct, null)}</div></div>
        ${p.units.map((u) => `<div><div class="unit-name">${esc(u.name)}${u.humidity != null ? ` · ${esc(u.humidity)}% humidity` : ''}</div>
          <div class="slots">${u.slots.map((slot) => slotTile({ slotId: slot.id }, slot.label, slot.spool, slot.tray)).join('')}</div></div>`).join('')}
        ${p.units.length ? '' : '<div class="muted" style="font-size:12px">No AMS. Add one on JusttPrint\'s Printers page.</div>'}
      </div>
    </div>`).join('');
  $('printers-empty').innerHTML = list.length ? '' : emptyBox('No printers yet', 'Add your printers in JusttPrint (Printers) to load spools into them here.');
}
function currentPrinter() {
  const list = ui.printers || [], s = ui.state; if (!s) return null;
  const device = s.device_id && list.find((p) => p.serial && p.serial.toLowerCase() === String(s.device_id).toLowerCase());
  return device || list.find((p) => p.id === s.settings.printer_id) || null;
}
function openPicker(where, label, current) {
  ui.picking = { where, current };
  $('picker-title').textContent = `Load a spool: ${label}`;
  $('picker-q').value = ''; $('picker-empty').disabled = !current;
  renderPicker(); $('picker').classList.add('on'); $('picker-q').focus();
  if (ui.spools === null) loadSpools();
}
function renderPicker() {
  if (!ui.picking) return;
  const words = $('picker-q').value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (ui.spools || []).filter((s) => s.remaining > 0 && words.every((w) => [s.name, s.brand, s.material, s.where].join(' ').toLowerCase().includes(w)))
    .sort((a, b) => (a.material || '~').localeCompare(b.material || '~') || hue(a.colors[0]) - hue(b.colors[0]));
  $('picker-list').innerHTML = ui.spools === null ? '<p class="summary"><span class="spinner"></span> Loading your spools…</p>'
    : list.length ? list.map((s) => `<button class="choice${s.id === ui.picking.current ? ' current' : ''}" data-pick="${s.id}">
        <div class="disc" style="background:${paint(s.colors)}"></div>
        <div class="txt"><div><b>${esc(s.name)}</b>${s.id === ui.picking.current ? '<span class="tag loaded">Here now</span>' : ''}</div>
          <div class="muted">${esc([s.brand, s.material].filter(Boolean).join(' · '))}${s.where ? ` · ${s.loaded ? 'in' : ''} ${esc(s.where)}` : ''}</div></div>
        <span>${grams(s.remaining)}</span></button>`).join('')
    : emptyBox('No spools', 'No spool with filament left matches.');
}
function closePicker() { ui.picking = null; $('picker').classList.remove('on'); }
function pick(spoolId) {
  if (!ui.picking) return;
  send({ type: 'load-spool', ...ui.picking.where, spoolId });
  closePicker();
}
$('printers').onclick = (e) => { const b = e.target.closest('button.slot'); if (b) openPicker(JSON.parse(b.dataset.where), b.dataset.label, Number(b.dataset.spool) || null); };
$('picker-list').onclick = (e) => { const b = e.target.closest('button[data-pick]'); if (b) pick(Number(b.dataset.pick)); };
$('picker-q').oninput = renderPicker;
$('picker-empty').onclick = () => pick(null);
$('picker-cancel').onclick = closePicker;
$('picker').onclick = (e) => { if (e.target.id === 'picker') closePicker(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
$('my-printer').onchange = () => send({ type: 'set-printer', printer_id: Number($('my-printer').value) || null });
$('prefresh').onclick = () => { ui.printers = null; renderPrinters(); send({ type: 'printers' }); };

// --- This print ---
function renderPrint() {
  const s = ui.state; if (!s) return;
  const ls = s.last_slice;
  $('slice-info').innerHTML = ls && ls.filaments.length
    ? `Last slice uses ${ls.filaments.map((f) => `<span class="tag" style="text-transform:none">${esc(f.material || '?')}${f.grams == null ? '' : ' ' + f.grams + ' g'}</span>`).join(' ')}`
    : 'Checks the project\'s filaments against your spools. Slice to check the grams too.';
  $('check').disabled = !connected();
  const lp = s.last_print, sent = s.print_sent, hasGrams = !!(ls && ls.filaments.some((f) => f.grams));
  let used = '';
  if (lp && lp.status === 'taken') {
    used = `<div class="status-line ${lp.undone ? '' : 'ok'}">${lp.undone ? 'Undone: the filament went back to the spools.' : `Took off${lp.model ? ` for ${esc(lp.model.name)}` : ''}${lp.printer ? ` on ${esc(lp.printer.name)}` : ''}${lp.eventId ? ', logged in the print history' : ''}:`}</div>`
      + (lp.undone ? '' : `<div class="needs">${lp.used.map((u) => `<div class="need" style="grid-template-columns:28px 1fr 80px 110px"><span class="slot" style="background:${esc(u.color || 'transparent')}"></span><span><b>${esc(u.name)}</b></span><span>−${esc(u.grams)} g</span><span class="result">${grams(u.left)} left</span></div>`).join('')}</div>`)
      + (lp.missing && lp.missing.length && !lp.undone ? `<div class="status-line warn">No spool for ${esc(lp.missing.join(', '))}: not taken off.</div>` : '');
  } else if (lp && lp.status === 'auto') {
    used = `<div class="status-line">${esc(lp.printer.name)} logs this print by itself when it ends, with the filament it used.</div>`;
  } else if (lp && lp.status === 'error') {
    used = `<div class="status-line bad">${esc(lp.error)}</div>`;
  }
  if (sent && !sent.done) used = `<div class="status-line warn">${sent.kind === 'upload' ? 'OrcaSlicer uploaded a print to the printer. If it is printing, take its filament off your spools.' : 'A print was sent.'}</div>` + used;
  else if (!lp && !s.settings.take_off) used = '<div class="status-line">Taking filament off by itself is off (Settings).</div>';
  $('used-info').innerHTML = used;
  const done = lp && lp.status !== 'error' && !lp.undone && lp.this_slice;
  $('take-off').disabled = !connected() || !hasGrams || !!done;
  $('take-off').title = done ? 'Already done for this slice: slice again, or Undo' : '';
  $('undo').hidden = !(lp && lp.status === 'taken' && !lp.undone);
  const ex = s.last_export;
  $('send').disabled = !ex || !connected() || ex.sent;
  $('send').textContent = ex && ex.sent ? 'Sent' : 'Send to JusttPrint';
  $('export-info').innerHTML = ex
    ? `<div class="file"><div class="icon">3MF</div><div class="what"><div><b>${esc(base(ex.path))}</b></div><div class="muted">${esc(ex.result || (s.opened_model ? `Will be filed with ${s.opened_model.name} if its name matches no model` : 'Ready to send'))}</div></div></div>`
    : `<div class="file"><div class="icon">…</div><div class="what muted">${s.settings.export_folder ? `Export plate sliced file into ${esc(s.settings.export_folder)} and it shows here.` : 'Choose the folder you export sliced files to in <button class="link" data-go="settings">Settings</button>.'}</div></div>`;
  $('project').disabled = !s.project_path || !connected();
  $('project-info').innerHTML = `<div class="file"><div class="icon">3MF</div><div class="what">${s.project_path ? `<div><b>${esc(base(s.project_path))}</b></div><div class="muted">${esc(s.project_path)}</div>` : '<div class="muted">Save the project in OrcaSlicer first (File, Save Project).</div>'}</div></div>`;
  count('n-print', ex && !ex.sent ? 1 : null);
}
function renderCheck(r) {
  $('check-busy').hidden = true;
  ui.matched = new Set(r.needs.filter((n) => n.spool).map((n) => n.spool.id));
  if (ui.spools) renderSpools();
  if (!r.needs.length) { $('check-result').innerHTML = '<div class="status-line">This project uses no filaments to check.</div>'; return; }
  const head = r.spools === 0 ? '<div class="status-line warn">You have no spools in JusttPrint yet.</div>'
    : r.ready ? '<div class="status-line ok">✓ Your spools cover this print.</div>' : `<div class="status-line bad">Missing: ${esc(r.missing.join(', '))}</div>`;
  const rows = r.needs.map((n) => `<div class="need">
      <span class="slot" style="background:${esc(n.color || 'transparent')}">${n.slot}</span>
      <span><b>${esc(n.material || 'Any')}</b> <span class="muted">${esc(n.colorName || '')}</span>${n.preset ? `<div class="muted" style="font-size:11px">${esc(n.preset)}</div>` : ''}</span>
      <span>${n.grams == null ? '<span class="muted">—</span>' : n.grams + ' g'}</span>
      <span>${n.spool ? `<span class="swatch-inline" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(n.spool.color || 'transparent')};margin-right:5px;vertical-align:-1px"></span>${esc(n.spool.name)}${n.spool.where ? ` <span class="muted">· ${esc(n.spool.where)}</span>` : ''}` : '<span class="bad">No matching spool</span>'}</span>
      <span class="result ${n.ok ? 'ok' : 'bad'}">${n.ok ? (n.left == null ? 'OK' : grams(n.left) + ' left') : (n.short ? grams(n.short) + ' short' : 'Missing')}</span>
    </div>`).join('');
  $('check-result').innerHTML = head + `<div class="needs">${rows}</div>`;
}
function runCheck() { if (!connected()) return; $('check-busy').hidden = false; send({ type: 'check' }); }
$('check').onclick = runCheck;
$('take-off').onclick = () => send({ type: 'take-off' });
$('undo').onclick = () => send({ type: 'undo-print' });
$('send').onclick = () => send({ type: 'send-sliced' });
$('project').onclick = () => send({ type: 'save-project' });

// --- Settings and state ---
function renderState(s) {
  const was = connected();
  ui.state = s;
  if (!ui.viewRestored) restoreView(s.settings.view || {});
  if (document.activeElement && !document.activeElement.closest('#view-settings')) {
    $('server').value = s.settings.server || '';
    $('auto').checked = !!s.settings.auto_send;
    $('tls').checked = s.settings.verify_tls !== false;
    $('folder').value = s.settings.export_folder || '';
    $('takeoff').checked = s.settings.take_off !== false;
  }
  $('key').placeholder = s.settings.has_key ? 'Saved (leave empty to keep it)' : 'jpk_…';
  const c = s.connection;
  $('conn').textContent = c && c.ok ? `${c.username} · JusttPrint ${c.version}` : (c && c.error ? 'Not connected' : 'Not connected');
  $('conn').className = 'pill ' + (c && c.ok ? 'ok' : c && c.error ? 'bad' : '');
  $('conn-detail').hidden = !c;
  $('conn-detail').className = 'status-line ' + (c && c.ok ? 'ok' : 'bad');
  $('conn-detail').textContent = c && c.ok ? `Connected to ${s.settings.server} as ${c.username} (${c.role}).${c.slicedInbox ? '' : ' Choose the Sliced inbox folder in JusttPrint (Print Queue) to send sliced files.'}` : (c && c.error) || '';
  if (!was && connected()) { send({ type: 'filters' }); if (ui.project) send({ type: 'project-filaments' }); loadModels(false); if (ui.tab === 'filament') loadSpools(); send({ type: 'printers' }); }
  if (!connected()) { ui.models = []; ui.total = 0; renderModels(); renderSpools(); if (!c && ui.tab === 'library') showTab('settings'); }
  else renderModels();
  renderNotice();
  renderPrint();
  if (ui.printers) renderPrinters();
  // A new slice: check it at once.
  const key = s.last_slice ? JSON.stringify(s.last_slice.filaments) : null;
  if (key && key !== ui.lastSliceKey && connected()) { runCheck(); if (ui.project) send({ type: 'project-filaments' }); }
  ui.lastSliceKey = key;
}
$('save').onclick = () => send({ type: 'save-settings', server: $('server').value, api_key: $('key').value, auto_send: $('auto').checked, verify_tls: $('tls').checked, export_folder: $('folder').value, take_off: $('takeoff').checked });

orca.onMessage((m) => {
  if (!m || !m.type) return;
  if (m.type === 'state') renderState(m);
  else if (m.type === 'models') {
    if (m.seq != null && m.seq !== ui.seq) return;
    ui.loading = false;
    ui.models = m.offset ? ui.models.concat(m.models) : m.models; ui.total = m.total == null ? ui.models.length : m.total;
    renderModels();
    if (m.models.length) maybeMore();
  } else if (m.type === 'model' || m.type === 'spool') {
    const item = m[m.type];
    if (!ui.details || ui.details.kind !== m.type || !item || item.id !== ui.details.id) return;
    ui.details.item = item; renderDetails();
    if (m.edited) {
      // The card shows the new print status and count; a change that takes it out of the filter shows on the next search.
      const card = ui.models.find((x) => x.id === item.id);
      if (card) { card.printStatus = item.printStatus; card.printCount = item.printCount; renderModels(); }
      if ('favorite' in item && ui.filters) send({ type: 'filters' });
    }
  } else if (m.type === 'filters') {
    ui.filters = m;
    // A remembered tag or category that is gone: show everything again.
    const gone = (ui.tag && !m.tags.some((t) => t.name === ui.tag)) || (ui.category && !m.categories.some((c) => c.id === ui.category || c.subcategories.some((x) => x.id === ui.category)));
    if (gone) { ui.tag = ''; ui.category = 0; }
    renderFilters();
    if (gone) loadModels(false);
  } else if (m.type === 'project-filaments') { ui.projectNeeds = m.needs || []; renderSpools(); }
  else if (m.type === 'spools') { ui.spools = m.spools; renderSpools(); renderPicker(); }
  else if (m.type === 'printers') { ui.printers = m.printers; renderPrinters(); if (ui.details && ui.details.kind === 'spool') renderDetails(); }
  else if (m.type === 'check') renderCheck(m.result);
  else if (m.type === 'plugin-downloaded') { ui.downloaded = m.path; renderNotice(); }
  else if (m.type === 'opened') { ui.opening = null; renderModels(); }
  else if (m.type === 'toast') { if (m.level === 'error') { if (ui.details && !ui.details.item) closeDetails(); ui.loading = false; $('check-busy').hidden = true; renderModels(); } if (m.level === 'error') { renderNotice(); renderDetails(); } toast(m.text, m.level); }
});
send({ type: 'ready' });
// New exports and saves are noticed on other threads; ask now and then (and auto-send from here).
setInterval(() => send({ type: 'poll' }), 2000);
</script>
</body></html>
"""


if orca is not None:

    def _ui():
        return orca.host.ui

    def _events(*names):
        """The lifecycle events with these names that this OrcaSlicer has (older builds lack some)."""
        return tuple(getattr(orca.LifecycleEvent, n) for n in names if hasattr(orca.LifecycleEvent, n))

    def _notify(text):
        """A warning in OrcaSlicer's 3D view (the level's type differs between builds)."""
        for level in ("warning", 1):
            try:
                _ui().push_notification(level, text)
                return
            except (TypeError, ValueError):
                continue

    class JusttPrintPage(orca.pages.PagesPluginCapabilityBase):
        """The JusttPrint tab."""

        _connection = None
        _last_poll = None
        # Exports from before the plugin started are not offered.
        _started = time.time()

        def get_name(self):
            return "JusttPrint"

        def get_ui(self):
            return PAGE

        # Settings live in this capability's config.
        def get_default_config(self):
            return dict(DEFAULT_SETTINGS)

        def _settings(self):
            try:
                saved = json.loads(self.get_config() or "{}")
            except ValueError:
                saved = {}
            return {**DEFAULT_SETTINGS, **(saved if isinstance(saved, dict) else {})}

        def _client(self):
            s = self._settings()
            return Client(s["server"], s["api_key"], s.get("verify_tls", True))

        # --- Talking to the page ---

        def _toast(self, text, level="info"):
            self.post_message({"type": "toast", "text": text, "level": level})

        def _push_state(self):
            s = self._settings()
            state = {
                "type": "state",
                "settings": {
                    "server": s["server"],
                    "has_key": bool(s["api_key"]),
                    "auto_send": s["auto_send"],
                    "verify_tls": s.get("verify_tls", True),
                    "export_folder": s.get("export_folder", ""),
                    "take_off": s.get("take_off", True),
                    "printer_id": s.get("printer_id"),
                    "view": s.get("view") or {},
                },
                "connection": self._connection,
                "last_slice": STATE["last_slice"],
                "last_export": STATE["last_export"],
                "project_path": STATE["project_path"],
                "opened_model": STATE["opened_model"],
                "device_id": STATE["device_id"],
                "print_sent": STATE["print_sent"],
                "last_print": STATE["last_print"],
            }
            self.post_message(state)

        def _connect(self):
            try:
                hello = self._client().hello()
                self._connection = {"ok": True, **hello, **version_notices(hello), "pluginVersion": PLUGIN_VERSION}
            except JusttPrintError as error:
                self._connection = {"ok": False, "error": str(error)}
            return self._connection

        def on_message(self, data):
            if not isinstance(data, dict):
                return
            kind = data.get("type")
            try:
                if kind == "ready":
                    if self._settings()["server"]:
                        self._connect()
                    self._push_state()
                elif kind == "poll":
                    self._poll()
                elif kind == "save-settings":
                    self._save_settings(data)
                elif kind in ("models", "search"):
                    self._models(data)
                elif kind == "spools":
                    self.post_message({"type": "spools", "spools": self._client().spools()})
                elif kind == "model":
                    self.post_message({"type": "model", "model": self._client().model(data.get("id"))})
                elif kind == "spool":
                    self.post_message({"type": "spool", "spool": self._client().spool(data.get("id"))})
                elif kind == "open-link":
                    self._open_link(data)
                elif kind == "save-view":
                    s = self._settings()
                    view = clean_view(data.get("view"))
                    if view != s.get("view"):
                        s["view"] = view
                        self.save_config(json.dumps(s))
                elif kind == "project-filaments":
                    self.post_message({"type": "project-filaments", "needs": self._project_needs()})
                elif kind == "filters":
                    self.post_message({"type": "filters", **self._client().filters()})
                elif kind == "edit-model":
                    self._edit_model(data)
                elif kind == "log-print":
                    model = self._client().log_print(data.get("id"), data.get("outcome") or "printed", data.get("quantity") or 1, str(data.get("notes") or ""), data.get("printerId"))
                    self.post_message({"type": "model", "model": model, "edited": True})
                    self._toast("Print logged")
                elif kind == "weigh":
                    spool = self._client().weigh_spool(data.get("id"), data.get("weight"), data.get("withSpool", True))
                    self._spool_changed(spool, f"Weighed: {round(spool.get('remaining', 0))} g left")
                elif kind == "drying":
                    spool = self._client().drying(data.get("id"), data.get("action"), data.get("temp"), data.get("hours"))
                    self._spool_changed(spool, "Drying started" if data.get("action") == "start" else "Drying finished")
                elif kind == "download-plugin":
                    self._download_plugin()
                elif kind == "printers":
                    self.post_message({"type": "printers", "printers": self._client().printers()})
                elif kind == "load-spool":
                    self._load_spool(data)
                elif kind == "set-printer":
                    self._set_printer(data.get("printer_id"))
                elif kind == "take-off":
                    self._take_off()
                elif kind == "undo-print":
                    self._undo_print()
                elif kind == "open":
                    self._open(data.get("id"), data.get("name"))
                elif kind == "check":
                    self._check()
                elif kind == "send-sliced":
                    self._send_sliced()
                elif kind == "save-project":
                    self._save_project()
            except JusttPrintError as error:
                log(f"{kind}: {error}")
                self._toast(str(error), "error")
            except Exception as error:  # noqa: BLE001 - show it instead of leaving the page waiting
                self._toast(f"Something went wrong: {error}", "error")
                raise

        def _save_settings(self, data):
            s = self._settings()
            try:
                s["server"] = normalize_server(data.get("server"))
            except ValueError as error:
                raise JusttPrintError(str(error)) from error
            key = str(data.get("api_key") or "").strip()
            if key:
                s["api_key"] = key
            s["auto_send"] = bool(data.get("auto_send"))
            s["verify_tls"] = bool(data.get("verify_tls", True))
            folder = os.path.expanduser(str(data.get("export_folder") or "").strip())
            if folder and not os.path.isdir(folder):
                raise JusttPrintError(f"There is no folder {folder}: enter the folder you export sliced files to")
            s["export_folder"] = folder
            s["take_off"] = bool(data.get("take_off", s.get("take_off", True)))
            if not self.save_config(json.dumps(s)):
                raise JusttPrintError("OrcaSlicer could not save the settings")
            connection = self._connect()
            self._push_state()
            if connection.get("ok"):
                self._toast(f"Connected as {connection['username']}")
                if not connection.get("slicedInbox"):
                    self._toast("Tip: choose the Sliced inbox folder in JusttPrint (Print Queue) to send sliced files")

        def _poll(self):
            self._look_for_export()
            export = STATE["last_export"]
            if export and not export["sent"] and export.get("auto") is None:
                export["auto"] = bool(self._settings()["auto_send"])
                if export["auto"]:
                    try:
                        self._send_sliced()
                    except JusttPrintError as error:
                        export["result"] = str(error)
                        _notify(f"JusttPrint: {error}")
            sent = STATE["print_sent"]
            if sent and not sent["done"] and sent["kind"] == "print" and self._settings().get("take_off", True):
                sent["done"] = True
                try:
                    self._take_off()
                except JusttPrintError as error:
                    STATE["last_print"] = {"status": "error", "error": str(error), "used": [], "missing": []}
                    _notify(f"JusttPrint: {error}")
            keys = ("last_slice", "last_export", "project_path", "opened_model", "device_id", "print_sent", "last_print")
            snapshot = json.dumps([STATE[k] for k in keys], sort_keys=True)
            if snapshot != self._last_poll:
                self._last_poll = snapshot
                self._push_state()

        def _look_for_export(self):
            """A new sliced file in the export folder becomes the one to send."""
            since = self._started
            export = STATE["last_export"]
            if export and export.get("mtime"):
                since = max(since, export["mtime"])
            found = newest_export(self._settings().get("export_folder"), since, time.time())
            if found and not (export and export["path"] == found[0] and export.get("mtime") == found[1]):
                log(f"New sliced file: {found[0]}")
                STATE["last_export"] = {"path": found[0], "mtime": found[1], "sent": False, "result": None, "auto": None}

        # --- Actions ---

        def _models(self, data):
            page = self._client().models(
                str(data.get("q") or ""),
                str(data.get("sort") or "newest"),
                str(data.get("status") or ""),
                data.get("offset") or 0,
                data.get("limit") or 30,
                bool(data.get("favorite")),
                str(data.get("tag") or ""),
                data.get("category") or None,
            )
            models = page.get("models", [])
            self.post_message(
                {"type": "models", "models": models, "total": page.get("total", len(models)), "offset": page.get("offset", 0), "seq": data.get("seq")}
            )

        def _edit_model(self, data):
            changes = {k: data[k] for k in ("printStatus", "rating", "favorite", "notes") if k in data}
            model = self._client().edit_model(data.get("id"), changes)
            self.post_message({"type": "model", "model": model, "edited": True})
            if "notes" in changes:
                self._toast("Notes saved")

        def _spool_changed(self, spool, text):
            """A spool changed from its details window: show it, and the list, again."""
            self.post_message({"type": "spool", "spool": spool})
            self.post_message({"type": "spools", "spools": self._client().spools()})
            self._toast(text)

        def _download_plugin(self):
            """Save the server's plugin into Downloads, show it, and tell the page how to install it."""
            raw = self._client().download_plugin()
            version = (self._connection or {}).get("pluginUpdate") or "new"
            path = plugin_save_path(downloads_folder(), version)
            try:
                with open(path, "wb") as f:
                    f.write(raw)
            except OSError as error:
                raise JusttPrintError(f"Could not save the plugin to {path}: {error}") from error
            log(f"Saved plugin {version} to {path}")
            self.post_message({"type": "plugin-downloaded", "path": path})
            try:
                open_with_system(os.path.dirname(path))
            except (OSError, subprocess.SubprocessError):
                pass  # the page says where it is

        def _open_link(self, data):
            """Open a page of the JusttPrint website ("#/model/…") or a model's web link in the browser."""
            page, url = str(data.get("page") or ""), str(data.get("url") or "")
            if page.startswith("#/"):
                url = self._client().server.rstrip("/") + "/" + page
            elif not url.lower().startswith(("http://", "https://")):
                return
            try:
                open_with_system(url)
            except (OSError, subprocess.SubprocessError) as error:
                raise JusttPrintError(f"Could not open the browser: {error}") from error

        def _open(self, model_id, name):
            client = self._client()
            result = client.open_links(model_id)
            for link in result["links"]:
                try:
                    open_with_system(orca_open_link(client.server, link["path"]))
                except (OSError, subprocess.SubprocessError) as error:
                    raise JusttPrintError(f"Could not open {link['name']} in OrcaSlicer: {error}") from error
            STATE["opened_model"] = {"id": result.get("modelId", model_id), "name": name}
            self.post_message({"type": "opened", "id": STATE["opened_model"]["id"]})
            self._toast(f"Opening {name}…")
            self._push_state()

        def _load_spool(self, data):
            slot_id = data.get("slotId")
            printer_id = data.get("printerId")
            printers = self._client().load_spool(slot_id, None if slot_id else printer_id, data.get("spoolId"))
            self.post_message({"type": "printers", "printers": printers})
            self.post_message({"type": "spools", "spools": self._client().spools()})
            self._toast("Spool loaded" if data.get("spoolId") else "Slot emptied")

        def _set_printer(self, printer_id):
            s = self._settings()
            s["printer_id"] = int(printer_id) if printer_id else None
            if not self.save_config(json.dumps(s)):
                raise JusttPrintError("OrcaSlicer could not save the settings")
            self._push_state()

        def _take_off(self):
            """Take the last slice's filament off the spools (a print was sent, or the button)."""
            last_slice = STATE["last_slice"]
            needs = [f for f in (last_slice or {}).get("filaments", []) if f.get("grams")]
            if not needs:
                raise JusttPrintError("Slice the plate first: the plugin takes off the grams the slice uses")
            sent = STATE["print_sent"] or {}
            opened = STATE["opened_model"]
            result = self._client().print_started(
                needs,
                model_id=opened and opened.get("id"),
                printer_id=self._settings().get("printer_id"),
                device_id=sent.get("device_id") or STATE["device_id"],
                name=sent.get("name") or None,
            )
            result["undone"] = False
            result["this_slice"] = True
            STATE["last_print"] = result
            if STATE["print_sent"]:
                STATE["print_sent"]["done"] = True
            if result.get("status") == "auto":
                text = f"{result['printer']['name']} logs this print by itself when it ends, with the filament it used"
            else:
                text = "Took " + ", ".join(f"{u['grams']} g off {u['name']}" for u in result.get("used", []))
                if result.get("missing"):
                    text += ". No spool for " + ", ".join(result["missing"])
            log(text)
            self._toast(text)
            _notify(f"JusttPrint: {text}")
            self._push_state()
            if result.get("status") == "taken":
                self.post_message({"type": "spools", "spools": self._client().spools()})

        def _undo_print(self):
            last = STATE["last_print"]
            if not last or last.get("status") != "taken" or last.get("undone"):
                raise JusttPrintError("There is nothing to undo")
            self._client().undo_print(last)
            last["undone"] = True
            self._toast("Gave the filament back to the spools")
            self._push_state()
            self.post_message({"type": "spools", "spools": self._client().spools()})

        def _project_needs(self):
            """The open project's filaments (material, color, slot), with the last slice's grams."""
            presets = []
            colors = None
            try:
                bundle = orca.host.preset_bundle()
                presets = list(bundle.current_filament_presets())
                colors = bundle.full_config_value("filament_colour")
            except Exception:  # noqa: BLE001 - before the GUI is ready, or an older API
                pass
            return needs_from_presets(presets, STATE["last_slice"], colors)

        def _check(self):
            needs = self._project_needs()
            if not needs:
                raise JusttPrintError("No filaments to check: choose filaments for the project, or slice it")
            log(f"Filament check: {needs}")
            self.post_message({"type": "check", "result": self._client().filament_check(needs)})

        def _send_sliced(self):
            export = STATE["last_export"]
            if not export:
                raise JusttPrintError("Export a sliced file first")
            path = export["path"]
            if not path.lower().endswith(".gcode.3mf"):
                raise JusttPrintError("JusttPrint takes sliced projects (.gcode.3mf): use Export plate sliced file")
            if not os.path.isfile(path):
                raise JusttPrintError(f"The exported file is gone: {path}")
            opened = STATE["opened_model"]
            result = self._client().send_sliced(path, opened and opened.get("id"))
            export["sent"] = True
            if result.get("status") == "filed" and result.get("model"):
                export["result"] = f"Filed with {result['model']['name']} and queued"
            else:
                export["result"] = "Waiting in JusttPrint's Sliced inbox for you to choose its model"
            self._toast(export["result"])
            self._push_state()

        def _save_project(self):
            path = STATE["project_path"]
            if not path or not os.path.isfile(path):
                raise JusttPrintError("Save the project in OrcaSlicer first (File, Save Project)")
            plater = None
            try:
                plater = orca.host.plater()
            except Exception:  # noqa: BLE001
                plater = None
            if plater is not None and plater.is_project_dirty():
                answer = _ui().message("The project has changes that are not saved. Upload the last saved version?", title="JusttPrint", buttons="yes_no", icon="question")
                if answer != "yes":
                    return
            result = self._client().save_project(path)
            self._toast(f"Saved {result['fileName']} to JusttPrint's Upload folder" + ("" if result.get("added") else " (it shows after the next scan)"))

        # --- What OrcaSlicer does ---

        def on_lifecycle_event(self, event, ctx):
            # Runs on the thread that raised the event: only record here; the page picks it up.
            name = getattr(ctx, "name", "") or ""
            sent_events = _events("PrintJobFinished", "UploadFinished", "SendJobFinished")
            if event in (
                orca.LifecycleEvent.ProjectOpened,
                orca.LifecycleEvent.ProjectAfterSave,
                orca.LifecycleEvent.GCodeExportFinished,
                *_events("DeviceSelected", "PrintJobStarted", "UploadStarted", "SendJobStarted"),
                *sent_events,
            ):
                log(
                    f"{getattr(event, 'name', event)}: name={name!r} msg={getattr(ctx, 'msg', '')!r} "
                    f"code={getattr(ctx, 'code', None)!r} device_id={getattr(ctx, 'device_id', None)!r}"
                )
            device_id = getattr(ctx, "device_id", None) or None
            if event in _events("DeviceSelected"):
                # OrcaSlicer 2.5.2 gives the selected printer's serial as the name, not device_id.
                selected = device_id or name
                if selected:
                    STATE["device_id"] = str(selected)
            if event in sent_events and getattr(ctx, "code", None) == orca.LifecycleEvtCode.Ok:
                # Print (Bambu) starts the print; Upload may or may not (the tab offers to take it
                # off); Send only copies the file to the printer's storage.
                kind = "print" if event in _events("PrintJobFinished") else "upload" if event in _events("UploadFinished") else None
                if kind:
                    STATE["print_sent"] = {"kind": kind, "name": name, "device_id": str(device_id or STATE["device_id"] or ""), "at": time.time(), "done": False}
            if event in (orca.LifecycleEvent.ProjectOpened, orca.LifecycleEvent.ProjectAfterSave):
                if name and os.path.isabs(name):
                    STATE["project_path"] = name
            elif event in (orca.LifecycleEvent.NewProject, orca.LifecycleEvent.ProjectClosed):
                STATE["project_path"] = None
                STATE["opened_model"] = None
            elif event == orca.LifecycleEvent.GCodeExportFinished:
                # Slicing writes a temporary .gcode (that is what this event reports in 2.5.2);
                # a .gcode.3mf here is an export, should a later OrcaSlicer report those.
                path = getattr(ctx, "msg", "") or ""
                if getattr(ctx, "code", None) == orca.LifecycleEvtCode.Ok and path.lower().endswith(".gcode"):
                    read_slice(path)
                if getattr(ctx, "code", None) == orca.LifecycleEvtCode.Ok and path.lower().endswith(".gcode.3mf"):
                    STATE["last_export"] = {"path": path, "sent": False, "result": None, "auto": None}

    @orca.plugin
    class JusttPrintPlugin(orca.base):
        def register_capabilities(self):
            orca.register_capability(JusttPrintPage)

