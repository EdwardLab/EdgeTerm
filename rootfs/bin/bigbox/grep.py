"""grep — print lines that match patterns (bigbox standalone)

For full grep functionality, grep is handled as a shell built-in
in the EdgeTerm shell. This standalone applet provides basic grep
and falls back to the built-in when available.
"""
import os
import re
import sys
import bigbox_utils


def main(args):
    flags, positional = bigbox_utils.parse_flags(args, "iIrRvVwEeFfchnlLsqo")
    ignore_case = "i" in flags
    recursive = "r" in flags or "R" in flags
    invert = "v" in flags
    word_regexp = "w" in flags
    line_number = "n" in flags
    count_only = "c" in flags
    files_with_matches = "l" in flags
    files_without_match = "L" in flags
    no_messages = "s" in flags
    quiet = "q" in flags
    only_matching = "o" in flags
    extended_regexp = "E" in flags
    fixed_strings = "F" in flags
    with_filename = False  # auto-detect later

    if not positional:
        print("Usage: grep [OPTION]... PATTERN [FILE]...", file=sys.stderr)
        print("Try 'grep --help' for more information.", file=sys.stderr)
        sys.exit(2)

    pattern = positional[0]
    files = positional[1:]

    # Build regex
    try:
        if fixed_strings:
            regex = re.compile(re.escape(pattern), re.IGNORECASE if ignore_case else 0)
        elif extended_regexp:
            regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
        else:
            regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as e:
        print(f"grep: invalid regular expression: {e}", file=sys.stderr)
        sys.exit(2)

    # Word boundary wrapper
    if word_regexp:
        orig = regex
        regex = re.compile(r'\b' + orig.pattern + r'\b', orig.flags)

    # Determine if we should print filenames
    if len(files) > 1 or recursive:
        with_filename = True

    # Read from stdin if no files
    if not files:
        files = ["-"]

    # Expand for recursive
    if recursive:
        expanded = []
        for f in files:
            if f == "-":
                expanded.append(f)
            elif os.path.isdir(f):
                for root, _, names in os.walk(f):
                    for name in names:
                        expanded.append(os.path.join(root, name))
            else:
                expanded.append(f)
        files = expanded

    match_count = 0
    file_has_match = False

    for filepath in files:
        last_was_match = False
        try:
            if filepath == "-":
                lines = sys.stdin.read().splitlines(keepends=True)
            else:
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    lines = f.readlines()
        except (OSError, IOError) as e:
            if not no_messages:
                print(f"grep: {filepath}: {e}", file=sys.stderr)
            continue

        for lineno, line in enumerate(lines, 1):
            line = line.rstrip("\n\r")
            m = regex.search(line)
            matches = bool(m)
            if invert:
                matches = not matches

            if matches:
                file_has_match = True
                if quiet:
                    sys.exit(0)
                if count_only:
                    match_count += 1
                    continue
                if files_with_matches:
                    print(filepath)
                    break
                if files_without_match:
                    continue
                last_was_match = True

                prefix = ""
                if with_filename:
                    prefix += f"{filepath}:"
                if line_number:
                    prefix += f"{lineno}:"

                if only_matching and m:
                    print(f"{prefix}{m.group(0)}")
                else:
                    print(f"{prefix}{line}")
            else:
                last_was_match = False

        if files_without_match and not file_has_match:
            print(filepath)

    if count_only:
        if with_filename and files:
            print(f"{match_count}")
        else:
            print(match_count)

    if quiet:
        sys.exit(0 if file_has_match else 1)
    if files_with_matches or files_without_match:
        sys.exit(0 if file_has_match else 1)

    sys.exit(0)
