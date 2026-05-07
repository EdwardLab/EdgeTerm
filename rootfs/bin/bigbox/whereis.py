"""
whereis - locate binary, source, and manual for command.
"""
import os
import sys

import bigbox_utils


# Standard search locations
BINARY_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/bin/bigbox"]
SOURCE_DIRS = ["/usr/src", "/usr/local/src"]
MAN_DIRS = ["/usr/share/man/man1", "/usr/share/man/man8",
            "/usr/local/share/man/man1", "/usr/local/share/man/man8",
            "/usr/man/man1", "/usr/man/man8"]


def find_binaries(name):
    """Find all matching binaries in standard locations."""
    results = []
    for d in BINARY_DIRS:
        full = os.path.join(d, name)
        if os.path.isfile(full) and os.access(full, os.X_OK):
            results.append(full)
        # Also check with .py extension (bigbox applets)
        py_path = full + ".py"
        if os.path.isfile(py_path):
            results.append(py_path)
    return results


def find_sources(name):
    """Find all matching source files."""
    results = []
    for d in SOURCE_DIRS:
        if not os.path.isdir(d):
            continue
        try:
            for root, dirs, files in os.walk(d):
                for f in files:
                    if f == name or f.startswith(name + "."):
                        results.append(os.path.join(root, f))
        except OSError:
            pass
    return results


def find_manuals(name):
    """Find all matching man pages."""
    results = []
    for d in MAN_DIRS:
        if not os.path.isdir(d):
            continue
        try:
            for f in os.listdir(d):
                # Match name.N* or name.N.*
                if f == name or f.startswith(name + "."):
                    results.append(os.path.join(d, f))
        except OSError:
            pass
    return results


def main(args):
    search_binary = True
    search_manual = True
    targets = []

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "b":
                    search_manual = False
                elif ch == "m":
                    search_binary = False
                else:
                    print(f"whereis: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: whereis [-b] [-m] COMMAND...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: whereis [-b] [-m] COMMAND...")
            print("  -b    search only for binaries")
            print("  -m    search only for manuals")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("whereis (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    if not targets:
        print("whereis: missing operand", file=sys.stderr)
        print("Usage: whereis [-b] [-m] COMMAND...", file=sys.stderr)
        sys.exit(1)

    for target in targets:
        parts = []
        if search_binary:
            bins = find_binaries(target)
            if bins:
                parts.append(" ".join(bins))
        if search_manual:
            mans = find_manuals(target)
            if mans:
                parts.append(" ".join(mans))

        if parts:
            print(f"{target}: {' '.join(parts)}")
        else:
            print(f"{target}:")
