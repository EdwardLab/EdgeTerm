"""
locate - find files by name.
"""
import fnmatch
import os
import sys

import bigbox_utils


def find_matches(root_dirs, pattern, case_insensitive, count_only, limit):
    """Walk through root directories and find files matching the pattern."""
    matches = []
    count = 0

    for root_dir in root_dirs:
        if not os.path.isdir(root_dir):
            continue
        try:
            for dirpath, dirnames, filenames in os.walk(root_dir):
                # Check directory names
                for d in dirnames:
                    full_path = os.path.join(dirpath, d)
                    name = d
                    if case_insensitive:
                        matched = fnmatch.fnmatch(name.lower(), pattern.lower())
                    else:
                        matched = fnmatch.fnmatch(name, pattern)

                    if matched:
                        if count_only:
                            count += 1
                            if limit and count >= limit:
                                break
                        else:
                            matches.append(full_path)
                            if limit and len(matches) >= limit:
                                break

                    if limit and len(matches) >= limit:
                        break

                if limit and (count_only and count >= limit) or (not count_only and len(matches) >= limit):
                    break

                # Check file names
                for f in filenames:
                    full_path = os.path.join(dirpath, f)
                    name = f
                    if case_insensitive:
                        matched = fnmatch.fnmatch(name.lower(), pattern.lower())
                    else:
                        matched = fnmatch.fnmatch(name, pattern)

                    if matched:
                        if count_only:
                            count += 1
                            if limit and count >= limit:
                                break
                        else:
                            matches.append(full_path)
                            if limit and len(matches) >= limit:
                                break

                    if limit and (count_only and count >= limit) or (not count_only and len(matches) >= limit):
                        break

                if limit and (count_only and count >= limit) or (not count_only and len(matches) >= limit):
                    break

        except OSError:
            pass

    if count_only:
        return count
    return matches


def main(args):
    case_insensitive = False
    count_only = False
    limit = None
    pattern = None
    i = 0

    while i < len(args):
        arg = args[i]
        if arg == "--":
            i += 1
            if i < len(args):
                pattern = args[i]
            break
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "i":
                    case_insensitive = True
                elif ch == "c":
                    count_only = True
                elif ch == "l":
                    # -l N
                    i += 1
                    if i >= len(args):
                        print("locate: option requires an argument -- 'l'", file=sys.stderr)
                        sys.exit(1)
                    try:
                        limit = int(args[i])
                    except ValueError:
                        print(f"locate: invalid limit '{args[i]}'", file=sys.stderr)
                        sys.exit(1)
                else:
                    print(f"locate: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: locate [-ic] [-l N] PATTERN", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: locate [-ic] [-l N] PATTERN")
            print("  -i    ignore case distinctions in pattern")
            print("  -c    only print count of matching entries")
            print("  -l N  limit output to N entries")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("locate (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            pattern = arg
        i += 1

    if pattern is None:
        print("locate: missing pattern", file=sys.stderr)
        print("Usage: locate [-ic] [-l N] PATTERN", file=sys.stderr)
        sys.exit(1)

    # Determine root directories to search
    home = os.environ.get("HOME", "/home/user")
    root_dirs = [home, os.getcwd()]

    # Deduplicate
    seen = set()
    unique_dirs = []
    for d in root_dirs:
        if d not in seen:
            seen.add(d)
            unique_dirs.append(d)

    result = find_matches(unique_dirs, pattern, case_insensitive, count_only, limit)

    if count_only:
        print(result)
    else:
        for match in result:
            print(match)
