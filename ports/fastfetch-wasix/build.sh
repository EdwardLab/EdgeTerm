#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PORT_DIR="$ROOT_DIR/ports/fastfetch-wasix"
CACHE_DIR="$PORT_DIR/.cache"
SOURCE_CACHE="$CACHE_DIR/fastfetch"
BUILD_ROOT="$CACHE_DIR/build"
SOURCE_DIR="$BUILD_ROOT/source"
BUILD_DIR="$BUILD_ROOT/cmake"
OUTPUT_DIR="$ROOT_DIR/runtime-packages/apt-repository"
FASTFETCH_COMMIT="08698098579bb8b043b0a343159b8018f5cea4fc"
FASTFETCH_VERSION="2.66.0"
WASIX_SYSROOT_ARCHIVE="$ROOT_DIR/ports/apt-wasix/.cache/wasix-sysroot-v2025-11-06.1.tar.gz"
WASI_SDK_DIR="$ROOT_DIR/ports/apt-wasix/.cache/wasi-sdk-33.0-arm64-linux"
IMAGE="edgeterm-apt-wasix-probe:2026-08-04"

mkdir -p "$CACHE_DIR" "$BUILD_ROOT" "$OUTPUT_DIR"

if [[ ! -d "$SOURCE_CACHE/.git" ]]; then
  git clone https://github.com/fastfetch-cli/fastfetch.git "$SOURCE_CACHE"
fi
if ! git -C "$SOURCE_CACHE" cat-file -e "$FASTFETCH_COMMIT^{commit}" 2>/dev/null; then
  git -C "$SOURCE_CACHE" fetch origin "$FASTFETCH_COMMIT"
fi
if [[ ! -f "$WASIX_SYSROOT_ARCHIVE" ]]; then
  echo "WASIX sysroot archive not found: $WASIX_SYSROOT_ARCHIVE" >&2
  exit 1
fi
if [[ ! -x "$WASI_SDK_DIR/bin/clang" ]]; then
  echo "WASI SDK not found: $WASI_SDK_DIR" >&2
  exit 1
fi

docker run --rm \
  --platform linux/arm64 \
  --volume "$SOURCE_CACHE:/source-cache:ro" \
  --volume "$BUILD_ROOT:/build" \
  --volume "$WASI_SDK_DIR:/wasi-sdk:ro" \
  --volume "$WASIX_SYSROOT_ARCHIVE:/toolchain/sysroot.tar.gz:ro" \
  --volume "$ROOT_DIR/ports/apt-wasix/wasix-toolchain.cmake:/toolchain/wasix-toolchain.cmake:ro" \
  --volume "$PORT_DIR/fastfetch-wasix.patch:/toolchain/fastfetch-wasix.patch:ro" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    find /build/source -mindepth 1 -delete 2>/dev/null || true
    mkdir -p /build/source /build/cmake /toolchain/sysroot
    git -C /source-cache archive "'"$FASTFETCH_COMMIT"'" | tar -x -C /build/source
    patch -d /build/source -p1 < /toolchain/fastfetch-wasix.patch
    tar -xzf /toolchain/sysroot.tar.gz -C /toolchain/sysroot
    export WASIX_SYSROOT="$(find /toolchain/sysroot -mindepth 2 -maxdepth 2 -type d -name sysroot -print -quit)"
    export WASIX_DEPS_PREFIX=/build/empty-deps
    export WASI_SDK_BIN=/wasi-sdk/bin
    cmake \
      -S /build/source \
      -B /build/cmake \
      -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE=/toolchain/wasix-toolchain.cmake \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_FLAGS="-D_WASI_EMULATED_PROCESS_CLOCKS" \
      -DCMAKE_EXE_LINKER_FLAGS="-Wl,-z,stack-size=2097152 -Wl,--max-memory=268435456 -lwasi-emulated-process-clocks" \
      -DDEFAULT_STRUCTURE="Title:Separator:OS:Kernel:Uptime:Packages:Shell:Terminal:CPU:Memory:Locale:Break:Colors" \
      -DENABLE_ZLIB=OFF \
      -DENABLE_THREADS=OFF \
      -DENABLE_LTO=OFF \
      -DENABLE_WORDEXP=OFF \
      -DENABLE_LUA=OFF \
      -DENABLE_QUICKJS=OFF \
      -DENABLE_LIBZFS=OFF \
      -DBUILD_FLASHFETCH=OFF \
      -DBUILD_TESTS=OFF \
      -DBINARY_LINK_TYPE=static
    cmake --build /build/cmake --parallel "${BUILD_JOBS:-4}" --target fastfetch
  '

install -m 755 "$BUILD_DIR/fastfetch" "$OUTPUT_DIR/fastfetch-$FASTFETCH_VERSION-wasm32-wasix"
echo "Built $OUTPUT_DIR/fastfetch-$FASTFETCH_VERSION-wasm32-wasix"
