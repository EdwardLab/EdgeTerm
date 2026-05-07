import sys


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            print("Usage: clear")
            print("Clear the terminal screen.")
            sys.exit(0)
        if arg == "--version":
            print("clear (EdgeTerm bigbox)")
            sys.exit(0)

    sys.stdout.write("\033[2J\033[H")
