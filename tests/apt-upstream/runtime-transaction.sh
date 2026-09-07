#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RUNTIME="$REPOSITORY_ROOT/runtime-packages/external-shell/edgeterm-posix-apt.webc"
FIXTURE_REPOSITORY="$REPOSITORY_ROOT/tests/fixtures/apt-repository"
DPKG_DATA="$REPOSITORY_ROOT/ports/apt-wasix/.cache/runtime-package/dpkg-data"
SANDBOX=${1:-$(mktemp -d /tmp/edgeterm-apt-transaction.XXXXXX)}

if [[ ! -f "$RUNTIME" ]]; then
  echo "APT runtime package is missing: $RUNTIME" >&2
  exit 1
fi

mkdir -p \
  "$SANDBOX/home/user/apt-repository" \
  "$SANDBOX/etc/apt/apt.conf.d" \
  "$SANDBOX/etc/apt/preferences.d" \
  "$SANDBOX/etc/apt/sources.list.d" \
  "$SANDBOX/etc/dpkg/dpkg.cfg.d" \
  "$SANDBOX/usr/share" \
  "$SANDBOX/var/cache/apt/archives/partial" \
  "$SANDBOX/var/lib/apt/lists/partial" \
  "$SANDBOX/var/lib/dpkg/info" \
  "$SANDBOX/var/lib/dpkg/parts" \
  "$SANDBOX/var/lib/dpkg/triggers" \
  "$SANDBOX/var/lib/dpkg/updates" \
  "$SANDBOX/var/log/apt" \
  "$SANDBOX/tmp"

cp -R "$DPKG_DATA/." "$SANDBOX/usr/share/"
cp "$FIXTURE_REPOSITORY/Packages" "$SANDBOX/home/user/apt-repository/Packages"
cp "$FIXTURE_REPOSITORY/edgeterm-apt-test_1.0.0_all.deb" \
  "$SANDBOX/home/user/apt-repository/edgeterm-apt-test_1.0.0_all.deb"
cp "$FIXTURE_REPOSITORY/fastfetch_2.66.0-1edgeterm1_wasm32-wasix.deb" \
  "$SANDBOX/home/user/apt-repository/fastfetch_2.66.0-1edgeterm1_wasm32-wasix.deb"

touch \
  "$SANDBOX/var/lib/dpkg/available" \
  "$SANDBOX/var/lib/dpkg/diversions" \
  "$SANDBOX/var/lib/dpkg/diversions-old" \
  "$SANDBOX/var/lib/dpkg/status" \
  "$SANDBOX/var/lib/dpkg/statoverride" \
  "$SANDBOX/var/lib/dpkg/statoverride-old" \
  "$SANDBOX/var/lib/dpkg/triggers/File" \
  "$SANDBOX/var/lib/dpkg/triggers/Unincorp"
printf '1\n' > "$SANDBOX/var/lib/dpkg/info/format"

cat > "$SANDBOX/etc/apt/apt.conf" <<'EOF'
Dpkg::Use-Pty "false";
Dpkg::Progress-Fancy "false";
APT::Architecture "wasm32-wasix";
APT::Architectures { "wasm32-wasix"; "all"; };
APT::Sandbox::User "root";
Acquire::Languages "none";
Acquire::AllowInsecureRepositories "true";
APT::Get::AllowUnauthenticated "true";
Dir::Bin::Methods "/bin";
Dir::Bin::dpkg "/bin/dpkg";
EOF
printf '%s\n' 'deb [trusted=yes] file:/home/user/apt-repository ./' \
  > "$SANDBOX/etc/apt/sources.list"

VOLUMES=(
  --volume "$SANDBOX/home:/home"
  --volume "$SANDBOX/etc:/etc"
  --volume "$SANDBOX/usr:/usr"
  --volume "$SANDBOX/var:/var"
  --volume "$SANDBOX/tmp:/tmp"
)

run_runtime() {
  local entrypoint=$1
  shift
  wasmer run "$RUNTIME" -e "$entrypoint" \
    "${VOLUMES[@]}" \
    --env PATH=/bin:/usr/bin:/usr/local/bin \
    -- "$@"
}

run_runtime dpkg-deb --extract \
  /home/user/apt-repository/edgeterm-apt-test_1.0.0_all.deb \
  /home/user/extracted-package
[[ -f "$SANDBOX/home/user/extracted-package/usr/local/bin/edgeterm-apt-test" ]]
extracted_output=$(run_runtime sh /home/user/extracted-package/usr/local/bin/edgeterm-apt-test)
[[ "$extracted_output" == "original-apt-dpkg-ok" ]]

run_runtime apt update
available_packages=$(run_runtime apt list)
[[ "$available_packages" == *"edgeterm-apt-test"* ]]
[[ "$available_packages" == *"/unknown 1.0.0 all"* ]]
[[ "$available_packages" == *"fastfetch"* ]]
run_runtime apt install -y edgeterm-apt-test
run_runtime apt install -y fastfetch

installed_status=$(run_runtime dpkg-query -W -f='${Status}' edgeterm-apt-test)
[[ "$installed_status" == "install ok installed" ]]
[[ -f "$SANDBOX/usr/local/bin/edgeterm-apt-test" ]]
[[ "$(cat "$SANDBOX/var/lib/edgeterm-apt-test/state")" == "installed" ]]

payload_output=$(run_runtime sh /usr/local/bin/edgeterm-apt-test)
[[ "$payload_output" == "original-apt-dpkg-ok" ]]

fastfetch_version=$(run_runtime ash -c 'fastfetch --version')
[[ "$fastfetch_version" == "fastfetch 2.66.0 (Unknown)" ]]
fastfetch_output=$(run_runtime ash -c 'fastfetch --structure Title:Separator:Kernel:Uptime:Shell:Terminal:Locale')
[[ "$fastfetch_output" == *"wasmer"* ]]
[[ "$fastfetch_output" == *"Kernel"* ]]

run_runtime apt remove -y edgeterm-apt-test

removed_status=$(run_runtime dpkg-query -W -f='${Status}' edgeterm-apt-test)
[[ "$removed_status" == "deinstall ok config-files" ]]
if [[ -e "$SANDBOX/usr/local/bin/edgeterm-apt-test" ]]; then
  echo "Removed package payload is still present." >&2
  exit 1
fi
if [[ -e "$SANDBOX/var/lib/edgeterm-apt-test/state" ]]; then
  echo "Removed package state is still present." >&2
  exit 1
fi

run_runtime apt purge -y edgeterm-apt-test
if run_runtime dpkg-query -W -f='${Status}' edgeterm-apt-test >/dev/null 2>&1; then
  echo "Purged package is still present in the package database." >&2
  exit 1
fi

echo "APT transaction passed: extract, update, install, query, execute, remove, and purge."
echo "Fastfetch package passed: install, version, and runtime output."
echo "Persistent sandbox: $SANDBOX"
