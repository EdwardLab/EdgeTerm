"""
hexdump — display file contents in hexadecimal.
Usage: hexdump [OPTION]... [FILE]...
"""
import sys
import os
import struct


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: hexdump [OPTION]... [FILE]...")
        print("  -C          canonical hex+ASCII display")
        print("  -b          one-byte octal display")
        print("  -c          one-byte character display")
        print("  -d          two-byte decimal display")
        print("  -o          two-byte octal display")
        print("  -x          two-byte hex display")
        print("  -n LENGTH   interpret only LENGTH bytes")
        print("  -s OFFSET   skip OFFSET bytes")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    fmt = "-C"  # default canonical format
    length = None
    offset = 0
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-n"):
            val = args[i + 1] if i + 1 < len(args) else ""
            if len(arg) > 2:
                val = arg[2:]
                i += 1
            else:
                i += 2
            length = parse_number(val)
            continue
        elif arg.startswith("-s"):
            val = args[i + 1] if i + 1 < len(args) else ""
            if len(arg) > 2:
                val = arg[2:]
                i += 1
            else:
                i += 2
            offset = parse_number(val)
            continue
        elif arg in ("-C", "-b", "-c", "-d", "-o", "-x"):
            fmt = arg
            i += 1
        elif arg.startswith("-"):
            # Try combined format flag
            valid_flags = {'C', 'b', 'c', 'd', 'o', 'x'}
            for ch in arg[1:]:
                if ch in valid_flags:
                    fmt = "-" + ch
            i += 1
        else:
            files.append(arg)
            i += 1

    if not files:
        files = ["-"]

    data = read_input_data(files)

    if offset > 0:
        if offset >= len(data):
            return
        data = data[offset:]

    if length is not None and length < len(data):
        data = data[:length]

    if fmt == "-C":
        dump_canonical(data)
    elif fmt == "-b":
        dump_one_byte_octal(data)
    elif fmt == "-c":
        dump_one_byte_char(data)
    elif fmt == "-d":
        dump_two_byte_decimal(data)
    elif fmt == "-o":
        dump_two_byte_octal(data)
    elif fmt == "-x":
        dump_two_byte_hex(data)
    else:
        dump_canonical(data)


def parse_number(s):
    """Parse a number with optional multipliers."""
    s = s.strip().lower()
    multiplier = 1
    if s.endswith('b'):
        multiplier = 512
        s = s[:-1]
    elif s.endswith('k'):
        multiplier = 1024
        s = s[:-1]
    elif s.endswith('m'):
        multiplier = 1024 * 1024
        s = s[:-1]
    try:
        return int(s) * multiplier
    except ValueError:
        return 0


def read_input_data(files):
    """Read bytes from files or stdin."""
    data = bytearray()
    for f in files:
        if f == "-":
            data.extend(sys.stdin.buffer.read())
        elif not os.path.exists(f):
            print(f"hexdump: {f}: No such file or directory", file=sys.stderr)
        else:
            with open(f, "rb") as fh:
                data.extend(fh.read())
    return bytes(data)


def dump_canonical(data):
    """Canonical hex+ASCII display (-C format)."""
    if not data:
        return

    for offset in range(0, len(data), 16):
        chunk = data[offset:offset + 16]
        # Address
        addr = f"{offset:08x}"

        # Hex bytes
        hex_parts = []
        for i, b in enumerate(chunk):
            if i == 8:
                hex_parts.append(" ")
            hex_parts.append(f"{b:02x}")

        # Pad hex section
        hex_str = " ".join(hex_parts)
        if len(chunk) < 16:
            hex_str = hex_str + "   " * (16 - len(chunk))
            if len(chunk) <= 8:
                hex_str = hex_str + " "

        # ASCII representation
        ascii_chars = ""
        for b in chunk:
            if 32 <= b <= 126:
                ascii_chars += chr(b)
            else:
                ascii_chars += "."

        print(f"{addr}  {hex_str}  |{ascii_chars}|")


def dump_one_byte_octal(data):
    """One-byte octal display."""
    if not data:
        return

    for offset in range(0, len(data), 16):
        chunk = data[offset:offset + 16]
        addr = f"{offset:08x}"
        octals = " ".join(f"{b:03o}" for b in chunk)
        print(f"{addr}  {octals}")


def dump_one_byte_char(data):
    """One-byte character display."""
    if not data:
        return

    for offset in range(0, len(data), 16):
        chunk = data[offset:offset + 16]
        addr = f"{offset:08x}"
        chars = []
        for b in chunk:
            if b == 0:
                chars.append("\\0")
            elif b == 7:
                chars.append("\\a")
            elif b == 8:
                chars.append("\\b")
            elif b == 9:
                chars.append("\\t")
            elif b == 10:
                chars.append("\\n")
            elif b == 11:
                chars.append("\\v")
            elif b == 12:
                chars.append("\\f")
            elif b == 13:
                chars.append("\\r")
            elif 32 <= b <= 126:
                chars.append(" " + chr(b))
            else:
                chars.append(f"{b:03o}")
        print(f"{addr}  {' '.join(chars)}")


def dump_two_byte_decimal(data):
    """Two-byte decimal display (little-endian)."""
    if not data:
        return

    for offset in range(0, len(data), 16):
        chunk = data[offset:offset + 16]
        addr = f"{offset:08x}"
        vals = []
        for i in range(0, len(chunk), 2):
            if i + 1 < len(chunk):
                v = struct.unpack('<h', bytes(chunk[i:i+2]))[0]
                vals.append(f"{v:6d}")
            else:
                break
        print(f"{addr}  {' '.join(vals)}")


def dump_two_byte_octal(data):
    """Two-byte octal display (little-endian)."""
    if not data:
        return

    for offset in range(0, len(data), 16):
        chunk = data[offset:offset + 16]
        addr = f"{offset:08x}"
        vals = []
        for i in range(0, len(chunk), 2):
            if i + 1 < len(chunk):
                v = chunk[i] | (chunk[i + 1] << 8)
                vals.append(f"{v:06o}")
            else:
                break
        print(f"{addr}  {' '.join(vals)}")


def dump_two_byte_hex(data):
    """Two-byte hex display (little-endian)."""
    if not data:
        return

    for offset in range(0, len(data), 16):
        chunk = data[offset:offset + 16]
        addr = f"{offset:08x}"
        vals = []
        for i in range(0, len(chunk), 2):
            if i + 1 < len(chunk):
                v = chunk[i] | (chunk[i + 1] << 8)
                vals.append(f"{v:04x}")
            else:
                break
        print(f"{addr}  {' '.join(vals)}")


if __name__ == "__main__":
    main(sys.argv[1:])
