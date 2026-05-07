import sys
import bigbox_utils


VERSION = "seq (EdgeTerm bigbox)"


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "seq",
                "LAST",
                [("LAST", "print numbers 1 to LAST"),
                 ("FIRST LAST", "print numbers FIRST to LAST"),
                 ("FIRST INCREMENT LAST", "print numbers FIRST to LAST by INCREMENT"),
                 ("-w", "equalize widths by padding leading zeros"),
                 ("-s SEP", "separator string (default: newline)")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

    # Parse flags
    equal_width = False
    separator = "\n"
    positional = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "-w":
            equal_width = True
        elif arg == "-s" and i + 1 < len(args):
            i += 1
            separator = args[i]
        elif arg.startswith("-s") and len(arg) > 2:
            separator = arg[2:]
        elif arg.startswith("-") and arg[:2].isalpha():
            for ch in arg[1:]:
                if ch == "w":
                    equal_width = True
                elif ch == "s":
                    print(f"seq: option requires an argument -- 's'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"seq: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            positional.append(arg)
        i += 1

    if not positional:
        print("seq: missing operand", file=sys.stderr)
        sys.exit(1)

    # Parse numbers: FIRST, INCREMENT, LAST
    if len(positional) == 1:
        first = 1
        inc = 1
        last = float(positional[0])
    elif len(positional) == 2:
        first = float(positional[0])
        inc = 1
        last = float(positional[1])
    elif len(positional) == 3:
        first = float(positional[0])
        inc = float(positional[1])
        last = float(positional[2])
    else:
        print("seq: extra operand", file=sys.stderr)
        sys.exit(1)

    # Generate numbers
    if inc == 0:
        print("seq: zero increment", file=sys.stderr)
        sys.exit(1)

    nums = []
    if inc > 0:
        val = first
        while val <= last:
            nums.append(val)
            val += inc
    else:
        val = first
        while val >= last:
            nums.append(val)
            val += inc

    # Determine width for -w
    if equal_width:
        width = max(len(format_num(n, False)) for n in nums)
    else:
        width = 0

    # Output
    out = separator.join(format_num(n, equal_width, width) for n in nums)
    sys.stdout.write(out + "\n")


def format_num(n, equal_width, width=0):
    """Format a number, optionally zero-padded."""
    if n == int(n):
        s = str(int(n))
    else:
        s = str(n)
    if equal_width:
        s = s.rjust(width)
    return s
