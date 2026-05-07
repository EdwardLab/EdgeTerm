"""mv — move (rename) files (bigbox standalone)"""
import os
import shutil
import sys
import bigbox_utils


def main(args):
    flags, paths = bigbox_utils.parse_flags(args, "fv")
    force = "f" in flags
    verbose = "v" in flags

    if len(paths) < 2:
        print("mv: missing file operand", file=sys.stderr)
        print("Usage: mv [-fv] SOURCE... DEST", file=sys.stderr)
        sys.exit(1)

    *sources, dest = paths

    # Expand globs in sources
    sources = bigbox_utils.expand_globs(sources)
    dest_is_dir = os.path.isdir(dest)

    if len(sources) > 1 and not dest_is_dir:
        print(f"mv: target '{dest}' is not a directory", file=sys.stderr)
        sys.exit(1)

    exit_code = 0
    for source in sources:
        if not os.path.exists(source):
            print(f"mv: cannot stat '{source}': No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        target = os.path.join(dest, os.path.basename(source)) if dest_is_dir else dest

        try:
            if os.path.exists(target) and not force:
                print(f"mv: cannot overwrite '{target}'", file=sys.stderr)
                exit_code = 1
                continue
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            shutil.move(source, target)
            if verbose:
                print(f"'{source}' -> '{target}'")
        except OSError as e:
            print(f"mv: cannot move '{source}': {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
