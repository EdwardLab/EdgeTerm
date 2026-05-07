import os
import sys


VERSION = "split (EdgeTerm bigbox)"


def main(args):
    # Defaults
    lines_per_file = 1000
    bytes_per_file = 0
    suffix_len = 2
    prefix = "x"
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            print("Usage: split [-l LINES] [-b BYTES] [-a SUFFIX_LEN] [FILE [PREFIX]]")
            print("  -l LINES    put LINES lines per output file (default 1000)")
            print("  -b BYTES    put BYTES bytes per output file")
            print("  -a N        use suffix of length N (default 2)")
            print("  --help      display this help and exit")
            print("  --version   output version information and exit")
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-l" and i + 1 < len(args):
            i += 1
            lines_per_file = int(args[i])
        elif arg.startswith("-l") and len(arg) > 2:
            lines_per_file = int(arg[2:])
        elif arg == "-b" and i + 1 < len(args):
            i += 1
            bytes_per_file = parse_bytes(args[i])
        elif arg.startswith("-b") and len(arg) > 2:
            bytes_per_file = parse_bytes(arg[2:])
        elif arg == "-a" and i + 1 < len(args):
            i += 1
            suffix_len = int(args[i])
        elif arg.startswith("-a") and len(arg) > 2:
            suffix_len = int(arg[2:])
        elif arg.startswith("-") and not arg.startswith("--") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "l":
                    print(f"split: option requires an argument -- 'l'", file=sys.stderr)
                    sys.exit(1)
                elif ch == "b":
                    print(f"split: option requires an argument -- 'b'", file=sys.stderr)
                    sys.exit(1)
                elif ch == "a":
                    print(f"split: option requires an argument -- 'a'", file=sys.stderr)
                    sys.exit(1)
                else:
                    print(f"split: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    # Get input file and prefix
    input_file = None
    if files:
        input_file = files[0]
        if len(files) > 1:
            prefix = files[1]

    # Read input
    if bytes_per_file:
        split_bytes(input_file, bytes_per_file, suffix_len, prefix)
    else:
        split_lines(input_file, lines_per_file, suffix_len, prefix)


def parse_bytes(s):
    """Parse byte count with optional suffix (K, M, G, T)."""
    s = s.upper()
    multiplier = 1
    if s.endswith("K"):
        multiplier = 1024
        s = s[:-1]
    elif s.endswith("M"):
        multiplier = 1024 * 1024
        s = s[:-1]
    elif s.endswith("G"):
        multiplier = 1024 * 1024 * 1024
        s = s[:-1]
    elif s.endswith("T"):
        multiplier = 1024 * 1024 * 1024 * 1024
        s = s[:-1]
    return int(s) * multiplier


def make_suffix(index, length):
    """Generate alphabetical suffix like 'aa', 'ab', etc."""
    result = []
    for _ in range(length):
        result.append(chr(ord('a') + (index % 26)))
        index //= 26
    return "".join(reversed(result))


def split_lines(input_file, lines_per_file, suffix_len, prefix):
    """Split file by line count."""
    if input_file:
        with open(input_file, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    else:
        lines = sys.stdin.read().splitlines(keepends=True)

    file_index = 0
    pos = 0
    while pos < len(lines):
        suffix = make_suffix(file_index, suffix_len)
        out_name = prefix + suffix
        chunk = lines[pos:pos + lines_per_file]
        with open(out_name, "w", encoding="utf-8") as out:
            out.writelines(chunk)
        file_index += 1
        pos += lines_per_file


def split_bytes(input_file, bytes_per_file, suffix_len, prefix):
    """Split file by byte count (always reads as binary)."""
    if input_file:
        with open(input_file, "rb") as f:
            data = f.read()
    else:
        data = sys.stdin.buffer.read()

    file_index = 0
    pos = 0
    while pos < len(data):
        suffix = make_suffix(file_index, suffix_len)
        out_name = prefix + suffix
        chunk = data[pos:pos + bytes_per_file]
        with open(out_name, "wb") as out:
            out.write(chunk)
        file_index += 1
        pos += bytes_per_file
