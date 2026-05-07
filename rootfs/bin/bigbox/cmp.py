import os
import sys

VERSION = "cmp (EdgeTerm bigbox) 1.0"


def print_help():
    print("Usage: cmp [OPTION]... FILE1 FILE2 [SKIP [SKIP2]]")
    print("Compare two files byte by byte.")
    print("")
    print("  -b            print differing bytes")
    print("  -i SKIP       skip first SKIP bytes of both files")
    print("  -i SKIP1:SKIP2  skip SKIP1 bytes of FILE1 and SKIP2 bytes of FILE2")
    print("  -n LIMIT      compare at most LIMIT bytes")
    print("  -l            print all differing bytes (verbose)")
    print("  -s            silent (exit code only)")
    print("")
    print("      --help    display this help and exit")
    print("      --version output version information and exit")


def format_byte(b):
    """Format a byte for display with -b flag."""
    if 32 <= b < 127:
        return f"{b:o} {chr(b)}"
    elif b == 0:
        return f"{b:o} \\0"
    elif b == 7:
        return f"{b:o} \\a"
    elif b == 8:
        return f"{b:o} \\b"
    elif b == 9:
        return f"{b:o} \\t"
    elif b == 10:
        return f"{b:o} \\n"
    elif b == 12:
        return f"{b:o} \\f"
    elif b == 13:
        return f"{b:o} \\r"
    else:
        return f"{b:o} ^#{chr(b + 64) if b < 32 else '?'}"


def main(args):
    skip1 = 0
    skip2 = None  # None means same as skip1
    limit = None
    print_bytes = False
    verbose = False
    silent = False
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
                if ch == "b":
                    print_bytes = True
                elif ch == "l":
                    verbose = True
                elif ch == "s":
                    silent = True
                elif ch == "i":
                    # Skip specified as -i SKIP or -i SKIP1:SKIP2
                    i += 1
                    if i < len(args):
                        skip_val = args[i]
                        if ":" in skip_val:
                            parts = skip_val.split(":", 1)
                            try:
                                skip1 = int(parts[0]) if parts[0] else 0
                                skip2 = int(parts[1]) if parts[1] else 0
                            except ValueError:
                                print(f"cmp: invalid skip value '{skip_val}'", file=sys.stderr)
                                sys.exit(2)
                        else:
                            try:
                                skip1 = int(skip_val)
                                skip2 = None
                            except ValueError:
                                print(f"cmp: invalid skip value '{skip_val}'", file=sys.stderr)
                                sys.exit(2)
                    else:
                        print("cmp: option requires an argument -- 'i'", file=sys.stderr)
                        sys.exit(2)
                elif ch == "n":
                    i += 1
                    if i < len(args):
                        try:
                            limit = int(args[i])
                        except ValueError:
                            print(f"cmp: invalid limit '{args[i]}'", file=sys.stderr)
                            sys.exit(2)
                    else:
                        print("cmp: option requires an argument -- 'n'", file=sys.stderr)
                        sys.exit(2)
                else:
                    print(f"cmp: invalid option -- '{ch}'", file=sys.stderr)
                    print("Try 'cmp --help' for more information.", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if len(files) < 2:
        print("cmp: missing operand", file=sys.stderr)
        print("Try 'cmp --help' for more information.", file=sys.stderr)
        sys.exit(2)

    file1, file2 = files[0], files[1]

    # Handle additional positional skip args (FILE1 FILE2 SKIP [SKIP2])
    if len(files) > 2:
        try:
            skip1 = int(files[2])
        except ValueError:
            print(f"cmp: invalid skip value '{files[2]}'", file=sys.stderr)
            sys.exit(2)
        if len(files) > 3:
            try:
                skip2 = int(files[3])
            except ValueError:
                print(f"cmp: invalid skip value '{files[3]}'", file=sys.stderr)
                sys.exit(2)
        else:
            skip2 = skip1

    if skip2 is None:
        skip2 = skip1

    # Open files
    try:
        if file1 == "-":
            data1 = sys.stdin.buffer.read()
        else:
            with open(file1, "rb") as f:
                data1 = f.read()
    except FileNotFoundError:
        print(f"cmp: {file1}: No such file or directory", file=sys.stderr)
        sys.exit(2)
    except IsADirectoryError:
        print(f"cmp: {file1}: Is a directory", file=sys.stderr)
        sys.exit(2)
    except PermissionError:
        print(f"cmp: {file1}: Permission denied", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"cmp: {file1}: {e}", file=sys.stderr)
        sys.exit(2)

    try:
        if file2 == "-":
            data2 = sys.stdin.buffer.read()
        else:
            with open(file2, "rb") as f:
                data2 = f.read()
    except FileNotFoundError:
        print(f"cmp: {file2}: No such file or directory", file=sys.stderr)
        sys.exit(2)
    except IsADirectoryError:
        print(f"cmp: {file2}: Is a directory", file=sys.stderr)
        sys.exit(2)
    except PermissionError:
        print(f"cmp: {file2}: Permission denied", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"cmp: {file2}: {e}", file=sys.stderr)
        sys.exit(2)

    # Apply skip
    if skip1 > 0:
        data1 = data1[skip1:]
    if skip2 > 0:
        data2 = data2[skip2:]

    # Apply limit
    if limit is not None:
        data1 = data1[:limit]
        data2 = data2[:limit]

    # Compare
    min_len = min(len(data1), len(data2))
    differ = False
    first_diff = None
    diff_count = 0

    for pos in range(min_len):
        if data1[pos] != data2[pos]:
            differ = True
            diff_count += 1
            if first_diff is None:
                first_diff = pos

            if verbose:
                if print_bytes:
                    b1 = format_byte(data1[pos])
                    b2 = format_byte(data2[pos])
                    print(f"{pos + 1:>6} {b1} {b2}")
                else:
                    print(f"{pos + 1:>6} {data1[pos]:3o} {data2[pos]:3o}")

    # Check for size difference
    if len(data1) != len(data2):
        differ = True

    if silent:
        sys.exit(1 if differ else 0)

    if not differ:
        # Files identical
        sys.exit(0)

    if first_diff is not None:
        if verbose:
            # Already printed all differences
            sys.exit(1)
        elif print_bytes:
            b1 = format_byte(data1[first_diff])
            b2 = format_byte(data2[first_diff])
            print(f"{file1} {file2} differ: byte {first_diff + 1}, line ??? is {b1} {b2}")
        else:
            print(f"{file1} {file2} differ: byte {first_diff + 1}, line ???")
        sys.exit(1)
    else:
        # Size mismatch
        if verbose:
            if len(data1) < len(data2):
                print(f"cmp: EOF on {file1} after byte {len(data1) + skip1}")
            else:
                print(f"cmp: EOF on {file2} after byte {len(data2) + skip2}")
        else:
            print(f"{file1} {file2} differ: size")
        sys.exit(1)
