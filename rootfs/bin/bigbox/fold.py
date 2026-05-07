import os
import sys
import bigbox_utils


VERSION = "fold (EdgeTerm bigbox)"


def main(args):
    width = 80
    break_spaces = False
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "fold",
                "[-w WIDTH] [-s] [FILE...]",
                [("-w WIDTH", "column width (default: 80)"),
                 ("-s", "break at spaces (do not break words)"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-s":
            break_spaces = True
        elif arg == "-w" and i + 1 < len(args):
            i += 1
            width = int(args[i])
        elif arg.startswith("-w") and len(arg) > 2:
            width = int(arg[2:])
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "s":
                    break_spaces = True
                elif ch == "w":
                    print(f"fold: option requires an argument -- 'w'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"fold: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    lines = bigbox_utils.read_input(files)
    for line in lines:
        line = line.rstrip("\r\n")

        while len(line) > width:
            if break_spaces:
                # Find last space within width
                segment = line[:width]
                space_pos = segment.rfind(" ")
                if space_pos > 0:
                    sys.stdout.write(segment[:space_pos] + "\n")
                    line = line[space_pos + 1:]
                else:
                    sys.stdout.write(segment + "\n")
                    line = line[width:]
            else:
                sys.stdout.write(line[:width] + "\n")
                line = line[width:]

        if line:
            sys.stdout.write(line + "\n")
