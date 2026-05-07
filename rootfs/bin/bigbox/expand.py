import os
import sys
import bigbox_utils


VERSION = "expand (EdgeTerm bigbox)"


def main(args):
    tab_size = 8
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "expand",
                "[-t N] [FILE...]",
                [("-t N", "tab size (default: 8), can be comma-separated list of tab positions"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-t" and i + 1 < len(args):
            i += 1
            tab_size = parse_tab_list(args[i])
        elif arg.startswith("-t") and len(arg) > 2:
            tab_size = parse_tab_list(arg[2:])
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "t":
                    print(f"expand: option requires an argument -- 't'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"expand: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    lines = bigbox_utils.read_input(files)
    for line in lines:
        sys.stdout.write(expand_line(line, tab_size))


def parse_tab_list(s):
    """Parse comma-separated tab positions or single number."""
    if "," in s:
        parts = [int(x.strip()) for x in s.split(",")]
        return parts
    return int(s)


def expand_line(line, tab_size):
    """Expand tabs to spaces."""
    if isinstance(tab_size, list):
        return expand_line_stops(line, tab_size)

    result = []
    col = 0
    for ch in line:
        if ch == "\t":
            spaces = tab_size - (col % tab_size)
            result.append(" " * spaces)
            col += spaces
        else:
            result.append(ch)
            if ch == "\n":
                col = 0
            else:
                col += 1
    return "".join(result)


def expand_line_stops(line, stops):
    """Expand tabs using specific tab stops."""
    result = []
    col = 0
    stop_idx = 0
    for ch in line:
        if ch == "\t":
            if stop_idx < len(stops):
                target = stops[stop_idx]
                if col < target:
                    result.append(" " * (target - col))
                    col = target
                else:
                    result.append(" ")
                    col += 1
                stop_idx += 1
            else:
                result.append(" ")
                col += 1
        else:
            result.append(ch)
            if ch == "\n":
                col = 0
                stop_idx = 0
            else:
                col += 1
    return "".join(result)
