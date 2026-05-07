"""
chgrp - change group ownership.
"""
import os
import sys

import bigbox_utils


def main(args):
    recursive = False
    group = None
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
                if ch == "R":
                    recursive = True
                else:
                    print(f"chgrp: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: chgrp [-R] GROUP FILE...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: chgrp [-R] GROUP FILE...")
            print("  -R    operate on files and directories recursively")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("chgrp (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    if len(targets) < 1:
        print("chgrp: missing operand", file=sys.stderr)
        print("Usage: chgrp [-R] GROUP FILE...", file=sys.stderr)
        sys.exit(1)

    # First target is the group
    group = targets[0]
    files = targets[1:]

    if not files:
        print("chgrp: missing operand after '%s'" % group, file=sys.stderr)
        print("Usage: chgrp [-R] GROUP FILE...", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    files = bigbox_utils.expand_globs(files)

    # Check all files exist first
    exit_code = 0
    for f in files:
        if not os.path.lexists(f):
            print(f"chgrp: cannot access '{f}': No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        # Simulate group change
        try:
            if recursive and os.path.isdir(f) and not os.path.islink(f):
                for dirpath, dirnames, filenames in os.walk(f):
                    print(f"chgrp: changing group of '{dirpath}' to {group} (simulated)")
                    for filename in filenames:
                        fp = os.path.join(dirpath, filename)
                        print(f"chgrp: changing group of '{fp}' to {group} (simulated)")
                    for dirname in dirnames:
                        dp = os.path.join(dirpath, dirname)
                        print(f"chgrp: changing group of '{dp}' to {group} (simulated)")
            else:
                print(f"chgrp: changing group of '{f}' to {group} (simulated)")
        except OSError as e:
            print(f"chgrp: changing group of '{f}': {e} (simulated)", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
