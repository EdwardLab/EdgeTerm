import glob as glob_mod
import os
import sys


def parse_flags(args):
    """Parse combined short flags like -pv into individual flags."""
    parents = False
    verbose = False
    mode = None
    targets = []
    i = 0

    while i < len(args):
        arg = args[i]
        if arg == "--":
            i += 1
            targets.extend(args[i:])
            break
        if arg.startswith("-") and not arg.startswith("--"):
            flags = arg[1:]
            for ch in flags:
                if ch == "p":
                    parents = True
                elif ch == "v":
                    verbose = True
                elif ch == "m":
                    # -m MODE — mode argument follows
                    # Could be next arg (e.g., -m 755) or attached (e.g., -m755)
                    if len(flags) > 1 and flags.index(ch) < len(flags) - 1:
                        # Attached form: -m755
                        rest = flags[flags.index(ch) + 1:]
                        mode = rest
                        break
                    else:
                        i += 1
                        if i >= len(args):
                            print("mkdir: option requires an argument -- 'm'", file=sys.stderr)
                            sys.exit(1)
                        mode = args[i]
                else:
                    print(f"mkdir: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: mkdir [-pv] [-m MODE] <dir...>", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: mkdir [-pv] [-m MODE] <dir...>")
            print("  -p    make parent directories as needed")
            print("  -v    print a message for each created directory")
            print("  -m    set file mode (as in chmod), e.g., -m 755")
            sys.exit(0)
        elif arg == "--version":
            print("mkdir (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    return parents, verbose, mode, targets


def main(args):
    parents, verbose, mode, targets = parse_flags(args)

    if not targets:
        print("mkdir: missing operand", file=sys.stderr)
        print("Usage: mkdir [-pv] [-m MODE] <dir...>", file=sys.stderr)
        sys.exit(1)

    # Parse the mode if provided
    mode_int = None
    if mode is not None:
        try:
            mode_int = int(mode, 8)
        except ValueError:
            print(f"mkdir: invalid mode '{mode}'", file=sys.stderr)
            sys.exit(1)

    # Expand globs
    expanded = []
    for t in targets:
        matches = glob_mod.glob(t)
        if matches:
            expanded.extend(matches)
        else:
            expanded.append(t)

    exit_code = 0
    for path in expanded:
        try:
            if parents:
                os.makedirs(path, exist_ok=True)
            else:
                os.mkdir(path)
                if mode_int is not None:
                    os.chmod(path, mode_int)
            if verbose:
                print(f"mkdir: created directory '{path}'")
        except FileExistsError:
            if not parents:
                print(f"mkdir: cannot create directory '{path}': File exists", file=sys.stderr)
                exit_code = 1
        except OSError as e:
            print(f"mkdir: cannot create directory '{path}': {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
