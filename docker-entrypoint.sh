#!/bin/bash
set -e

# Printventory server on plain Node (src/server/index.js). No Electron, no X server.

# --- Run the app as PUID:PGID (default 1000:1000). PUID=0 keeps the old root behavior. ---
# Files the app writes (database, moves, Organize Library) get this owner on mounted folders.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
case "$PUID$PGID" in
  *[!0-9]*|'') echo "Error: PUID and PGID must be numbers (got PUID='$PUID' PGID='$PGID')"; exit 1 ;;
esac

# Same data path as the Electron-based image, so existing volumes keep working.
DATA_DIR=/root/.config/printventory
mkdir -p "$DATA_DIR"
export XDG_CONFIG_HOME=/root/.config
RUN_AS=()

if [ "$PUID" = "0" ]; then
  echo "Running as root (PUID=0)"
else
  if ! getent group "$PGID" >/dev/null; then
    groupadd -g "$PGID" printventory
  fi
  if ! getent passwd "$PUID" >/dev/null; then
    useradd -u "$PUID" -g "$PGID" -d /home/printventory -s /usr/sbin/nologin printventory
  fi
  APP_USER="$(getent passwd "$PUID" | cut -d: -f1)"
  APP_HOME="$(getent passwd "$PUID" | cut -d: -f6)"
  mkdir -p "$APP_HOME"
  chown "$PUID:$PGID" "$APP_HOME"

  chmod 711 /root /root/.config
  # Re-own the data folder only when something in it has a different owner (fast on later starts).
  if [ "$(stat -c %u:%g "$DATA_DIR")" != "$PUID:$PGID" ] \
    || find "$DATA_DIR" \( ! -uid "$PUID" -o ! -gid "$PGID" \) -print -quit | grep -q .; then
    echo "Setting owner of $DATA_DIR to $PUID:$PGID..."
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi

  RUN_AS=(setpriv --reuid="$PUID" --regid="$PGID" --init-groups)
  # Keep the right to listen on ports below 1024 (Let's Encrypt on port 80) when Docker allows it.
  if setpriv --inh-caps=+net_bind_service --ambient-caps=+net_bind_service true 2>/dev/null; then
    RUN_AS+=(--inh-caps=+net_bind_service --ambient-caps=+net_bind_service)
  fi

  export HOME="$APP_HOME"
  export USER="$APP_USER"
  echo "Running as $APP_USER ($PUID:$PGID). Set PUID/PGID to match the owner of your library files."
fi

# --- WebGL for thumbnails (headless Chromium). PRINTVENTORY_CHROMIUM_ARGS overrides this. ---
# PRINTVENTORY_GPU=auto (default) | nvidia | swiftshader
GPU_MODE="$(echo "${PRINTVENTORY_GPU:-auto}" | tr '[:upper:]' '[:lower:]')"
USE_NVIDIA=0
case "$GPU_MODE" in
  nvidia|hardware|gpu) USE_NVIDIA=1 ;;
  swiftshader|software|cpu) USE_NVIDIA=0 ;;
  *)
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      USE_NVIDIA=1
    fi
    ;;
esac

if [ -z "${PRINTVENTORY_CHROMIUM_ARGS:-}" ] && [ "$USE_NVIDIA" = "1" ]; then
  case ",${NVIDIA_DRIVER_CAPABILITIES:-}," in
    *,graphics,*|*,all,*) ;;
    *) echo "Warning: NVIDIA_DRIVER_CAPABILITIES='${NVIDIA_DRIVER_CAPABILITIES:-<unset>}' — WebGL needs 'graphics' (e.g. graphics,compute,utility)." ;;
  esac
  export PRINTVENTORY_CHROMIUM_ARGS="--use-gl=angle --use-angle=vulkan --enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE --disable-vulkan-surface --ignore-gpu-blocklist --enable-webgl --disable-gpu-sandbox"
  echo "Thumbnails: NVIDIA hardware WebGL"
else
  echo "Thumbnails: ${PRINTVENTORY_CHROMIUM_ARGS:+custom Chromium flags}${PRINTVENTORY_CHROMIUM_ARGS:-SwiftShader software WebGL}"
fi

# --- Node heap: ~60% of the container memory limit (2–16 GB), or PRINTVENTORY_MAX_OLD_SPACE_MB ---
resolve_max_old_space_mb() {
  if [ -n "${PRINTVENTORY_MAX_OLD_SPACE_MB:-}" ]; then
    echo "${PRINTVENTORY_MAX_OLD_SPACE_MB}"
    return
  fi
  local limit_bytes=""
  if [ -r /sys/fs/cgroup/memory.max ]; then
    limit_bytes="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    limit_bytes="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)"
  fi
  if [ -z "$limit_bytes" ] || [ "$limit_bytes" = "max" ] || [ "$limit_bytes" -gt 1000000000000 ] 2>/dev/null; then
    echo 8192
    return
  fi
  local heap_mb=$((limit_bytes / 1024 / 1024 * 60 / 100))
  if [ "$heap_mb" -lt 2048 ]; then heap_mb=2048; elif [ "$heap_mb" -gt 16384 ]; then heap_mb=16384; fi
  echo "$heap_mb"
}

MAX_OLD_SPACE_MB="$(resolve_max_old_space_mb)"
echo "Node max-old-space-size: ${MAX_OLD_SPACE_MB}MB (override with PRINTVENTORY_MAX_OLD_SPACE_MB)"

# exec: Node is PID 1's direct replacement, so docker stop's SIGTERM reaches it and it exits cleanly.
exec "${RUN_AS[@]}" node \
  --max-old-space-size="${MAX_OLD_SPACE_MB}" \
  --expose-gc \
  src/server/index.js
