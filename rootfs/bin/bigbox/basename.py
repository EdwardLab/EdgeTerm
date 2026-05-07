"""
basename - strip directory and suffix from filenames.
"""
import os
import sys

import bigbox_utils


def main(args):
    multiple = False
    suffix = None
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
                if ch == "a":
                    multiple = True
                elif ch == "s":
                    # -s SUFFIX
                    i += 1
                    if i >= len(args):
                        print("basename: option requires an argument -- 's'", file=sys.stderr)
                        sys.exit(1)
                    suffix = args[i]
                else:
                    print(f"basename: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: basename NAME [SUFFIX]", file=sys.stderr)
                    print("   or: basename [-a] [-s SUFFIX] NAME...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: basename NAME [SUFFIX]")
            print("   or: basename [-a] [-s SUFFIX] NAME...")
            print("  -a    support multiple arguments")
            print("  -s    remove a trailing SUFFIX")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("basename (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    if not targets:
        print("basename: missing operand", file=sys.stderr)
        print("Usage: basename NAME [SUFFIX]", file=sys.stderr)
        sys.exit(1)

    # If not -a and we have exactly 2 args and no -s, second arg is the suffix
    if not multiple and suffix is None and len(targets) == 2:
        suffix = targets[1]
        targets = [targets[0]]

    exit_code = 0
    for target in targets:
        try:
            base = os.path.basename(target)
            if suffix is not None and base.endswith(suffix):
                base = base[:-len(suffix)]
            print(base)
        except Exception as e:
            print(f"basename: {target}: {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
