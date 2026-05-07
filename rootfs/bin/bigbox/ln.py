"""
ln - make links between files.
"""
import os
import sys

import bigbox_utils


def main(args):
    symbolic = False
    force = False
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
                    symbolic = True
                elif ch == "f":
                    force = True
                elif ch == "v":
                    pass  # verbose, silently accepted
                else:
                    print(f"ln: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: ln [-sf] TARGET LINK_NAME", file=sys.stderr)
                    print("   or: ln [-sf] TARGET... DIRECTORY", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: ln [-sf] TARGET LINK_NAME")
            print("   or: ln [-sf] TARGET... DIRECTORY")
            print("  -s    make symbolic links instead of hard links")
            print("  -f    remove existing destination files")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("ln (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    if len(targets) < 2:
        print("ln: missing operand", file=sys.stderr)
        print("Usage: ln [-sf] TARGET LINK_NAME", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    targets = bigbox_utils.expand_globs(targets)

    last = targets[-1]
    sources = targets[:-1]

    # If last is a directory, create links inside it
    if os.path.isdir(last):
        exit_code = 0
        for src in sources:
            if not os.path.lexists(src):
                print(f"ln: failed to access '{src}': No such file or directory", file=sys.stderr)
                exit_code = 1
                continue
            dest = os.path.join(last, os.path.basename(src))
            try:
                if force and os.path.lexists(dest):
                    os.unlink(dest)
                if symbolic:
                    os.symlink(src, dest)
                else:
                    os.link(src, dest)
            except OSError as e:
                print(f"ln: failed to create link '{dest}': {e}", file=sys.stderr)
                exit_code = 1
        sys.exit(exit_code)

    # Otherwise: TARGET LINK_NAME
    if len(sources) != 1:
        print(f"ln: target '{last}' is not a directory", file=sys.stderr)
        sys.exit(1)

    src = sources[0]
    dest = last

    if not os.path.lexists(src):
        if symbolic:
            # For symbolic links, we allow the target to not exist
            pass
        else:
            print(f"ln: failed to access '{src}': No such file or directory", file=sys.stderr)
            sys.exit(1)

    try:
        if force and os.path.lexists(dest):
            os.unlink(dest)
        if symbolic:
            os.symlink(src, dest)
        else:
            os.link(src, dest)
    except OSError as e:
        print(f"ln: failed to create link '{dest}': {e}", file=sys.stderr)
        sys.exit(1)
