# EdgeTerm Wasmer SDK runtime

EdgeTerm self-hosts a patched build of `@wasmer/sdk` 0.10.0 so browser
workers do not depend on a third-party CDN.

## Source

- Upstream repository: `https://github.com/wasmerio/wasmer-js`
- Upstream commit: `fafb390806342eeae2253e41cccca3831309e369`
- Wasmer source commit: `1374112e67bbd50418bfd843775622c9eedf2ac3`
- License: MIT
- EdgeTerm patch: `patches/edgeterm-wasmer-sdk-0.10.0.patch`
- Wasmer patch: `patches/wasmer-6.1.0-proc-spawn-stdio.patch`

The patch preserves module bytes when tasks cross worker boundaries, keeps
mounted directories available to raw WASIX runners, applies mounts before an
optional working directory, synchronizes mounted directories when a process
exits, and exposes otherwise hidden runner failures through stderr. These
changes are runtime-generic and do not include package-specific source.

The pinned Wasmer commit includes the required `dup2` behavior for child
standard input, output, and error descriptors. The EdgeTerm Wasmer patch adds
browser-safe process waiting, current-directory inheritance, memory-backed
descriptor closing, and a process-recycle hook used by the SDK to persist
filesystem changes. APT and dpkg use `posix_spawn` for helpers such as archive
extraction, so these changes are required for real package transactions rather
than version-only command execution.

## Rebuild

Clone `wasmer-js` and Wasmer at the pinned commits above. Apply the Wasmer
patch to the Wasmer checkout and point the `wasmer-js` Cargo dependencies for
`virtual-fs`, `virtual-net`, `wasmer`, `wasmer-config`, `wasmer-types`,
`wasmer-wasix`, `wasmer-package`, and `wasmer-backend-api` at that local
checkout. Then apply the EdgeTerm patch and use the upstream browser build:

```bash
git -C ../wasmer apply ../EdgeTerm/runtime/wasmer-sdk/patches/wasmer-6.1.0-proc-spawn-stdio.patch
git apply ../EdgeTerm/runtime/wasmer-sdk/patches/edgeterm-wasmer-sdk-0.10.0.patch
npm install
npm run build
```

Copy `dist/index.mjs`, `dist/worker.mjs`, and
`dist/wasmer_js_bg.wasm` into this directory's `dist/` folder. EdgeTerm's
build script copies these files into the browser runtime.

## Separation from BusyBox

BusyBox is not stored in this directory or bundled into EdgeTerm. EdgeTerm
downloads the separate GPL-2.0-only guest artifact described by
`runtime/external-shell.json`, verifies its manifest and SHA-256 digest, and
runs it through the generic WASIX process boundary.
