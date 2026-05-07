import os
import sys
import bigbox_utils


VERSION = "join (EdgeTerm bigbox)"


def main(args):
    delimiter = None  # whitespace
    field1 = 1
    field2 = 1
    positional = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "join",
                "[-t CHAR] [-1 FIELD] [-2 FIELD] FILE1 FILE2",
                [("-t CHAR", "field delimiter character"),
                 ("-1 FIELD", "join on this field of FILE1 (default: 1)"),
                 ("-2 FIELD", "join on this field of FILE2 (default: 1)"),
                 ("", "FILE1 and FILE2 must be sorted on the join fields.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-1" and i + 1 < len(args):
            i += 1
            field1 = int(args[i])
        elif arg.startswith("-1") and len(arg) > 2:
            field1 = int(arg[2:])
        elif arg == "-2" and i + 1 < len(args):
            i += 1
            field2 = int(args[i])
        elif arg.startswith("-2") and len(arg) > 2:
            field2 = int(arg[2:])
        elif arg == "-t" and i + 1 < len(args):
            i += 1
            delimiter = args[i]
        elif arg.startswith("-t") and len(arg) > 2:
            delimiter = arg[2:]
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "1":
                    print(f"join: option requires an argument -- '1'", file=sys.stderr)
                    sys.exit(1)
                elif ch == "2":
                    print(f"join: option requires an argument -- '2'", file=sys.stderr)
                    sys.exit(1)
                elif ch == "t":
                    print(f"join: option requires an argument -- 't'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"join: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            positional.append(arg)
        i += 1

    if len(positional) < 2:
        print("join: missing operand", file=sys.stderr)
        sys.exit(1)

    file1, file2 = positional[0], positional[1]

    # Read files
    try:
        with open(file1, "r", encoding="utf-8", errors="replace") as f:
            lines1 = f.read().splitlines()
    except FileNotFoundError:
        print(f"join: {file1}: No such file", file=sys.stderr)
        sys.exit(1)

    try:
        with open(file2, "r", encoding="utf-8", errors="replace") as f:
            lines2 = f.read().splitlines()
    except FileNotFoundError:
        print(f"join: {file2}: No such file", file=sys.stderr)
        sys.exit(1)

    # Parse lines into fields
    rows1 = [parse_fields(line, delimiter) for line in lines1]
    rows2 = [parse_fields(line, delimiter) for line in lines2]

    # Build lookup for file2 by join key
    lookup2 = {}
    for row in rows2:
        key = get_field(row, field2)
        if key not in lookup2:
            lookup2[key] = []
        lookup2[key].append(row)

    # Join
    joined_keys = set()
    for row1 in rows1:
        key1 = get_field(row1, field1)
        if key1 in lookup2:
            for row2 in lookup2[key1]:
                joined_keys.add(key1)
                # Output: join field, then remaining fields from file1, then all fields from file2
                # (skip the join field from file2 to avoid duplication)
                out_fields = row1[:]
                # Remove the join field from file2 output
                f2_fields = row2[:]
                if field2 <= len(f2_fields):
                    del f2_fields[field2 - 1]
                out_fields.extend(f2_fields)
                print_line(out_fields, delimiter)

    # Check for unpaired lines in file1 and file2 (like GNU join -a1 -a2 would, but basic join doesn't)
    # Basic join only outputs paired lines


def parse_fields(line, delimiter):
    """Split a line into fields."""
    if delimiter is None:
        return line.split()
    return line.split(delimiter)


def get_field(row, n):
    """Get the nth field (1-indexed), or empty string if not present."""
    if n <= len(row):
        return row[n - 1]
    return ""


def print_line(fields, delimiter):
    """Output fields joined by delimiter."""
    if delimiter is None:
        sys.stdout.write(" ".join(fields) + "\n")
    else:
        sys.stdout.write(delimiter.join(fields) + "\n")
