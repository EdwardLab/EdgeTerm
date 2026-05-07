"""
tr — translate or delete characters.
Usage: tr [OPTION]... SET1 [SET2]
"""
import re
import sys
import bigbox_utils


VERSION = "tr (EdgeTerm bigbox)"
PROG = "tr"


# Character class definitions
CHAR_CLASSES = {
    "alpha": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "digit": "0123456789",
    "alnum": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "lower": "abcdefghijklmnopqrstuvwxyz",
    "upper": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "space": " \t\n\r\f\v",
    "punct": "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
    "print": " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\t",
    "graph": "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    "cntrl": "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f",
    "xdigit": "0123456789abcdefABCDEF",
}


def expand_set(s):
    """Expand a SET string into a list of characters.
    Handles ranges (a-z), character classes ([:alpha:]), and escapes."""
    result = []
    i = 0
    while i < len(s):
        # Check for character class [:xxx:]
        if s[i:i+2] == "[:":
            j = s.find(":]", i + 2)
            if j != -1:
                class_name = s[i+2:j]
                if class_name in CHAR_CLASSES:
                    result.extend(CHAR_CLASSES[class_name])
                i = j + 2
                continue

        # Check for escaped chars
        if s[i] == "\\" and i + 1 < len(s):
            ch = s[i + 1]
            esc = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\",
                   "a": "\a", "b": "\b", "f": "\f", "v": "\v"}
            if ch in esc:
                result.append(esc[ch])
            elif ch == "0" and i + 2 < len(s) and s[i+2] in "01234567":
                # Octal
                j = i + 2
                digits = ""
                while j < len(s) and len(digits) < 3 and s[j] in "01234567":
                    digits += s[j]
                    j += 1
                if digits:
                    result.append(chr(int(digits, 8)))
                    i = j - 1
            else:
                result.append(ch)
            i += 2
            continue

        # Check for range a-z
        if i + 2 < len(s) and s[i + 1] == "-" and s[i + 2] != ":":
            start = s[i]
            end = s[i + 2]
            for c in range(ord(start), ord(end) + 1):
                result.append(chr(c))
            i += 3
            continue

        result.append(s[i])
        i += 1

    return result


def main(args):
    delete = False
    squeeze = False
    complement = False
    truncate = False
    sets = []

    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... SET1 [SET2]",
                [("-d", "delete characters in SET1, do not translate"),
                 ("-s", "replace each sequence of repeated chars with single occurrence"),
                 ("-c", "use the complement of SET1"),
                 ("-t", "truncate SET1 to length of SET2"),
                 ("", "SETs use character classes [:alpha:], ranges a-z, escapes \\n")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "d":
                    delete = True
                elif ch == "s":
                    squeeze = True
                elif ch == "c":
                    complement = True
                elif ch == "t":
                    truncate = True
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            sets.append(arg)

    if len(sets) < 1:
        print(f"{PROG}: missing operand", file=sys.stderr)
        sys.exit(1)

    set1_chars = expand_set(sets[0])
    set2_chars = expand_set(sets[1]) if len(sets) > 1 else []

    if truncate and len(set2_chars) < len(set1_chars):
        set1_chars = set1_chars[:len(set2_chars)]

    if complement:
        # Complement set1: all ASCII printable + common chars not in set1
        all_chars = set(chr(i) for i in range(0, 256))
        complement_set = sorted(all_chars - set(set1_chars))
        set1_chars = complement_set

    input_text = sys.stdin.read()

    if delete:
        # -d: delete all chars in SET1
        del_set = set(set1_chars)
        result = [c for c in input_text if c not in del_set]
    elif set2_chars:
        # Translate: map each char in SET1 to corresponding char in SET2
        # If set1 is longer, last char of set2 repeats
        trans_map = {}
        for idx, ch in enumerate(set1_chars):
            if idx < len(set2_chars):
                trans_map[ch] = set2_chars[idx]
            else:
                trans_map[ch] = set2_chars[-1] if set2_chars else ch
        result = [trans_map.get(c, c) for c in input_text]
    else:
        result = list(input_text)

    # Squeeze: replace repeated chars with single occurrence
    if squeeze:
        squeeze_set = set(set1_chars) if set1_chars else None
        squeezed = []
        for idx, c in enumerate(result):
            if idx > 0 and c == result[idx - 1]:
                if squeeze_set and c in squeeze_set:
                    continue
            squeezed.append(c)
        result = squeezed

    sys.stdout.write("".join(result))


if __name__ == "__main__":
    main(sys.argv[1:])
