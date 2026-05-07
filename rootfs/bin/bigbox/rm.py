import glob as glob_mod
import os
import shutil
import sys


def parse_flags(args):
    """Parse combined short flags like -rf into individual flags."""
    recursive = False
    force = False
    verbose = False
    targets = []

    for arg in args:
        if arg.startswith("-") and not arg.startswith("--"):
            flags = arg[1:]  # strip leading dash
            for ch in flags:
                if ch == "r" or ch == "R":
                    recursive = True
                elif ch == "f":
                    force = True
                elif ch == "v":
                    verbose = True
                else:
                    print(f"rm: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: rm [-rfv] <file...>", file=sys.stderr)
                    sys.exit(1)
        elif arg == "--help":
            print("Usage: rm [-rfv] <file...>")
            print("  -r, -R   remove directories and their contents recursively")
            print("  -f       ignore nonexistent files, never prompt")
            print("  -v       explain what is being done")
            sys.exit(0)
        elif arg == "--version":
            print("rm (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    return recursive, force, verbose, targets


def expand_targets(targets):
    """Expand glob patterns in targets."""
    expanded = []
    for t in targets:
        matches = glob_mod.glob(t)
        if matches:
            expanded.extend(matches)
        else:
            expanded.append(t)
    return expanded


def main(args):
    recursive, force, verbose, targets = parse_flags(args)

    if not targets:
        if force:
            return 0
        print("rm: missing operand", file=sys.stderr)
        print("Usage: rm [-rfv] <file...>", file=sys.stderr)
        sys.exit(1)

    targets = expand_targets(targets)
    exit_code = 0

    for path in targets:
        if not os.path.lexists(path):
            if not force:
                print(f"rm: cannot remove '{path}': No such file or directory", file=sys.stderr)
                exit_code = 1
            continue

        try:
            if os.path.isdir(path) and not os.path.islink(path):
                if recursive:
                    shutil.rmtree(path)
                    if verbose:
                        print(f"removed directory '{path}'")
                else:
                    print(f"rm: cannot remove '{path}': Is a directory", file=sys.stderr)
                    exit_code = 1
            else:
                os.remove(path)
                if verbose:
                    print(f"removed '{path}'")
        except PermissionError as e:
            if not force:
                print(f"rm: cannot remove '{path}': {e}", file=sys.stderr)
                exit_code = 1
        except OSError as e:
            if not force:
                print(f"rm: cannot remove '{path}': {e}", file=sys.stderr)
                exit_code = 1

    sys.exit(exit_code)
