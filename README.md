# EdgeTerm

EdgeTerm is a browser-native runtime platform built around Pyodide, WebAssembly, php-wasm, and local-first workspaces. It gives each workspace a terminal, filesystem, editor, app preview browser, display canvas, and optional cloud backup/share layer while keeping user code execution inside the browser.

The backend, when enabled, handles accounts, metadata, snapshots, sharing, tiers, and admin controls. It does not execute workspace code.

## Supported at a glance

- Editions: Offline Edition and Cloud Edition from the same frontend runtime.
- Workspace storage: browser IndexedDB/IDBFS, local-directory sync through the File System Access API, ZIP import/export, and cloud snapshots.
- Terminal runtime: an optional BusyBox WASIX environment, Pyodide Python fallback, bundled shell tools, `pip`/`micropip`, WASM CLI packages, PHP CLI/runtime support, and experimental browser-local Node/npm support.
- Web app preview: EdgeServe for Flask/WSGI, ASGI/FastAPI/Starlette, Django WSGI, PHP document roots, PHP files, and static sites.
- App Mode: workspace apps that open directly as Python, PHP, or static HTML app surfaces.
- Display output: canvas, SVG, image, trusted HTML, table output, matplotlib helpers, pandas table helpers, and SDL/pygame-style canvas binding.
- Files and editor: file manager, upload/download, drag-and-drop, copy/cut/paste, rename/delete, archive extraction, Monaco editor, split editor, preview, and command palette.
- Project launcher: one-action Flask, Django, FastAPI, WordPress, static-site, and pygame starters with dependency setup and automatic preview.
- Run center: active app discovery with open, restart, stop, and log actions for EdgeServe projects.
- Cloud features: users, sessions, cloud backups, restore-from-cloud, public/restricted/private shares, read-only/read-write shares, write-back, forks, tiers, quotas, and admin pages.
- External backups: encrypted incremental restore points written directly from the browser to Google Drive, Dropbox, S3-compatible storage, or a local folder.
- EdgeServe browser: tabbed preview surface, route prefixes, back/refresh/fullscreen controls, local cookies/storage, request logs, and app navigation.

## Editions

EdgeTerm builds three editions from the same source tree.

| Edition | Output | Backend | Cloud UI | Runtime execution |
| --- | --- | --- | --- | --- |
| Offline Edition | `build/` or `dist-offline/` | No | No | Browser only |
| Cloud Edition | `build/`, copied to `backend/static/` | Flask | Yes | Browser only |
| Embed Edition | `build/` | No | No | Browser only, controlled through Bridge |

Offline Edition is a pure static app. Cloud Edition adds a Flask backend for auth, snapshots, sharing, and admin operations. In both editions, workspace commands and user code run in the browser runtime.

## Repo layout

```text
frontend/
  index.html
  src/
    core/
    cloud/
    ui/
    features/

backend/
  app.py
  models.py
  auth.py
  admin.py
  snapshots.py
  shares.py
  templates/
  static/

rootfs/
  bin/
  usr/
  home/

scripts/
  build.mjs
```

Related docs:

- `EdgeTerm App Mode.md`
- `EdgeTerm Display API.md`
- `docs/pkg.md`

## Install and build

Install the pinned frontend dependencies and verified runtime assets:

```bash
npm ci
npm run prepare:runtime
```

Build Offline Edition:

```bash
npm run build:offline
```

`prepare:node-runtime` installs and verifies the optional pinned Edge.js runtime
pack. It accepts a locally built artifact through `EDGEJS_RUNTIME_FILE` and can
also use an already verified artifact in `runtime-packages/node`. Omit that step
when producing an EdgeTerm build without direct `node` execution. Browser npm
installs and the React/Vite frontend adapter remain separate from the Edge.js
runtime pack. The browser runtime uses `@wasmer/sdk@0.11.0`; the POSIX package
runtime keeps its independently pinned SDK integration so upgrades in either
runtime cannot silently change the other.

Build Cloud Edition:

```bash
npm run build:cloud
```

Build and serve Embed Edition:

```bash
npm run build:embed
npm run serve:embed
```

The Embed Edition enables the versioned EdgeTerm Bridge for an explicit list
of parent origins. It is intended for products that embed the upstream
EdgeTerm UI without forking it. See `docs/embed-bridge.md`.

## Browser npm and Node runtime

EdgeTerm provides browser-local `npm` and `npx` commands for frontend projects.
Source files, installed packages, the npm cache, and build output stay in the
active browser workspace.

Supported commands:

- `npm install`, including direct dependencies and `--save-dev`
- `npm ci` with lockfile v3 validation
- `npm uninstall`, `npm list`, and `npm cache clean`
- `npm run`, `npm exec`, and `npx`
- `npm --version`

Supported frontend workflows:

- static HTML, CSS, and JavaScript
- React and Vite projects
- Next.js `app/page` and `pages/index` projects through the static frontend adapter
- JavaScript, JSX, TypeScript, and TSX browser builds
- `npm run build`, `npm run dev`, and `npm run preview`
- EdgeServe virtual URLs, SPA fallback, automatic rebuild, and full preview refresh

EdgeTerm resolves public npm packages in the browser, verifies each tarball
against its registry integrity value, and writes lockfile v3. It rejects path
traversal, links, native `.node` addons, unsafe archive entries, oversized
packages, and unsupported flags. Package lifecycle scripts are blocked by
default and require separate approval for each install.

Vite platform binaries are not executed. EdgeTerm uses its bundled
`esbuild-wasm` adapter and skips optional platform packages such as native
Rollup, Rolldown, SWC, Lightning CSS, Parcel watcher, Sharp, and fsevents
bindings. Native Vite HMR is not promised in this release; file changes trigger
a browser-local rebuild and a full EdgeServe refresh.

Next.js `dev`, `build`, and `start` scripts use the same browser-local adapter.
Client components, common `next/link`, `next/image`, navigation, public assets,
and SPA routing are supported. Server Components that require server-only
modules, Server Actions, API routes, middleware, SSR, and image optimization
remain experimental and return an explicit compatibility error.

Direct `node` execution uses the optional pinned Edge.js QuickJS/WASIX runtime.
Its Bridge capability becomes available only after artifact checksum
verification and a real startup smoke test. Express, Next.js SSR, WebSocket,
and arbitrary `server.listen()` request dispatch remain experimental until a
reliable Edge.js-to-EdgeServe request bridge is available.

The pinned browser package is defined by `runtime/node/edgejs-package.toml` and
`runtime/node/manifest.json`. Rebuild Edge.js at the commit in that manifest
with the QuickJS WebAssembly fallback disabled, package the resulting WASIX
module as WebC, and update the manifest size and SHA-256 together. EdgeTerm
does not accept an unverified or floating runtime artifact.

The Node runtime requires a secure context, `SharedArrayBuffer`, and these
response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Chrome is the first supported browser for this runtime. Firefox and Safari
receive a compatibility error when the required browser capabilities are not
available.

## External workspace backups

The Backups view can write encrypted incremental restore points directly to a
user-owned storage destination. Google Drive uses app data, Dropbox uses an
App Folder, S3 uses browser-side Signature Version 4, and Local Folder uses
the File System Access API. Backup bytes do
not require an EdgeTerm backend.

The repository stores content-addressed encrypted chunks in immutable packs.
Unchanged chunks are reused across restore points. A full encrypted manifest
and commit marker make interrupted uploads resumable and prevent incomplete
restore points from appearing as valid backups. Restore verifies manifest,
chunk, and final file hashes before committing a staging workspace.

The recovery password stays in the browser and is not recoverable by an OAuth
broker or EdgeTerm server. Remembering it stores an encrypted local copy in
IndexedDB. Schedules run while EdgeTerm is open; a static browser application
cannot wake itself after every tab is closed.

Embed hosts can expose these operations through `backup.status`,
`backup.create`, `backup.list`, `backup.verify`, `backup.restore_preview`,
`backup.restore`, and `backup.cancel`. See `docs/embed-bridge.md` for the
authorization boundary.

You can also use the Makefile:

```bash
make offline
make cloud
make clean
make run
```

Every build regenerates `rootfs.zip` and the boot manifests from `rootfs/`.
The library sources live in `rootfs/usr/lib`; generated manifests and backend
static files are excluded from Git. Runtime downloads are pinned by size and
SHA-256 in `runtime/assets.json` and are decompressed and verified before use.

## Package repository

The published repository is [packages.digitalplat.org](https://packages.digitalplat.org/).
The candidate catalog contains 101 downloadable packages; 75 currently meet the
stable suite gates, including Git and PHP. The artifact catalog identifies each
package's channel, version, checksum, license, and upstream source.

```sh
apt update
apt install git php
git --version
php --version
```

The browser verifies `InRelease` with the pinned publisher key before accepting
an index. It checks the release expiry, index digest, package size, and package
digest. Missing, expired, empty, or unavailable repositories fail explicitly.
The verified index is staged as a local APT source so native APT queries and
installations use the same package catalog. The browser's default transport
includes candidate packages; stable acceptance is listed separately in the catalog.

Set `EDGETERM_APT_REPOSITORY_URL` at build time to use another deployment of the
same signed repository. Local development uses `/edgeterm-packages/local-flat`
and a signed sibling `edgeterm-packages/repository/local-flat` directory.
The legacy `pkg` source uses the preserved `legacy-packages` branch.

## Verification

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r backend/requirements-lock.txt
npm run build:cloud
npm test
python -m unittest discover -s tests/backend
```

The backend suite exercises accounts, sessions, snapshots, sharing, quotas, and
authorization. Set `EDGETERM_TEST_MYSQL_HOST`, `EDGETERM_TEST_MYSQL_PORT`,
`EDGETERM_TEST_MYSQL_USER`, and `EDGETERM_TEST_MYSQL_PASSWORD` to also run the
integration tests. These create and drop uniquely named test databases and
require a dedicated test MySQL instance. CI runs both layers against MySQL 8.4.

For browser acceptance against the signed local repository:

```sh
EDGETERM_APT_REPOSITORY_URL=/edgeterm-packages/local-flat npm run build:embed
npm run test:browser
```

Open `http://127.0.0.1:3100/` in Chrome and select **Run acceptance suite**.
The suite creates a separate workspace and checks package installation,
execution, application previews, repository failures, and reload persistence.
Results are saved to `/tmp/edgeterm-browser-acceptance.json` by default.

Private cloud shares are readable only by their owner. Restricted shares allow
the owner and the named recipients. Expired or revoked shares cannot be written
back, and disabled forks are enforced by the backend.

## Offline Edition

Offline Edition is emitted to `build/` by `npm run build:offline` and to `dist-offline/` by `make offline`.

Supported offline features:

- browser-local workspaces
- terminal, shell, editor, files, display, and EdgeServe previews
- ZIP import/export
- local-directory storage where the browser supports the File System Access API
- Python, PHP, static, WSGI/ASGI, and browser-WASM runtime features

Not included in Offline Edition:

- login/register UI
- cloud snapshots
- share links
- admin UI
- cloud API calls

You can serve Offline Edition with any static server, or open `build/index.html` directly where browser restrictions allow.

## Workspaces and storage

EdgeTerm workspaces are local-first. A workspace contains the root filesystem, user home files, installed runtime state, app files, settings, and browser-side workspace metadata.

Supported workspace operations:

- create, rename, switch, and delete workspaces
- import and export workspace ZIP files
- restore a workspace from a cloud snapshot
- sync workspace files into browser storage
- sync to and from a user-picked local directory
- maintain multiple browser-local workspaces
- use workspace users and home directories
- keep custom restored root filesystems separate from the bundled system rootfs

Storage backends:

- Browser storage uses IndexedDB/IDBFS.
- Local-directory storage uses the browser File System Access API.
- Cloud snapshots store metadata in MySQL and ZIP blobs on disk.

Large workspace imports can take time because the browser has to unzip, write, index, and sync many files. EdgeTerm shows import progress and delays cloud re-sync after cloud restores so large imports do not immediately freeze again while writing a fresh snapshot.

## Terminal and runtime

The terminal runs inside the browser using Pyodide and EdgeTerm shell helpers. It includes a pure-character boot loading animation while services initialize.

Supported terminal/runtime features:

- Python through Pyodide
- `python`, `python3`, `pip`, `pip3`, and `micropip`
- runtime package rehydration for installed Python packages where supported
- PHP through the bundled php-wasm package system
- `pkg` for browser-native package repositories
- experimental BoxedWine/Wine launch bridge for browser-local Win32 apps
- common shell commands through Bigbox-style helpers
- workspace filesystem access from Python and PHP
- WSGI/ASGI request dispatch without host sockets
- WASM CLI execution for supported command packages

Common Unix commands prefer the optional BusyBox WASIX runtime. EdgeTerm loads
the runtime through a generic external-process boundary, verifies its release
manifest, size, SHA-256 checksum, license identifier, and startup behavior, and
then mounts the active browser workspace into `ash`. If the runtime cannot be
loaded or verified, the existing Python EdgeTerm shell continues automatically.

BusyBox source code and release artifacts are not included in this MPL-2.0
repository. They are distributed separately under GPL-2.0-only from
[`DigitalPlatDev/EdgeTerm-BusyBox-WASIX`](https://github.com/DigitalPlatDev/EdgeTerm-BusyBox-WASIX).
EdgeTerm contains only the generic runtime loader, configuration, and fallback
integration. Python, PHP, npm, Node, EdgeServe, and other host-integrated
commands continue to use their dedicated browser runtimes.

EdgeTerm's binary package manager is available as `pkg`. It reads
`/etc/sources.list`, downloads static repository indexes, resolves dependencies,
installs archives into `/packages/<name>/`, records state in
`/var/lib/pkg/status.json`, caches archives under `/var/cache/pkg/`, and
registers package binaries through `/bin/<command>` for the WASM command bridge.

```bash
pkg source add https://example.com/edgeterm/repo
pkg update
pkg install sqlite
sqlite3 test.db
```

Legacy repository and manifest details live in `docs/pkg.md`.

Common bundled commands include file, archive, text, process-like, and network-style tools such as `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `grep`, `sed`, `awk`, `tar`, `zip`, `unzip`, `curl`, and `wget`. Some commands are compatibility implementations for the browser filesystem rather than standalone native executables.

Experimental Wine commands are reserved for the BoxedWine runtime path:

```bash
edgepkg install boxedwine wine-runtime
wine notepad.exe
wine explorer
winecfg
winetricks
```

The Wine path is browser-only. It prepares `/home/user/.wine`, attaches the EdgeTerm Display canvas as the BoxedWine SDL/OpenGL target, streams launch/status logs to the terminal, and keeps Wine prefix state inside workspace persistence, exports, imports, and cloud snapshots. Cloud Edition stores metadata and snapshots only; it never executes Win32 code.

Runtime constraints:

- no real TCP listeners from workspace code
- no host OS subprocesses or daemons
- browser storage quota depends on the browser/device
- native extensions are limited to what the browser runtime provides
- generic WASM CLI stdin/stdout behavior depends on the package wrapper

## Files and editor

The file manager supports:

- browse, open, preview, upload, and download files
- drag-and-drop uploads
- create files and folders
- copy, cut, paste, rename, and delete
- select multiple files
- open terminal in the current folder
- extract common archive formats such as ZIP and tar variants
- detect unsupported archive types with a clear message

The editor uses Monaco and supports:

- open and save workspace files
- language-aware editing
- split editor
- preview modal for supported files
- command palette
- keyboard save shortcuts
- upload into the active folder

Monaco is loaded from CDN in the current frontend, so first load requires network access unless your deployment caches or vendors it.

## Project launcher and run center

Open **Projects and Runs** from the main toolbar to create a ready-to-run starter. Choose a template, project name, and workspace location. EdgeTerm writes the starter files, installs browser-compatible dependencies, persists the project, and optionally opens the app immediately.

Available templates:

- Flask WSGI app
- Django WSGI app with a local SQLite database
- FastAPI ASGI app
- WordPress with the browser-compatible SQLite integration
- static HTML, CSS, and JavaScript site
- pygame SDL canvas app

The Run Center lists EdgeServe apps started by either the launcher or terminal. Each entry can be opened, restarted, stopped, or connected to the EdgeServe request log. pygame runs open in Display and keep their terminal output available through the log action.

Projects can also use a versioned `edgeterm.toml` file to declare package dependencies, local tasks, preview behavior, environment values, and references to encrypted local Vault entries. The Development workspace panel can inspect and restore that configuration, discover and run tests, start a supported debugger, and create or restore browser-local checkpoints. See [`docs/development-environment.md`](docs/development-environment.md) for the schema, Bridge methods, and capability boundaries.

## Database Manager

Open **Database Manager** to work with SQLite files inside the active workspace. It discovers `.db`, `.sqlite`, and `.sqlite3` files, including common Django and WordPress locations.

The manager supports:

- schema and table discovery
- row browsing with a 100-row table shortcut
- arbitrary SQL queries and `EXPLAIN QUERY PLAN`
- committed `INSERT`, `UPDATE`, and `DELETE` statements
- database import and export
- one-click WordPress and Django database shortcuts

Query results are limited to 500 displayed rows so a large result does not freeze the workspace UI.

## Developer Hub

Open **Developer Hub** and choose a project root to use the integrated developer workflow:

- **Git** initializes real Git repositories, shows staged, modified, and untracked files, creates commits through Dulwich, imports public GitHub repository archives through the EdgeTerm network bridge, and exports project ZIP files.
- **Dependencies** reads Python `requirements.txt`, Node `package.json`, and PHP/WordPress runtime requirements. Missing Python and PHP dependencies can be repaired in one action.
- **Logs** summarizes and exports EdgeServe request, response, timing, failure, and browser-bridge events.
- **WordPress** discovers local installations, reports their version and plugin count, opens the site or SQLite database, and repairs the PHP runtime package.
- **Snapshots** creates compressed local restore points, provides a chronological timeline, and supports restore, download, and delete actions.
- **Templates** provides one-click handoff to the tested Flask, Django, FastAPI, WordPress, static-site, and pygame project starters.
- **Performance** audits project file count and size, browser resource transfer, running apps, pending saves, request logs, and the largest files. It can also force pending workspace saves to flush.

Git support installs the pure-Python Dulwich package into the active browser runtime on first use. Public GitHub imports do not require an account or token; authenticated private-repository operations and pushing to GitHub are not included.

## Display output

EdgeTerm Display is a browser-native output panel for rich program output.

Supported message types:

- `switch`
- `canvas`
- `svg`
- `image`
- `html`
- `table`
- `clear`
- `resize`
- `fullscreen`

Python helper:

```python
import edgeterm_display as display

display.show()
display.html("<h1>Hello from EdgeTerm</h1>")
display.table([{"name": "Ada", "score": 98}])
```

Display also supports matplotlib SVG/PNG helpers, pandas table output, pointer/keyboard event queues, and SDL/pygame-style canvas binding through Pyodide. See `EdgeTerm Display API.md` for the full protocol.

## EdgeServe

EdgeServe previews local workspace apps in the Display browser. It does not bind a TCP port or spawn an operating-system server. Requests are routed through EdgeTerm's in-browser dispatch layer.

Supported commands:

```bash
edgeserve flask module:app
edgeserve asgi module:app
edgeserve django project.wsgi:application
edgeserve php .
edgeserve static .
```

Aliases:

```bash
edgeflask module:app
edgeasgi module:app
```

Supported modes in the runtime:

- `flask`
- `wsgi`
- `django`
- `asgi`
- `fastapi`
- `starlette`
- `php`
- `static`

Examples:

```bash
# Serve a Flask app exported as app from app.py
edgeserve flask app:app

# Serve a FastAPI or Starlette app
edgeserve asgi main:app

# Serve a Django WSGI app
edgeserve django mysite.wsgi:application

# Serve a PHP document root with index.php front-controller support
edgeserve php .

# Serve one PHP file directly
edgeserve php public/index.php

# Serve static HTML, CSS, JS, images, and documents
edgeserve static .
```

When EdgeServe starts, EdgeTerm opens the app in the Display browser and prints a route prefix such as `/wsgi-.../`, `/php-.../`, or `/static-.../`. Preview tabs include back, refresh, address, focus, fullscreen, cookie/storage handling, and request logs.

## PHP EdgeServe

`edgeserve php` runs PHP inside the browser through EdgeTerm's WASM package system. It does not start Apache, Nginx, PHP-FPM, a TCP listener, or a server process on the host machine.

Basic project:

```bash
mkdir -p public
cat > public/index.php <<'PHP'
<?php
header('Content-Type: application/json');
echo json_encode([
    'message' => 'Hello from EdgeServe PHP',
    'path' => $_SERVER['REQUEST_URI'] ?? '/',
    'query' => $_GET,
]);
PHP

edgeserve php public
```

Single-file project:

```bash
cat > hello.php <<'PHP'
<?php
echo "<h1>Hello from PHP</h1>";
PHP

edgeserve php hello.php
```

PHP routing behavior:

- A directory target becomes the PHP document root.
- `index.php` is used as a front controller when no concrete file matches the request path.
- A `.php` target is used directly as the entry script.
- Static assets are served from the document root when present.
- Extensionless current paths are treated as directory-like for relative admin links and assets.

PHP request data:

- `$_GET`
- `$_POST`
- request headers
- cookies
- `php://input`
- `SCRIPT_NAME`
- `PATH_INFO`
- `REQUEST_URI`
- common `$_SERVER` values

PHP WebSocket bridge:

- Browser code inside the EdgeServe/App Mode preview can use `new WebSocket("/path")`.
- EdgeTerm intercepts local WebSocket URLs and dispatches PHP events to the matching PHP script.
- PHP handlers can inspect `edgeterm_ws_event()` or `$_SERVER['EDGETERM_WEBSOCKET_EVENT']`.
- Supported events are `open`, `message`, and `close`.
- PHP can send messages back with `edgeterm_ws_send($value)` and close with `edgeterm_ws_close($code, $reason)`.
- This is a browser-local bridge, not a native TCP WebSocket server.

Example PHP handler:

```php
<?php
$ws = edgeterm_ws_event();

if ($ws['event'] === 'open') {
    edgeterm_ws_send('connected');
    return;
}

if ($ws['event'] === 'message') {
    $message = json_decode(file_get_contents('php://input'), true);
    edgeterm_ws_send('echo: ' . ($message['data'] ?? ''));
    return;
}

if ($ws['event'] === 'close') {
    return;
}
?>
```

PHP limitations:

- Native TCP WebSocket upgrades are not supported for PHP apps.
- Long-running background daemons and host subprocesses are not available.
- Native PHP extensions are limited to extensions bundled with the browser runtime.
- External HTTP calls can fail when the browser, runtime, CORS, or deployment blocks them.
- File writes are workspace-local until browser sync, local sync, export, or cloud snapshot runs.

WordPress can run through `edgeserve php` for local admin/site testing, but it still inherits browser-runtime limits. Network checks such as calls to `api.wordpress.org` may fail if outbound access is blocked. Browser extension URLs can appear as 404s in EdgeServe logs; those are extension requests, not WordPress files.

## App Mode

App Mode lets a workspace open as an app instead of the normal terminal/file-manager workspace. It uses the same browser-local container and can return to the workspace without resetting it.

Supported App Mode runtimes:

- `python`: Pyodide-powered Flask/WSGI apps.
- `php`: php-wasm requests with static-file fallback.
- `static`: HTML apps rendered from the workspace filesystem.
- `wine`: experimental browser-local BoxedWine/Wine app launch.

App Mode config file:

```text
/etc/appmode/config.json
```

Important supported config fields:

- `enabled`
- `runtime`
- `entrypoint`
- `staticRoot`
- `workingDirectory`
- `fullscreen`
- `autoStart`
- `preserveStateOnExit`
- `showLoadingOverlay`
- `exit.hotkey`
- `exit.confirmBeforeExit`
- `ui.hideWorkspaceChrome`
- `ui.allowDebugTerminal`
- `ui.debugTerminalHotkey`
- `ui.showAddressBar`
- `python.appSpec`
- `python.framework`
- `python.routePrefix`
- `static.indexFile`
- `static.allowInlineScripts`

The Settings panel can enable App Mode, choose the runtime, set paths, configure fullscreen/auto-start/hotkeys, launch immediately, and open the config file in the editor. See `EdgeTerm App Mode.md` for detailed examples.

## Cloud Edition

Cloud Edition uses Flask for account and storage services while runtime execution stays in the browser.

Install backend dependencies:

```bash
python -m pip install -r backend/requirements.txt
```

Run locally:

```bash
cd backend
python app.py --host 127.0.0.1 --port 8080
```

Local preview:

- http://127.0.0.1:8080/
- http://127.0.0.1:8080/admin

Cloud features:

- user registration, login, logout, and sessions
- profile and tier information
- snapshot upload, list, download, restore, delete, and batch delete
- retained backup pruning
- auto-sync settings
- public, private, and restricted shares
- read-only and read-write shares
- temporary shares
- fork/clone support
- cloud write-back for writable shares
- App Mode share links
- custom share slugs
- share expiration
- admin users, tiers, quotas, storage, shares, snapshots, settings, notice HTML, and terms HTML

Selected API endpoints:

- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `POST /api/snapshot/upload`
- `GET /api/snapshot/list`
- `GET /api/snapshot/download/<id>`
- `DELETE /api/snapshot/<id>`
- `POST /api/snapshot/batch-delete`
- `DELETE /api/snapshot`
- `GET /api/share/list`
- `POST /api/share/create`
- `GET /api/share/resolve`
- `GET /api/share/<id>`
- `POST /api/share/update/<id>`
- `DELETE /api/share/<id>`
- `POST /api/share/revoke/<id>`
- `POST /api/share/writeback/<id>`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `POST /api/admin/users/<id>`
- `DELETE /api/admin/users/<id>`
- `GET /api/admin/storage`
- `GET /api/admin/shares`
- `POST /api/admin/shares/<id>`
- `DELETE /api/admin/shares/<id>`
- `GET /api/admin/snapshots`
- `GET /api/admin/snapshots/<id>/download`
- `DELETE /api/admin/snapshots/<id>`
- `POST /api/admin/snapshots/import`
- `GET /api/admin/tiers`
- `POST /api/admin/tiers`
- `DELETE /api/admin/tiers/<id>`
- `POST /api/admin/settings`

## Cloud storage

Cloud Edition uses:

- MySQL for metadata
- local blob storage for rootfs snapshot ZIP files

Metadata stored in MySQL:

- users
- sessions
- snapshots metadata
- shares
- share allowed-user lists
- tiers
- settings

Blob files are stored on disk at `backend/.edgeterm-cloud/blobs/` by default.

Cloud Edition requires MySQL. If MySQL is not configured, the backend fails to start instead of silently falling back to a local JSON store.

### MySQL configuration

Environment variables:

```bash
export EDGETERM_DB_HOST=10.0.0.20
export EDGETERM_DB_PORT=3306
export EDGETERM_DB_NAME=edgeterm
export EDGETERM_DB_USER=edgeterm
export EDGETERM_DB_PASSWORD='your-password'
```

CLI arguments:

```bash
python backend/app.py \
  --host 0.0.0.0 \
  --port 8082 \
  --db-host 10.0.0.20 \
  --db-port 3306 \
  --db-name edgeterm \
  --db-user edgeterm \
  --db-password 'your-password'
```

Normalized MySQL tables:

- `users`
- `sessions`
- `snapshots`
- `shares`
- `share_allowed_users`
- `tiers`
- `settings`

The legacy `edgeterm_state` table is still written as a compatibility/migration snapshot, but the live backend reads and writes the normalized tables.

### Environment files

`backend/app.py` loads environment variables from:

- repo root `.env`
- `backend/.env`

Supported keys:

- `EDGETERM_HOST`
- `EDGETERM_PORT`
- `EDGETERM_CLOUD_DIR`
- `EDGETERM_DB_HOST`
- `EDGETERM_DB_PORT`
- `EDGETERM_DB_NAME`
- `EDGETERM_DB_USER`
- `EDGETERM_DB_PASSWORD`

### Production service example

```bash
cd /home/python/edgeterm
npm install
python3 -m pip install -r backend/requirements.txt
npm run build:cloud
cp -r build/* backend/static/

cd backend
cp .env.example .env
# edit .env with your real values
python3 -m waitress --host=0.0.0.0 --port=9092 --call "app:create_app"
```

## Frontend build flags

The frontend runtime reads:

- `window.EDGETERM_CLOUD_ENABLED`
- `window.EDGETERM_PAGE_KIND`
- `window.EDGETERM_ASSET_BASE`

That allows the same runtime bundle to run as:

- offline main app
- cloud main app
- cloud share page
- cloud admin page

## Browser support notes

Recommended browser:

- Chromium-based browsers for best File System Access API and WASM behavior.

Browser-dependent features:

- local-directory workspace storage
- persistent storage quota
- large IndexedDB writes
- clipboard and file picker APIs
- fullscreen behavior
- WebAssembly package performance

If a page becomes temporarily unresponsive during very large imports, wait first. The browser may be writing thousands of files into IndexedDB and can recover after the sync finishes.

## Known limitations

- Workspace code cannot bind real ports or accept external TCP connections.
- Backend APIs do not execute user code.
- Browser runtime code cannot spawn host OS processes.
- Long-running daemons are not available inside workspaces.
- Storage quota is controlled by the browser.
- CDN-loaded dependencies such as Pyodide or Monaco require network access unless deployment caches them.
- Native Python/PHP extensions are limited to what the browser runtime supports.
- Static App Mode CSS URL rewriting is limited for complex stylesheets.
- Display HTML is trusted workspace content and is not a general-purpose security sandbox.
- Cloud Edition currently requires MySQL for metadata.
