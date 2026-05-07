"""
logname — print user's login name.
Usage: logname [OPTION]
"""
import os
import sys

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"logname (edgeos-bigbox) {VERSION}")
        return

    # Check for invalid options
    for a in args:
        if a.startswith("-") and a not in ("--help", "--version"):
            print(f"logname: invalid option -- '{a}'", file=sys.stderr)
            sys.exit(2)

    # Read from EDGE_USER env var (set by EdgeTerm)
    user = os.environ.get("EDGE_USER")
    if user:
        print(user)
        return

    # Fallback to standard env vars
    user = os.environ.get("USER") or os.environ.get("LOGNAME") or os.environ.get("USERNAME")
    if user:
        print(user)
        return

    # Last resort
    print("user")


def _help():
    print("Usage: logname [OPTION]")
    print("Print the name of the current user.")
    print()
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
