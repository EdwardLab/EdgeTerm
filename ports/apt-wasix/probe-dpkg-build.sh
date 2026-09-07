#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PORT_DIR="$ROOT_DIR/ports/apt-wasix"
CACHE_DIR="$PORT_DIR/.cache"
SOURCE_DIR="$CACHE_DIR/dpkg-1.22.22"
BUILD_DIR="$CACHE_DIR/build"
SYSROOT_ARCHIVE="$CACHE_DIR/wasix-sysroot-v2025-11-06.1.tar.gz"
WASI_SDK_VERSION="33.0"
BINARYEN_VERSION="131"
case "$(uname -m)" in
  arm64|aarch64)
    WASI_SDK_HOST="arm64"
    WASI_SDK_SHA256="4f98ee738c7abb45c81a94d1461fc53cc569d1cd01498951c8184d841a027844"
    BINARYEN_HOST="aarch64"
    BINARYEN_SHA256="ba991f677edd9a21d2bc96c0144bc8ac5b112d4d98a3eb266e075e22e557df2a"
    DOCKER_PLATFORM="linux/arm64"
    ;;
  x86_64|amd64)
    WASI_SDK_HOST="x86_64"
    WASI_SDK_SHA256="0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce"
    BINARYEN_HOST="x86_64"
    BINARYEN_SHA256="b5bf1f0eaf17c63ee588ff7a5954dc8f6ce2c26989051c66f24dfe9ece3e46db"
    DOCKER_PLATFORM="linux/amd64"
    ;;
  *)
    echo "Unsupported build host architecture: $(uname -m)" >&2
    exit 1
    ;;
esac
WASI_SDK_ARCHIVE="$CACHE_DIR/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_HOST-linux.tar.gz"
WASI_SDK_DIR="$CACHE_DIR/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_HOST-linux"
BINARYEN_ARCHIVE="$CACHE_DIR/binaryen-version_$BINARYEN_VERSION-$BINARYEN_HOST-linux.tar.gz"
BINARYEN_DIR="$CACHE_DIR/binaryen-version_$BINARYEN_VERSION-$BINARYEN_HOST-linux"
DPKG_COMMIT="58e5927f9f2103e94574d92edbd93e41ab93384a"
IMAGE="edgeterm-apt-wasix-probe:2026-08-04"

if [[ ! -f "$WASI_SDK_ARCHIVE" ]]; then
  curl -fL --retry 3 \
    --output "$WASI_SDK_ARCHIVE" \
    "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_HOST-linux.tar.gz"
fi

actual_wasi_sdk_sha256=$(shasum -a 256 "$WASI_SDK_ARCHIVE" | awk '{print $1}')
if [[ "$actual_wasi_sdk_sha256" != "$WASI_SDK_SHA256" ]]; then
  echo "wasi-sdk checksum mismatch: $actual_wasi_sdk_sha256" >&2
  exit 1
fi

if [[ ! -x "$WASI_SDK_DIR/bin/clang" ]]; then
  mkdir -p "$WASI_SDK_DIR"
  tar -xzf "$WASI_SDK_ARCHIVE" -C "$WASI_SDK_DIR" --strip-components=1
fi

if [[ ! -f "$BINARYEN_ARCHIVE" ]]; then
  curl -fL --retry 3 \
    --output "$BINARYEN_ARCHIVE" \
    "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN_VERSION/binaryen-version_$BINARYEN_VERSION-$BINARYEN_HOST-linux.tar.gz"
fi

actual_binaryen_sha256=$(sha256sum "$BINARYEN_ARCHIVE" | cut -d" " -f1)
if [[ "$actual_binaryen_sha256" != "$BINARYEN_SHA256" ]]; then
  echo "Binaryen checksum mismatch: $actual_binaryen_sha256" >&2
  exit 1
fi

if [[ ! -x "$BINARYEN_DIR/bin/wasm-opt" ]]; then
  mkdir -p "$BINARYEN_DIR"
  tar -xzf "$BINARYEN_ARCHIVE" -C "$BINARYEN_DIR" --strip-components=1
fi

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone --filter=blob:none --branch 1.22.22 --single-branch \
    https://salsa.debian.org/dpkg-team/dpkg.git "$SOURCE_DIR"
fi

if [[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$DPKG_COMMIT" ]]; then
  echo "Unexpected dpkg source revision" >&2
  exit 1
fi

docker run --rm \
  --platform "$DOCKER_PLATFORM" \
  --volume "$SOURCE_DIR:/source:ro" \
  --volume "$BUILD_DIR:/build" \
  --volume "$PORT_DIR/wasix-apt-compat.c:/toolchain/wasix-apt-compat.c:ro" \
  --volume "$PORT_DIR/wasix-apt-compat.h:/toolchain/wasix-apt-compat.h:ro" \
  --volume "$PORT_DIR/dpkg-wasix-process.patch:/toolchain/dpkg-wasix-process.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-architecture.patch:/toolchain/dpkg-wasix-architecture.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-compat-source.patch:/toolchain/dpkg-wasix-compat-source.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-locking.patch:/toolchain/dpkg-wasix-locking.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-commands.patch:/toolchain/dpkg-wasix-commands.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-spawn.patch:/toolchain/dpkg-wasix-spawn.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-error-context.patch:/toolchain/dpkg-wasix-error-context.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-child-exit.patch:/toolchain/dpkg-wasix-child-exit.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-extract.patch:/toolchain/dpkg-wasix-extract.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-sync.patch:/toolchain/dpkg-wasix-sync.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-pipe.patch:/toolchain/dpkg-wasix-pipe.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-filesystem.patch:/toolchain/dpkg-wasix-filesystem.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-directory-install.patch:/toolchain/dpkg-wasix-directory-install.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-remove.patch:/toolchain/dpkg-wasix-remove.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-short-read.patch:/toolchain/dpkg-wasix-short-read.patch:ro" \
  --volume "$PORT_DIR/dpkg-wasix-parse.patch:/toolchain/dpkg-wasix-parse.patch:ro" \
  --volume "$WASI_SDK_DIR:/wasi-sdk:ro" \
  --volume "$BINARYEN_DIR:/binaryen:ro" \
  --volume "$SYSROOT_ARCHIVE:/toolchain/sysroot.tar.gz:ro" \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    mkdir -p /toolchain/sysroot
    tar -xzf /toolchain/sysroot.tar.gz -C /toolchain/sysroot
    export WASIX_SYSROOT="$(find /toolchain/sysroot -mindepth 2 -maxdepth 2 -type d -name sysroot -print -quit)"
    test -n "$WASIX_SYSROOT"
    export WASI_SDK_BIN=/wasi-sdk/bin
    export CC="$WASI_SDK_BIN/clang --target=wasm32-wasi --sysroot=$WASIX_SYSROOT"
    export CXX="$WASI_SDK_BIN/clang++ --target=wasm32-wasi --sysroot=$WASIX_SYSROOT"
    export AR="$WASI_SDK_BIN/llvm-ar"
    export RANLIB="$WASI_SDK_BIN/llvm-ranlib"
    export NM="$WASI_SDK_BIN/llvm-nm"
    export STRIP="$WASI_SDK_BIN/llvm-strip"
    export PKG_CONFIG_PATH=/build/deps-install/lib/pkgconfig
    export CPPFLAGS="-I/build/deps-install/include -I/toolchain -include /toolchain/wasix-apt-compat.h -DEDGETERM_WASIX_STACK_UPPER=8388608"
    export CFLAGS="-O2 -pthread -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS"
    export CXXFLAGS="$CFLAGS"
    export LDFLAGS="-pthread -L/build/deps-install/lib -Wl,-z,stack-size=8388608 -Wl,--max-memory=1073741824 -Wl,--export=__stack_pointer -Wl,--export=__heap_base -Wl,--export=__data_end -lwasi-emulated-mman -lwasi-emulated-process-clocks"
    export MD_LIBS="-lmd"
    source_key="$(git -C /source rev-parse HEAD):$($WASI_SDK_BIN/clang --version | head -1):layout-usr-etc-var-v17-short-read:$CPPFLAGS:$LDFLAGS:$(sha256sum /toolchain/wasix-apt-compat.c /toolchain/wasix-apt-compat.h /toolchain/dpkg-wasix-process.patch /toolchain/dpkg-wasix-architecture.patch /toolchain/dpkg-wasix-compat-source.patch /toolchain/dpkg-wasix-locking.patch /toolchain/dpkg-wasix-commands.patch /toolchain/dpkg-wasix-spawn.patch /toolchain/dpkg-wasix-error-context.patch /toolchain/dpkg-wasix-child-exit.patch /toolchain/dpkg-wasix-extract.patch /toolchain/dpkg-wasix-sync.patch /toolchain/dpkg-wasix-pipe.patch /toolchain/dpkg-wasix-filesystem.patch /toolchain/dpkg-wasix-directory-install.patch /toolchain/dpkg-wasix-remove.patch /toolchain/dpkg-wasix-short-read.patch /toolchain/dpkg-wasix-parse.patch | sha256sum | cut -d" " -f1)"
    if [[ ! -f /build/dpkg-source/.edgeterm-source-stamp ]] || [[ "$(cat /build/dpkg-source/.edgeterm-source-stamp)" != "$source_key" ]]; then
      rm -rf /build/dpkg-source /build/dpkg-build
      cp -a /source /build/dpkg-source
      cp /toolchain/wasix-apt-compat.c /build/dpkg-source/lib/dpkg/edgeterm-wasix-compat.c
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-process.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-architecture.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-compat-source.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-locking.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-commands.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-spawn.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-error-context.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-child-exit.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-extract.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-sync.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-pipe.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-filesystem.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-directory-install.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-remove.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-short-read.patch
      patch -d /build/dpkg-source -p1 < /toolchain/dpkg-wasix-parse.patch
      (cd /build/dpkg-source && autoreconf -fiv)
      printf "%s\n" "$source_key" > /build/dpkg-source/.edgeterm-source-stamp
    fi
    cd /build/dpkg-source
    mkdir -p /build/dpkg-build
    cd /build/dpkg-build
    /build/dpkg-source/configure \
      --host=wasm32-wasi \
      --prefix=/usr \
      --sysconfdir=/etc \
      --localstatedir=/var \
      --disable-shared \
      --enable-static \
      --disable-nls \
      --disable-dselect \
      --disable-start-stop-daemon \
      --disable-update-alternatives \
      --disable-devel-docs \
      --disable-mmap \
      --disable-disk-preallocate \
      --without-libselinux \
      --with-libz=static \
      --with-libbz2=static \
      --with-liblzma=static \
      --with-libzstd=static
    make -j"${BUILD_JOBS:-2}"
    while IFS= read -r executable; do
      transformed="${executable}.asyncify"
      if [[ "$(basename "$executable")" == "dpkg-deb" ]] ||
         [[ "$(basename "$executable")" == "dpkg" ]]; then
        /binaryen/bin/wasm-opt \
          --enable-reference-types \
          --enable-bulk-memory \
          --asyncify \
          "$executable" \
          -o "$transformed"
        mv "$transformed" "$executable"
        continue
      fi
      if ! /binaryen/bin/wasm-opt \
        --enable-reference-types \
        --enable-bulk-memory \
        --pass-arg=asyncify-ignore-indirect \
        --pass-arg=asyncify-addlist@edgeterm_vfork \
        --pass-arg=asyncify-propagate-addlist \
        --asyncify \
        "$executable" \
        -o "$transformed"; then
        rm -f "$transformed"
        /binaryen/bin/wasm-opt \
          --enable-reference-types \
          --enable-bulk-memory \
          --asyncify \
          "$executable" \
          -o "$transformed"
      fi
      mv "$transformed" "$executable"
    done < <(find /build/dpkg-build -type f -perm -0100 -exec file {} \; | sed -n "s/: WebAssembly.*//p")
    rm -rf /build/dpkg-install
    make install DESTDIR=/build/dpkg-install
  '
