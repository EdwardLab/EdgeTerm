#!/usr/bin/env bash
set -euo pipefail

: "${CC:?CC is required}"
: "${AR:?AR is required}"
: "${RANLIB:?RANLIB is required}"

PREFIX=${WASIX_DEPS_PREFIX:-/build/deps-install}
BUILD_DIR=${WASIX_LIBMD_BUILD_DIR:-/build/libmd-build-v2}
JOBS=${BUILD_JOBS:-2}

mkdir -p "$BUILD_DIR"
tar -C /libmd-source --exclude=.git -cf - . | tar -C "$BUILD_DIR" -xf -
printf '%s\n' '1.1.0' > "$BUILD_DIR/.dist-version"
cd "$BUILD_DIR"
autoreconf -fiv
./configure \
  --host=wasm32-wasi \
  --prefix="$PREFIX" \
  --disable-shared \
  --enable-static
make -j"$JOBS"
make install
