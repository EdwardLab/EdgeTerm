# External shell runtime

EdgeTerm can prefer a separately distributed BusyBox WASIX executable for
common Unix commands while retaining the Python EdgeTerm shell as a fallback.
The MPL-2.0 application does not include or link BusyBox source code or its
compiled artifact.

## Runtime boundary

The build copies a generic WASIX worker and a small runtime configuration into
`external-runtime/`. On first use, the worker downloads the configured release
manifest and artifact, validates the schema, runtime identifier, license,
length, and SHA-256 checksum, and performs a real command smoke test. It then
mounts the active workspace at `/home/user` and a generated compatibility seed
at `/.edgeterm-posix`. Native ash copies the seed into its ephemeral process
root before it reads `/etc/profile`. Only the workspace mount is synchronized
back to browser storage. System compatibility files never overwrite user
files. Simple
pipelines use separate WASIX processes with bounded buffered standard input so
they do not depend on browser support for guest process forking.

The external Unix shell excludes `node_modules` from its temporary mount.
Node and npm commands continue to use the dedicated Node runtime and its
persistent dependency storage.

Entering `busybox ash`, `busybox sh`, `ash`, or `sh -i` starts an EdgeTerm-managed
BusyBox shell session. Commands remain in the BusyBox runtime until `exit`
returns to the host-integrated EdgeTerm shell. The session uses one long-lived
native WASIX process with writable standard input and streamed standard output.
Shell variables, aliases, the current directory, and commands waiting for input
remain active between terminal submissions. Workspace changes are synchronized
back to browser storage while the process is running and once more when it exits.

## POSIX compatibility environment

The EdgeTerm host creates a browser-local POSIX compatibility profile around
the separate BusyBox executable. It provides the conventional directory tree,
including `/bin`, `/etc`, `/home`, `/proc`, `/run`, `/sys`, `/tmp`, `/usr`, and
`/var`. `/home/user` is the persistent workspace. `/tmp` and the generated
system tree belong to the current WASIX process.

The profile includes conventional account, hostname, locale, resolver,
protocol, service, mount, machine ID, process, memory, CPU, cgroup, network,
and TTY files. It also provides read-only compatibility commands for host
information that cannot be implemented as BusyBox applets on the current WASIX
ABI, including `getconf`, `getent`, `hostname`, `nproc`, `df`, `free`, `uptime`,
`locale`, `mount`, `stty`, `logname`, `users`, and `who`. Storage values come
from the browser origin storage estimate. Memory and process limits describe
the WebAssembly runtime, not the host computer.

Wasmer supplies the process streams and devices such as `/dev/null`,
`/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/urandom`, and
`/dev/zero`. EdgeTerm keeps one native ash process alive and forwards complete
terminal lines to its standard input. This supports interactive shell state and
programs that consume streamed input, but it is not a raw Unix PTY. Terminal
ioctls, job control, sessions, signals, file locks, FIFOs, dynamic mounts,
privilege changes, and raw device administration remain limited by the browser
WASIX ABI.

`/proc` and `/sys` are compatibility views for feature detection rather than
dynamic runtime filesystems. Static fields use conservative values and identify
the runtime as WASIX. Programs must still check actual syscall results before
enabling a feature.

The default release comes from the separate GPL-2.0-only source repository:

`https://github.com/DigitalPlatDev/EdgeTerm-BusyBox-WASIX`

The artifact is never copied into the EdgeTerm source tree or build output.

## Fallback behavior

The Python shell remains part of the normal EdgeTerm root filesystem. It is
used when the external runtime is disabled, unavailable, incompatible, fails
integrity validation, or cannot run because the page lacks cross-origin
isolation. Host-integrated commands such as Python, PHP, npm, Node, EdgeServe,
package management, and workspace help also remain on their dedicated runtime
paths. They remain callable after leaving native ash. The command router keeps
native BusyBox/POSIX commands inside ash and sends host-integrated runtimes to
their existing EdgeTerm implementations.

The Bridge exposes `runtime.external_shell.prepare`,
`runtime.external_shell.status`, and `runtime.external_shell.reset`. Runtime
status reports whether BusyBox is ready and identifies the active fallback.

## Local development

Set `EDGETERM_EXTERNAL_SHELL_MANIFEST_URL` while building to test a local or
staging manifest without changing the committed release configuration:

```bash
EDGETERM_EXTERNAL_SHELL_MANIFEST_URL=http://127.0.0.1:4187/runtime-manifest.json npm run build:offline
```

The manifest and artifact server must provide appropriate CORS headers when it
uses a different origin. EdgeTerm itself must be served with cross-origin
opener and embedder policies so the Wasmer browser SDK can use
`SharedArrayBuffer`.

The embed development server can mount a separately built GPL runtime on the
same origin without copying it into this repository:

```bash
EDGETERM_EXTERNAL_SHELL_MANIFEST_URL=/external-runtime-package/runtime-manifest.json npm run build:embed
EDGETERM_EXTERNAL_RUNTIME_LOCAL_DIR=../EdgeTerm-BusyBox-WASIX/edgeterm/dist npm run serve:embed
```

The mounted directory is available only at `/external-runtime-package/` while
the development server is running. It is not included in the EdgeTerm build.
