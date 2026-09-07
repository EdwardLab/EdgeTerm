#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PORT_DIR="$ROOT_DIR/ports/apt-wasix"
CACHE_DIR="$PORT_DIR/.cache"
SOURCE_DIR="$CACHE_DIR/apt"
OPENSSL_SOURCE_DIR="$CACHE_DIR/openssl"
ZLIB_SOURCE_DIR="$CACHE_DIR/zlib"
BZIP2_SOURCE_DIR="$CACHE_DIR/bzip2"
XZ_SOURCE_DIR="$CACHE_DIR/xz"
LZ4_SOURCE_DIR="$CACHE_DIR/lz4"
XXHASH_SOURCE_DIR="$CACHE_DIR/xxhash"
ZSTD_SOURCE_DIR="$CACHE_DIR/zstd"
LIBMD_SOURCE_DIR="$CACHE_DIR/libmd"
BUILD_DIR="$CACHE_DIR/build"
WASIX_LIBC_RELEASE="v2025-11-06.1"
WASIX_SYSROOT_SHA256="45c00faa96ccdc7d35c7505453a61b64cea1857fe61fd3c7ee1242f4d55ae505"
DEFAULT_SYSROOT_ARCHIVE="$CACHE_DIR/wasix-sysroot-$WASIX_LIBC_RELEASE.tar.gz"
SYSROOT_ARCHIVE="${WASIX_SYSROOT_ARCHIVE:-$DEFAULT_SYSROOT_ARCHIVE}"
WASI_SDK_VERSION="33.0"
case "$(uname -m)" in
  arm64|aarch64)
    WASI_SDK_HOST="arm64"
    WASI_SDK_SHA256="4f98ee738c7abb45c81a94d1461fc53cc569d1cd01498951c8184d841a027844"
    DOCKER_PLATFORM="linux/arm64"
    ;;
  x86_64|amd64)
    WASI_SDK_HOST="x86_64"
    WASI_SDK_SHA256="0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce"
    DOCKER_PLATFORM="linux/amd64"
    ;;
  *)
    echo "Unsupported build host architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
WASI_SDK_ARCHIVE="$CACHE_DIR/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_HOST-linux.tar.gz"
WASI_SDK_DIR="$CACHE_DIR/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_HOST-linux"
APT_COMMIT="5e6dcc8d0c8bdce61e9cc7f497abadb5349d509a"
OPENSSL_COMMIT="8cf17aaeb4599f8af87fefd810b5b5fee90fe69e"
ZLIB_COMMIT="216c70c020aa53f0c40920d155f808b6b59c9acb"
BZIP2_COMMIT="75a94bea3918e612b879d6a11ca64b8689526147"
XZ_COMMIT="87a90e3bb803a35289eaf98e1aa47844d7f57774"
LZ4_COMMIT="ebb370ca83af193212df4dcbadcc5d87bc0de2f0"
XXHASH_COMMIT="e626a72bc2321cd320e953a0ccf1584cad60f363"
ZSTD_COMMIT="ac66b19e6bd6b83238bf008eecc1298105298532"
LIBMD_COMMIT="16d68ab76eee25bf8ec807aff9a6ea7e0f135019"
IMAGE="edgeterm-apt-wasix-probe:2026-08-04"

mkdir -p "$CACHE_DIR" "$BUILD_DIR"

if [[ "$SYSROOT_ARCHIVE" == "$DEFAULT_SYSROOT_ARCHIVE" && ! -f "$SYSROOT_ARCHIVE" ]]; then
  curl -fL --retry 3 \
    --output "$SYSROOT_ARCHIVE" \
    "https://github.com/wasix-org/wasix-libc/releases/download/$WASIX_LIBC_RELEASE/sysroot.tar.gz"
fi

if [[ ! -f "$SYSROOT_ARCHIVE" ]]; then
  echo "WASIX sysroot archive not found: $SYSROOT_ARCHIVE" >&2
  exit 1
fi

if [[ ! -f "$WASI_SDK_ARCHIVE" ]]; then
  curl -fL --retry 3 \
    --output "$WASI_SDK_ARCHIVE" \
    "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_HOST-linux.tar.gz"
fi

actual_wasi_sdk_sha256=$(sha256sum "$WASI_SDK_ARCHIVE" | cut -d" " -f1)
if [[ "$actual_wasi_sdk_sha256" != "$WASI_SDK_SHA256" ]]; then
  echo "wasi-sdk checksum mismatch: $actual_wasi_sdk_sha256" >&2
  exit 1
fi

if [[ ! -x "$WASI_SDK_DIR/bin/clang++" ]]; then
  mkdir -p "$WASI_SDK_DIR"
  tar -xzf "$WASI_SDK_ARCHIVE" -C "$WASI_SDK_DIR" --strip-components=1
fi

actual_sysroot_sha256=$(sha256sum "$SYSROOT_ARCHIVE" | cut -d" " -f1)
if [[ "$SYSROOT_ARCHIVE" == "$DEFAULT_SYSROOT_ARCHIVE" && "$actual_sysroot_sha256" != "$WASIX_SYSROOT_SHA256" ]]; then
  echo "WASIX sysroot checksum mismatch: $actual_sysroot_sha256" >&2
  exit 1
fi

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone https://salsa.debian.org/apt-team/apt.git "$SOURCE_DIR"
fi

if ! git -C "$SOURCE_DIR" cat-file -e "$APT_COMMIT^{commit}" 2>/dev/null; then
  git -C "$SOURCE_DIR" fetch origin "$APT_COMMIT"
fi
git -C "$SOURCE_DIR" checkout --detach "$APT_COMMIT"

if ! git -C "$SOURCE_DIR" diff --quiet --ignore-submodules --; then
  echo "Pinned APT source cache contains local changes; refusing to build from a contaminated source tree." >&2
  exit 1
fi

if [[ ! -d "$OPENSSL_SOURCE_DIR/.git" ]]; then
  git clone https://github.com/openssl/openssl.git "$OPENSSL_SOURCE_DIR"
fi

if ! git -C "$OPENSSL_SOURCE_DIR" cat-file -e "$OPENSSL_COMMIT^{commit}" 2>/dev/null; then
  git -C "$OPENSSL_SOURCE_DIR" fetch origin "$OPENSSL_COMMIT"
fi
git -C "$OPENSSL_SOURCE_DIR" checkout --detach "$OPENSSL_COMMIT"

fetch_source() {
  local url=$1
  local directory=$2
  local commit=$3
  if [[ ! -d "$directory/.git" ]]; then
    git clone --filter=blob:none "$url" "$directory"
  fi
  if ! git -C "$directory" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git -C "$directory" fetch origin "$commit"
  fi
  git -C "$directory" checkout --detach "$commit"
}

fetch_source https://github.com/madler/zlib.git "$ZLIB_SOURCE_DIR" "$ZLIB_COMMIT"
fetch_source https://sourceware.org/git/bzip2.git "$BZIP2_SOURCE_DIR" "$BZIP2_COMMIT"
fetch_source https://github.com/tukaani-project/xz.git "$XZ_SOURCE_DIR" "$XZ_COMMIT"
fetch_source https://github.com/lz4/lz4.git "$LZ4_SOURCE_DIR" "$LZ4_COMMIT"
fetch_source https://github.com/Cyan4973/xxHash.git "$XXHASH_SOURCE_DIR" "$XXHASH_COMMIT"
fetch_source https://github.com/facebook/zstd.git "$ZSTD_SOURCE_DIR" "$ZSTD_COMMIT"
fetch_source https://git.hadrons.org/git/libmd.git "$LIBMD_SOURCE_DIR" "$LIBMD_COMMIT"

docker build \
  --platform "$DOCKER_PLATFORM" \
  --tag "$IMAGE" \
  --file "$PORT_DIR/Dockerfile" \
  "$PORT_DIR"

docker run --rm \
  --platform "$DOCKER_PLATFORM" \
  --env EDGETERM_APT_CLEAN="${EDGETERM_APT_CLEAN:-0}" \
  --volume "$SOURCE_DIR:/source:ro" \
  --volume "$OPENSSL_SOURCE_DIR:/openssl-source:ro" \
  --volume "$ZLIB_SOURCE_DIR:/zlib-source:ro" \
  --volume "$BZIP2_SOURCE_DIR:/bzip2-source:ro" \
  --volume "$XZ_SOURCE_DIR:/xz-source:ro" \
  --volume "$LZ4_SOURCE_DIR:/lz4-source:ro" \
  --volume "$XXHASH_SOURCE_DIR:/xxhash-source:ro" \
  --volume "$ZSTD_SOURCE_DIR:/zstd-source:ro" \
  --volume "$LIBMD_SOURCE_DIR:/libmd-source:ro" \
  --volume "$BUILD_DIR:/build" \
  --volume "$WASI_SDK_DIR:/wasi-sdk:ro" \
  --volume "$PORT_DIR/build-dependencies.sh:/toolchain/build-dependencies.sh:ro" \
  --volume "$PORT_DIR/build-libmd.sh:/toolchain/build-libmd.sh:ro" \
  --volume "$PORT_DIR/openssl-wasix.conf:/toolchain/openssl-wasix.conf:ro" \
  --volume "$PORT_DIR/wasix-apt-compat.c:/toolchain/wasix-apt-compat.c:ro" \
  --volume "$PORT_DIR/wasix-apt-compat.h:/toolchain/wasix-apt-compat.h:ro" \
  --volume "$PORT_DIR/resolv.h:/toolchain/resolv.h:ro" \
  --volume "$PORT_DIR/without-ftparchive.patch:/toolchain/without-ftparchive.patch:ro" \
  --volume "$PORT_DIR/clang-incomplete-type.patch:/toolchain/clang-incomplete-type.patch:ro" \
  --volume "$PORT_DIR/clang-string-view.patch:/toolchain/clang-string-view.patch:ro" \
  --volume "$PORT_DIR/platform-filesystem.patch:/toolchain/platform-filesystem.patch:ro" \
  --volume "$PORT_DIR/wasix-process.patch:/toolchain/wasix-process.patch:ro" \
  --volume "$PORT_DIR/wasix-posix-spawn.patch:/toolchain/wasix-posix-spawn.patch:ro" \
  --volume "$PORT_DIR/wasix-clock.patch:/toolchain/wasix-clock.patch:ro" \
  --volume "$PORT_DIR/wasix-locking.patch:/toolchain/wasix-locking.patch:ro" \
  --volume "$PORT_DIR/wasix-storage.patch:/toolchain/wasix-storage.patch:ro" \
  --volume "$PORT_DIR/wasix-no-exceptions.patch:/toolchain/wasix-no-exceptions.patch:ro" \
  --volume "$PORT_DIR/wasix-browser-exit.patch:/toolchain/wasix-browser-exit.patch:ro" \
  --volume "$PORT_DIR/wasix-terminal-output.patch:/toolchain/wasix-terminal-output.patch:ro" \
  --volume "$PORT_DIR/wasix-file-write-context.patch:/toolchain/wasix-file-write-context.patch:ro" \
  --volume "$PORT_DIR/wasix-mmap-fallback.patch:/toolchain/wasix-mmap-fallback.patch:ro" \
  --volume "$PORT_DIR/wasix-temp-file.patch:/toolchain/wasix-temp-file.patch:ro" \
  --volume "$PORT_DIR/apt-config-debsystem.patch:/toolchain/apt-config-debsystem.patch:ro" \
  --volume "$PORT_DIR/wasix-toolchain.cmake:/toolchain/wasix-toolchain.cmake:ro" \
  --volume "$SYSROOT_ARCHIVE:/toolchain/sysroot.tar.gz:ro" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    mkdir -p /toolchain/sysroot
    tar -xzf /toolchain/sysroot.tar.gz -C /toolchain/sysroot
    export WASIX_SYSROOT="$(find /toolchain/sysroot -mindepth 2 -maxdepth 2 -type d -name sysroot -print -quit)"
    test -n "$WASIX_SYSROOT"
    export OPENSSL_LOCAL_CONFIG_DIR=/toolchain
    export WASIX_DEPS_PREFIX=/build/deps-install
    export WASIX_TOOLCHAIN_FILE=/toolchain/wasix-toolchain.cmake
    export WASI_SDK_BIN=/wasi-sdk/bin
    export CC="$WASI_SDK_BIN/clang --target=wasm32-wasi --sysroot=$WASIX_SYSROOT"
    export CXX="$WASI_SDK_BIN/clang++ --target=wasm32-wasi --sysroot=$WASIX_SYSROOT"
    export AR="$WASI_SDK_BIN/llvm-ar"
    export RANLIB="$WASI_SDK_BIN/llvm-ranlib"
    export CFLAGS="-pthread -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -I/toolchain -include /toolchain/wasix-apt-compat.h"
    export CXXFLAGS="-fno-exceptions $CFLAGS"
    export LDFLAGS="-pthread -Wl,-z,stack-size=4194304 -Wl,--max-memory=1073741824 -Wl,-u,debSys -lwasi-emulated-mman -lwasi-emulated-process-clocks"
    sysroot_key="$(sha256sum /toolchain/sysroot.tar.gz | cut -d" " -f1):$($WASI_SDK_BIN/clang --version | head -1)"
    openssl_key="$(git -C /openssl-source rev-parse HEAD):$sysroot_key:$CFLAGS:no-threads:$(sha256sum /toolchain/openssl-wasix.conf | cut -d" " -f1)"
    if [[ -f /build/openssl-install/lib/libcrypto.a && -f /build/openssl-install/lib/libssl.a && ! -f /build/openssl-install/.edgeterm-build-stamp ]]; then
      printf "%s\n" "$openssl_key" > /build/openssl-install/.edgeterm-build-stamp
    fi
    if [[ ! -f /build/openssl-install/.edgeterm-build-stamp ]] || [[ "$(cat /build/openssl-install/.edgeterm-build-stamp)" != "$openssl_key" ]]; then
      rm -rf /build/openssl-source /build/openssl-install
      cp -a /openssl-source /build/openssl-source
      cd /build/openssl-source
      perl Configure wasix32 \
        --prefix=/build/openssl-install \
        --openssldir=/etc/ssl \
        no-shared \
        no-tests \
        no-module \
        no-dso \
        no-dgram \
        no-asm \
        no-async \
        no-threads
      make -j"${BUILD_JOBS:-2}" build_libs
      make install_dev
      printf "%s\n" "$openssl_key" > /build/openssl-install/.edgeterm-build-stamp
    fi
    deps_key="$sysroot_key:$CFLAGS:$(git -C /zlib-source rev-parse HEAD):$(git -C /bzip2-source rev-parse HEAD):$(git -C /xz-source rev-parse HEAD):$(git -C /lz4-source rev-parse HEAD):$(git -C /xxhash-source rev-parse HEAD):$(git -C /zstd-source rev-parse HEAD):$(sha256sum /toolchain/build-dependencies.sh /toolchain/wasix-toolchain.cmake | sha256sum | cut -d" " -f1)"
    if [[ ! -f /build/deps-install/.edgeterm-build-stamp ]] || [[ "$(cat /build/deps-install/.edgeterm-build-stamp)" != "$deps_key" ]]; then
      /toolchain/build-dependencies.sh
      printf "%s\n" "$deps_key" > /build/deps-install/.edgeterm-build-stamp
    fi
    libmd_key="$sysroot_key:$CFLAGS:$(git -C /libmd-source rev-parse HEAD):$(sha256sum /toolchain/build-libmd.sh | cut -d" " -f1)"
    if [[ ! -f /build/deps-install/.edgeterm-libmd-stamp ]] || [[ "$(cat /build/deps-install/.edgeterm-libmd-stamp)" != "$libmd_key" ]]; then
      /toolchain/build-libmd.sh
      printf "%s\n" "$libmd_key" > /build/deps-install/.edgeterm-libmd-stamp
    fi
    export PKG_CONFIG_PATH=/build/deps-install/lib/pkgconfig:/build/deps-install/lib64/pkgconfig
    apt_source_key="$(git -C /source rev-parse HEAD):$sysroot_key:$CFLAGS:$CXXFLAGS:$LDFLAGS:$(sha256sum /toolchain/wasix-toolchain.cmake /toolchain/resolv.h /toolchain/wasix-apt-compat.c /toolchain/wasix-apt-compat.h /toolchain/without-ftparchive.patch /toolchain/clang-incomplete-type.patch /toolchain/clang-string-view.patch /toolchain/platform-filesystem.patch /toolchain/wasix-process.patch /toolchain/wasix-posix-spawn.patch /toolchain/wasix-clock.patch /toolchain/wasix-locking.patch /toolchain/wasix-storage.patch /toolchain/wasix-no-exceptions.patch /toolchain/wasix-browser-exit.patch /toolchain/wasix-terminal-output.patch /toolchain/wasix-file-write-context.patch /toolchain/wasix-mmap-fallback.patch /toolchain/wasix-temp-file.patch /toolchain/apt-config-debsystem.patch | sha256sum | cut -d" " -f1)"
    if [[ ! -f /build/apt-source/.edgeterm-source-stamp ]] || [[ "$(cat /build/apt-source/.edgeterm-source-stamp)" != "$apt_source_key" ]]; then
      rm -rf /build/apt-source /build/apt-cmake
      cp -a /source /build/apt-source
      patch -d /build/apt-source -p1 < /toolchain/without-ftparchive.patch
      patch -d /build/apt-source -p1 < /toolchain/clang-incomplete-type.patch
      patch -d /build/apt-source -p1 < /toolchain/clang-string-view.patch
      patch -d /build/apt-source -p1 < /toolchain/platform-filesystem.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-process.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-posix-spawn.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-clock.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-locking.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-storage.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-no-exceptions.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-browser-exit.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-terminal-output.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-file-write-context.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-mmap-fallback.patch
      patch -d /build/apt-source -p1 < /toolchain/wasix-temp-file.patch
      patch -d /build/apt-source -p1 < /toolchain/apt-config-debsystem.patch
      printf "%s\n" "$apt_source_key" > /build/apt-source/.edgeterm-source-stamp
    fi
    cmake \
      -S /build/apt-source \
      -B /build/apt-cmake \
      -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE=/toolchain/wasix-toolchain.cmake \
      -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS" \
      -DCMAKE_INSTALL_PREFIX=/usr \
      -DCMAKE_INSTALL_SYSCONFDIR=/etc \
      -DCMAKE_INSTALL_LOCALSTATEDIR=/var \
      -DCOMMON_ARCH=wasm32-wasix \
      -DROOT_GROUP=root \
      -DSTATE_DIR=/var/lib/apt \
      -DCACHE_DIR=/var/cache/apt \
      -DLOG_DIR=/var/log/apt \
      -DCONF_DIR=/etc/apt \
      -DLIBEXEC_DIR=/usr/lib/apt/methods \
      -DBIN_DIR=/usr/bin \
      -DWITH_DOC=OFF \
      -DWITH_TESTS=OFF \
      -DWASIX_STATIC=ON \
      -DWASIX_APT_COMPAT_SOURCE=/toolchain/wasix-apt-compat.c \
      -DBUILD_APT_FTPARCHIVE=OFF \
      -DOPENSSL_INCLUDE_DIR=/build/openssl-install/include \
      -DOPENSSL_CRYPTO_LIBRARY=/build/openssl-install/lib/libcrypto.a \
      -DOPENSSL_SSL_LIBRARY=/build/openssl-install/lib/libssl.a \
      -DZLIB_INCLUDE_DIR=/build/deps-install/include \
      -DZLIB_LIBRARY=/build/deps-install/lib/libz.a \
      -DBZIP2_INCLUDE_DIR=/build/deps-install/include \
      -DBZIP2_LIBRARIES=/build/deps-install/lib/libbz2.a \
      -DUSE_NLS=ON
    if [[ "${EDGETERM_APT_CLEAN:-0}" == "1" ]]; then
      cmake --build /build/apt-cmake --target clean
    fi
    cmake --build /build/apt-cmake \
      --parallel "${BUILD_JOBS:-2}" \
      --target apt apt-cache apt-get apt-config apt-mark file copy store http gpgv
  '
