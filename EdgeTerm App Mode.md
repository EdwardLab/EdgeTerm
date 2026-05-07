# EdgeTerm App Mode

EdgeTerm App Mode lets a workspace behave like a local browser-native app instead of the standard terminal and file-manager shell. It runs entirely inside the current EdgeTerm workspace, keeps using the workspace filesystem, and can return to the normal EdgeTerm Workspace view without resetting the container.

## What App Mode does

- Runs one workspace as a local app surface.
- Supports multiple runtimes behind one loader.
- Starts automatically when a workspace opens if enabled and `autoStart` is `true`.
- Exits back to the normal workspace with a configurable hotkey.
- Keeps the browser-local container model: no real backend server, no socket listener, no port binding.

Current runtimes:

- `python`: Pyodide-powered app routes through a Flask-style API.
- `static`: HTML apps rendered from the workspace filesystem.

Future runtimes can plug into the same loader later, including Lua or generic WASM apps.

## Config file

App Mode is controlled by:

`/etc/appmode/config.json`

If the file does not exist, EdgeTerm creates a default one.

Default example:

```json
{
  "enabled": false,
  "runtime": "python",
  "entrypoint": "/home/user/app.py",
  "staticRoot": "/home/user/public",
  "workingDirectory": "/home/user",
  "fullscreen": true,
  "autoStart": true,
  "preserveStateOnExit": true,
  "showLoadingOverlay": true,
  "exit": {
    "method": "hotkey",
    "hotkey": "Escape",
    "confirmBeforeExit": false
  },
  "ui": {
    "hideWorkspaceChrome": true,
    "allowDebugTerminal": false,
    "debugTerminalHotkey": "Ctrl+`"
  },
  "python": {
    "appObject": "app",
    "routePrefix": "/",
    "allowFilesystemAccess": true
  },
  "static": {
    "indexFile": "index.html",
    "allowInlineScripts": true
  }
}
```

## Config fields

- `enabled`
  - Turns App Mode on for the current workspace.
- `runtime`
  - `python` or `static`.
- `entrypoint`
  - Python script path for `python`.
  - Optional HTML entry file for `static`.
- `staticRoot`
  - Base directory for static assets and static HTML routing.
- `workingDirectory`
  - Directory EdgeTerm switches into before starting the app.
- `fullscreen`
  - Enables fullscreen App Mode presentation.
- `autoStart`
  - Starts App Mode automatically when the workspace opens.
- `preserveStateOnExit`
  - Keeps the current app surface alive when leaving App Mode.
- `showLoadingOverlay`
  - Shows a loading screen while the app runtime starts.

### `exit`

- `method`
  - Currently `hotkey`.
- `hotkey`
  - Default is `Escape`.
- `confirmBeforeExit`
  - If `true`, asks for confirmation before leaving App Mode.

### `ui`

- `hideWorkspaceChrome`
  - Hides the normal workspace chrome while the app is active.
- `allowDebugTerminal`
  - Enables a debug-terminal hotkey path.
- `debugTerminalHotkey`
  - Default is `Ctrl+\``.
  - Current behavior returns to the normal terminal view.

### `python`

- `appObject`
  - Name of the app object exported by the script, default `app`.
- `routePrefix`
  - Prefix used for Python route dispatch.
- `allowFilesystemAccess`
  - Documents whether the Python app can use the workspace filesystem. Current runtime keeps normal workspace filesystem access.

### `static`

- `indexFile`
  - Default index file used when routing a static directory.
- `allowInlineScripts`
  - Allows or strips inline `<script>` blocks in static HTML mode.

## Enabling App Mode

You can enable App Mode in two ways:

1. Edit `/etc/appmode/config.json` directly.
2. Open `Settings` inside EdgeTerm Workspace and use the `App Mode` panel.

The settings panel lets you:

- enable or disable App Mode
- pick `python` or `static`
- set entrypoint path
- set static root
- set working directory
- configure fullscreen
- configure auto-start
- configure the exit hotkey
- launch App Mode immediately
- open the config file in the built-in editor

## Python App Mode

Python App Mode uses a browser-side route dispatcher powered by Pyodide. There is no real HTTP server. Requests are routed internally from the browser UI into Python handlers.

Example:

```python
from edgeterm import app, request


@app.route("/")
def index():
    return """
    <h1>Hello from EdgeTerm App Mode</h1>
    <p><a href="/api/data">Open JSON route</a></p>
    """


@app.route("/api/data")
def data():
    return {"value": 123, "query": request.args}
```

### Supported Python return types

- `str`
  - returned as HTML by default
- `dict` or `list`
  - returned as JSON
- `(body, status)`
- `(body, status, headers)`

### Python routing notes

- Route handlers are synchronous in the current implementation.
- `request` exposes:
  - `method`
  - `path`
  - `query_string`
  - `headers`
  - `body`
  - `args`
  - `form`
  - `json`
- If a Python route is not found, EdgeTerm can still serve matching files from `staticRoot`.

## Static HTML App Mode

Static mode loads HTML directly from the workspace filesystem.

Typical layout:

```text
/home/user/public/
  index.html
  app.js
  styles.css
  logo.png
```

Example config:

```json
{
  "enabled": true,
  "runtime": "static",
  "entrypoint": "/home/user/public/index.html",
  "staticRoot": "/home/user/public"
}
```

Static mode supports:

- HTML from the workspace filesystem
- linked JS, CSS, images, audio, and video assets rewritten into browser-safe blob URLs
- internal navigation between local HTML pages
- local `fetch()` calls routed back into the App Mode loader for workspace files

## Entrypoints and working directory

### Python

- `entrypoint` should be a Python file such as `/home/user/app.py`
- `workingDirectory` is applied before running the script

### Static

- `entrypoint` can point directly to an HTML file
- if omitted or directory-like, EdgeTerm uses `staticRoot` + `static.indexFile`

## Exiting App Mode

Primary exit is the configured hotkey:

- default: `Escape`

When App Mode exits:

- EdgeTerm returns to the normal workspace view
- the container is not reset
- if `preserveStateOnExit` is `true`, the app surface stays available for quick re-entry

## Runtime behavior

### Python runtime

- Runs locally through Pyodide
- No backend server
- No sockets or bound ports
- Browser-side request dispatch only

### Static runtime

- Loads local files from the workspace filesystem
- Renders them inside the App Mode surface

## Current limitations

- Python route handlers are synchronous only in this first implementation.
- `allowFilesystemAccess` is descriptive right now; Python apps still use the workspace filesystem normally.
- Static asset rewriting handles common linked assets, but complex CSS `url(...)` rewriting is not fully implemented.
- Browser history and URL bar are not treated like a normal hosted website.
- Debug terminal hotkey currently returns to the normal terminal view rather than opening a live terminal drawer inside the app.
- No cloud publish or share URL support yet.
- No Lua/WASM App Mode runtime yet.

## Future extension points

The loader is designed to grow into more runtimes without changing workspace-level controls:

- Lua runtime
- generic WebAssembly app runtime
- richer static router behavior
- SPA history synchronization
- app-to-terminal debug drawer
- packaged app manifests
- exportable local app bundles
