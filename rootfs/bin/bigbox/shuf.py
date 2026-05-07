import os
import random
import sys
import bigbox_utils


VERSION = "shuf (EdgeTerm bigbox)"


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "shuf",
                "[FILE]",
                [("-n COUNT", "output at most COUNT lines"),
                 ("-e", "echo mode: treat each argument as an input line"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

    # Parse flags
    count = None
    echo_mode = False
    positional = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "-e":
            echo_mode = True
        elif arg == "-n" and i + 1 < len(args):
            i += 1
            count = int(args[i])
        elif arg.startswith("-n") and len(arg) > 2:
            count = int(arg[2:])
        elif arg.startswith("--") and arg != "--":
            print(f"shuf: unrecognized option '{arg}'", file=sys.stderr)
            sys.exit(1)
        elif arg.startswith("-") and not arg.startswith("--") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "e":
                    echo_mode = True
                elif ch == "n":
                    print(f"shuf: option requires an argument -- 'n'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"shuf: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            positional.append(arg)
        i += 1

    if echo_mode:
        # Echo mode: shuffle the remaining args
        pool = positional
    elif not positional or positional[0] == "-":
        pool = sys.stdin.read().splitlines(keepends=False)
    else:
        filepath = positional[0]
        if not os.path.exists(filepath):
            print(f"shuf: {filepath}: No such file", file=sys.stderr)
            sys.exit(1)
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            pool = f.read().splitlines(keepends=False)

    random.shuffle(pool)

    if count is not None:
        pool = pool[:count]

    for line in pool:
        sys.stdout.write(line + "\n")
