import glob as glob_mod
import os
import sys


def parse_flags(args):
    """Parse combined short flags like -bn into individual flags."""
    number_all = False       # -n: number all output lines
    number_nonblank = False  # -b: number nonempty output lines
    squeeze_blank = False    # -s: suppress repeated empty lines
    show_ends = False        # -E: display $ at end of each line
    show_tabs = False        # -T: display TAB as ^I
    show_nonprinting = False # -v: use ^ and M- notation
    targets = []

    for arg in args:
        if arg.startswith("-") and not arg.startswith("--"):
            flags = arg[1:]
            for ch in flags:
                if ch == "n":
                    number_all = True
                elif ch == "b":
                    number_nonblank = True
                elif ch == "s":
                    squeeze_blank = True
                elif ch == "E":
                    show_ends = True
                elif ch == "T":
                    show_tabs = True
                elif ch == "v":
                    show_nonprinting = True
                elif ch == "A":
                    show_ends = True
                    show_tabs = True
                    show_nonprinting = True
                elif ch == "e":
                    show_ends = True
                    show_nonprinting = True
                elif ch == "t":
                    show_tabs = True
                    show_nonprinting = True
                else:
                    print(f"cat: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: cat [-nbsETAvet] [file...]", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: cat [-nbsETAvet] [file...]")
            print("  -n    number all output lines")
            print("  -b    number nonempty output lines (overrides -n)")
            print("  -s    suppress repeated empty output lines")
            print("  -E    display $ at end of each line")
            print("  -T    display TAB characters as ^I")
            print("  -v    use ^ and M- notation for nonprinting characters")
            print("  -A    equivalent to -vET")
            print("  -e    equivalent to -vE")
            print("  -t    equivalent to -vT")
            print("With no FILE, or when FILE is -, read standard input.")
            sys.exit(0)
        elif arg == "--version":
            print("cat (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    return (number_all, number_nonblank, squeeze_blank,
            show_ends, show_tabs, show_nonprinting, targets)


def escape_char(ch, show_nonprinting):
    """Apply -v style escaping: ^X for control chars, M-X for high bytes."""
    if not show_nonprinting:
        return ch
    code = ord(ch)
    if code == 9 or code == 10:  # tab, newline
        return ch
    if code < 32:
        return "^" + chr(code + 64)
    if code == 127:
        return "^?"
    if 128 <= code < 160:
        return "M-" + (chr(code - 128) if code - 128 >= 32 else "^" + chr(code - 128 + 64))
    if 160 <= code < 256:
        return "M-" + chr(code - 128)
    return ch


def process_line(line, show_ends, show_tabs, show_nonprinting):
    """Apply per-line transformations."""
    result = []
    for ch in line:
        if ch == "\t" and show_tabs:
            result.append("^I")
        elif ch == "\n" and show_ends:
            result.append("$\n")
        elif ch == "\n":
            result.append("\n")
        else:
            result.append(escape_char(ch, show_nonprinting))
    processed = "".join(result)
    if show_ends and not processed.endswith("$\n"):
        processed = processed.rstrip("\n") + "$\n"
    return processed


def cat_files(targets, number_all, number_nonblank, squeeze_blank,
              show_ends, show_tabs, show_nonprinting):
    """Read and output files with formatting."""
    line_number = 0
    prev_blank = False

    # If no targets, read stdin
    if not targets:
        targets = ["-"]

    for target in targets:
        # Expand globs
        matches = glob_mod.glob(target)
        actual_targets = matches if matches and target != "-" else [target]

        for actual in actual_targets:
            try:
                if actual == "-":
                    lines = sys.stdin.read().splitlines(keepends=True)
                elif not os.path.exists(actual):
                    print(f"cat: {actual}: No such file or directory", file=sys.stderr)
                    continue
                elif os.path.isdir(actual):
                    print(f"cat: {actual}: Is a directory", file=sys.stderr)
                    continue
                else:
                    with open(actual, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()

                for line in lines:
                    # Check if blank (empty or whitespace-only)
                    is_blank = line.strip() == ""

                    # Squeeze blank lines
                    if squeeze_blank:
                        if is_blank:
                            if prev_blank:
                                continue
                            prev_blank = True
                        else:
                            prev_blank = False

                    # Line numbering
                    if number_nonblank:
                        if is_blank:
                            prefix = "      "
                        else:
                            line_number += 1
                            prefix = f"{line_number:>6}\t"
                    elif number_all:
                        line_number += 1
                        prefix = f"{line_number:>6}\t"
                    else:
                        prefix = ""

                    processed = process_line(line, show_ends, show_tabs, show_nonprinting)
                    sys.stdout.write(prefix + processed)

            except Exception as e:
                print(f"cat: {actual}: {e}", file=sys.stderr)


def main(args):
    (number_all, number_nonblank, squeeze_blank,
     show_ends, show_tabs, show_nonprinting, targets) = parse_flags(args)
    cat_files(targets, number_all, number_nonblank, squeeze_blank,
              show_ends, show_tabs, show_nonprinting)
