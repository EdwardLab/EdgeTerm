# EdgeTerm `pkg` Package Manager

`pkg` is EdgeTerm's browser-native package manager for prebuilt WASM and Emscripten command packages. It installs package payloads into `/packages/<name>/`, keeps package state under `/var/lib/pkg/`, stores downloaded archives in `/var/cache/pkg/`, and registers executable package commands through `/bin/<command>` symlinks that EdgeTerm's existing WASM command registry can discover.

## Commands

```sh
pkg update
pkg install <name>
pkg install sqlite=3.54.0
pkg remove <name>
pkg purge <name>
pkg upgrade
pkg list
pkg list --installed
pkg list --available
pkg search <query>
pkg info <name>
pkg show <name>
pkg files <name>
pkg which <command>
pkg depends <name>
pkg rdepends <name>
pkg clean
pkg autoremove
pkg verify
pkg doctor
pkg source list
pkg source add <url>
pkg source remove <url>
pkg --help
pkg --version
```

Useful global options:

```sh
-y, --yes        Assume yes and suppress package script warnings
-q, --quiet      Reduce status output
--verbose        Reserved for more detailed output
--no-scripts     Skip install/remove scripts
--reinstall      Reinstall an already-installed package
--dry-run        Show planned actions
```

## Source List

`pkg update` reads `/etc/sources.list`. Blank lines and comments beginning with `#` are ignored.

Direct repository index:

```text
repo https://example.com/edgeterm/repo index.json
repo https://example.com/edgeterm/repo/index.json
```

Deb-style static layout:

```text
deb https://raw.githubusercontent.com/EdwardLab/edgeterm-packages/main stable main
```

The `repo` form fetches either the URL itself when it ends in `.json`, or `<url>/index.json` otherwise. The `deb` form fetches:

```text
<base-url>/dists/<channel>/<component>/index.json
```

## Repository Layout

Recommended tree:

```text
repo/
├── index.json
├── packages/
│   ├── jq/
│   │   ├── jq-1.7.1-edgeterm-wasm32.tar.gz
│   │   └── package.json
│   ├── lua/
│   │   ├── lua-5.4.6-edgeterm-wasm32.tar.gz
│   │   └── package.json
│   ├── sqlite/
│   │   ├── sqlite-3.54.0-edgeterm-wasm32.tar.gz
│   │   └── package.json
│   └── php/
│       ├── php-8.5.6-edgeterm-wasm32.tar.gz
│       └── package.json
└── signatures/
    └── index.sig
```

Package archives may be `.tar.gz`, `.tgz`, `.tar`, or `.zip`. A payload can contain files directly, or a single top-level directory containing `package.json`.

## `index.json`

```json
{
  "format": "edgeterm-pkg-index-v1",
  "generatedAt": "2026-05-19T00:00:00Z",
  "channel": "stable",
  "arch": "wasm32-emscripten",
  "packages": [
    {
      "name": "sqlite",
      "version": "3.54.0",
      "description": "SQLite CLI for EdgeTerm",
      "license": "Public-Domain",
      "arch": "wasm32-emscripten",
      "runtime": "emscripten",
      "type": "emscripten-cli",
      "url": "packages/sqlite/sqlite-3.54.0-edgeterm-wasm32.tar.gz",
      "sha256": "sha256-...",
      "size": 1234567,
      "dependencies": [],
      "bin": {
        "sqlite3": "sqlite3"
      },
      "tags": ["database", "cli"]
    }
  ]
}
```

Relative package URLs are resolved relative to the fetched index URL.

## Package Manifest

Every installed package should include `/packages/<name>/package.json`. Existing simple manifests continue to work.

```json
{
  "name": "sqlite",
  "version": "3.54.0",
  "description": "SQLite CLI compiled for EdgeTerm WebAssembly runtime",
  "license": "Public-Domain",
  "homepage": "https://sqlite.org",
  "runtime": "emscripten",
  "type": "emscripten-cli",
  "arch": "wasm32-emscripten",
  "entry": "sqlite3",
  "wasm": "sqlite3.wasm",
  "js": null,
  "bin": {
    "sqlite3": "sqlite3"
  },
  "dependencies": [],
  "optionalDependencies": [],
  "provides": ["sqlite3"],
  "conflicts": [],
  "files": ["sqlite3", "sqlite3.wasm", "package.json"],
  "checksums": {
    "sqlite3": "sha256-...",
    "sqlite3.wasm": "sha256-..."
  },
  "scripts": {
    "preinstall": "echo preparing sqlite",
    "postinstall": "echo sqlite installed",
    "preremove": "echo removing sqlite",
    "postremove": "echo sqlite removed"
  },
  "env": {
    "SQLITE_HISTORY": "/home/user/.sqlite_history"
  },
  "tags": ["database", "cli", "wasm"]
}
```

Scripts are optional and run inside the EdgeTerm shell with `PKG_NAME`, `PKG_VERSION`, `PKG_ROOT`, and `PKG_PATH` in the environment. Package scripts are trusted package code; `pkg` warns before running them unless `-y` is used.

## Local Database

`pkg` stores local state in:

```text
/var/lib/pkg/
├── lists/
├── status.json
├── installed/
└── cache/
```

Downloaded package archives are cached under:

```text
/var/cache/pkg/
```

On first run, `pkg` migrates existing `/packages/*/package.json` installations into `/var/lib/pkg/status.json` without changing their layout.

