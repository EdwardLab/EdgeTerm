# EdgeTerm Embed and Bridge

The Embed Edition lets another web application host the upstream EdgeTerm UI
in a cross-origin iframe and control its browser-local workspace through a
small, versioned API.

EdgeTerm remains the runtime and UI owner. The host imports
`@edgeterm/bridge`, opens the Embed build, and calls Bridge methods. Updating
EdgeTerm does not require copying its terminal, editor, filesystem, or preview
implementation into the host product.

## Build

```bash
EDGETERM_BRIDGE_ALLOWED_ORIGINS=http://127.0.0.1:3100,http://localhost:3100 \
  npm run build:embed
npm run serve:embed
```

The build writes `build/bridge-manifest.json`. The manifest records the
protocol version, runtime version, allowed parent origins, capabilities, and a
SHA-256 digest for each emitted asset.

The development server listens on `127.0.0.1:3200` by default. Override it
with `EDGETERM_EMBED_HOST` and `EDGETERM_EMBED_PORT`.

## Host client

```js
import { EdgeTermBridgeClient } from "@edgeterm/bridge";

const bridge = new EdgeTermBridgeClient({
  iframe: document.querySelector("#edgeterm"),
  targetOrigin: "http://127.0.0.1:3200",
});

await bridge.connect();
const status = await bridge.request("runtime.status");
```

The host package is in `packages/bridge`. It has no runtime dependencies.

## Bridge v2 methods

Read operations:

- `runtime.status`
- `runtime.node.status`
- `workspace.list`
- `fs.list`
- `fs.search`
- `fs.read`
- `fs.manifest`
- `fs.read_binary`
- `project.detect`
- `app.status`
- `preview.open`
- `preview.refresh`
- `preview.inspect`
- `preview.console`
- `preview.network`
- `packages.npm.cache_status`
- `backup.status`
- `backup.list`
- `backup.verify`
- `backup.restore_preview`
- `git.status`
- `git.diff`
- `git.log`
- `editor.open`
- `ui.show`

Mutating operations:

- `runtime.node.prepare`
- `runtime.node.reset`
- `workspace.create`
- `workspace.open`
- `project.scaffold`
- `fs.write`
- `fs.replace_text`
- `fs.write_binary`
- `fs.apply_changes`
- `fs.mkdir`
- `fs.delete`
- `terminal.run`
- `terminal.cancel`
- `packages.npm.install`
- `packages.npm.ci`
- `packages.npm.run`
- `packages.npm.cancel`
- `app.start`
- `app.restart`
- `app.stop`
- `git.commit`
- `backup.create`
- `backup.restore`
- `backup.cancel`

Mutating methods do not display their own authorization UI. The embedding
product must show the proposed operation and obtain the user's confirmation
before calling them.

`fs.write` supports `expected_sha256` for optimistic concurrency.
`fs.search` performs bounded literal searches across file names and text
content while skipping generated, secret, oversized, and binary files.
`fs.replace_text` applies an exact optimistic-concurrency update without
rewriting unrelated file content.
`fs.apply_changes` accepts a group of writes and restores earlier contents if
one write fails. `terminal.run` returns the execution ID, exit code, output,
and working directory. Output is also emitted through `terminal.output`
events.

`preview.request` returns the HTTP response code as `http_status`; `status`
describes the Bridge operation. Terminal commands with a nonzero exit code return
`status: "failed"`, preserving their output and exit code.

External backup methods operate on the active browser-local workspace. In an
embedded build, managed OAuth must use the authenticated host request channel;
the embed does not receive a broker URL or provider refresh token. The host may
return a short-lived, provider-scoped access token over the origin-bound
MessagePort so the browser can transfer encrypted backup objects directly to
the selected storage provider. Client secrets and refresh tokens remain in the
host service. Standalone builds may configure their own OAuth broker.
`backup.restore` must always receive separate user confirmation from the
embedding product.

Bridge v2 recognizes the normal development commands used by Flask, FastAPI,
Django, PHP, and Python static servers. It reports a virtual
`127.0.0.1:<port>` listener while requests stay inside EdgeTerm Browser.

`packages.npm.install`, `packages.npm.ci`, and supported frontend
`packages.npm.run` operations use the browser npm and build adapters even when
direct Edge.js execution is unavailable. The `npm_frontend` runtime capability
lists that support separately.

Direct Node/WASM remains an experimental capability. A build advertises
`node_wasm.available` only after the pinned Edge.js artifact passes checksum
verification and a real execution smoke test. When it is not available, React
and Vite projects may still install, build, watch, and preview through the
frontend adapter, while generic Node HTTP, SSR, and API servers return an
explicit request-dispatch error.

`git.commit` requires an explicit `paths` list. It never stages the full
workspace.

## Security boundary

- The Bridge is disabled in Offline and Cloud builds.
- The Embed build accepts connections only from the exact parent origins
  configured at build time.
- The handshake transfers a `MessagePort`; requests do not use wildcard
  `postMessage` targets.
- Every session has a random ID and every request must include it.
- Requests are limited to 1 MiB. Larger binary files use bounded chunks.
- Filesystem methods are restricted to the active workspace user's home
  directory.
- EdgeTerm runs commands in its browser worker. Bridge does not provide host
  shell, Docker, SSH, native sockets, host filesystem, or server process
  access.
- The embedding host and EdgeTerm should use different origins. This keeps
  workspace-rendered content outside the host application's origin.

Run the protocol tests with:

```bash
npm run test:bridge
```
