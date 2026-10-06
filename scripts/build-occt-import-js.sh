#!/usr/bin/env bash
# Rebuild vendor/occt-import-js (the STEP/IGES importer the parse worker loads) without dynamic JS,
# so the page's Content Security Policy needs no 'unsafe-eval'. See vendor/occt-import-js/BUILD.md.
#
# Usage: scripts/build-occt-import-js.sh [work-folder]
# Needs git, python3 and about 4 GB of disk. Takes 30 to 60 minutes (OpenCascade is large).
set -euo pipefail

OCCT_IMPORT_JS_TAG=0.0.23
OCCT_COMMIT=d2abb6d844231cb8f29be6894440874a4700e4a5   # the occt submodule commit of that tag
EMSDK_VERSION=3.1.69                                    # what occt-import-js's own build uses

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/occt-import-js-build}"
mkdir -p "$WORK"
cd "$WORK"

# CMake and Ninja in a private Python environment (nothing installed system-wide).
[ -x venv/bin/cmake ] || { python3 -m venv venv && venv/bin/pip install -q cmake ninja; }
export PATH="$WORK/venv/bin:$PATH"

[ -d emsdk ] || git clone -q --depth 1 https://github.com/emscripten-core/emsdk.git
emsdk/emsdk install "$EMSDK_VERSION"
emsdk/emsdk activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh

[ -d occt-import-js ] || git clone -q --branch "$OCCT_IMPORT_JS_TAG" --depth 1 https://github.com/kovacsv/occt-import-js.git
# The submodule's own server (git.dev.opencascade.org) is often unreachable; GitHub mirrors it.
if [ ! -f occt-import-js/occt/CMakeLists.txt ]; then
  rm -rf occt-import-js/occt && mkdir occt-import-js/occt
  git -C occt-import-js/occt init -q
  git -C occt-import-js/occt fetch -q --depth 1 https://github.com/Open-Cascade-SAS/OCCT.git "$OCCT_COMMIT"
  git -C occt-import-js/occt checkout -q FETCH_HEAD
fi

cd occt-import-js
# Upstream settings, plus DYNAMIC_EXECUTION=0: embind then calls into WebAssembly through plain
# closures instead of functions built with new Function. CMAKE_POLICY_VERSION_MINIMUM lets CMake 4
# read OpenCascade's 2022 build files.
emcmake cmake -B build/wasm -G Ninja -DEMSCRIPTEN=1 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_EXE_LINKER_FLAGS="-sDYNAMIC_EXECUTION=0"
cmake --build build/wasm --target OcctImportJS -j "$(getconf _NPROCESSORS_ONLN)"

OUT=build/wasm/Release
if grep -qE 'new Function|newFunc\(Function' "$OUT/occt-import-js.js"; then
  echo "The build still generates code from strings; not copying it." >&2
  exit 1
fi
cp "$OUT/occt-import-js.js" "$OUT/occt-import-js.wasm" "$ROOT/vendor/occt-import-js/"
echo "Copied the rebuilt occt-import-js into vendor/occt-import-js. Run npm test and npm run test:e2e."
