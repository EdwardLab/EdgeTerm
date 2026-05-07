"""
od — dump files in octal and other formats.
Usage: od [OPTION]... [FILE]...
"""
import sys
import os
import struct


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: od [OPTION]... [FILE]...")
        print("  -A RADIX  address radix: d/o/x/n")
        print("  -j BYTES  skip bytes")
        print("  -N BYTES  limit bytes")
        print("  -t TYPE   output type (a/c/d/f/o/u/x)")
        print("  -v        no * for duplicate lines")
        print("  -w BYTES  bytes per line (default 16)")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    addr_radix = 'o'  # default octal
    skip_bytes = 0
    limit_bytes = None
    output_type = None
    verbose = False
    bytes_per_line = 16
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-A"):
            val = args[i + 1] if i + 1 < len(args) else ""
            if len(arg) > 2:
                val = arg[2:]
                i += 1
            else:
                i += 2
            if val in ('d', 'o', 'x', 'n'):
                addr_radix = val
            else:
                print(f"od: invalid address radix '{val}'", file=sys.stderr)
                sys.exit(2)
            continue
        elif arg.startswith("-j"):
            val = args[i + 1] if i + 1 < len(args) else ""
            if len(arg) > 2:
                val = arg[2:]
                i += 1
            else:
                i += 2
            skip_bytes = parse_number(val)
            continue
        elif arg.startswith("-N"):
            val = args[i + 1] if i + 1 < len(args) else ""
            if len(arg) > 2:
                val = arg[2:]
                i += 1
            else:
                i += 2
            limit_bytes = parse_number(val)
            continue
        elif arg.startswith("-t"):
            val = args[i + 1] if i + 1 < len(args) else ""
            if len(arg) > 2:
                val = arg[2:]
                i += 1
            else:
                i += 2
            output_type = val
            continue
        elif arg.startswith("-w"):
            val = args[i + 1] if i + 1 < len(args) else ""
            if len(arg) > 2:
                val = arg[2:]
                i += 1
            else:
                i += 2
            bytes_per_line = parse_number(val)
            if bytes_per_line <= 0:
                bytes_per_line = 16
            continue
        elif arg == "-v":
            verbose = True
            i += 1
        elif arg.startswith("-"):
            print(f"od: invalid option -- '{arg[1:]}'", file=sys.stderr)
            sys.exit(2)
        else:
            files.append(arg)
            i += 1

    if not files:
        files = ["-"]

    # If no output type specified, default to -t o2 (two-byte octal)
    if output_type is None:
        output_type = "o2"

    parse_type = parse_type_spec(output_type)
    data = read_input_data(files)
    dump_data(data, skip_bytes, limit_bytes, bytes_per_line, addr_radix, parse_type, verbose)


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
            print(f"od: {f}: No such file or directory", file=sys.stderr)
        else:
            with open(f, "rb") as fh:
                data.extend(fh.read())
    return bytes(data)


def parse_type_spec(t):
    """Parse a type specification like 'x1', 'c', 'o2', etc."""
    if not t:
        return ('o', 2)  # default

    # Known types: a, c, d, f, o, u, x
    type_map = {
        'a': 'named_char',
        'c': 'ascii',
        'd': 'signed_decimal',
        'f': 'float',
        'o': 'octal',
        'u': 'unsigned_decimal',
        'x': 'hex',
    }

    base_type = t[0]
    if base_type not in type_map:
        return ('o', 2)

    # Get count (optional number after type letter)
    count_str = t[1:]
    count = 1
    if count_str:
        try:
            count = int(count_str)
        except ValueError:
            count = 1

    return (type_map[base_type], count)


def dump_data(data, skip, limit, bpl, addr_radix, ptype, verbose):
    """Dump data in the specified format."""
    if skip > 0:
        if skip >= len(data):
            return
        data = data[skip:]

    if limit is not None and limit < len(data):
        data = data[:limit]

    if not data:
        return

    conv_type, conv_count = ptype
    byte_size = get_type_byte_size(conv_type)
    chunk_size = max(1, byte_size * conv_count)
    items_per_line = max(1, bpl // chunk_size)
    actual_bpl = items_per_line * chunk_size

    # Format addresses
    addr_chars = get_addr_chars(addr_radix, len(data))
    addr_fmt = get_addr_format(addr_radix, addr_chars)

    last_line = None
    line_repeated = False

    for offset in range(0, len(data), actual_bpl):
        chunk = data[offset:offset + actual_bpl]
        line = format_line(chunk, offset, conv_type, conv_count, addr_fmt, addr_radix)

        if line is None:
            continue

        if line == last_line and not verbose:
            if not line_repeated:
                line_repeated = True
                print("*")
        else:
            print(line)
            last_line = line
            line_repeated = False

    # Print final address
    if addr_radix != 'n':
        total = min(len(data), limit if limit else len(data))
        print(format_address(total, addr_fmt))


def get_type_byte_size(conv_type):
    """Get byte size for a conversion type."""
    sizes = {
        'named_char': 1,
        'ascii': 1,
        'signed_decimal': 2,
        'float': 4,
        'octal': 2,
        'unsigned_decimal': 2,
        'hex': 1,
    }
    return sizes.get(conv_type, 1)


def get_addr_chars(radix, data_len):
    """Calculate address field width."""
    if radix == 'n':
        return 0
    if radix == 'd':
        return max(7, len(str(data_len)))
    elif radix == 'o':
        if data_len == 0:
            return 7
        return max(7, len(oct(data_len)[2:]) + 1)
    elif radix == 'x':
        return max(7, len(hex(data_len)[2:]) + 1)
    return 7


def get_addr_format(radix, chars):
    """Get printf-style address format."""
    if radix == 'd':
        return f"%0{chars}d"
    elif radix == 'o':
        return f"%0{chars}o"
    elif radix == 'x':
        return f"%0{chars}x"
    return ""


def format_address(addr, fmt):
    """Format an address value."""
    return fmt % addr


def format_line(chunk, offset, conv_type, count, addr_fmt, addr_radix):
    """Format a single output line."""
    if not chunk:
        return None

    parts = []

    # Address prefix
    if addr_radix != 'n':
        parts.append(format_address(offset, addr_fmt))

    if conv_type == 'hex':
        # One-byte hex
        hexes = [f"{b:02x}" for b in chunk]
        line = " ".join(parts + hexes)
    elif conv_type == 'octal':
        # Two-byte octal
        vals = []
        for i in range(0, len(chunk), 2):
            if i + 1 < len(chunk):
                v = chunk[i] | (chunk[i + 1] << 8)
                vals.append(f"{v:06o}")
            else:
                vals.append(f"{chunk[i]:03o}")
        line = " ".join(parts + vals)
    elif conv_type == 'ascii':
        chars = []
        for b in chunk:
            if b == 0:
                chars.append(r'\0')
            elif b == 7:
                chars.append(r'\a')
            elif b == 8:
                chars.append(r'\b')
            elif b == 9:
                chars.append(r'\t')
            elif b == 10:
                chars.append(r'\n')
            elif b == 11:
                chars.append(r'\v')
            elif b == 12:
                chars.append(r'\f')
            elif b == 13:
                chars.append(r'\r')
            elif 32 <= b <= 126:
                chars.append(chr(b))
            else:
                chars.append(f"{b:03o}")
        line = " ".join(parts + chars)
    elif conv_type == 'named_char':
        char_names = {
            0: 'nul', 7: 'bel', 8: 'bs', 9: 'ht', 10: 'nl', 11: 'vt',
            12: 'ff', 13: 'cr', 27: 'esc', 32: 'sp', 127: 'del',
        }
        chars = []
        for b in chunk:
            if b in char_names:
                chars.append(char_names[b])
            elif 33 <= b <= 126:
                chars.append(chr(b))
            else:
                chars.append(f"{b:03o}")
        line = " ".join(parts + chars)
    elif conv_type == 'signed_decimal':
        vals = []
        for i in range(0, len(chunk), 2):
            if i + 1 < len(chunk):
                v = struct.unpack('<h', bytes(chunk[i:i+2]))[0]
                vals.append(f"{v:6d}")
            else:
                vals.append(f"{chunk[i]:6d}")
        line = " ".join(parts + vals)
    elif conv_type == 'unsigned_decimal':
        vals = []
        for i in range(0, len(chunk), 2):
            if i + 1 < len(chunk):
                v = struct.unpack('<H', bytes(chunk[i:i+2]))[0]
                vals.append(f"{v:5d}")
            else:
                vals.append(f"{chunk[i]:5d}")
        line = " ".join(parts + vals)
    elif conv_type == 'float':
        vals = []
        for i in range(0, len(chunk), 4):
            if i + 3 < len(chunk):
                v = struct.unpack('<f', bytes(chunk[i:i+4]))[0]
                vals.append(f"{v:14.7g}")
        line = " ".join(parts + vals)
    else:
        # default hex
        hexes = [f"{b:02x}" for b in chunk]
        line = " ".join(parts + hexes)

    return line


if __name__ == "__main__":
    main(sys.argv[1:])
