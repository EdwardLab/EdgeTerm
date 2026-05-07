"""cp — copy files and directories (bigbox standalone)"""
import os
import shutil
import sys
import bigbox_utils


def main(args):
    flags, paths = bigbox_utils.parse_flags(args, "rRfvp")
    recursive = "r" in flags or "R" in flags
    force = "f" in flags
    verbose = "v" in flags
    preserve = "p" in flags

    if len(paths) < 2:
        print("cp: missing file operand", file=sys.stderr)
        print("Usage: cp [-rRfvp] SOURCE... DEST", file=sys.stderr)
        sys.exit(1)

    *sources, dest = paths

    # Expand globs in sources
    sources = bigbox_utils.expand_globs(sources)
    dest_is_dir = os.path.isdir(dest)

    if len(sources) > 1 and not dest_is_dir:
        print(f"cp: target '{dest}' is not a directory", file=sys.stderr)
        sys.exit(1)

    exit_code = 0
    for source in sources:
        if not os.path.exists(source):
            print(f"cp: cannot stat '{source}': No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        target = os.path.join(dest, os.path.basename(source)) if dest_is_dir else dest

        if os.path.isdir(source):
            if not recursive:
                print(f"cp: -r not specified; omitting directory '{source}'", file=sys.stderr)
                exit_code = 1
                continue
            try:
                if os.path.exists(target) and not force:
                    print(f"cp: cannot overwrite directory '{target}'", file=sys.stderr)
                    exit_code = 1
                    continue
                if os.path.exists(target):
                    shutil.rmtree(target)
                shutil.copytree(source, target)
                if verbose:
                    print(f"'{source}' -> '{target}'")
            except OSError as e:
                print(f"cp: cannot copy '{source}': {e}", file=sys.stderr)
                exit_code = 1
        else:
            try:
                if os.path.exists(target) and not force:
                    print(f"cp: cannot overwrite '{target}'", file=sys.stderr)
                    exit_code = 1
                    continue
                os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                if preserve:
                    shutil.copy2(source, target)
                else:
                    shutil.copy(source, target)
                if verbose:
                    print(f"'{source}' -> '{target}'")
            except OSError as e:
                print(f"cp: cannot copy '{source}': {e}", file=sys.stderr)
                exit_code = 1

    sys.exit(exit_code)
