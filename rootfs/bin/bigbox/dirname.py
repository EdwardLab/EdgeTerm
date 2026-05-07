"""
dirname - strip last component from file name.
"""
import os
import sys

import bigbox_utils


def main(args):
    targets = []

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                print(f"dirname: invalid option -- '{ch}'", file=sys.stderr)
                print("Usage: dirname NAME...", file=sys.stderr)
                sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: dirname NAME...")
            print("Output each NAME with its last non-slash component and trailing slashes removed.")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("dirname (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    if not targets:
        print("dirname: missing operand", file=sys.stderr)
        print("Usage: dirname NAME...", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    targets = bigbox_utils.expand_globs(targets)

    exit_code = 0
    for target in targets:
        try:
            print(os.path.dirname(target))
        except Exception as e:
            print(f"dirname: {target}: {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
