import sys

# Import ls and call with -l flag
import ls  # noqa: F401


def main(args):
    # vdir acts like "ls -l" (verbose directory listing)
    ls_args = ["-l"]
    for arg in args:
        if arg in ("--help", "-help"):
            print("Usage: vdir [OPTION]... [FILE]...")
            print("List directory contents (verbose/long format).")
            print("")
            print("  --help     display this help and exit")
            print("  --version  output version information and exit")
            print("")
            print("vdir is an alias for 'ls -l'.")
            sys.exit(0)
        if arg == "--version":
            print("vdir (EdgeTerm bigbox)")
            sys.exit(0)
        ls_args.append(arg)

    ls.main(ls_args)
