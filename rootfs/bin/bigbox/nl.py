import os
import sys
import bigbox_utils


VERSION = "nl (EdgeTerm bigbox)"


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "nl",
                "[FILE...]",
                [("-b STYLE", "line numbering style: a=all, t=nonempty (default), n=none"),
                 ("-n FORMAT", "number format: ln=left, rn=right (default), rz=right zero-padded"),
                 ("-w WIDTH", "width of line number (default: 6)"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

    # Defaults
    style = "t"       # a=all, t=nonempty, n=none
    num_format = "rn" # ln=left, rn=right, rz=right-zero
    width = 6

    positional = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "-b" and i + 1 < len(args):
            i += 1
            style = args[i]
        elif arg.startswith("-b") and len(arg) > 2:
            style = arg[2:]
        elif arg == "-n" and i + 1 < len(args):
            i += 1
            num_format = args[i]
        elif arg.startswith("-n") and len(arg) > 2:
            num_format = arg[2:]
        elif arg == "-w" and i + 1 < len(args):
            i += 1
            width = int(args[i])
        elif arg.startswith("-w") and len(arg) > 2:
            width = int(arg[2:])
        elif arg.startswith("-") and not arg.startswith("--") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "b":
                    print(f"nl: option requires an argument -- 'b'", file=sys.stderr)
                    sys.exit(1)
                elif ch == "n":
                    print(f"nl: option requires an argument -- 'n'", file=sys.stderr)
                    sys.exit(1)
                elif ch == "w":
                    print(f"nl: option requires an argument -- 'w'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"nl: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            positional.append(arg)
        i += 1

    # Read input
    if not positional:
        lines = sys.stdin.read().splitlines(keepends=True)
    else:
        lines = bigbox_utils.read_input(positional)

    line_no = 0
    output_lines = []

    for line in lines:
        is_empty = line.strip() == ""

        if style == "a":
            line_no += 1
            show_number = True
        elif style == "t":
            show_number = not is_empty
            if show_number:
                line_no += 1
        elif style == "n":
            show_number = False
        else:
            show_number = False

        if show_number:
            if num_format == "ln":
                num_str = str(line_no).ljust(width)
            elif num_format == "rz":
                num_str = str(line_no).zfill(width)
            else:  # rn
                num_str = str(line_no).rjust(width)
            output_lines.append(f"     {num_str}\t{line}")
        else:
            output_lines.append(f"{'':>{width + 7}}{line}")

    sys.stdout.write("".join(output_lines))
