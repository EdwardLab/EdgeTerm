"""
unzip — extract ZIP archives.
Usage: unzip [OPTION]... FILE[.zip] [FILE...] [-x EXCLUDE] [-d DIR]
"""
import sys
import os
import zipfile


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        print("Usage: unzip [OPTION]... FILE[.zip] [FILE...] [-x EXCLUDE] [-d DIR]", file=sys.stderr)
        sys.exit(2)
    if args[0] == "--help":
        print("Usage: unzip [OPTION]... FILE[.zip] [FILE...] [-x EXCLUDE] [-d DIR]")
        print("  -l        list archive contents")
        print("  -t        test archive integrity")
        print("  -q        quiet")
        print("  -o        overwrite files without prompting")
        print("  -n        never overwrite existing files")
        print("  -d DIR    extract into directory")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    list_mode = False
    test_mode = False
    quiet = False
    overwrite = False
    never_overwrite = False
    extract_dir = None
    archive_file = None
    include_files = []
    exclude_files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-") and not arg.startswith("--"):
            if arg == "-":
                i += 1
                continue
            for ch in arg[1:]:
                if ch == 'l':
                    list_mode = True
                elif ch == 't':
                    test_mode = True
                elif ch == 'q':
                    quiet = True
                elif ch == 'o':
                    overwrite = True
                elif ch == 'n':
                    never_overwrite = True
                elif ch == 'd':
                    i += 1
                    extract_dir = args[i] if i < len(args) else None
                elif ch == 'x':
                    # Exclude files follow as next arg(s)
                    pass
                else:
                    print(f"unzip: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        elif arg == "-x":
            # Exclude files
            i += 1
            while i < len(args) and not args[i].startswith("-"):
                exclude_files.append(args[i])
                i += 1
            continue
        elif arg == "-d":
            i += 1
            extract_dir = args[i] if i < len(args) else None
            i += 1
        elif archive_file is None:
            archive_file = arg
            i += 1
        else:
            include_files.append(arg)
            i += 1

    if archive_file is None:
        print("unzip: no zipfile specified", file=sys.stderr)
        sys.exit(2)

    if not archive_file.endswith(".zip"):
        archive_file = archive_file + ".zip"

    if not os.path.exists(archive_file):
        print(f"unzip: cannot find or open {archive_file}", file=sys.stderr)
        sys.exit(2)

    try:
        zf = zipfile.ZipFile(archive_file, "r")
    except zipfile.BadZipFile:
        print(f"unzip: {archive_file}: bad zipfile", file=sys.stderr)
        sys.exit(2)

    if list_mode:
        list_archive(zf, quiet)
        zf.close()
        return

    if test_mode:
        test_archive(zf, quiet)
        zf.close()
        return

    extract_archive(zf, extract_dir, overwrite, never_overwrite, quiet, include_files, exclude_files)
    zf.close()


def list_archive(zf, quiet):
    """List contents of a zip archive."""
    if not quiet:
        print("Archive:  " + getattr(zf, "filename", "unknown"))
        print("  Length      Date    Time    Name")
        print("---------  ---------- -----   ----")

    total_size = 0
    total_files = 0

    for info in zf.infolist():
        date_str = f"{info.date_time[0]:04d}-{info.date_time[1]:02d}-{info.date_time[2]:02d}"
        time_str = f"{info.date_time[3]:02d}:{info.date_time[4]:02d}"
        name = info.filename
        if info.is_dir():
            name = name.rstrip("/") + "/"
            if not quiet:
                print(f"{'':>9}  {date_str} {time_str}   {name}")
        else:
            if not quiet:
                print(f"{info.file_size:>9}  {date_str} {time_str}   {name}")
            total_size += info.file_size
            total_files += 1

    if not quiet:
        print(f"---------                     -------")
        print(f"{total_size:>9}                     {total_files} files")


def test_archive(zf, quiet):
    """Test integrity of a zip archive."""
    bad = False
    for info in zf.infolist():
        try:
            zf.read(info.filename)
            if not quiet:
                print(f"  testing: {info.filename}    OK")
        except Exception:
            print(f"  testing: {info.filename}    FAILED", file=sys.stderr)
            bad = True
    if not bad and not quiet:
        print("No errors detected in compressed data.")


def extract_archive(zf, extract_dir, overwrite, never_overwrite, quiet, include_files, exclude_files):
    """Extract files from zip archive."""
    if extract_dir:
        os.makedirs(extract_dir, exist_ok=True)
        old_cwd = os.getcwd()
        os.chdir(extract_dir)
    else:
        old_cwd = None

    try:
        for info in zf.infolist():
            name = info.filename

            # Apply include/exclude filters
            if include_files and not any(name.startswith(f) or name == f for f in include_files):
                continue
            if exclude_files and any(name.startswith(f) or name == f for f in exclude_files):
                continue

            # Determine destination path
            dest = name

            # Check if file exists
            if os.path.exists(dest) and never_overwrite:
                if not quiet:
                    print(f"  skipping: {name}")
                continue

            if os.path.exists(dest) and not overwrite and not never_overwrite:
                print(f"  replace {name}? [y]es, [n]o, [A]ll, [N]one: ", end="", file=sys.stderr)
                try:
                    response = sys.stdin.readline().strip().lower()
                except EOFError:
                    response = "y"
                if response in ("n", "none"):
                    continue
                elif response in ("a", "all"):
                    overwrite = True
                elif response in ("n", "none"):
                    never_overwrite = True
                    continue

            if not quiet:
                if info.is_dir():
                    print(f"  creating: {name}")
                else:
                    print(f"  inflating: {name}")

            try:
                zf.extract(info, ".")
            except Exception as e:
                print(f"unzip: {name}: {e}", file=sys.stderr)
    finally:
        if old_cwd:
            os.chdir(old_cwd)


if __name__ == "__main__":
    main(sys.argv[1:])
