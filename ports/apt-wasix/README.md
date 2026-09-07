# Upstream APT and dpkg for WASIX

This port builds the original Debian APT and dpkg sources for the EdgeTerm
WASIX runtime. It does not provide a command-line-compatible replacement or a
scripted package database.

The source revisions are pinned to:

- APT 3.3.2 commit `5e6dcc8d0c8bdce61e9cc7f497abadb5349d509a`
- dpkg 1.22.22 commit `58e5927f9f2103e94574d92edbd93e41ab93384a`
- BusyBox 1.38 from the separate EdgeTerm BusyBox WASIX source repository

The packaged runtime is a separate GPL-2.0-only WebC artifact. EdgeTerm loads
it as an external runtime package, so the GPL modules are not linked into the
MPL-licensed EdgeTerm application.

## Build

Build the pinned APT and dpkg sources, then package the runtime:

```sh
./ports/apt-wasix/probe-build.sh
./ports/apt-wasix/probe-dpkg-build.sh
./ports/apt-wasix/package-runtime.sh
```

The final artifact and checksum manifest are written to:

```text
runtime-packages/external-shell/edgeterm-posix-apt.webc
runtime-packages/external-shell/runtime-manifest.json
```

The port uses pinned upstream OpenSSL, zlib, bzip2, xz, lz4, xxHash, zstd, and
libmd sources. Repository generation is disabled because the package client
does not require Berkeley DB.

## Runtime behavior

The runtime exposes the upstream `apt`, `apt-get`, `apt-cache`, `apt-config`,
`apt-mark`, `dpkg`, `dpkg-deb`, and `dpkg-query` binaries. APT methods and dpkg
maintainer scripts are executed as WASIX child processes.

EdgeTerm initializes the package database and persists these paths with the
workspace:

- `/etc/apt` and `/etc/dpkg`
- `/var/lib/apt` and `/var/lib/dpkg`
- `/var/cache/apt` and `/var/log/apt`
- `/usr/local` and `/opt`

APT writes list output directly to EdgeTerm's scrollable terminal. The
automatic external pager is disabled for the WASIX build because it would
require a second interactive process tree.

The package architecture is `wasm32-wasix`; architecture-independent packages
use `all`. Packages containing binaries for another architecture remain
incompatible, as expected. First-party packages should install persistent
payloads under `/usr/local` or `/opt`.

## Transaction test

Run the native transaction fixture with:

```sh
./tests/apt-upstream/runtime-transaction.sh
```

The test uses the original APT and dpkg binaries to perform all of the
following operations against a fresh persistent root:

1. Extract the test `.deb` with `dpkg-deb`.
2. Update APT from a flat repository.
3. Install the package and run its `postinst` script.
4. Query the installed state with `dpkg-query`.
5. Execute the installed payload.
6. Remove the package and verify its payload and state are gone.
7. Purge the remaining package metadata.

The test fails on any incomplete operation and prints the retained sandbox path
for inspection.
