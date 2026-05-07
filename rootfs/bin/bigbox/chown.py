"""
chown - change file owner and group.
"""
import os
import sys

import bigbox_utils


def main(args):
    recursive = False
    owner_group = None
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
                    print(f"chown: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: chown [-R] OWNER[:GROUP] FILE...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: chown [-R] OWNER[:GROUP] FILE...")
            print("  -R    operate on files and directories recursively")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("chown (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    if len(targets) < 1:
        print("chown: missing operand", file=sys.stderr)
        print("Usage: chown [-R] OWNER[:GROUP] FILE...", file=sys.stderr)
        sys.exit(1)

    # First target is the owner[:group] spec
    owner_group = targets[0]
    files = targets[1:]

    if not files:
        print("chown: missing operand after '%s'" % owner_group, file=sys.stderr)
        print("Usage: chown [-R] OWNER[:GROUP] FILE...", file=sys.stderr)
        sys.exit(1)

    # Expand globs
    files = bigbox_utils.expand_globs(files)

    # Check all files exist first
    exit_code = 0
    for f in files:
        if not os.path.lexists(f):
            print(f"chown: cannot access '{f}': No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        # Simulate ownership change
        try:
            if recursive and os.path.isdir(f) and not os.path.islink(f):
                for dirpath, dirnames, filenames in os.walk(f):
                    st = os.stat(dirpath)
                    print(f"chown: changing ownership of '{dirpath}' to {owner_group} (simulated)")
                    for filename in filenames:
                        fp = os.path.join(dirpath, filename)
                        print(f"chown: changing ownership of '{fp}' to {owner_group} (simulated)")
                    for dirname in dirnames:
                        dp = os.path.join(dirpath, dirname)
                        print(f"chown: changing ownership of '{dp}' to {owner_group} (simulated)")
            else:
                print(f"chown: changing ownership of '{f}' to {owner_group} (simulated)")
        except OSError as e:
            print(f"chown: changing ownership of '{f}': {e} (simulated)", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
