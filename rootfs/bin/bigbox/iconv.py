"""
iconv — convert text encoding.
Usage: iconv [-f ENCODING] [-t ENCODING] [FILE]...
   or: iconv -l
"""
import sys
import bigbox_utils


VERSION = "iconv (EdgeTerm bigbox)"
PROG = "iconv"

# Known encoding aliases
ENCODINGS = {
    "utf-8": "utf-8",
    "utf8": "utf-8",
    "utf_8": "utf-8",
    "utf-16": "utf-16",
    "utf16": "utf-16",
    "utf_16": "utf-16",
    "utf-16le": "utf-16-le",
    "utf16le": "utf-16-le",
    "utf_16le": "utf-16-le",
    "utf-16be": "utf-16-be",
    "utf16be": "utf-16-be",
    "utf_16be": "utf-16-be",
    "utf-32": "utf-32",
    "utf32": "utf-32",
    "utf_32": "utf-32",
    "latin1": "latin-1",
    "latin-1": "latin-1",
    "iso-8859-1": "latin-1",
    "iso8859-1": "latin-1",
    "ascii": "ascii",
    "us-ascii": "ascii",
}


def normalize_encoding(name):
    """Normalize an encoding name to Python's codec name."""
    name_lower = name.lower().replace("-", "_").replace(" ", "_")
    return ENCODINGS.get(name_lower, name_lower)


def list_encodings():
    """Print the list of known encodings."""
    known = sorted(set(ENCODINGS.values()))
    for enc in known:
        print(enc)


def main(args):
    from_enc = "utf-8"
    to_enc = "utf-8"
    list_mode = False
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[-f ENCODING] [-t ENCODING] [FILE]...",
                [("-f ENCODING", "input encoding (default: utf-8)"),
                 ("-t ENCODING", "output encoding (default: utf-8)"),
                 ("-l", "list known encodings"),
                 ("", "Supported: utf-8, latin1, ascii, utf-16, utf-16le, utf-16be, utf-32")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-l":
            list_mode = True
        elif arg == "-f" and i + 1 < len(args):
            i += 1
            from_enc = normalize_encoding(args[i])
        elif arg.startswith("-f") and len(arg) > 2:
            from_enc = normalize_encoding(arg[2:])
        elif arg == "-t" and i + 1 < len(args):
            i += 1
            to_enc = normalize_encoding(args[i])
        elif arg.startswith("-t") and len(arg) > 2:
            to_enc = normalize_encoding(arg[2:])
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "l":
                    list_mode = True
                elif ch in "ft":
                    print(f"{PROG}: option requires an argument -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if list_mode:
        list_encodings()
        return

    # Read raw bytes
    if not files:
        raw_data = sys.stdin.buffer.read()
    else:
        raw_data = bytearray()
        for fname in files:
            try:
                with open(fname, "rb") as f:
                    raw_data.extend(f.read())
            except FileNotFoundError:
                print(f"{PROG}: {fname}: No such file or directory", file=sys.stderr)
                sys.exit(1)
        raw_data = bytes(raw_data)

    if not raw_data:
        return

    # Decode from source encoding
    try:
        text = raw_data.decode(from_enc, errors="replace")
    except LookupError:
        print(f"{PROG}: unknown encoding: {from_enc}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"{PROG}: conversion error: {e}", file=sys.stderr)
        sys.exit(1)

    # Encode to target encoding
    try:
        output = text.encode(to_enc, errors="replace")
    except LookupError:
        print(f"{PROG}: unknown encoding: {to_enc}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"{PROG}: conversion error: {e}", file=sys.stderr)
        sys.exit(1)

    sys.stdout.buffer.write(output)


if __name__ == "__main__":
    main(sys.argv[1:])
