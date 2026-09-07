#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PORT_DIR="$ROOT_DIR/ports/apt-wasix"
CACHE_DIR="$PORT_DIR/.cache"
APT_BUILD_DIR="$CACHE_DIR/build/apt-cmake"
DPKG_BUILD_DIR="$CACHE_DIR/build/dpkg-build"
STAGE_DIR="$CACHE_DIR/runtime-package"
OUTPUT_DIR="$ROOT_DIR/runtime-packages/external-shell"
OUTPUT_FILE="$OUTPUT_DIR/edgeterm-posix-apt.webc"
TEMP_OUTPUT_DIR=""

cleanup() {
  if [[ -n "$TEMP_OUTPUT_DIR" && -d "$TEMP_OUTPUT_DIR" ]]; then
    rmdir "$TEMP_OUTPUT_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

command -v wasmer >/dev/null 2>&1 || {
  echo "Wasmer CLI is required to package the runtime." >&2
  exit 1
}

copy_module() {
  local source=$1
  local destination=$2
  if [[ ! -f "$source" ]]; then
    echo "Required WASIX module is missing: $source" >&2
    exit 1
  fi
  cp "$source" "$STAGE_DIR/$destination"
}

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$OUTPUT_DIR"

copy_module "$CACHE_DIR/busybox-1.38.0-wasix.wasm" busybox.wasm
copy_module "$APT_BUILD_DIR/cmdline/apt" apt.wasm
copy_module "$APT_BUILD_DIR/cmdline/apt-cache" apt-cache.wasm
copy_module "$APT_BUILD_DIR/cmdline/apt-get" apt-get.wasm
copy_module "$APT_BUILD_DIR/cmdline/apt-config" apt-config.wasm
copy_module "$APT_BUILD_DIR/cmdline/apt-mark" apt-mark.wasm
copy_module "$APT_BUILD_DIR/methods/file" apt-method-file.wasm
copy_module "$APT_BUILD_DIR/methods/copy" apt-method-copy.wasm
copy_module "$APT_BUILD_DIR/methods/store" apt-method-store.wasm
copy_module "$APT_BUILD_DIR/methods/http" apt-method-http.wasm
copy_module "$APT_BUILD_DIR/methods/gpgv" apt-method-gpgv.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg" dpkg.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg-deb" dpkg-deb.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg-query" dpkg-query.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg-divert" dpkg-divert.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg-realpath" dpkg-realpath.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg-split" dpkg-split.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg-statoverride" dpkg-statoverride.wasm
copy_module "$DPKG_BUILD_DIR/src/dpkg-trigger" dpkg-trigger.wasm

mkdir -p "$STAGE_DIR/dpkg-data"
for data_file in cputable ostable tupletable abitable; do
  cp "$CACHE_DIR/build/dpkg-source/data/$data_file" "$STAGE_DIR/dpkg-data/$data_file"
done

mkdir -p "$STAGE_DIR/bin"
for applet in \
  busybox ash sh tar rm cat diff chmod chown chgrp cp ln mkdir mv rmdir touch \
  gzip gunzip xz unxz; do
  cp "$STAGE_DIR/busybox.wasm" "$STAGE_DIR/bin/$applet"
done
for command in \
  apt apt-cache apt-get apt-config apt-mark \
  dpkg dpkg-deb dpkg-query dpkg-divert \
  dpkg-realpath dpkg-split dpkg-statoverride dpkg-trigger; do
  cp "$STAGE_DIR/$command.wasm" "$STAGE_DIR/bin/$command"
done
cp "$STAGE_DIR/apt-method-file.wasm" "$STAGE_DIR/bin/file"
cp "$STAGE_DIR/apt-method-copy.wasm" "$STAGE_DIR/bin/copy"
cp "$STAGE_DIR/apt-method-store.wasm" "$STAGE_DIR/bin/store"
cp "$STAGE_DIR/apt-method-http.wasm" "$STAGE_DIR/bin/http"
cp "$STAGE_DIR/apt-method-http.wasm" "$STAGE_DIR/bin/https"
cp "$STAGE_DIR/apt-method-gpgv.wasm" "$STAGE_DIR/bin/gpgv"
chmod 755 "$STAGE_DIR/bin/"*

cp "$PORT_DIR/runtime-package.toml" "$STAGE_DIR/wasmer.toml"
TEMP_OUTPUT_DIR=$(mktemp -d "$OUTPUT_DIR/.package.XXXXXX")
wasmer package build "$STAGE_DIR/wasmer.toml" --out "$TEMP_OUTPUT_DIR/edgeterm-posix-apt.webc"
mv "$TEMP_OUTPUT_DIR/edgeterm-posix-apt.webc" "$OUTPUT_FILE"

sha256=$(shasum -a 256 "$OUTPUT_FILE" | awk '{print $1}')
bytes=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')
abitable_sha=$(shasum -a 256 "$STAGE_DIR/dpkg-data/abitable" | awk '{print $1}')
cputable_sha=$(shasum -a 256 "$STAGE_DIR/dpkg-data/cputable" | awk '{print $1}')
ostable_sha=$(shasum -a 256 "$STAGE_DIR/dpkg-data/ostable" | awk '{print $1}')
tupletable_sha=$(shasum -a 256 "$STAGE_DIR/dpkg-data/tupletable" | awk '{print $1}')
abitable_data=$(base64 < "$STAGE_DIR/dpkg-data/abitable" | tr -d '\n')
cputable_data=$(base64 < "$STAGE_DIR/dpkg-data/cputable" | tr -d '\n')
ostable_data=$(base64 < "$STAGE_DIR/dpkg-data/ostable" | tr -d '\n')
tupletable_data=$(base64 < "$STAGE_DIR/dpkg-data/tupletable" | tr -d '\n')
cat > "$OUTPUT_DIR/runtime-manifest.json" <<EOF
{
  "schema": "edgeterm.external-runtime.v1",
  "runtime": "busybox-wasix",
  "version": "apt-3.3.2-dpkg-1.22.22",
  "license": "GPL-2.0-only",
  "artifact": {
    "file": "edgeterm-posix-apt.webc",
    "sha256": "$sha256",
    "bytes": $bytes
  },
  "filesystem": {
    "usr/share/dpkg/abitable": { "sha256": "$abitable_sha", "data": "$abitable_data" },
    "usr/share/dpkg/cputable": { "sha256": "$cputable_sha", "data": "$cputable_data" },
    "usr/share/dpkg/ostable": { "sha256": "$ostable_sha", "data": "$ostable_data" },
    "usr/share/dpkg/tupletable": { "sha256": "$tupletable_sha", "data": "$tupletable_data" }
  }
}
EOF

echo "Packaged original APT and dpkg runtime: $OUTPUT_FILE"
