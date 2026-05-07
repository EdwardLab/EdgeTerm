"""
wc — print newline, word, and byte counts for each file.
Usage: wc [OPTION]... [FILE]...
"""
import sys
import bigbox_utils


VERSION = "wc (EdgeTerm bigbox)"
PROG = "wc"


def count_bytes(data):
    """Count bytes in data."""
    if isinstance(data, str):
        return len(data.encode("utf-8"))
    return len(data)


def count_chars(data):
    """Count characters in data."""
    if isinstance(data, bytes):
        return len(data.decode("utf-8", errors="replace"))
    return len(data)


def count_lines(data):
    """Count newline characters."""
    return data.count("\n")


def count_words(data):
    """Count whitespace-delimited words."""
    return len(data.split())


def max_line_length(data):
    """Find the length of the longest line."""
    lines = data.split("\n")
    # Don't count the trailing newline as a line
    if data.endswith("\n"):
        lines = lines[:-1]
    if not lines:
        return 0
    return max(len(line) for line in lines)


def main(args):
    count_bytes_flag = False
    count_chars_flag = False
    count_lines_flag = False
    count_words_flag = False
    max_line_flag = False
    files = []
    no_flags = True

    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... [FILE]...",
                [("-c", "print the byte counts"),
                 ("-m", "print the character counts"),
                 ("-l", "print the newline counts"),
                 ("-L", "print the maximum display width"),
                 ("-w", "print the word counts"),
                 ("", "With no FILE, or when FILE is -, read standard input.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "c":
                    count_bytes_flag = True
                    no_flags = False
                elif ch == "m":
                    count_chars_flag = True
                    no_flags = False
                elif ch == "l":
                    count_lines_flag = True
                    no_flags = False
                elif ch == "L":
                    max_line_flag = True
                    no_flags = False
                elif ch == "w":
                    count_words_flag = True
                    no_flags = False
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)

    if no_flags:
        count_lines_flag = True
        count_words_flag = True
        count_bytes_flag = True

    totals = [0, 0, 0, 0]  # lines, words, bytes, max_line
    multi = len(files) > 1

    if not files:
        data = sys.stdin.read()
        parts = []
        if count_lines_flag:
            lc = count_lines(data)
            parts.append(f"{lc:>8}")
            totals[0] += lc
        if count_words_flag:
            wc = count_words(data)
            parts.append(f"{wc:>8}")
            totals[1] += wc
        if count_chars_flag:
            cc = count_chars(data)
            parts.append(f"{cc:>8}")
            totals[2] += cc
        if count_bytes_flag:
            bc = count_bytes(data)
            parts.append(f"{bc:>8}")
            totals[2] += bc
        if max_line_flag:
            ml = max_line_length(data)
            parts.append(f"{ml:>8}")
            totals[3] = max(totals[3], ml)
        sys.stdout.write(" ".join(parts) + "\n")
    else:
        for fname in files:
            try:
                with open(fname, "r", encoding="utf-8", errors="replace") as f:
                    data = f.read()
            except FileNotFoundError:
                print(f"{PROG}: {fname}: No such file or directory", file=sys.stderr)
                continue

            parts = []
            if count_lines_flag:
                lc = count_lines(data)
                parts.append(f"{lc:>8}")
                totals[0] += lc
            if count_words_flag:
                wc = count_words(data)
                parts.append(f"{wc:>8}")
                totals[1] += wc
            if count_chars_flag:
                cc = count_chars(data)
                parts.append(f"{cc:>8}")
            if count_bytes_flag:
                bc = count_bytes(data)
                parts.append(f"{bc:>8}")
                if count_chars_flag:
                    totals[2] += cc
                else:
                    totals[2] += bc
            if max_line_flag:
                ml = max_line_length(data)
                parts.append(f"{ml:>8}")
                totals[3] = max(totals[3], ml)
            sys.stdout.write(" ".join(parts) + f" {fname}\n")

        if multi:
            total_parts = []
            if count_lines_flag:
                total_parts.append(f"{totals[0]:>8}")
            if count_words_flag:
                total_parts.append(f"{totals[1]:>8}")
            if count_bytes_flag or count_chars_flag:
                total_parts.append(f"{totals[2]:>8}")
            if max_line_flag:
                total_parts.append(f"{totals[3]:>8}")
            sys.stdout.write(" ".join(total_parts) + " total\n")


if __name__ == "__main__":
    main(sys.argv[1:])
