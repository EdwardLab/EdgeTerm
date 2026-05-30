import binascii
import os
import sys

VERSION = "base64 (EdgeTerm bigbox) 1.0"


def b64encode(data, altchars=None):
    """Small stdlib-compatible shim so this command cannot shadow base64."""
    encoded = binascii.b2a_base64(bytes(data), newline=False)
    if altchars is not None:
        encoded = encoded.translate(bytes.maketrans(b"+/", bytes(altchars)))
    return encoded


def b64decode(data, altchars=None, validate=False):
    """Decode base64 data; mirrors the stdlib entry points used by packages."""
    raw = data.encode("ascii") if isinstance(data, str) else bytes(data)
    if altchars is not None:
        raw = raw.translate(bytes.maketrans(bytes(altchars), b"+/"))
    if not validate:
        raw = bytes(ch for ch in raw if chr(ch) in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n\t ")
    return binascii.a2b_base64(raw, strict_mode=bool(validate))


def standard_b64encode(data):
    return b64encode(data)


def standard_b64decode(data):
    return b64decode(data)


def urlsafe_b64encode(data):
    return b64encode(data, altchars=b"-_")


def urlsafe_b64decode(data):
    raw = data.encode("ascii") if isinstance(data, str) else bytes(data)
    padding = b"=" * (-len(raw) % 4)
    return b64decode(raw + padding, altchars=b"-_")


def encodebytes(data):
    return binascii.b2a_base64(bytes(data))


def decodebytes(data):
    return b64decode(data)


encodestring = encodebytes
decodestring = decodebytes


def print_help():
    print("Usage: base64 [OPTION]... [FILE]...")
    print("Base64 encode or decode FILE, or standard input, to standard output.")
    print("")
    print("  -d            decode data")
    print("  -i            when decoding, ignore non-alphabet characters")
    print("  -w COLS       wrap encoded lines at COLS characters (default 76,")
    print("                  0 to disable wrapping)")
    print("")
    print("      --help    display this help and exit")
    print("      --version output version information and exit")


def encode_data(data, wrap=76):
    """Base64 encode data with optional line wrapping."""
    encoded = b64encode(data).decode("ascii")
    if wrap > 0:
        lines = []
        for i in range(0, len(encoded), wrap):
            lines.append(encoded[i:i + wrap])
        return "\n".join(lines) + "\n"
    return encoded + "\n"


def decode_data(data, ignore_garbage=False):
    """Base64 decode data, optionally ignoring non-alphabet chars."""
    if ignore_garbage:
        # Keep only valid base64 characters
        valid_chars = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
        cleaned = "".join(ch for ch in data if ch in valid_chars)
        data = cleaned
    try:
        decoded = b64decode(data)
        return decoded
    except Exception as e:
        print(f"base64: invalid input: {e}", file=sys.stderr)
        return None


def main(args):
    decode = False
    ignore_garbage = False
    wrap = 76
    files = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            i += 1
            files.extend(args[i:])
            break
        elif arg == "--help":
            print_help()
            return
        elif arg == "--version":
            print(VERSION)
            return
        elif arg.startswith("-") and not arg.startswith("--"):
            for ch in arg[1:]:
                if ch == "d":
                    decode = True
                elif ch == "i":
                    ignore_garbage = True
                elif ch == "w":
                    i += 1
                    if i < len(args):
                        try:
                            wrap = int(args[i])
                        except ValueError:
                            print(f"base64: invalid wrap size: {args[i]}", file=sys.stderr)
                            sys.exit(1)
                    else:
                        print("base64: option requires an argument -- 'w'", file=sys.stderr)
                        sys.exit(1)
                else:
                    print(f"base64: invalid option -- '{ch}'", file=sys.stderr)
                    print("Try 'base64 --help' for more information.", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    # Read input
    if not files:
        # stdin
        try:
            input_data = sys.stdin.buffer.read()
        except Exception:
            input_data = b""
    else:
        input_data = bytearray()
        for f in files:
            if f == "-":
                input_data.extend(sys.stdin.buffer.read())
            else:
                try:
                    with open(f, "rb") as fh:
                        input_data.extend(fh.read())
                except FileNotFoundError:
                    print(f"base64: {f}: No such file or directory", file=sys.stderr)
                    sys.exit(1)
                except Exception as e:
                    print(f"base64: {f}: {e}", file=sys.stderr)
                    sys.exit(1)
        input_data = bytes(input_data)

    if decode:
        # For decode, work with text
        text_data = input_data.decode("ascii", errors="replace")
        result = decode_data(text_data, ignore_garbage=ignore_garbage)
        if result is None:
            sys.exit(1)
        sys.stdout.buffer.write(result)
    else:
        result = encode_data(input_data, wrap=wrap)
        sys.stdout.write(result)
