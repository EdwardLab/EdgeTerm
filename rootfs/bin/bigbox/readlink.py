"""
readlink - print resolved symbolic links.
"""
import os
import sys

import bigbox_utils


def main(args):
    canonicalize = False
    no_newline = False
    targets = []

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "f":
                    canonicalize = True
                elif ch == "n":
                    no_newline = True
                else:
                    print(f"readlink: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: readlink [-fn] FILE...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: readlink [-fn] FILE...")
            print("  -f    canonicalize by following every symlink in every component of the file name")
            print("  -n    do not output the trailing newline")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("readlink (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    if not targets:
        print("readlink: missing operand", file=sys.stderr)
        print("Usage: readlink [-fn] FILE...", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    targets = bigbox_utils.expand_globs(targets)

    exit_code = 0
    for target in targets:
        if not os.path.lexists(target):
            print(f"readlink: {target}: No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        try:
            if canonicalize:
                result = os.path.realpath(target)
            else:
                if not os.path.islink(target):
                    # Follow GNU readlink: silently skip non-symlinks without -f
                    print(f"readlink: {target}: Invalid argument", file=sys.stderr)
                    exit_code = 1
                    continue
                result = os.readlink(target)

            if no_newline:
                print(result, end="")
            else:
                print(result)
        except OSError as e:
            print(f"readlink: {target}: {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
