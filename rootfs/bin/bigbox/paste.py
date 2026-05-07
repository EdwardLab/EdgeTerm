"""
paste — merge lines of files.
Usage: paste [OPTION]... [FILE]...
"""
import sys
import bigbox_utils


VERSION = "paste (EdgeTerm bigbox)"
PROG = "paste"


def parse_delims(s):
    """Parse delimiter list. Supports escape sequences like \\t, \\n, \\0."""
    delims = []
    i = 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            ch = s[i + 1]
            if ch == "t":
                delims.append("\t")
            elif ch == "n":
                delims.append("\n")
            elif ch == "0":
                delims.append("\0")
            elif ch == "\\":
                delims.append("\\")
            elif ch == "r":
                delims.append("\r")
            else:
                delims.append(ch)
            i += 2
        else:
            delims.append(s[i])
            i += 1
    return delims


def read_file_or_stdin(fname):
    """Read lines from a file or stdin (for '-')."""
    if fname == "-":
        return sys.stdin.read().splitlines(keepends=True)
    try:
        with open(fname, "r", encoding="utf-8", errors="replace") as f:
            return f.readlines()
    except FileNotFoundError:
        print(f"{PROG}: {fname}: No such file or directory", file=sys.stderr)
        sys.exit(1)


def main(args):
    delim_list = None  # None means default tab
    serial = False
    zero_term = False
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... [FILE]...",
                [("-d LIST", "reuse characters from LIST instead of TAB"),
                 ("-s", "paste one file at a time instead of in parallel"),
                 ("-z", "line delimiter is NUL, not newline"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-d" and i + 1 < len(args):
            i += 1
            delim_list = parse_delims(args[i])
        elif arg.startswith("-d") and len(arg) > 2:
            delim_list = parse_delims(arg[2:])
        elif arg == "-s":
            serial = True
        elif arg == "-z":
            zero_term = True
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "s":
                    serial = True
                elif ch == "z":
                    zero_term = True
                elif ch == "d":
                    print(f"{PROG}: option requires an argument -- 'd'", file=sys.stderr)
                    sys.exit(2)
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if not files:
        files = ["-"]

    newline = "\0" if zero_term else "\n"
    separator = delim_list if delim_list else ["\t"]

    if serial:
        # -s mode: paste each file's lines into one line
        for fname in files:
            lines = read_file_or_stdin(fname)
            # Strip newlines from each line
            stripped = [l.rstrip("\n\r") for l in lines]
            if stripped:
                out = ""
                for idx, s in enumerate(stripped):
                    if idx > 0:
                        delim = separator[min(idx - 1, len(separator) - 1)]
                        out += delim
                    out += s
                sys.stdout.write(out + newline)
            else:
                sys.stdout.write(newline)
    else:
        # Parallel mode: merge files column-wise
        file_lines = []
        max_lines = 0
        for fname in files:
            lines = read_file_or_stdin(fname)
            stripped = [l.rstrip("\n\r") for l in lines]
            file_lines.append(stripped)
            if len(stripped) > max_lines:
                max_lines = len(stripped)

        for row in range(max_lines):
            parts = []
            for col_idx, lines in enumerate(file_lines):
                if col_idx > 0:
                    delim = separator[min(col_idx - 1, len(separator) - 1)]
                    parts.append(delim)
                if row < len(lines):
                    parts.append(lines[row])
                else:
                    parts.append("")
            sys.stdout.write("".join(parts) + newline)


if __name__ == "__main__":
    main(sys.argv[1:])
