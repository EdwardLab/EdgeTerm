import os
import sys
import bigbox_utils


VERSION = "comm (EdgeTerm bigbox)"


def main(args):
    suppress_col1 = False
    suppress_col2 = False
    suppress_col3 = False
    files = []

    for arg in args:
        if arg == "-1":
            suppress_col1 = True
        elif arg == "-2":
            suppress_col2 = True
        elif arg == "-3":
            suppress_col3 = True
        elif arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "comm",
                "[-123] FILE1 FILE2",
                [("-1", "suppress column 1 (lines unique to FILE1)"),
                 ("-2", "suppress column 2 (lines unique to FILE2)"),
                 ("-3", "suppress column 3 (lines that appear in both)"),
                 ("", "FILE1 and FILE2 must be sorted.")],
            )
            sys.exit(0)
        elif arg == "--version":
            print(VERSION)
            sys.exit(0)
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "1":
                    suppress_col1 = True
                elif ch == "2":
                    suppress_col2 = True
                elif ch == "3":
                    suppress_col3 = True
                else:
                    print(f"comm: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)

    if len(files) < 2:
        print("comm: missing operand", file=sys.stderr)
        sys.exit(1)

    file1, file2 = files[0], files[1]

    try:
        with open(file1, "r", encoding="utf-8", errors="replace") as f:
            lines1 = f.read().splitlines()
    except FileNotFoundError:
        print(f"comm: {file1}: No such file", file=sys.stderr)
        sys.exit(1)

    try:
        with open(file2, "r", encoding="utf-8", errors="replace") as f:
            lines2 = f.read().splitlines()
    except FileNotFoundError:
        print(f"comm: {file2}: No such file", file=sys.stderr)
        sys.exit(1)

    # Two-pointer walk through sorted files
    i = j = 0
    while i < len(lines1) and j < len(lines2):
        if lines1[i] < lines2[j]:
            if not suppress_col1:
                sys.stdout.write(lines1[i] + "\n")
            i += 1
        elif lines1[i] > lines2[j]:
            if not suppress_col2:
                sys.stdout.write("\t" + lines2[j] + "\n")
            j += 1
        else:
            if not suppress_col3:
                # Column 3 preceded by tabs for col1 and col2
                prefix = ""
                if not suppress_col1:
                    prefix += "\t"
                if not suppress_col2:
                    prefix += "\t"
                sys.stdout.write(prefix + lines1[i] + "\n")
            i += 1
            j += 1

    # Remaining lines from file1
    while i < len(lines1):
        if not suppress_col1:
            sys.stdout.write(lines1[i] + "\n")
        i += 1

    # Remaining lines from file2
    while j < len(lines2):
        if not suppress_col2:
            sys.stdout.write("\t" + lines2[j] + "\n")
        j += 1
