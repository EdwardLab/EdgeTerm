import sys


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            print("Usage: reset")
            print("Reset the terminal.")
            sys.exit(0)
        if arg == "--version":
            print("reset (EdgeTerm bigbox)")
            sys.exit(0)

    sys.stdout.write("\033c")
