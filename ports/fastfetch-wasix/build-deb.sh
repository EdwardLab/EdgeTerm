#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PORT_DIR="$ROOT_DIR/ports/fastfetch-wasix"
OUTPUT_DIR="$ROOT_DIR/tests/fixtures/apt-repository"
BUILD_OUTPUT="$ROOT_DIR/runtime-packages/apt-repository/fastfetch-2.66.0-wasm32-wasix"
PACKAGE_VERSION="2.66.0-1edgeterm1"
PACKAGE_FILE="fastfetch_${PACKAGE_VERSION}_wasm32-wasix.deb"
WORK_DIR=$(mktemp -d)
trap 'find "$WORK_DIR" -mindepth 1 -delete 2>/dev/null || true; rmdir "$WORK_DIR" 2>/dev/null || true' EXIT

if [[ ! -x "$BUILD_OUTPUT" ]]; then
  "$PORT_DIR/build.sh"
fi

mkdir -p \
  "$WORK_DIR/package/DEBIAN" \
  "$WORK_DIR/package/usr/local/bin" \
  "$WORK_DIR/package/usr/share/doc/fastfetch"

printf '%s\n' \
  "Package: fastfetch" \
  "Version: $PACKAGE_VERSION" \
  "Section: utils" \
  "Priority: optional" \
  "Architecture: wasm32-wasix" \
  "Maintainer: EdgeTerm Project <support@digitalplat.org>" \
  "Homepage: https://github.com/fastfetch-cli/fastfetch" \
  "Description: Fastfetch system information tool for EdgeTerm" \
  > "$WORK_DIR/package/DEBIAN/control"

install -m 755 "$BUILD_OUTPUT" "$WORK_DIR/package/usr/local/bin/fastfetch"
install -m 644 "$PORT_DIR/.cache/fastfetch/LICENSE" "$WORK_DIR/package/usr/share/doc/fastfetch/copyright"

mkdir -p "$OUTPUT_DIR"
docker run --rm \
  --volume "$WORK_DIR:/work" \
  --volume "$OUTPUT_DIR:/output" \
  ubuntu:24.04 \
  dpkg-deb --root-owner-group --build /work/package "/output/$PACKAGE_FILE"

package_size=$(wc -c < "$OUTPUT_DIR/$PACKAGE_FILE" | tr -d ' ')
package_sha256=$(shasum -a 256 "$OUTPUT_DIR/$PACKAGE_FILE" | awk '{print $1}')
installed_size=$(du -k "$WORK_DIR/package/usr/local/bin/fastfetch" | awk '{print $1}')

if [[ ! -f "$OUTPUT_DIR/Packages" ]]; then
  : > "$OUTPUT_DIR/Packages"
fi
awk 'BEGIN { RS=""; ORS="\n\n" } $0 !~ /^Package: fastfetch$/m { print }' \
  "$OUTPUT_DIR/Packages" > "$WORK_DIR/Packages.base"
{
  cat "$WORK_DIR/Packages.base"
  printf '%s\n' \
    "Package: fastfetch" \
    "Version: $PACKAGE_VERSION" \
    "Architecture: wasm32-wasix" \
    "Maintainer: EdgeTerm Project <support@digitalplat.org>" \
    "Installed-Size: $installed_size" \
    "Filename: ./$PACKAGE_FILE" \
    "Size: $package_size" \
    "SHA256: $package_sha256" \
    "Homepage: https://github.com/fastfetch-cli/fastfetch" \
    "Description: Fastfetch system information tool for EdgeTerm" \
    ""
} > "$OUTPUT_DIR/Packages"

echo "Created $OUTPUT_DIR/$PACKAGE_FILE"
