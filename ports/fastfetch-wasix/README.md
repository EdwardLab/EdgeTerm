# Fastfetch WASIX port

This port builds Fastfetch 2.66.0 from pinned upstream commit
`08698098579bb8b043b0a343159b8018f5cea4fc` for the EdgeTerm WASIX runtime.

The port keeps the upstream Fastfetch CLI and disables or substitutes hardware
probes that cannot be implemented inside a browser runtime. Runtime-backed OS,
kernel, uptime, package, shell, terminal, CPU, memory, and locale information is
reported from the mounted EdgeTerm POSIX environment.

Build and package:

```sh
ports/fastfetch-wasix/build.sh
ports/fastfetch-wasix/build-deb.sh
```

The Debian package is written to `tests/fixtures/apt-repository` and uses the
`wasm32-wasix` architecture already configured by the EdgeTerm APT runtime.
