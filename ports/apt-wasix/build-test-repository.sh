#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUTPUT_DIR="$ROOT_DIR/tests/fixtures/apt-repository"
PACKAGE_NAME="edgeterm-apt-test"
PACKAGE_VERSION="1.0.0"
PACKAGE_FILE="${PACKAGE_NAME}_${PACKAGE_VERSION}_all.deb"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p \
  "$WORK_DIR/package/DEBIAN" \
  "$WORK_DIR/package/usr/local/bin"

printf '%s\n' \
  "Package: $PACKAGE_NAME" \
  "Version: $PACKAGE_VERSION" \
  "Section: utils" \
  "Priority: optional" \
  "Architecture: all" \
  "Maintainer: EdgeTerm Test Suite <test@invalid.example>" \
  "Description: EdgeTerm APT and dpkg integration test package" \
  > "$WORK_DIR/package/DEBIAN/control"

printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'mkdir -p /var/lib/edgeterm-apt-test' \
  'printf "%s\\n" installed > /var/lib/edgeterm-apt-test/state' \
  > "$WORK_DIR/package/DEBIAN/postinst"

printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'if [ "$1" = remove ] || [ "$1" = purge ]; then' \
  '  rm -rf /var/lib/edgeterm-apt-test' \
  'fi' \
  > "$WORK_DIR/package/DEBIAN/postrm"

printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s\\n" "original-apt-dpkg-ok"' \
  > "$WORK_DIR/package/usr/local/bin/edgeterm-apt-test"

chmod 755 \
  "$WORK_DIR/package/DEBIAN/postinst" \
  "$WORK_DIR/package/DEBIAN/postrm" \
  "$WORK_DIR/package/usr/local/bin/edgeterm-apt-test"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

docker run --rm \
  --volume "$WORK_DIR:/work" \
  --volume "$OUTPUT_DIR:/output" \
  ubuntu:24.04 \
  dpkg-deb --root-owner-group --build /work/package "/output/$PACKAGE_FILE"

package_size=$(wc -c < "$OUTPUT_DIR/$PACKAGE_FILE" | tr -d ' ')
package_sha256=$(shasum -a 256 "$OUTPUT_DIR/$PACKAGE_FILE" | awk '{print $1}')

printf '%s\n' \
  "Package: $PACKAGE_NAME" \
  "Version: $PACKAGE_VERSION" \
  "Architecture: all" \
  "Maintainer: EdgeTerm Test Suite <test@invalid.example>" \
  "Installed-Size: 1" \
  "Filename: ./$PACKAGE_FILE" \
  "Size: $package_size" \
  "SHA256: $package_sha256" \
  "Description: EdgeTerm APT and dpkg integration test package" \
  "" \
  > "$OUTPUT_DIR/Packages"

printf '%s\n' \
  "deb [trusted=yes] file:/home/user/apt-repository ./" \
  > "$OUTPUT_DIR/sources.list"

echo "Created $OUTPUT_DIR/$PACKAGE_FILE"
