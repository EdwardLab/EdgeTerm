import hashlib
import os
import sys

VERSION = "sha256sum (EdgeTerm bigbox) 1.0"


def print_help():
    print("Usage: sha256sum [OPTION]... [FILE]...")
    print("Print or check SHA-256 (256-bit) checksums.")
    print("")
    print("  -b            read in binary mode")
    print("  -c            read SHA-256 sums from FILEs and check them")
    print("  -t            read in text mode (default)")
    print("      --tag     create a BSD-style checksum")
    print("  -z            end each output line with NUL, not newline")
    print("")
    print("      --help    display this help and exit")
    print("      --version output version information and exit")


def sha256sum_file(filepath):
    """Compute SHA-256 checksum for a file."""
    try:
        with open(filepath, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        print(f"sha256sum: {filepath}: No such file or directory", file=sys.stderr)
        return None
    except PermissionError:
        print(f"sha256sum: {filepath}: Permission denied", file=sys.stderr)
        return None
    except IsADirectoryError:
        print(f"sha256sum: {filepath}: Is a directory", file=sys.stderr)
        return None
    except Exception as e:
        print(f"sha256sum: {filepath}: {e}", file=sys.stderr)
        return None

    digest = hashlib.sha256(data).hexdigest()
    return digest


def format_output(digest, filepath, binary_mode=False, tag=False, zero=False):
    """Format checksum output."""
    if tag:
        result = f"SHA256 ({filepath}) = {digest}"
    else:
        flag = "*" if binary_mode else " "
        result = f"{digest} {flag}{filepath}"

    if zero:
        return result + "\0"
    return result + "\n"


def check_checksums(filepath, zero=False):
    """Read a checksum file and verify files."""
    try:
        with open(filepath, "r") as f:
            lines = f.readlines()
    except FileNotFoundError:
        print(f"sha256sum: {filepath}: No such file or directory", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"sha256sum: {filepath}: {e}", file=sys.stderr)
        return 1

    exit_code = 0
    for line_idx, line in enumerate(lines, 1):
        line = line.rstrip("\n\r")
        if not line:
            continue

        if line.startswith("SHA256 ("):
            try:
                rest = line[8:]
                close_paren = rest.rfind(")")
                if close_paren == -1:
                    print(f"sha256sum: {filepath}:{line_idx}: improperly formatted SHA256 checksum line", file=sys.stderr)
                    continue
                filename = rest[:close_paren]
                expected_digest = rest[close_paren + 4:].strip()
            except Exception:
                print(f"sha256sum: {filepath}:{line_idx}: improperly formatted SHA256 checksum line", file=sys.stderr)
                continue
        else:
            if len(line) < 64:
                print(f"sha256sum: {filepath}:{line_idx}: improperly formatted SHA256 checksum line", file=sys.stderr)
                continue
            expected_digest = line[:64]
            binary = len(line) > 65 and line[64] == "*"
            filename = line[66:] if len(line) > 66 else ""

        if not filename:
            continue

        digest = sha256sum_file(filename)
        if digest is None:
            print(f"sha256sum: {filename}: FAILED open or read", file=sys.stderr)
            exit_code = 1
        elif digest == expected_digest:
            if zero:
                print(f"{filename}: OK", end="\0")
            else:
                print(f"{filename}: OK")
        else:
            if zero:
                print(f"{filename}: FAILED", end="\0")
            else:
                print(f"{filename}: FAILED")
            exit_code = 1

    return exit_code


def main(args):
    binary_mode = False
    check_mode = False
    tag = False
    zero = False
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
        elif arg == "--tag":
            tag = True
        elif arg.startswith("-") and not arg.startswith("--"):
            for ch in arg[1:]:
                if ch == "b":
                    binary_mode = True
                elif ch == "c":
                    check_mode = True
                elif ch == "t":
                    binary_mode = False
                elif ch == "z":
                    zero = True
                else:
                    print(f"sha256sum: invalid option -- '{ch}'", file=sys.stderr)
                    print("Try 'sha256sum --help' for more information.", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    if check_mode:
        if not files:
            files.append("-")
        for f in files:
            if f == "-":
                try:
                    lines = sys.stdin.read().splitlines()
                except Exception as e:
                    print(f"sha256sum: {e}", file=sys.stderr)
                    sys.exit(1)
                exit_code = 0
                for line in lines:
                    if not line:
                        continue
                    if line.startswith("SHA256 ("):
                        try:
                            rest = line[8:]
                            close_paren = rest.rfind(")")
                            filename = rest[:close_paren]
                            expected_digest = rest[close_paren + 4:].strip()
                        except Exception:
                            continue
                    else:
                        if len(line) < 64:
                            continue
                        expected_digest = line[:64]
                        filename = line[66:] if len(line) > 66 else ""
                    if not filename:
                        continue
                    digest = sha256sum_file(filename)
                    if digest is None:
                        print(f"{filename}: FAILED open or read")
                        exit_code = 1
                    elif digest == expected_digest:
                        print(f"{filename}: OK")
                    else:
                        print(f"{filename}: FAILED")
                        exit_code = 1
                sys.exit(exit_code)
            else:
                ec = check_checksums(f, zero=zero)
                if ec:
                    sys.exit(ec)
        return

    if not files:
        try:
            data = sys.stdin.buffer.read()
        except Exception:
            data = b""
        digest = hashlib.sha256(data).hexdigest()
        result = f"{digest}  -" if not tag else f"SHA256 (-) = {digest}"
        if zero:
            sys.stdout.write(result + "\0")
        else:
            print(result)
    else:
        exit_code = 0
        for f in files:
            digest = sha256sum_file(f)
            if digest is None:
                exit_code = 1
            else:
                output = format_output(digest, f, binary_mode=binary_mode, tag=tag, zero=zero)
                sys.stdout.write(output)
        sys.exit(exit_code)
