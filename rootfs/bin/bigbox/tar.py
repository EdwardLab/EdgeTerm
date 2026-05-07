"""
tar — archive utility.
Usage: tar [OPTION]... [FILE]...
"""
import sys
import os
import tarfile
import gzip as gzip_mod
import bz2
import io


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        print("Usage: tar [OPTION]... [FILE]...", file=sys.stderr)
        print("Try 'tar --help' for more information.", file=sys.stderr)
        sys.exit(2)

    if args[0] == "--help":
        print("Usage: tar [OPTION]... [FILE]...")
        print("  -c, --create        create a new archive")
        print("  -x, --extract       extract files from archive")
        print("  -t, --list          list archive contents")
        print("  -f ARCHIVE          use archive file")
        print("  -v, --verbose       verbosely list files processed")
        print("  -z                  filter through gzip")
        print("  -j                  filter through bzip2")
        print("  -C DIR              change to directory")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    mode = None
    archive_file = None
    verbose = False
    gzip_filter = False
    bzip2_filter = False
    change_dir = None
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("--"):
            if arg == "--create":
                mode = "c"
            elif arg == "--extract":
                mode = "x"
            elif arg == "--list":
                mode = "t"
            elif arg == "--verbose":
                verbose = True
            elif arg == "--file":
                i += 1
                archive_file = args[i] if i < len(args) else None
            else:
                print(f"tar: unrecognized option '{arg}'", file=sys.stderr)
                sys.exit(2)
            i += 1
        elif arg.startswith("-") and not arg.startswith("--"):
            # Handle combined short flags like -xzf, -cvf, etc.
            if arg == "-":
                files.append("-")
                i += 1
                continue
            # Check if it's a flag with value: -f archive, -C dir
            for j, ch in enumerate(arg[1:], 1):
                if ch == 'c':
                    if mode is not None and mode != 'c':
                        print("tar: cannot combine create with extract or list", file=sys.stderr)
                        sys.exit(2)
                    mode = 'c'
                elif ch == 'x':
                    if mode is not None and mode != 'x':
                        print("tar: cannot combine extract with create or list", file=sys.stderr)
                        sys.exit(2)
                    mode = 'x'
                elif ch == 't':
                    if mode is not None and mode != 't':
                        print("tar: cannot combine list with create or extract", file=sys.stderr)
                        sys.exit(2)
                    mode = 't'
                elif ch == 'v':
                    verbose = True
                elif ch == 'z':
                    gzip_filter = True
                elif ch == 'j':
                    bzip2_filter = True
                elif ch == 'f':
                    i += 1
                    archive_file = args[i] if i < len(args) else None
                elif ch == 'C':
                    i += 1
                    change_dir = args[i] if i < len(args) else os.getcwd()
                else:
                    print(f"tar: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        else:
            files.append(arg)
            i += 1

    if mode is None:
        print("tar: you must specify one of -c, -x or -t", file=sys.stderr)
        sys.exit(2)

    # Handle -f being part of combined flag where the next arg is the filename
    # This is already handled in the loop above

    if mode == 'c' and not files:
        print("tar: no files specified for creation", file=sys.stderr)
        sys.exit(2)

    if archive_file is None and mode in ('c',):
        print("tar: no archive file specified (use -f)", file=sys.stderr)
        sys.exit(2)

    if change_dir:
        old_cwd = os.getcwd()
        os.chdir(change_dir)
    else:
        old_cwd = None

    try:
        if mode == 'c':
            create_archive(archive_file, files, verbose, gzip_filter, bzip2_filter)
        elif mode in ('x', 't'):
            list_or_extract(archive_file, files, mode, verbose, gzip_filter, bzip2_filter)
    finally:
        if old_cwd:
            os.chdir(old_cwd)


def open_tarfile(path, mode, gzip_filter=False, bzip2_filter=False):
    """Open a tarfile with appropriate compression."""
    if path is None:
        # stdin/stdout
        if mode.startswith('r'):
            return tarfile.open(fileobj=sys.stdin.buffer, mode=mode)
        else:
            return tarfile.open(fileobj=sys.stdout.buffer, mode=mode)
    if gzip_filter or (path and path.endswith('.gz')):
        return tarfile.open(path, mode + ':gz')
    if bzip2_filter or (path and path.endswith('.bz2')):
        return tarfile.open(path, mode + ':bz2')
    return tarfile.open(path, mode)


def create_archive(archive_path, files, verbose, gzip_filter, bzip2_filter):
    """Create a tar archive."""
    mode = 'w'
    if archive_path:
        if gzip_filter:
            mode = 'w:gz'
        elif bzip2_filter:
            mode = 'w:bz2'
        elif archive_path.endswith('.gz'):
            mode = 'w:gz'
        elif archive_path.endswith('.bz2'):
            mode = 'w:bz2'

    if archive_path is None:
        tf = tarfile.open(fileobj=sys.stdout.buffer, mode=mode)
    else:
        tf = tarfile.open(archive_path, mode)

    with tf:
        for f in files:
            if os.path.isdir(f):
                for root, dirs, dirfiles in os.walk(f):
                    for name in dirfiles:
                        full = os.path.join(root, name)
                        if verbose:
                            print(full)
                        tf.add(full)
                    for d in dirs:
                        full = os.path.join(root, d)
                        if verbose:
                            print(full + "/")
                        tf.add(full)
            else:
                if verbose:
                    print(f)
                tf.add(f)


def list_or_extract(archive_path, files, mode, verbose, gzip_filter, bzip2_filter):
    """List or extract a tar archive."""
    try:
        tf = open_tarfile(archive_path, 'r', gzip_filter, bzip2_filter)
    except tarfile.ReadError as e:
        print(f"tar: {archive_path}: {e}", file=sys.stderr)
        sys.exit(2)
    except FileNotFoundError:
        print(f"tar: {archive_path}: No such file or directory", file=sys.stderr)
        sys.exit(2)

    with tf:
        if mode == 't':
            # List contents
            members = tf.getmembers()
            for m in members:
                if verbose:
                    print(f"{m.mode:06o} {m.uname if m.uname else ''}/{m.gname if m.gname else ''} {m.size:8d} {m.name}")
                else:
                    print(m.name)
        elif mode == 'x':
            # Extract files
            if not files:
                tf.extractall()
                if verbose:
                    for m in tf.getmembers():
                        print(m.name)
            else:
                for f in files:
                    try:
                        tf.extract(f)
                        if verbose:
                            print(f)
                    except KeyError:
                        print(f"tar: {f}: Not found in archive", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
