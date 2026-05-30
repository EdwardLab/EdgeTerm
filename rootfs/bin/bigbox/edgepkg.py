"""edgepkg - install optional EdgeTerm browser runtime packages."""

import json
import os


PACKAGES = {
    "boxedwine": {
        "name": "boxedwine",
        "version": "experimental",
        "runtime": "boxedwine",
        "description": "Browser-only BoxedWine WebAssembly runtime package placeholder.",
        "assets": {
            "loader": "boxedwine.js",
            "wasm": "boxedwine.wasm"
        },
        "commands": {}
    },
    "wine-runtime": {
        "name": "wine-runtime",
        "version": "experimental",
        "runtime": "wine",
        "description": "Wine userspace bundle metadata for the EdgeTerm BoxedWine bridge.",
        "requires": ["boxedwine"],
        "prefix": "/home/user/.wine",
        "bin": {
            "wine": "wine.py",
            "wineconsole": "wine.py",
            "winecfg": "wine.py",
            "winetricks": "wine.py"
        }
    },
}


HELP = """Usage:
  edgepkg install boxedwine
  edgepkg install wine-runtime
  edgepkg list

edgepkg records optional browser runtime package metadata inside /packages.
Large WASM/runtime bundles are intentionally lazy-loaded or supplied by an
Offline/Cloud Edition asset bundle; the backend never executes package code.
"""


def _ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def _write_text(path, text):
    _ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def _install(name):
    manifest = PACKAGES.get(name)
    if not manifest:
        print(f"edgepkg: unknown package: {name}")
        return 1
    root = f"/packages/{name}"
    _ensure_dir(root)
    _write_text(f"{root}/package.json", json.dumps(manifest, indent=2) + "\n")
    if name == "boxedwine":
        _write_text(
            f"{root}/README.txt",
            "Place the BoxedWine Emscripten loader and .wasm assets here, or configure an Edition asset URL.\n"
        )
    if name == "wine-runtime":
        _ensure_dir("/home/user/.wine")
        _write_text(
            "/home/user/.wine/edgeterm-wine.json",
            json.dumps({
                "runtime": "wine",
                "engine": "boxedwine",
                "storage": "workspace",
                "createdBy": "edgepkg",
                "experimental": True
            }, indent=2) + "\n"
        )
    print(f"[edgepkg] installed {name}")
    return 0


async def main(args):
    if not args or args[0] in {"-h", "--help"}:
        print(HELP.strip())
        return 0 if args else 1
    command = args[0]
    if command == "list":
        for name in sorted(PACKAGES):
            installed = os.path.isfile(f"/packages/{name}/package.json")
            print(f"{name}{' (installed)' if installed else ''}")
        return 0
    if command == "install":
        if len(args) < 2:
            print("edgepkg: missing package name")
            return 1
        code = 0
        for name in args[1:]:
            code = max(code, _install(name))
        return code
    print(f"edgepkg: unknown command: {command}")
    return 1
