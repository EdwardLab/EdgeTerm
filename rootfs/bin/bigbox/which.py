"""
which - locate a command.
"""
import os
import sys

import bigbox_utils


def find_executable(name, path_dirs):
    """Search for an executable in the given path directories."""
    results = []
    for p in path_dirs:
        if not p:
            continue
        full = os.path.join(p, name)
        if os.path.isfile(full) and os.access(full, os.X_OK):
            results.append(full)
    return results


def main(args):
    all_matches = False
    targets = []

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "a":
                    all_matches = True
                else:
                    print(f"which: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: which [-a] COMMAND...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: which [-a] COMMAND...")
            print("  -a    print all matching executables in PATH, not just the first")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("which (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    if not targets:
        print("which: missing operand", file=sys.stderr)
        print("Usage: which [-a] COMMAND...", file=sys.stderr)
        sys.exit(1)

    # Build PATH directories
    path_str = os.environ.get("PATH", "")
    path_dirs = path_str.split(os.pathsep) if path_str else []

    # Always include /bin/bigbox
    bigbox_dir = "/bin/bigbox"
    if bigbox_dir not in path_dirs:
        path_dirs.append(bigbox_dir)

    exit_code = 0
    for target in targets:
        results = find_executable(target, path_dirs)
        if not results:
            exit_code = 1
            continue
        if all_matches:
            for r in results:
                print(r)
        else:
            print(results[0])

    sys.exit(exit_code)
