"""
sort — sort lines of text files.
Usage: sort [OPTION]... [FILE]...
"""
import argparse
import os
import random
import re
import sys
import bigbox_utils


VERSION = "sort (EdgeTerm bigbox)"
PROG = "sort"


def parse_keydef(k):
    """Parse a KEYDEF string like '2.3r', '2,3', '2' into a dict."""
    parts = k.split(",", 1)
    start = {"field": 1, "char": 1, "opts": ""}
    end = None

    def parse_pos(s):
        pos = {"field": 1, "char": 1}
        m = re.match(r"^(\d+)(?:\.(\d+))?(.*)", s)
        if m:
            pos["field"] = int(m.group(1))
            if m.group(2):
                pos["char"] = int(m.group(2))
            pos["opts"] = m.group(3)
        return pos

    start = parse_pos(parts[0])
    if len(parts) > 1 and parts[1]:
        end = parse_pos(parts[1])
    return start, end


def keyfunc(line, keydefs, flags):
    """Extract sort key(s) from a line based on key definitions."""
    keys = []
    f_flags = flags.copy()
    for kd in keydefs:
        start, end = kd
        f = start["field"]
        c = start["char"]
        opts = start.get("opts", "")
        fields = line.split(flags.get("separator", None) or None)
        if f > len(fields):
            val = ""
        else:
            val = fields[f - 1]
            if c > 1:
                val = val[c - 1:]
        if end:
            ef = end["field"]
            ec = end["char"]
            if ef > len(fields):
                val2 = ""
            else:
                val2 = fields[ef - 1]
                if ec <= len(val2):
                    val2 = val2[:ec]
            val = val + "\0" + val2

        if "b" in opts or "b" in f_flags:
            val = val.lstrip()
        if "f" in opts or "f" in f_flags:
            val = val.lower()
        keys.append(val)
    if not keydefs:
        val = line
        if "b" in f_flags:
            val = val.lstrip()
        if "f" in f_flags:
            val = val.lower()
        keys = [val]
    return tuple(keys)


def try_numeric(val):
    """Try to convert to float for numeric sort."""
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def try_human(val):
    """Try to convert human-readable size like 1K, 2.3M to bytes."""
    m = re.match(r"^([0-9.]+)\s*([KMGTPEZY]?)$", val.strip(), re.I)
    if m:
        num = float(m.group(1))
        suffix = m.group(2).upper()
        units = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4,
                 "P": 1024**5, "E": 1024**6, "Z": 1024**7, "Y": 1024**8}
        if suffix in units:
            return num * units[suffix]
        return num
    return None


def try_version(val):
    """Parse version string into comparable tuple."""
    parts = re.findall(r"[0-9]+|[a-zA-Z]+|[^a-zA-Z0-9]+", val)
    result = []
    for p in parts:
        if re.match(r"^\d+$", p):
            result.append((0, int(p)))
        elif re.match(r"^[a-zA-Z]+$", p):
            result.append((1, p.lower()))
        else:
            result.append((2, p))
    return result


def sort_compare(a, b, flags, keydefs):
    """Comparison function respecting sort flags and key definitions."""
    ka = keyfunc(a, keydefs, flags)
    kb = keyfunc(b, keydefs, flags)

    for va, vb in zip(ka, kb):
        cmp_val = None
        if "n" in flags:
            na = try_numeric(va)
            nb = try_numeric(vb)
            if na is not None and nb is not None:
                cmp_val = (na > nb) - (na < nb)
        if cmp_val is None and "h" in flags:
            ha = try_human(va)
            hb = try_human(vb)
            if ha is not None and hb is not None:
                cmp_val = (ha > hb) - (ha < hb)
        if cmp_val is None and "V" in flags:
            va_ver = try_version(va)
            vb_ver = try_version(vb)
            cmp_val = (va_ver > vb_ver) - (va_ver < vb_ver)
        if cmp_val is None:
            if va < vb:
                cmp_val = -1
            elif va > vb:
                cmp_val = 1
            else:
                cmp_val = 0

        if cmp_val != 0:
            return -cmp_val if "r" in flags else cmp_val
    return 0


def main(args):
    flags = {}
    keydefs = []
    files = []
    outfile = None
    check_only = False
    random_sort = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... [FILE]...",
                [("-r", "reverse the result of comparisons"),
                 ("-n", "compare according to string numerical value"),
                 ("-h", "compare human readable numbers (e.g., 2K, 1G)"),
                 ("-u", "output only the first of equal lines"),
                 ("-f", "fold lower case to upper case characters"),
                 ("-k KEYDEF", "sort via a key; KEYDEF: F[.C][OPTS][,F[.C][OPTS]]"),
                 ("-t SEP", "use SEP as field separator"),
                 ("-b", "ignore leading blanks"),
                 ("-o FILE", "write result to FILE instead of standard output"),
                 ("-c", "check for sorted input; do not sort"),
                 ("-R", "sort by random hash"),
                 ("-V", "natural sort of (version) numbers within text")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg == "-o" and i + 1 < len(args):
            i += 1
            outfile = args[i]
        elif arg.startswith("-o") and len(arg) > 2:
            outfile = arg[2:]
        elif arg == "-k" and i + 1 < len(args):
            i += 1
            keydefs.append(parse_keydef(args[i]))
        elif arg.startswith("-k") and len(arg) > 2:
            keydefs.append(parse_keydef(arg[2:]))
        elif arg == "-t" and i + 1 < len(args):
            i += 1
            flags["separator"] = args[i]
        elif arg.startswith("-t") and len(arg) > 2:
            flags["separator"] = arg[2:]
        elif arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "r":
                    flags["r"] = True
                elif ch == "n":
                    flags["n"] = True
                elif ch == "h":
                    flags["h"] = True
                elif ch == "u":
                    flags["u"] = True
                elif ch == "f":
                    flags["f"] = True
                elif ch == "b":
                    flags["b"] = True
                elif ch == "c":
                    check_only = True
                elif ch == "R":
                    random_sort = True
                elif ch == "V":
                    flags["V"] = True
                elif ch in "okt":
                    print(f"{PROG}: option requires an argument -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    lines = bigbox_utils.read_input(files)

    if check_only:
        for j in range(1, len(lines)):
            if sort_compare(lines[j - 1], lines[j], flags, keydefs) > 0:
                print(f"{PROG}: {files[0] if files else 'stdin'}:{j + 1}: disorder: {lines[j].rstrip()}", file=sys.stderr)
                sys.exit(1)
        sys.exit(0)

    if random_sort:
        random.shuffle(lines)
    else:
        from functools import cmp_to_key
        lines.sort(key=cmp_to_key(lambda a, b: sort_compare(a, b, flags, keydefs)))

    if "u" in flags:
        uniq_lines = []
        for j, line in enumerate(lines):
            if j == 0 or sort_compare(lines[j - 1], line, flags, keydefs) != 0:
                uniq_lines.append(line)
        lines = uniq_lines

    output = "".join(lines)
    if outfile:
        with open(outfile, "w", encoding="utf-8", errors="replace") as f:
            f.write(output)
    else:
        sys.stdout.write(output)


if __name__ == "__main__":
    main(sys.argv[1:])
