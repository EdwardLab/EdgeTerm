import sys


def interpret_escapes(text):
    """Interpret backslash escape sequences like \\n, \\t, \\033, etc."""
    result = []
    i = 0
    while i < len(text):
        if text[i] == "\\" and i + 1 < len(text):
            ch = text[i + 1]
            if ch == "n":
                result.append("\n")
            elif ch == "t":
                result.append("\t")
            elif ch == "r":
                result.append("\r")
            elif ch == "\\":
                result.append("\\")
            elif ch == "a":
                result.append("\a")
            elif ch == "b":
                result.append("\b")
            elif ch == "f":
                result.append("\f")
            elif ch == "v":
                result.append("\v")
            elif ch == "e":
                result.append("\033")
            elif ch == "0":
                # Octal: \0NNN — read up to 3 octal digits
                j = i + 2
                octal_digits = []
                while j < len(text) and len(octal_digits) < 3 and text[j] in "01234567":
                    octal_digits.append(text[j])
                    j += 1
                if octal_digits:
                    code = int("".join(octal_digits), 8)
                    result.append(chr(code))
                    i = j - 1
                else:
                    result.append("\0")
                    i += 1
                continue
            elif ch == "x":
                # Hex: \xHH
                j = i + 2
                hex_digits = []
                while j < len(text) and len(hex_digits) < 2 and text[j] in "0123456789abcdefABCDEF":
                    hex_digits.append(text[j])
                    j += 1
                if hex_digits:
                    code = int("".join(hex_digits), 16)
                    result.append(chr(code))
                    i = j - 1
                else:
                    result.append("\\x")
                    i += 1
                continue
            else:
                result.append("\\" + ch)
            i += 2
        else:
            result.append(text[i])
            i += 1
    return "".join(result)


def parse_flags(args):
    """Parse flags for echo. Handles -n, -e, -E."""
    no_newline = False
    interpret = False   # default: do NOT interpret
    i = 0
    text_parts = []

    while i < len(args):
        arg = args[i]
        if arg == "-n":
            no_newline = True
            i += 1
            continue
        if arg == "-e":
            interpret = True
            i += 1
            continue
        if arg == "-E":
            interpret = False
            i += 1
            continue
        if arg == "--":
            i += 1
            text_parts.extend(args[i:])
            break
        # Stop parsing flags once we hit something that's not a flag
        text_parts.extend(args[i:])
        break

    return no_newline, interpret, text_parts


def main(args):
    no_newline, interpret, text_parts = parse_flags(args)

    output = " ".join(text_parts)

    if interpret:
        output = interpret_escapes(output)

    end = "" if no_newline else "\n"
    sys.stdout.write(output + end)
