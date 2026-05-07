"""
arch — print machine architecture.
Usage: arch [OPTION]
"""
import sys

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"arch (edgeos-bigbox) {VERSION}")
        return

    # Filter out known flags so invalid ones produce error
    known = {"--help", "--version"}
    for a in args:
        if a in known:
            continue
        if a.startswith("-"):
            print(f"arch: invalid option -- '{a}'", file=sys.stderr)
            sys.exit(2)

    # Output wasm32 for EdgeTerm (WebAssembly)
    print("wasm32")


def _help():
    print("Usage: arch [OPTION]")
    print("Print machine architecture.")
    print()
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
