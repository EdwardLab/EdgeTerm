"""
realpath - print resolved path.
"""
import os
import sys

import bigbox_utils


def main(args):
    no_symlinks = False
    relative_to = None
    targets = []
    i = 0

    while i < len(args):
        arg = args[i]
        if arg == "--":
            i += 1
            targets.extend(args[i:])
            break
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "s":
                    no_symlinks = True
                else:
                    print(f"realpath: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: realpath [-s] [--relative-to=DIR] FILE...", file=sys.stderr)
                    sys.exit(1)
        elif arg.startswith("--relative-to="):
            relative_to = arg[len("--relative-to="):]
        elif arg == "--relative-to":
            i += 1
            if i >= len(args):
                print("realpath: option --relative-to requires an argument", file=sys.stderr)
                sys.exit(1)
            relative_to = args[i]
        elif arg in ("--help", "-help"):
            print("Usage: realpath [-s] [--relative-to=DIR] FILE...")
            print("  -s              don't expand symlinks")
            print("      --relative-to=DIR  print paths relative to DIR")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("realpath (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    if not targets:
        print("realpath: missing operand", file=sys.stderr)
        print("Usage: realpath [-s] [--relative-to=DIR] FILE...", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    targets = bigbox_utils.expand_globs(targets)

    exit_code = 0
    for target in targets:
        if not os.path.lexists(target):
            print(f"realpath: {target}: No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        try:
            if no_symlinks:
                resolved = os.path.abspath(target)
            else:
                resolved = os.path.realpath(target)

            if relative_to is not None:
                try:
                    resolved = os.path.relpath(resolved, relative_to)
                except ValueError:
                    # On Windows, relpath fails across drives; just use absolute
                    pass

            print(resolved)
        except OSError as e:
            print(f"realpath: {target}: {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
