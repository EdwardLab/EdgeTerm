# EdgeTerm

EdgeTerm is a browser-native runtime platform built around Pyodide, WebAssembly, php-wasm, and local-first workspaces. It gives each workspace a terminal, filesystem, editor, app preview browser, display canvas, and optional cloud backup/share layer while keeping user code execution inside the browser.

The backend, when enabled, handles accounts, metadata, snapshots, sharing, tiers, and admin controls. It does not execute workspace code.

## Supported at a glance

- Editions: Offline Edition and Cloud Edition from the same frontend runtime.
- Workspace storage: browser IndexedDB/IDBFS, local-directory sync through the File System Access API, ZIP import/export, and cloud snapshots.
- Terminal runtime: Pyodide Python, bundled shell tools, `pip`/`micropip` package flow, WASM CLI packages, and PHP CLI/runtime support.
- Web app preview: EdgeServe for Flask/WSGI, ASGI/FastAPI/Starlette, Django WSGI, PHP document roots, PHP files, and static sites.
- App Mode: workspace apps that open directly as Python, PHP, or static HTML app surfaces.
- Display output: canvas, SVG, image, trusted HTML, table output, matplotlib helpers, pandas table helpers, and SDL/pygame-style canvas binding.
- Files and editor: file manager, upload/download, drag-and-drop, copy/cut/paste, rename/delete, archive extraction, Monaco editor, split editor, preview, and command palette.
- Cloud features: users, sessions, cloud backups, restore-from-cloud, public/restricted/private shares, read-only/read-write shares, write-back, forks, tiers, quotas, and admin pages.
- EdgeServe browser: tabbed preview surface, route prefixes, back/refresh/fullscreen controls, local cookies/storage, request logs, and app navigation.

## Editions

EdgeTerm builds two editions from the same source tree.

| Edition | Output | Backend | Cloud UI | Runtime execution |
| --- | --- | --- | --- | --- |
| Offline Edition | `build/` or `dist-offline/` | No | No | Browser only |
| Cloud Edition | `build/`, copied to `backend/static/` | Flask | Yes | Browser only |

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

## Install and build

Install frontend build dependencies:

```bash
npm install
```

Build Offline Edition:

```bash
npm run build:offline
```

Build Cloud Edition:

```bash
npm run build:cloud
```

You can also use the Makefile:

```bash
make offline
make cloud
make clean
make run
```

After changing files in `rootfs/`, rebuild `rootfs.zip`:

```bat
buildrootfs.bat
```

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
- common shell commands through Bigbox-style helpers
- workspace filesystem access from Python and PHP
- WSGI/ASGI request dispatch without host sockets
- WASM CLI execution for supported command packages

Common bundled commands include file, archive, text, process-like, and network-style tools such as `ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `grep`, `sed`, `awk`, `tar`, `zip`, `unzip`, `curl`, and `wget`. Some commands are compatibility implementations for the browser filesystem rather than full native Linux binaries.

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
python app.py --host 127.0.0.1 --port 8082
```

Local preview:

- http://127.0.0.1:8082/
- http://127.0.0.1:8082/admin

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

### Linux production example

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
