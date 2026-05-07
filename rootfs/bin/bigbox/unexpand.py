import os
import sys
import bigbox_utils


VERSION = "unexpand (EdgeTerm bigbox)"


def main(args):
    all_spaces = False
    tab_size = 8
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "unexpand",
                "[-a] [-t N] [FILE...]",
                [("-a", "convert all spaces (not just leading)"),
                 ("-t N", "tab size (default: 8)"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-a":
            all_spaces = True
        elif arg == "-t" and i + 1 < len(args):
            i += 1
            tab_size = int(args[i])
        elif arg.startswith("-t") and len(arg) > 2:
            tab_size = int(arg[2:])
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "a":
                    all_spaces = True
                elif ch == "t":
                    print(f"unexpand: option requires an argument -- 't'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"unexpand: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    lines = bigbox_utils.read_input(files)
    for line in lines:
        sys.stdout.write(unexpand_line(line, tab_size, all_spaces))


def unexpand_line(line, tab_size, all_spaces):
    """Replace spaces with tabs where possible."""
    if all_spaces:
        return unexpand_all(line, tab_size)
    else:
        return unexpand_leading(line, tab_size)


def unexpand_leading(line, tab_size):
    """Replace leading spaces with tabs."""
    result = list(line)
    # Count leading spaces
    space_count = 0
    for ch in result:
        if ch == " ":
            space_count += 1
        elif ch == "\t":
            space_count = 0
            break
        else:
            break

    if space_count < tab_size:
        return line

    # Replace with tabs
    tabs = space_count // tab_size
    remainder = space_count % tab_size
    return "\t" * tabs + " " * remainder + line[space_count:]


def unexpand_all(line, tab_size):
    """Replace all spaces with tabs where possible."""
    result = []
    col = 0
    space_start = None

    for ch in line:
        if ch == " ":
            if space_start is None:
                space_start = col
        else:
            if space_start is not None:
                # Emit the spaces, converting runs to tabs
                space_len = col - space_start
                emit_spaces(result, space_len, tab_size, space_start)
                space_start = None

            result.append(ch)
            if ch == "\n":
                col = -1  # will be incremented to 0
            elif ch == "\t":
                col += tab_size - (col % tab_size)
        col += 1

    # Handle trailing spaces
    if space_start is not None:
        space_len = col - space_start
        emit_spaces(result, space_len, tab_size, space_start)

    return "".join(result)


def emit_spaces(result, count, tab_size, col):
    """Emit spaces with optimal tab conversion."""
    # Calculate how many tabs we can use
    # First tab fills to next tab stop
    pos = col
    while count > 0:
        next_stop = ((pos // tab_size) + 1) * tab_size
        gap = next_stop - pos
        if gap <= count and gap > 0:
            result.append("\t")
            count -= gap
            pos = next_stop
        else:
            result.append(" " * count)
            break
