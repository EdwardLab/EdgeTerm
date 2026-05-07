"""
install - copy files and set attributes.
"""
import os
import shutil
import stat
import sys

import bigbox_utils


def main(args):
    make_dirs = False
    mode_str = None
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
                if ch == "d":
                    make_dirs = True
                elif ch == "m":
                    # -m MODE
                    i += 1
                    if i >= len(args):
                        print("install: option requires an argument -- 'm'", file=sys.stderr)
                        sys.exit(1)
                    mode_str = args[i]
                else:
                    print(f"install: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: install [-d] [-m MODE] SOURCE... DEST", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: install [-d] [-m MODE] SOURCE... DEST")
            print("  -d    treat all arguments as directory names and create them")
            print("  -m    set permission mode (as in chmod), e.g., -m 755")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("install (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    # Parse mode
    mode_int = None
    if mode_str is not None:
        try:
            if mode_str.startswith("0"):
                mode_int = int(mode_str, 8)
            else:
                # Try decimal first, then octal
                try:
                    mode_int = int(mode_str)
                except ValueError:
                    mode_int = int(mode_str, 8)
        except (ValueError, TypeError):
            print(f"install: invalid mode '{mode_str}'", file=sys.stderr)
            sys.exit(1)

    # Expand globs
    targets = bigbox_utils.expand_globs(targets)

    # -d mode: create directories
    if make_dirs:
        if not targets:
            print("install: missing operand", file=sys.stderr)
            print("Usage: install [-d] [-m MODE] SOURCE... DEST", file=sys.stderr)
            sys.exit(1)

        exit_code = 0
        for target in targets:
            try:
                os.makedirs(target, exist_ok=True)
                if mode_int is not None:
                    os.chmod(target, mode_int)
            except OSError as e:
                print(f"install: cannot create directory '{target}': {e}", file=sys.stderr)
                exit_code = 1
        sys.exit(exit_code)

    # Regular mode: SOURCE... DEST
    if len(targets) < 2:
        print("install: missing destination file operand after", file=sys.stderr, end=" ")
        if targets:
            print(f"'{targets[0]}'", file=sys.stderr)
        else:
            print("'...'", file=sys.stderr)
        print("Usage: install [-d] [-m MODE] SOURCE... DEST", file=sys.stderr)
        sys.exit(1)

    sources = targets[:-1]
    dest = targets[-1]

    exit_code = 0
    for src in sources:
        if not os.path.exists(src):
            print(f"install: cannot stat '{src}': No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        try:
            if os.path.isdir(dest):
                # Destination is a directory, copy into it
                dest_path = os.path.join(dest, os.path.basename(src))
            else:
                dest_path = dest

            if os.path.isdir(src):
                # Copy directory tree
                if os.path.exists(dest_path):
                    shutil.rmtree(dest_path)
                shutil.copytree(src, dest_path)
            else:
                # Copy file
                shutil.copy2(src, dest_path)

            # Set permissions if -m was given
            if mode_int is not None:
                os.chmod(dest_path, mode_int)

        except OSError as e:
            print(f"install: cannot copy '{src}' to '{dest}': {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
