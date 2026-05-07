import os
import sys
import bigbox_utils


VERSION = "column (EdgeTerm bigbox)"


def main(args):
    table_mode = False
    separator = " "
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "column",
                "[-t] [-s SEP] [FILE...]",
                [("-t", "create a table (align columns)"),
                 ("-s SEP", "set column delimiter (default: whitespace)"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-t":
            table_mode = True
        elif arg == "-s" and i + 1 < len(args):
            i += 1
            separator = args[i]
        elif arg.startswith("-s") and len(arg) > 2:
            separator = arg[2:]
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "t":
                    table_mode = True
                elif ch == "s":
                    print(f"column: option requires an argument -- 's'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"column: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    lines = bigbox_utils.read_input(files)

    if table_mode:
        output_table(lines, separator)
    else:
        # Default: just output with the given separator
        for line in lines:
            sys.stdout.write(line)


def output_table(lines, separator):
    """Align columns into a table."""
    rows = []
    for line in lines:
        line = line.rstrip("\r\n")
        if separator == " ":
            fields = line.split()
        else:
            fields = line.split(separator)
        rows.append(fields)

    if not rows:
        return

    # Calculate column widths
    max_cols = max(len(r) for r in rows)
    widths = [0] * max_cols
    for row in rows:
        for idx, field in enumerate(row):
            widths[idx] = max(widths[idx], len(field))

    # Output aligned
    sep_out = "  "
    for row in rows:
        padded = []
        for idx, field in enumerate(row):
            padded.append(field.ljust(widths[idx]))
        sys.stdout.write(sep_out.join(padded) + "\n")
