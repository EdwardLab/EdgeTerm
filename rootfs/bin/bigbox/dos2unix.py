"""
dos2unix — convert DOS/Mac line endings to Unix.
Usage: dos2unix [OPTION]... [FILE]...
"""
import os
import sys
import bigbox_utils


VERSION = "dos2unix (EdgeTerm bigbox)"
PROG = "dos2unix"


def main(args):
    newfile = False
    keep_date = False
    quiet = False
    infile = None
    outfile = None
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... [FILE]...",
                [("-n INFILE OUTFILE", "new file mode: write to OUTFILE"),
                 ("-k", "keep file date timestamp"),
                 ("-q", "quiet mode (suppress warnings)"),
                 ("", "Convert DOS line endings (\\r\\n) to Unix (\\n)."),
                 ("", "With no FILE, read from standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-n" and i + 2 < len(args):
            newfile = True
            infile = args[i + 1]
            outfile = args[i + 2]
            i += 2
        elif arg == "-k":
            keep_date = True
        elif arg == "-q":
            quiet = True
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "k":
                    keep_date = True
                elif ch == "q":
                    quiet = True
                elif ch == "n":
                    print(f"{PROG}: option requires an argument -- 'n'", file=sys.stderr)
                    sys.exit(2)
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if newfile:
        # New file mode: -n INFILE OUTFILE
        try:
            with open(infile, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            print(f"{PROG}: {infile}: No such file or directory", file=sys.stderr)
            sys.exit(1)

        converted = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        with open(outfile, "wb") as f:
            f.write(converted)

        if keep_date:
            try:
                stat_info = os.stat(infile)
                os.utime(outfile, (stat_info.st_atime, stat_info.st_mtime))
            except OSError:
                pass
        return

    if not files:
        # Read from stdin, write to stdout
        data = sys.stdin.buffer.read()
        converted = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        sys.stdout.buffer.write(converted)
        return

    for fname in files:
        try:
            with open(fname, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            print(f"{PROG}: {fname}: No such file or directory", file=sys.stderr)
            continue

        converted = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        if converted == data:
            if not quiet:
                pass  # No change; silently skip
            continue

        original_mtime = None
        if keep_date:
            try:
                original_mtime = os.stat(fname).st_mtime
            except OSError:
                pass

        with open(fname, "wb") as f:
            f.write(converted)

        if keep_date and original_mtime is not None:
            try:
                os.utime(fname, (original_mtime, original_mtime))
            except OSError:
                pass


if __name__ == "__main__":
    main(sys.argv[1:])
