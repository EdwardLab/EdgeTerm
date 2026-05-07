import sys

# Import ls and call with default flags for directory listing
import ls  # noqa: F401


def main(args):
    # dir acts like "ls -l" by default with colorized output (dir=directory listing)
    # Insert -l flag and call ls.main
    ls_args = ["-l"]
    # Pass through any additional args (filtering out our own --help/--version)
    for arg in args:
        if arg in ("--help", "-help"):
            print("Usage: dir [OPTION]... [FILE]...")
            print("List directory contents (long format by default).")
            print("")
            print("  --help     display this help and exit")
            print("  --version  output version information and exit")
            print("")
            print("dir is an alias for 'ls -l'.")
            sys.exit(0)
        if arg == "--version":
            print("dir (EdgeTerm bigbox)")
            sys.exit(0)
        ls_args.append(arg)

    ls.main(ls_args)
