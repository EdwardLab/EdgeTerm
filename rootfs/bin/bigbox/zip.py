"""
zip — package and compress files into ZIP archive.
Usage: zip [OPTION]... ZIPFILE FILE... or zip -e ZIPFILE (encrypt)
"""
import sys
import os
import zipfile
import getpass


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        print("Usage: zip [OPTION]... ZIPFILE FILE...", file=sys.stderr)
        sys.exit(2)
    if args[0] == "--help":
        print("Usage: zip [OPTION]... ZIPFILE FILE...")
        print("  -r        recurse into directories")
        print("  -e        encrypt (prompt for password)")
        print("  -q        quiet")
        print("  -v        verbose")
        print("  -m        move files into archive (delete originals)")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    recursive = False
    encrypt = False
    quiet = False
    verbose = False
    move = False
    password = None
    zipfile_name = None
    files = []
    args_list = list(args)

    i = 0
    while i < len(args_list):
        arg = args_list[i]
        if arg.startswith("-") and not arg.startswith("--"):
            if arg == "-":
                i += 1
                continue
            for ch in arg[1:]:
                if ch == 'r':
                    recursive = True
                elif ch == 'e':
                    encrypt = True
                elif ch == 'q':
                    quiet = True
                elif ch == 'v':
                    verbose = True
                elif ch == 'm':
                    move = True
                else:
                    print(f"zip: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        elif arg == "--":
            i += 1
            files.extend(args_list[i:])
            break
        else:
            if zipfile_name is None:
                zipfile_name = arg
            else:
                files.append(arg)
            i += 1

    if zipfile_name is None:
        print("zip: no zipfile specified", file=sys.stderr)
        sys.exit(2)

    if not files:
        print("zip: no files specified", file=sys.stderr)
        sys.exit(2)

    if encrypt:
        p1 = getpass.getpass("Enter password: ")
        p2 = getpass.getpass("Verify password: ")
        if p1 != p2:
            print("zip: passwords do not match", file=sys.stderr)
            sys.exit(2)
        password = p1.encode("utf-8")

    # Ensure .zip extension
    if not zipfile_name.endswith(".zip"):
        zipfile_name = zipfile_name + ".zip"

    mode = "w"
    compression = zipfile.ZIP_DEFLATED

    try:
        with zipfile.ZipFile(zipfile_name, mode, compression) as zf:
            for f in files:
                if os.path.isdir(f):
                    if recursive:
                        for root, dirs, dirfiles in os.walk(f):
                            for name in dirfiles:
                                full = os.path.join(root, name)
                                arcname = os.path.relpath(full, os.path.dirname(f) if os.path.dirname(f) else ".")
                                add_to_zip(zf, full, arcname, password, verbose, quiet)
                            for d in dirs:
                                full = os.path.join(root, d)
                                arcname = os.path.relpath(full, os.path.dirname(f) if os.path.dirname(f) else ".") + "/"
                                add_to_zip(zf, full, arcname, password, verbose, quiet)
                    else:
                        if not quiet:
                            print(f"zip: {f} is a directory (use -r)", file=sys.stderr)
                else:
                    add_to_zip(zf, f, os.path.basename(f), password, verbose, quiet)
    except Exception as e:
        print(f"zip: {e}", file=sys.stderr)
        sys.exit(2)

    if move:
        for f in files:
            if os.path.isfile(f):
                os.remove(f)
            elif os.path.isdir(f) and recursive:
                import shutil
                shutil.rmtree(f)


def add_to_zip(zf, filepath, arcname, password, verbose, quiet):
    """Add a file to the zip archive."""
    if verbose:
        print(f"  adding: {arcname}")
    try:
        zf.write(filepath, arcname)
        if password:
            # Set password for this entry
            zf.setpassword(password)
    except Exception as e:
        if not quiet:
            print(f"zip: {filepath}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
