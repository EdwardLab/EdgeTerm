#!/usr/bin/env bash
set -euo pipefail

: "${WASIX_SYSROOT:?WASIX_SYSROOT is required}"

PREFIX=${WASIX_DEPS_PREFIX:-/build/deps-install}
BUILD_ROOT=${WASIX_DEPS_BUILD_ROOT:-/build/deps-build}
TOOLCHAIN=${WASIX_TOOLCHAIN_FILE:-/toolchain/wasix-toolchain.cmake}
JOBS=${BUILD_JOBS:-2}

cmake_static() {
  local source_dir=$1
  local build_dir=$2
  shift 2
  cmake \
    -S "$source_dir" \
    -B "$build_dir" \
    -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DBUILD_SHARED_LIBS=OFF \
    "$@"
  cmake --build "$build_dir" --parallel "$JOBS"
  cmake --install "$build_dir"
}

rm -rf "$BUILD_ROOT" "$PREFIX"
mkdir -p "$BUILD_ROOT" "$PREFIX/include" "$PREFIX/lib"

cmake \
  -S /zlib-source \
  -B "$BUILD_ROOT/zlib" \
  -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_ROOT/zlib" --target zlibstatic --parallel "$JOBS"
install -m 0644 /zlib-source/zlib.h "$PREFIX/include/zlib.h"
install -m 0644 "$BUILD_ROOT/zlib/zconf.h" "$PREFIX/include/zconf.h"
install -m 0644 "$BUILD_ROOT/zlib/libz.a" "$PREFIX/lib/libz.a"

mkdir -p "$BUILD_ROOT/bzip2"
cp -a /bzip2-source/. "$BUILD_ROOT/bzip2/"
make -C "$BUILD_ROOT/bzip2" \
  CC="$CC" \
  AR="$AR" \
  RANLIB="$RANLIB" \
  CFLAGS="$CFLAGS -fPIC" \
  libbz2.a \
  -j"$JOBS"
install -m 0644 "$BUILD_ROOT/bzip2/bzlib.h" "$PREFIX/include/bzlib.h"
install -m 0644 "$BUILD_ROOT/bzip2/libbz2.a" "$PREFIX/lib/libbz2.a"

cmake_static /xz-source "$BUILD_ROOT/xz" \
  -DBUILD_TESTING=OFF \
  -DXZ_THREADS=no \
  -DTUKLIB_CPUCORES_SCHED_GETAFFINITY=FALSE \
  -DXZ_NLS=OFF \
  -DXZ_TOOL_XZ=OFF \
  -DXZ_TOOL_XZDEC=OFF \
  -DXZ_TOOL_LZMADEC=OFF \
  -DXZ_TOOL_LZMAINFO=OFF \
  -DXZ_DOC=OFF

cmake_static /lz4-source/build/cmake "$BUILD_ROOT/lz4" \
  -DBUILD_STATIC_LIBS=ON \
  -DLZ4_BUILD_CLI=OFF \
  -DLZ4_POSITION_INDEPENDENT_LIB=ON

cmake_static /xxhash-source/cmake_unofficial "$BUILD_ROOT/xxhash" \
  -DXXHASH_BUILD_XXHSUM=OFF

cmake_static /zstd-source/build/cmake "$BUILD_ROOT/zstd" \
  -DZSTD_BUILD_SHARED=OFF \
  -DZSTD_BUILD_STATIC=ON \
  -DZSTD_BUILD_PROGRAMS=OFF \
  -DZSTD_BUILD_TESTS=OFF \
  -DZSTD_BUILD_CONTRIB=OFF \
  -DZSTD_MULTITHREAD_SUPPORT=OFF
