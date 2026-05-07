import hashlib
import os
import sys

VERSION = "md5sum (EdgeTerm bigbox) 1.0"


def print_help():
    print("Usage: md5sum [OPTION]... [FILE]...")
    print("Print or check MD5 (128-bit) checksums.")
    print("")
    print("  -b            read in binary mode")
    print("  -c            read MD5 sums from FILEs and check them")
    print("  -t            read in text mode (default)")
    print("      --tag     create a BSD-style checksum")
    print("  -z            end each output line with NUL, not newline")
    print("")
    print("      --help    display this help and exit")
    print("      --version output version information and exit")


def md5sum_file(filepath, binary_mode=False, tag=False, zero=False):
    """Compute MD5 checksum for a file."""
    mode = "rb" if binary_mode else "rb"
    try:
        with open(filepath, mode) as f:
            data = f.read()
    except FileNotFoundError:
        print(f"md5sum: {filepath}: No such file or directory", file=sys.stderr)
        return None
    except PermissionError:
        print(f"md5sum: {filepath}: Permission denied", file=sys.stderr)
        return None
    except IsADirectoryError:
        print(f"md5sum: {filepath}: Is a directory", file=sys.stderr)
        return None
    except Exception as e:
        print(f"md5sum: {filepath}: {e}", file=sys.stderr)
        return None

    digest = hashlib.md5(data).hexdigest()
    return digest


def format_output(digest, filepath, binary_mode=False, tag=False, zero=False):
    """Format checksum output."""
    if tag:
        result = f"MD5 ({filepath}) = {digest}"
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
        print(f"md5sum: {filepath}: No such file or directory", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"md5sum: {filepath}: {e}", file=sys.stderr)
        return 1

    exit_code = 0
    for line in lines:
        line = line.rstrip("\n\r")
        if not line:
            continue

        # BSD-style: MD5 (filename) = digest
        if line.startswith("MD5 ("):
            try:
                rest = line[5:]  # remove "MD5 ("
                close_paren = rest.rfind(")")
                if close_paren == -1:
                    print(f"md5sum: {filepath}:{lines.index(line)+1}: improperly formatted MD5 checksum line", file=sys.stderr)
                    continue
                filename = rest[:close_paren]
                expected_digest = rest[close_paren + 4:].strip()  # skip ") = "
            except Exception:
                print(f"md5sum: {filepath}:{lines.index(line)+1}: improperly formatted MD5 checksum line", file=sys.stderr)
                continue
        else:
            # Standard: digest [ *]filename
            binary = False
            if len(line) < 32:
                print(f"md5sum: {filepath}:{lines.index(line)+1}: improperly formatted MD5 checksum line", file=sys.stderr)
                continue
            expected_digest = line[:32]
            if len(line) > 33 and line[32] in (" ", "*"):
                binary = line[32] == "*"
                filename = line[34:]
            else:
                filename = ""

        if not filename:
            continue

        digest = md5sum_file(filename, binary_mode=binary)
        if digest is None:
            if zero:
                print(f"md5sum: {filename}: FAILED open or read", end="\0", file=sys.stderr)
            else:
                print(f"md5sum: {filename}: FAILED open or read", file=sys.stderr)
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
                    binary_mode = False  # text mode
                elif ch == "z":
                    zero = True
                else:
                    print(f"md5sum: invalid option -- '{ch}'", file=sys.stderr)
                    print("Try 'md5sum --help' for more information.", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    if check_mode:
        if not files:
            files.append("-")
        for f in files:
            if f == "-":
                # Read from stdin
                try:
                    lines = sys.stdin.read().splitlines()
                except Exception as e:
                    print(f"md5sum: {e}", file=sys.stderr)
                    sys.exit(1)
                # Process each line as a checksum entry
                exit_code = 0
                for line in lines:
                    if not line:
                        continue
                    if line.startswith("MD5 ("):
                        try:
                            rest = line[5:]
                            close_paren = rest.rfind(")")
                            filename = rest[:close_paren]
                            expected_digest = rest[close_paren + 4:].strip()
                        except Exception:
                            continue
                    else:
                        if len(line) < 32:
                            continue
                        expected_digest = line[:32]
                        binary = len(line) > 33 and line[32] == "*"
                        filename = line[34:] if len(line) > 34 else ""
                    if not filename:
                        continue
                    digest = md5sum_file(filename, binary_mode=binary)
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
        # Read from stdin
        try:
            data = sys.stdin.buffer.read()
        except Exception:
            data = b""
        if data is None:
            data = b""
        digest = hashlib.md5(data).hexdigest()
        result = f"{digest}  -" if not tag else f"MD5 (-) = {digest}"
        if zero:
            sys.stdout.write(result + "\0")
        else:
            print(result)
    else:
        exit_code = 0
        for f in files:
            digest = md5sum_file(f, binary_mode=binary_mode)
            if digest is None:
                exit_code = 1
            else:
                output = format_output(digest, f, binary_mode=binary_mode, tag=tag, zero=zero)
                sys.stdout.write(output)
        sys.exit(exit_code)
