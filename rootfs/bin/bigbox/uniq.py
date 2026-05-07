"""
uniq — report or omit repeated lines.
Usage: uniq [OPTION]... [INPUT [OUTPUT]]
"""
import sys
import bigbox_utils


VERSION = "uniq (EdgeTerm bigbox)"
PROG = "uniq"


def main(args):
    count = False
    only_dup = False
    only_uniq = False
    ignore_case = False
    skip_fields = 0
    skip_chars = 0
    compare_chars = 0  # 0 means unlimited
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... [INPUT [OUTPUT]]",
                [("-c", "prefix lines by the number of occurrences"),
                 ("-d", "only print duplicate lines, one for each group"),
                 ("-u", "only print unique lines"),
                 ("-i", "ignore case when comparing"),
                 ("-f N", "skip N fields"),
                 ("-s N", "skip N characters"),
                 ("-w N", "compare no more than N characters per line")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-f" and i + 1 < len(args):
            i += 1
            skip_fields = int(args[i])
        elif arg.startswith("-f") and len(arg) > 2:
            skip_fields = int(arg[2:])
        elif arg == "-s" and i + 1 < len(args):
            i += 1
            skip_chars = int(args[i])
        elif arg.startswith("-s") and len(arg) > 2:
            skip_chars = int(arg[2:])
        elif arg == "-w" and i + 1 < len(args):
            i += 1
            compare_chars = int(args[i])
        elif arg.startswith("-w") and len(arg) > 2:
            compare_chars = int(arg[2:])
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "c":
                    count = True
                elif ch == "d":
                    only_dup = True
                elif ch == "u":
                    only_uniq = True
                elif ch == "i":
                    ignore_case = True
                elif ch in "fsw":
                    print(f"{PROG}: option requires an argument -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    # Handle INPUT [OUTPUT]
    infile = None
    outfile = None
    if len(files) >= 1:
        infile = files[0]
    if len(files) >= 2:
        outfile = files[1]

    if infile:
        try:
            with open(infile, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except FileNotFoundError:
            print(f"{PROG}: {infile}: No such file or directory", file=sys.stderr)
            sys.exit(1)
    else:
        lines = sys.stdin.readlines()

    def transform(line):
        """Apply -f, -s, -i transforms for comparison key."""
        key = line
        if skip_fields > 0:
            parts = key.split(None, skip_fields)
            if len(parts) > skip_fields:
                key = parts[skip_fields]
            else:
                key = ""
        if skip_chars > 0:
            key = key[skip_chars:]
        if compare_chars > 0:
            key = key[:compare_chars]
        if ignore_case:
            key = key.lower()
        return key

    # Group consecutive equal lines
    groups = []
    current_line = None
    current_key = None
    current_group = []

    for line in lines:
        key = transform(line)
        if current_key is not None and key == current_key:
            current_group.append(line)
        else:
            if current_group:
                groups.append((current_line, current_group))
            current_line = line
            current_key = key
            current_group = [line]

    if current_group:
        groups.append((current_line, current_group))

    # Build output lines
    output_lines = []
    for _, group in groups:
        n = len(group)
        if only_dup and n < 2:
            continue
        if only_uniq and n > 1:
            continue

        out_line = group[0]
        if count:
            out_line = f"{n:>7} {out_line}"
        output_lines.append(out_line)

    output = "".join(output_lines)

    if outfile:
        with open(outfile, "w", encoding="utf-8", errors="replace") as f:
            f.write(output)
    else:
        sys.stdout.write(output)


if __name__ == "__main__":
    main(sys.argv[1:])
