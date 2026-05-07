"""
xz — compress/decompress with LZMA.
Usage: xz [OPTION]... [FILE]...
"""
import sys
import os


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: xz [OPTION]... [FILE]...")
        print("  -c        output to stdout")
        print("  -d        decompress")
        print("  -f        force overwrite")
        print("  -k        keep original file")
        print("  -l        list compressed file contents")
        print("  -N        do not store name")
        print("  -q        quiet")
        print("  -r        recursive (not fully implemented)")
        print("  -t        test compressed file")
        print("  -v        verbose")
        print("  -1..-9    compression level")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    try:
        import lzma
    except ImportError:
        print("xz: lzma module not available", file=sys.stderr)
        sys.exit(1)

    compresslevel = 6
    decompress = False
    stdout_output = False
    force = False
    keep = False
    list_mode = False
    no_name = False
    quiet = False
    recursive = False
    test_mode = False
    verbose = False
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-") and not arg.startswith("--"):
            if arg == "-":
                files.append("-")
                i += 1
                continue
            for ch in arg[1:]:
                if ch == 'c':
                    stdout_output = True
                elif ch == 'd':
                    decompress = True
                elif ch == 'f':
                    force = True
                elif ch == 'k':
                    keep = True
                elif ch == 'l':
                    list_mode = True
                elif ch == 'N':
                    no_name = True
                elif ch == 'q':
                    quiet = True
                elif ch == 'r':
                    recursive = True
                elif ch == 't':
                    test_mode = True
                elif ch == 'v':
                    verbose = True
                elif ch in '123456789':
                    compresslevel = int(ch)
                else:
                    print(f"xz: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        elif arg == "--":
            i += 1
            files.extend(args[i:])
            break
        else:
            files.append(arg)
            i += 1

    if list_mode:
        list_files(files, verbose, quiet)
        return

    if test_mode:
        test_files(files, quiet)
        return

    if not files:
        if decompress:
            data = sys.stdin.buffer.read()
            try:
                result = lzma.decompress(data)
                sys.stdout.buffer.write(result)
            except Exception as e:
                if not quiet:
                    print(f"xz: {e}", file=sys.stderr)
                sys.exit(1)
        else:
            data = sys.stdin.buffer.read()
            result = lzma.compress(data)
            sys.stdout.buffer.write(result)
        return

    if stdout_output:
        for f in files:
            process_stdout(f, decompress, quiet)
        return

    for f in files:
        if os.path.isdir(f):
            if recursive:
                for root, dirs, dirfiles in os.walk(f):
                    for name in dirfiles:
                        full = os.path.join(root, name)
                        process_file(full, decompress, force, keep, verbose, quiet, no_name)
            else:
                if not quiet:
                    print(f"xz: {f} is a directory (use -r)", file=sys.stderr)
            continue
        process_file(f, decompress, force, keep, verbose, quiet, no_name)


def process_stdout(path, decompress, quiet):
    """Process a single file to stdout."""
    import lzma

    if not os.path.exists(path):
        if not quiet:
            print(f"xz: {path}: No such file or directory", file=sys.stderr)
        return

    with open(path, "rb") as fh:
        data = fh.read()

    try:
        if decompress:
            result = lzma.decompress(data)
        else:
            result = lzma.compress(data)
        sys.stdout.buffer.write(result)
    except Exception as e:
        if not quiet:
            print(f"xz: {path}: {e}", file=sys.stderr)


def process_file(path, decompress, force, keep, verbose, quiet, no_name):
    """Process a single file."""
    import lzma

    if not os.path.exists(path):
        if not quiet:
            print(f"xz: {path}: No such file or directory", file=sys.stderr)
        return

    if decompress:
        if not path.endswith(".xz"):
            if not quiet:
                print(f"xz: {path}: unknown suffix -- ignored", file=sys.stderr)
            return
        outpath = path[:-3]
    else:
        outpath = path + ".xz"

    if os.path.exists(outpath) and not force:
        if not quiet:
            print(f"xz: {outpath} already exists; not overwritten", file=sys.stderr)
        return

    with open(path, "rb") as fh:
        data = fh.read()

    try:
        if decompress:
            result = lzma.decompress(data)
        else:
            result = lzma.compress(data)
    except Exception as e:
        if not quiet:
            print(f"xz: {path}: {e}", file=sys.stderr)
        return

    with open(outpath, "wb") as fh:
        fh.write(result)

    if verbose:
        orig_size = os.path.getsize(path)
        new_size = os.path.getsize(outpath)
        if not quiet:
            pct = 100.0 * (1.0 - new_size / orig_size) if orig_size > 0 else 0
            print(f"  {path}: {new_size / orig_size * 100 if orig_size > 0 else 0:.1f}%")

    if not keep:
        os.remove(path)


def list_files(files, verbose, quiet):
    """List contents of compressed files."""
    import lzma

    for f in files:
        if not os.path.exists(f):
            if not quiet:
                print(f"xz: {f}: No such file or directory", file=sys.stderr)
            continue
        try:
            with lzma.open(f, "rb") as lz:
                uncompressed_data = lz.read()
        except Exception as e:
            if not quiet:
                print(f"xz: {f}: {e}", file=sys.stderr)
            continue
        compressed_size = os.path.getsize(f)
        uncompressed_size = len(uncompressed_data)
        ratio = 100.0 * (1.0 - compressed_size / uncompressed_size) if uncompressed_size > 0 else 0.0
        print(f"{compressed_size:>12d}  {uncompressed_size:>12d}  {ratio:>5.1f}%  {f}")


def test_files(files, quiet):
    """Test compressed file integrity."""
    import lzma

    for f in files:
        if not os.path.exists(f):
            if not quiet:
                print(f"xz: {f}: No such file or directory", file=sys.stderr)
            continue
        try:
            with lzma.open(f, "rb") as lz:
                lz.read()
            if not quiet:
                print(f"{f}: OK")
        except Exception as e:
            print(f"{f}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
