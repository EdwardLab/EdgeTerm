import os
import sys
import bigbox_utils


VERSION = "rev (EdgeTerm bigbox)"


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            print("Usage: rev [FILE...]")
            bigbox_utils.print_help(
                "rev",
                "[FILE...]",
                [("", "reverse each line character-wise"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

    # Filter out flags to get files
    files = [a for a in args if not a.startswith("-") or a == "-"]

    lines = bigbox_utils.read_input(files)
    for line in lines:
        rev_line = line.rstrip("\r\n")[::-1] + "\n"
        sys.stdout.write(rev_line)
