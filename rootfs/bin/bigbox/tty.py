"""
tty — print the file name of the terminal connected to standard input.
Usage: tty [OPTION]
"""
import os
import sys

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"tty (edgeos-bigbox) {VERSION}")
        return

    flag_s = "-s" in args  # silent mode

    # Check if stdin is a TTY
    if sys.stdin.isatty():
        tty_name = "/dev/edgeterm"
        if flag_s:
            # Silent mode: no output, just return status
            sys.exit(0)
        print(tty_name)
    else:
        if flag_s:
            sys.exit(1)
        print("not a tty")


def _help():
    print("Usage: tty [OPTION]")
    print("Print the file name of the terminal connected to standard input.")
    print()
    print("  -s, --silent   print nothing, only return exit status")
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
