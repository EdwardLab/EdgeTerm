"""
cut — remove sections from each line of files.
Usage: cut OPTION... [FILE]...
"""
import sys
import bigbox_utils


VERSION = "cut (EdgeTerm bigbox)"
PROG = "cut"


def parse_list(spec):
    """Parse a LIST spec like '1,3-5,7-' into a list of (start, end) ranges.
    End may be None meaning 'to end'. 1-indexed, converted to 0-indexed internally."""
    ranges = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            if a:
                start = int(a)
            else:
                start = 1
            if b:
                end = int(b)
            else:
                end = None
        else:
            start = int(part)
            end = int(part)
        ranges.append((start, end))
    return ranges


def in_ranges(idx, ranges):
    """Check if 0-indexed idx falls within any of the parsed ranges."""
    for start, end in ranges:
        if end is None:
            if idx + 1 >= start:
                return True
        else:
            if start <= idx + 1 <= end:
                return True
    return False


def main(args):
    byte_mode = False
    char_mode = False
    field_mode = False
    delimiter = "\t"
    suppress = False
    complement = False
    files = []
    list_spec = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "OPTION... [FILE]...",
                [("-b LIST", "select only these bytes"),
                 ("-c LIST", "select only these characters"),
                 ("-f LIST", "select only these fields"),
                 ("-d DELIM", "use DELIM instead of TAB for field delimiter"),
                 ("-s", "do not print lines not containing delimiters"),
                 ("--complement", "complement the set of selected bytes/char/fields"),
                 ("", "Use one of -b, -c, or -f. LIST: N, N-M, N- (e.g., 1,3-5,7-)")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-b" and i + 1 < len(args):
            i += 1
            byte_mode = True
            list_spec = args[i]
        elif arg.startswith("-b") and len(arg) > 2:
            byte_mode = True
            list_spec = arg[2:]
        elif arg == "-c" and i + 1 < len(args):
            i += 1
            char_mode = True
            list_spec = args[i]
        elif arg.startswith("-c") and len(arg) > 2:
            char_mode = True
            list_spec = arg[2:]
        elif arg == "-f" and i + 1 < len(args):
            i += 1
            field_mode = True
            list_spec = args[i]
        elif arg.startswith("-f") and len(arg) > 2:
            field_mode = True
            list_spec = arg[2:]
        elif arg == "-d" and i + 1 < len(args):
            i += 1
            delimiter = args[i]
            if delimiter == "\\t":
                delimiter = "\t"
        elif arg.startswith("-d") and len(arg) > 2:
            delimiter = arg[2:]
            if delimiter == "\\t":
                delimiter = "\t"
        elif arg == "-s":
            suppress = True
        elif arg == "--complement":
            complement = True
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch in "bcf":
                    print(f"{PROG}: option requires an argument -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
                elif ch == "s":
                    suppress = True
                elif ch == "d":
                    print(f"{PROG}: option requires an argument -- 'd'", file=sys.stderr)
                    sys.exit(2)
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if not (byte_mode or char_mode or field_mode):
        print(f"{PROG}: you must specify a list of bytes, characters, or fields", file=sys.stderr)
        print(f"Try '{PROG} --help' for more information.", file=sys.stderr)
        sys.exit(1)

    lines = bigbox_utils.read_input(files)
    ranges = parse_list(list_spec)

    for line in lines:
        line = line.rstrip("\n").rstrip("\r")

        if field_mode:
            if delimiter == "\t":
                fields = line.split("\t")
            else:
                fields = line.split(delimiter)

            if suppress and len(fields) <= 1:
                continue

            if complement:
                selected = [f for idx, f in enumerate(fields) if not in_ranges(idx, ranges)]
            else:
                selected = [f for idx, f in enumerate(fields) if in_ranges(idx, ranges)]

            sys.stdout.write(delimiter.join(selected) + "\n")

        elif char_mode:
            chars = list(line)
            if complement:
                selected = [c for idx, c in enumerate(chars) if not in_ranges(idx, ranges)]
            else:
                selected = [c for idx, c in enumerate(chars) if in_ranges(idx, ranges)]
            sys.stdout.write("".join(selected) + "\n")

        elif byte_mode:
            raw = line.encode("utf-8", errors="replace")
            if complement:
                selected = bytes(raw[i] for i in range(len(raw)) if not in_ranges(i, ranges))
            else:
                selected = bytes(raw[i] for i in range(len(raw)) if in_ranges(i, ranges))
            sys.stdout.buffer.write(selected + b"\n")


if __name__ == "__main__":
    main(sys.argv[1:])
