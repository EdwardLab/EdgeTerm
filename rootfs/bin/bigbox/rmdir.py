"""
rmdir - remove empty directories.
"""
import os
import sys

import bigbox_utils


def main(args):
    parents = False
    verbose = False
    ignore_fail = False
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
                if ch == "p":
                    parents = True
                elif ch == "v":
                    verbose = True
                elif ch == "-":
                    # long option detection
                    if arg == "--ignore-fail-on-non-empty":
                        ignore_fail = True
                    pass
                else:
                    print(f"rmdir: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: rmdir [-pv] [--ignore-fail-on-non-empty] DIR...", file=sys.stderr)
                    sys.exit(1)
        elif arg == "--ignore-fail-on-non-empty":
            ignore_fail = True
        elif arg in ("--help", "-help"):
            print("Usage: rmdir [-pv] [--ignore-fail-on-non-empty] DIR...")
            print("  -p    remove DIRECTORY and its ancestors; e.g., 'rmdir -p a/b/c' is similar to 'rmdir a/b/c a/b a'")
            print("  -v    output a diagnostic for every directory processed")
            print("      --ignore-fail-on-non-empty  ignore each failure that is solely because a directory is non-empty")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("rmdir (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    if not targets:
        print("rmdir: missing operand", file=sys.stderr)
        print("Usage: rmdir [-pv] [--ignore-fail-on-non-empty] DIR...", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    targets = bigbox_utils.expand_globs(targets)

    exit_code = 0
    for target in targets:
        # Resolve path
        path = bigbox_utils.resolve_path(target)

        if not os.path.exists(path):
            print(f"rmdir: failed to remove '{target}': No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        if not os.path.isdir(path):
            print(f"rmdir: failed to remove '{target}': Not a directory", file=sys.stderr)
            exit_code = 1
            continue

        try:
            if parents:
                # -p: walk up the tree
                # Build list of directories to remove (bottom-up)
                dirs_to_remove = [path]
                parent = os.path.dirname(path)
                while parent and parent != path:
                    if os.path.isdir(parent):
                        dirs_to_remove.append(parent)
                    path = parent
                    parent = os.path.dirname(parent)
                dirs_to_remove.reverse()  # We'll remove from deepest first

                for d in reversed(dirs_to_remove):
                    try:
                        os.rmdir(d)
                        if verbose:
                            print(f"rmdir: removing directory, '{d}'")
                    except OSError as e:
                        if "not empty" in str(e) or "Directory not empty" in str(e) or "ENOTEMPTY" in str(e):
                            if not ignore_fail:
                                print(f"rmdir: failed to remove '{d}': Directory not empty", file=sys.stderr)
                                exit_code = 1
                        else:
                            print(f"rmdir: failed to remove '{d}': {e}", file=sys.stderr)
                            exit_code = 1
                        break  # can't remove parent if child fails
            else:
                os.rmdir(path)
                if verbose:
                    print(f"rmdir: removing directory, '{target}'")

        except OSError as e:
            if "not empty" in str(e) or "Directory not empty" in str(e) or "ENOTEMPTY" in str(e):
                if not ignore_fail:
                    print(f"rmdir: failed to remove '{target}': Directory not empty", file=sys.stderr)
                    exit_code = 1
            else:
                print(f"rmdir: failed to remove '{target}': {e}", file=sys.stderr)
                exit_code = 1

    sys.exit(exit_code)
