"""
printf — format and print data.
Usage: printf FORMAT [ARGUMENT]...
"""
import re
import sys
import bigbox_utils


VERSION = "printf (EdgeTerm bigbox)"
PROG = "printf"


def interpret_escapes(s):
    """Interpret escape sequences in a string."""
    result = []
    i = 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            ch = s[i + 1]
            if ch == "a":
                result.append("\a")
                i += 2
            elif ch == "b":
                result.append("\b")
                i += 2
            elif ch == "f":
                result.append("\f")
                i += 2
            elif ch == "n":
                result.append("\n")
                i += 2
            elif ch == "r":
                result.append("\r")
                i += 2
            elif ch == "t":
                result.append("\t")
                i += 2
            elif ch == "v":
                result.append("\v")
                i += 2
            elif ch == "\\":
                result.append("\\")
                i += 2
            elif ch == "0":
                # Octal: \0NNN
                j = i + 2
                digits = ""
                while j < len(s) and len(digits) < 3 and s[j] in "01234567":
                    digits += s[j]
                    j += 1
                if digits:
                    result.append(chr(int(digits, 8)))
                    i = j
                else:
                    result.append("\0")
                    i += 2
            elif ch == "x":
                j = i + 2
                digits = ""
                while j < len(s) and len(digits) < 2 and s[j] in "0123456789abcdefABCDEF":
                    digits += s[j]
                    j += 1
                if digits:
                    result.append(chr(int(digits, 16)))
                    i = j
                else:
                    result.append("\\x")
                    i += 2
            else:
                result.append(ch)
                i += 2
        else:
            result.append(s[i])
            i += 1
    return "".join(result)


def parse_format_spec(fmt):
    """Parse a printf format string into literal parts and format specifiers.
    Returns list of (literal_text, spec) tuples where spec is None for text
    and a dict for format specifiers."""
    parts = []
    i = 0
    while i < len(fmt):
        if fmt[i] == "%" and i + 1 < len(fmt):
            if fmt[i + 1] == "%":
                parts.append(("%", None))
                i += 2
                continue
            # Parse format spec
            j = i + 1
            flags = ""
            while j < len(fmt) and fmt[j] in "-+0 #'":
                flags += fmt[j]
                j += 1
            width = ""
            while j < len(fmt) and fmt[j].isdigit():
                width += fmt[j]
                j += 1
            precision = ""
            if j < len(fmt) and fmt[j] == ".":
                j += 1
                while j < len(fmt) and fmt[j].isdigit():
                    precision += fmt[j]
                    j += 1
            # Length modifier (skip)
            while j < len(fmt) and fmt[j] in "hlLjztq":
                j += 1
            if j < len(fmt) and fmt[j] in "diuoxXfFeEgGcCs":
                spec_type = fmt[j]
                spec = {
                    "flags": flags,
                    "width": int(width) if width else 0,
                    "precision": int(precision) if precision else -1,
                    "type": spec_type,
                }
                parts.append((fmt[i:j+1], spec))
                i = j + 1
            else:
                parts.append((fmt[i], None))
                i += 1
        else:
            parts.append((fmt[i], None))
            i += 1

    return parts


def format_arg(conversion, arg, spec):
    """Format a single argument according to the format specifier."""
    t = spec["type"]
    width = spec["width"]
    precision = spec["precision"]
    fl = spec["flags"]
    left_align = "-" in fl
    show_sign = "+" in fl
    space_sign = " " in fl
    zero_pad = "0" in fl and not left_align

    if t == "%":
        return "%"

    if t == "c":
        ch = arg[0] if arg else "\0"
        return ch

    if t == "s":
        if precision >= 0:
            arg = arg[:precision]
        if width > len(arg):
            if left_align:
                return arg + " " * (width - len(arg))
            else:
                return " " * (width - len(arg)) + arg
        return arg

    if t in "di":
        try:
            val = int(arg)
        except (ValueError, TypeError):
            val = 0
        sign = ""
        if val < 0:
            sign = "-"
            val = -val
        elif show_sign:
            sign = "+"
        elif space_sign:
            sign = " "
        s = str(int(val))
        if precision >= 0:
            s = s.rjust(precision, "0")
        s = sign + s
        if zero_pad and width > len(s):
            s = sign + s[len(sign):].rjust(width - len(sign) + len(sign), "0") if sign else s.rjust(width, "0")
        if width > len(s):
            if left_align:
                s = s + " " * (width - len(s))
            else:
                s = " " * (width - len(s)) + s
        return s

    if t == "u":
        try:
            val = int(arg)
        except (ValueError, TypeError):
            val = 0
        if val < 0:
            val = 0
        s = str(val)
        if precision >= 0:
            s = s.rjust(precision, "0")
        if zero_pad and width > len(s):
            s = s.rjust(width, "0")
        if width > len(s):
            if left_align:
                s = s + " " * (width - len(s))
            else:
                s = " " * (width - len(s)) + s
        return s

    if t == "o":
        try:
            val = int(arg)
        except (ValueError, TypeError):
            val = 0
        if val < 0:
            val = -val
        s = oct(val)[2:]
        if "#" in fl and s != "0":
            s = "0" + s
        if precision >= 0:
            s = s.rjust(precision, "0")
        if zero_pad and width > len(s):
            s = s.rjust(width, "0")
        if width > len(s):
            if left_align:
                s = s + " " * (width - len(s))
            else:
                s = " " * (width - len(s)) + s
        return s

    if t in "xX":
        try:
            val = int(arg)
        except (ValueError, TypeError):
            val = 0
        if val < 0:
            val = -val
        upper = t == "X"
        s = hex(val)[2:]
        if upper:
            s = s.upper()
        if "#" in fl and val != 0:
            prefix = "0X" if upper else "0x"
            s = prefix + s
        if precision >= 0:
            s = s.rjust(precision, "0")
        if zero_pad and width > len(s):
            s = s.rjust(width, "0")
        if width > len(s):
            if left_align:
                s = s + " " * (width - len(s))
            else:
                s = " " * (width - len(s)) + s
        return s

    if t in "fFeEgG":
        try:
            val = float(arg)
        except (ValueError, TypeError):
            val = 0.0
        sign = ""
        if val < 0:
            sign = "-"
            val = -val
        elif show_sign:
            sign = "+"
        elif space_sign:
            sign = " "
        if precision < 0:
            precision = 6

        if t == "f":
            s = f"{val:.{precision}f}"
        elif t == "e":
            s = f"{val:.{precision}e}"
        elif t == "E":
            s = f"{val:.{precision}E}"
        elif t == "g":
            s = f"{val:.{precision}g}"
        elif t == "G":
            s = f"{val:.{precision}G}"

        s = sign + s
        if zero_pad and width > len(s):
            s = sign + s[len(sign):].rjust(width - len(sign) + len(sign), "0") if sign else s.rjust(width, "0")
        if width > len(s):
            if left_align:
                s = s + " " * (width - len(s))
            else:
                s = " " * (width - len(s)) + s
        return s

    return arg


def main(args):
    if not args:
        print(f"{PROG}: missing operand", file=sys.stderr)
        sys.exit(1)

    # Check for --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "FORMAT [ARGUMENT]...",
                [("%s", "string"),
                 ("%d, %i", "decimal integer"),
                 ("%u", "unsigned decimal"),
                 ("%o", "octal"),
                 ("%x, %X", "hexadecimal"),
                 ("%f, %F", "floating point"),
                 ("%e, %E", "scientific notation"),
                 ("%g, %G", "shortest of %e/%f"),
                 ("%c", "character"),
                 ("%%", "literal percent sign"),
                 ("\\n, \\t, \\\\", "escape sequences")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)
        break

    format_str = interpret_escapes(args[0])
    arguments = args[1:]

    specs = parse_format_spec(format_str)

    arg_idx = 0
    output = ""

    for literal, spec in specs:
        if spec is None:
            output += literal
        elif spec["type"] == "%":
            output += "%"
        else:
            if arg_idx < len(arguments):
                arg = arguments[arg_idx]
            else:
                # Reuse the last argument, or empty string
                arg = arguments[-1] if arguments else ""
            arg_idx += 1
            output += format_arg(None, arg, spec)

    sys.stdout.write(output)


if __name__ == "__main__":
    main(sys.argv[1:])
