import difflib
import os
import sys

VERSION = "diff (EdgeTerm bigbox) 1.0"


def print_help():
    print("Usage: diff [OPTION]... FILES")
    print("Compare files line by line.")
    print("")
    print("  -u            use unified format (default)")
    print("  -c            use context format")
    print("  -i            ignore case differences")
    print("  -w            ignore all whitespace")
    print("  -b            ignore changes in the amount of whitespace")
    print("  -B            ignore changes whose lines are all blank")
    print("  -r            recursively compare subdirectories")
    print("  -q            output only whether files differ")
    print("  -s            report when two files are the same")
    print("")
    print("      --help    display this help and exit")
    print("      --version output version information and exit")


def normalize_line(line, ignore_case=False, ignore_whitespace=False, ignore_blank_changes=False):
    """Normalize a line based on flags."""
    if ignore_whitespace:
        line = "".join(line.split())
    elif ignore_blank_changes:
        line = line.strip()
    if ignore_case:
        line = line.lower()
    return line


def is_blank_line(line):
    """Check if a line is blank or whitespace-only."""
    return line.strip() == ""


def compare_files(file1, file2, unified=True, context=False,
                  ignore_case=False, ignore_whitespace=False,
                  ignore_blank_changes=False, ignore_blank_lines=False):
    """Compare two files and return diff lines."""
    try:
        if file1 == "-":
            lines1 = sys.stdin.read().splitlines(keepends=True)
        else:
            with open(file1, "r") as f:
                lines1 = f.readlines()
    except FileNotFoundError:
        print(f"diff: {file1}: No such file or directory", file=sys.stderr)
        sys.exit(2)
    except IsADirectoryError:
        print(f"diff: {file1}: Is a directory", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"diff: {file1}: {e}", file=sys.stderr)
        sys.exit(2)

    try:
        if file2 == "-":
            lines2 = sys.stdin.read().splitlines(keepends=True)
        else:
            with open(file2, "r") as f:
                lines2 = f.readlines()
    except FileNotFoundError:
        print(f"diff: {file2}: No such file or directory", file=sys.stderr)
        sys.exit(2)
    except IsADirectoryError:
        print(f"diff: {file2}: Is a directory", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"diff: {file2}: {e}", file=sys.stderr)
        sys.exit(2)

    # Apply -B: filter out blank lines
    if ignore_blank_lines:
        lines1 = [l for l in lines1 if not is_blank_line(l)]
        lines2 = [l for l in lines2 if not is_blank_line(l)]

    # Create normalized versions for comparison
    norm1 = [normalize_line(l, ignore_case, ignore_whitespace, ignore_blank_changes) for l in lines1]
    norm2 = [normalize_line(l, ignore_case, ignore_whitespace, ignore_blank_changes) for l in lines2]

    if unified:
        diff_lines = list(difflib.unified_diff(
            norm1, norm2,
            fromfile=file1, tofile=file2,
            lineterm=""
        ))
        # Replace normalized lines with original lines in the diff output
        # This is tricky because unified_diff produces metadata too
        # For simplicity with flags, we'll use the normalized diff logic but
        # reconstruct output with original lines where possible
        if ignore_case or ignore_whitespace or ignore_blank_changes:
            return make_custom_unified_diff(lines1, lines2, norm1, norm2, file1, file2)
        return diff_lines
    elif context:
        diff_lines = list(difflib.context_diff(
            norm1, norm2,
            fromfile=file1, tofile=file2,
            lineterm=""
        ))
        if ignore_case or ignore_whitespace or ignore_blank_changes:
            return make_custom_context_diff(lines1, lines2, norm1, norm2, file1, file2)
        return diff_lines
    else:
        # Default unified
        diff_lines = list(difflib.unified_diff(
            norm1, norm2,
            fromfile=file1, tofile=file2,
            lineterm=""
        ))
        if ignore_case or ignore_whitespace or ignore_blank_changes:
            return make_custom_unified_diff(lines1, lines2, norm1, norm2, file1, file2)
        return diff_lines


def make_custom_unified_diff(lines1, lines2, norm1, norm2, file1, file2):
    """Generate unified diff using original lines but normalized comparison."""
    # Use SequenceMatcher on normalized lines
    matcher = difflib.SequenceMatcher(None, norm1, norm2)
    result = []
    result.append(f"--- {file1}")
    result.append(f"+++ {file2}")

    for group in matcher.get_grouped_opcodes(3):
        # Write @@ header
        first = group[0]
        last = group[-1]
        start1 = max(first[1], 0) + 1
        start2 = max(first[2], 0) + 1
        len1 = last[3] - first[1]
        len2 = last[4] - first[2]
        result.append(f"@@ -{start1},{len1} +{start2},{len2} @@")

        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for line in lines1[i1:i2]:
                    result.append(" " + line.rstrip("\n"))
            elif tag == "replace":
                for line in lines1[i1:i2]:
                    result.append("-" + line.rstrip("\n"))
                for line in lines2[j1:j2]:
                    result.append("+" + line.rstrip("\n"))
            elif tag == "delete":
                for line in lines1[i1:i2]:
                    result.append("-" + line.rstrip("\n"))
            elif tag == "insert":
                for line in lines2[j1:j2]:
                    result.append("+" + line.rstrip("\n"))

    return result


def make_custom_context_diff(lines1, lines2, norm1, norm2, file1, file2):
    """Generate context diff using original lines but normalized comparison."""
    matcher = difflib.SequenceMatcher(None, norm1, norm2)
    result = []
    result.append(f"*** {file1}")
    result.append(f"--- {file2}")

    for group in matcher.get_grouped_opcodes(3):
        first = group[0]
        last = group[-1]
        start1 = max(first[1] - 2, 0) + 1
        start2 = max(first[2] - 2, 0) + 1
        end1 = min(last[3] + 2, len(lines1))
        end2 = min(last[4] + 2, len(lines2))
        result.append(f"***************")
        result.append(f"*** {start1},{end1} ****")

        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                for line in lines1[i1:i2]:
                    result.append("  " + line.rstrip("\n"))
            elif tag == "replace":
                for line in lines1[i1:i2]:
                    result.append("- " + line.rstrip("\n"))
            elif tag == "delete":
                for line in lines1[i1:i2]:
                    result.append("- " + line.rstrip("\n"))

        result.append(f"--- {start2},{end2} ----")
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                pass  # already shown in first part
            elif tag == "replace":
                for line in lines2[j1:j2]:
                    result.append("+ " + line.rstrip("\n"))
            elif tag == "insert":
                for line in lines2[j1:j2]:
                    result.append("+ " + line.rstrip("\n"))

    return result


def files_are_different(file1, file2, ignore_case=False, ignore_whitespace=False,
                        ignore_blank_changes=False, ignore_blank_lines=False):
    """Quick check if files differ."""
    lines1 = open(file1, "r").readlines()
    lines2 = open(file2, "r").readlines()

    if ignore_blank_lines:
        lines1 = [l for l in lines1 if not is_blank_line(l)]
        lines2 = [l for l in lines2 if not is_blank_line(l)]

    if len(lines1) != len(lines2):
        return True

    for l1, l2 in zip(lines1, lines2):
        n1 = normalize_line(l1, ignore_case, ignore_whitespace, ignore_blank_changes)
        n2 = normalize_line(l2, ignore_case, ignore_whitespace, ignore_blank_changes)
        if n1 != n2:
            return True
    return False


def compare_dirs(dir1, dir2, recursive=False, unified=True, context=False,
                 ignore_case=False, ignore_whitespace=False,
                 ignore_blank_changes=False, ignore_blank_lines=False,
                 brief=False, report_same=False):
    """Compare two directories."""
    try:
        files1 = set(os.listdir(dir1))
        files2 = set(os.listdir(dir2))
    except PermissionError as e:
        print(f"diff: {e}", file=sys.stderr)
        sys.exit(2)

    common = files1 & files2
    only1 = files1 - files2
    only2 = files2 - files1

    exit_code = 0

    for f in sorted(only1):
        path = os.path.join(dir1, f)
        if os.path.isdir(path) and recursive:
            print(f"Only in {dir1}: {f}/")
        else:
            print(f"Only in {dir1}: {f}")
        exit_code = 1

    for f in sorted(only2):
        path = os.path.join(dir2, f)
        if os.path.isdir(path) and recursive:
            print(f"Only in {dir2}: {f}/")
        else:
            print(f"Only in {dir2}: {f}")
        exit_code = 1

    for f in sorted(common):
        path1 = os.path.join(dir1, f)
        path2 = os.path.join(dir2, f)

        if os.path.isdir(path1) and os.path.isdir(path2):
            if recursive:
                ec = compare_dirs(path1, path2, recursive, unified, context,
                                   ignore_case, ignore_whitespace,
                                   ignore_blank_changes, ignore_blank_lines,
                                   brief, report_same)
                if ec:
                    exit_code = ec
            continue

        if brief:
            if files_are_different(path1, path2, ignore_case, ignore_whitespace,
                                    ignore_blank_changes, ignore_blank_lines):
                print(f"Files {path1} and {path2} differ")
                exit_code = 1
            elif report_same:
                print(f"Files {path1} and {path2} are identical")
        else:
            diff_out = compare_files(path1, path2, unified, context,
                                      ignore_case, ignore_whitespace,
                                      ignore_blank_changes, ignore_blank_lines)
            if diff_out:
                exit_code = 1
                for line in diff_out:
                    print(line)

    return exit_code


def main(args):
    unified = True
    context = False
    ignore_case = False
    ignore_whitespace = False
    ignore_blank_changes = False
    ignore_blank_lines = False
    recursive = False
    brief = False
    report_same = False
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
                if ch == "u":
                    unified = True
                    context = False
                elif ch == "c":
                    context = True
                    unified = False
                elif ch == "i":
                    ignore_case = True
                elif ch == "w":
                    ignore_whitespace = True
                elif ch == "b":
                    ignore_blank_changes = True
                elif ch == "B":
                    ignore_blank_lines = True
                elif ch == "r":
                    recursive = True
                elif ch == "q":
                    brief = True
                elif ch == "s":
                    report_same = True
                else:
                    print(f"diff: invalid option -- '{ch}'", file=sys.stderr)
                    print("Try 'diff --help' for more information.", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)
        i += 1

    if len(files) < 2:
        print("diff: missing operand after '" + (files[-1] if files else "") + "'", file=sys.stderr)
        print("Try 'diff --help' for more information.", file=sys.stderr)
        sys.exit(2)

    file1, file2 = files[0], files[1]

    # Check if files or directories
    path1_exists = os.path.exists(file1)
    path2_exists = os.path.exists(file2)

    if not path1_exists:
        print(f"diff: {file1}: No such file or directory", file=sys.stderr)
        sys.exit(2)
    if not path2_exists:
        print(f"diff: {file2}: No such file or directory", file=sys.stderr)
        sys.exit(2)

    isdir1 = os.path.isdir(file1)
    isdir2 = os.path.isdir(file2)

    if isdir1 and isdir2:
        ec = compare_dirs(file1, file2, recursive, unified, context,
                           ignore_case, ignore_whitespace,
                           ignore_blank_changes, ignore_blank_lines,
                           brief, report_same)
        sys.exit(ec)
    elif isdir1 or isdir2:
        print(f"diff: {file1 if isdir1 else file2}: Is a directory", file=sys.stderr)
        sys.exit(2)

    if brief:
        if files_are_different(file1, file2, ignore_case, ignore_whitespace,
                                ignore_blank_changes, ignore_blank_lines):
            print(f"Files {file1} and {file2} differ")
            sys.exit(1)
        elif report_same:
            print(f"Files {file1} and {file2} are identical")
        sys.exit(0)

    diff_out = compare_files(file1, file2, unified, context,
                              ignore_case, ignore_whitespace,
                              ignore_blank_changes, ignore_blank_lines)

    if not diff_out:
        if report_same:
            print(f"Files {file1} and {file2} are identical")
        sys.exit(0)

    for line in diff_out:
        print(line)
    sys.exit(1)
