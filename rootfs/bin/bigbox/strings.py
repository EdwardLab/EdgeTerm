"""
strings — print the sequences of printable characters in files.
Usage: strings [OPTION]... [FILE]...
"""
import re
import sys
import bigbox_utils


VERSION = "strings (EdgeTerm bigbox)"
PROG = "strings"


def extract_strings(data, min_len, encoding_type):
    """Extract printable strings from binary data."""
    if encoding_type == "s":
        # Single-7-bit: each byte is a character
        pattern = b"[\x20-\x7e]{" + str(min_len).encode() + b",}"
        for match in re.finditer(pattern, data):
            yield match.group().decode("ascii", errors="replace")

    elif encoding_type == "S":
        # Single-8-bit: each byte is a character (ISO-8859-1 range)
        pattern = b"[\x20-\x7e\xa0-\xff]{" + str(min_len).encode() + b",}"
        for match in re.finditer(pattern, data):
            yield match.group().decode("latin-1", errors="replace")

    elif encoding_type in ("b", "l"):
        # Big-endian or little-endian short (2 bytes per char)
        byte_order = "big" if encoding_type == "b" else "little"
        chars = []
        i = 0
        while i + 1 < len(data):
            code = int.from_bytes(data[i:i+2], byte_order, signed=False)
            if 0x20 <= code <= 0x7e:
                chars.append(chr(code))
                i += 2
            elif code == 0 and len(chars) >= min_len:
                yield "".join(chars)
                chars = []
                i += 2
            else:
                if len(chars) >= min_len:
                    yield "".join(chars)
                chars = []
                i += 2
        if len(chars) >= min_len:
            yield "".join(chars)

    else:
        # Default: same as 's'
        pattern = b"[\x20-\x7e]{" + str(min_len).encode() + b",}"
        for match in re.finditer(pattern, data):
            yield match.group().decode("ascii", errors="replace")


def main(args):
    min_len = 4
    scan_all = False
    encoding = "s"  # s=single-7-bit, S=single-8-bit, b=big-endian, l=little-endian
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... [FILE]...",
                [("-n MIN", "minimum string length (default: 4)"),
                 ("-a", "scan the whole file, not just data sections"),
                 ("-e ENCODING",
                  "select encoding: s=single-7-bit, S=single-8-bit, "
                  "b=big-endian, l=little-endian"),
                 ("", "Print sequences of printable characters in files.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-n" and i + 1 < len(args):
            i += 1
            min_len = int(args[i])
        elif arg.startswith("-n") and len(arg) > 2:
            min_len = int(arg[2:])
        elif arg == "-e" and i + 1 < len(args):
            i += 1
            encoding = args[i]
        elif arg.startswith("-e") and len(arg) > 2:
            encoding = arg[2:]
        elif arg == "-a":
            scan_all = True
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "a":
                    scan_all = True
                elif ch in "ne":
                    print(f"{PROG}: option requires an argument -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if not files:
        # Read from stdin
        data = sys.stdin.buffer.read()
        for s in extract_strings(data, min_len, encoding):
            print(s)
        return

    for fname in files:
        try:
            with open(fname, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            print(f"{PROG}: {fname}: No such file or directory", file=sys.stderr)
            continue
        except IsADirectoryError:
            continue

        for s in extract_strings(data, min_len, encoding):
            print(s)


if __name__ == "__main__":
    main(sys.argv[1:])
