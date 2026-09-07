# EdgeTerm development environment

EdgeTerm projects can declare a reproducible browser-local environment in `edgeterm.toml`. The project configuration, source files, dependency state, debugger data, test output, and checkpoints remain on the current device.

## Project configuration

The current schema version is `1`:

```toml
version = 1

[project]
name = "Example API"
root = "."
framework = "fastapi"

[packages]
apt = ["git"]
npm = []
pip = ["fastapi", "uvicorn"]

[env]
APP_MODE = "development"

[secrets]
DATABASE_URL = "vault:database-url"

[[tasks]]
id = "dev"
label = "Run API"
command = "uvicorn main:app"
cwd = "."
kind = "command"
background = true
problem_matcher = ""

[preview]
task = "dev"
path = "/"
auto_open = true

[permissions]
network = "ask"
package_install = "ask"
```

Supported framework identifiers are `static`, `vite`, `nextjs-static`, `flask`, `fastapi`, `django`, and `php`. If the file is absent, EdgeTerm inspects the project and prepares a draft. Restoring the environment creates a checkpoint before package changes and writes the generated file only after validation.

Secret values belong in the local encrypted Vault. The configuration stores only `vault:name` references. Vault values are not displayed after saving and are excluded from project files, exports, and language-service input.

## Development workspace

The Projects page contains five compact panels:

- **Environment** compares the declared packages with the active browser environment and restores missing dependencies.
- **Tasks** starts declared commands through the Process Host.
- **Tests** discovers Python unittest, pytest, Django, npm, and PHP suites. Each run records the real exit code, duration, structured cases, output, and failure locations.
- **Debug** starts the supported Python single-file debugger with breakpoints, continue, step, stack, locals, and stop. Other adapters remain unavailable until the browser runtime can provide their required execution control.
- **Checkpoints** stores, compares, pins, and restores local project states.

Project checkpoints are hash-verified ZIP archives stored in IndexedDB. EdgeTerm creates them before AI change sets, npm installation, environment restoration, and other declared bulk changes. APT uses compact package-state checkpoints containing the exact installed package names and versions; restoring one asks the original APT runtime to apply only the package delta. Automatic project checkpoints retain the latest 30 unpinned entries. Pinned entries are retained until explicitly removed.

## Process Host

The Process Host provides one lifecycle for terminal commands, tasks, tests, debuggers, package operations, and Digi AI:

- `process.start`
- `process.status`
- `process.output`
- `process.input`
- `process.signal`
- `process.resize`
- `process.wait`

Every process records its command, working directory, state, timestamps, workspace generation, and real exit code. Output is collected without terminal prompt text or nested terminal rendering. Unsupported input, terminal resize, signals, sockets, process creation, or device access returns an explicit capability error.

## Language and component services

Language services use JSON-RPC in a dedicated Worker. Monaco supplies its built-in JavaScript, TypeScript, HTML, CSS, and JSON features; EdgeTerm adds project indexing, Python syntax diagnostics, SQL symbols, cross-file definitions, references, rename, hover, formatting, and diagnostics through the language Bridge methods.

The experimental Component Host currently exposes CLI environment, standard streams, workspace filesystem operations, clocks, random data, and terminal capability. HTTP requires separate approval. DNS and sockets remain unavailable until the active browser can provide and authorize them. Existing WASIX programs continue to use the stable package runtime and do not depend on the Component Host.

## Bridge methods

Development integrations can inspect capabilities with `runtime.status`. The relevant Bridge groups are:

- `project.environment.inspect` and `project.environment.apply`
- `task.list`, `task.run`, and `task.cancel`
- `language.status`, `language.restart`, and `language.diagnostics`
- `test.discover`, `test.run`, and `test.cancel`
- `debug.status`, `debug.start`, `debug.command`, and `debug.stop`
- `checkpoint.create`, `checkpoint.list`, `checkpoint.diff`, `checkpoint.restore`, and `checkpoint.pin`
- `process.start`, `process.status`, `process.output`, `process.input`, `process.signal`, `process.resize`, and `process.wait`
- `runtime.component.status` and `runtime.component.invoke`

All long operations return request identifiers, state, exit status when applicable, workspace generation, timestamps, and recoverable error information. Read-only inspection does not require write approval. File changes, package operations, process starts, checkpoint restoration, and debugger control follow the active workspace permission policy.
