import glob as glob_mod
import os
import stat
import sys
import time


def format_mode(mode):
    """Generate permission string like '-rw-r--r--'."""
    is_dir = "d" if stat.S_ISDIR(mode) else "-"
    perms = ""
    for who in ("USR", "GRP", "OTH"):
        for what in ("R", "W", "X"):
            perms += (mode & getattr(stat, f"S_I{what}{who}")) and what.lower() or "-"
    return is_dir + perms


def format_bytes(size):
    """Human-readable byte formatter."""
    for unit in ("B", "K", "M", "G", "T"):
        if abs(size) < 1024:
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}P"


def parse_flags(args):
    """Parse combined short flags like -lah into individual flags."""
    show_all = False
    long_format = False
    human_readable = False
    one_per_line = False
    sort_time = False
    reverse_sort = False
    sort_size = False
    recursive = False
    almost_all = False  # -A: all except . and ..
    directory = False   # -d: list directories themselves, not contents
    classify = False    # -F: append indicator
    targets = []

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--"):
            flags = arg[1:]
            for ch in flags:
                if ch == "a":
                    show_all = True
                elif ch == "A":
                    almost_all = True
                elif ch == "l":
                    long_format = True
                elif ch == "h":
                    human_readable = True
                elif ch == "1":
                    one_per_line = True
                elif ch == "t":
                    sort_time = True
                elif ch == "r":
                    reverse_sort = True
                elif ch == "S":
                    sort_size = True
                elif ch == "R":
                    recursive = True
                elif ch == "d":
                    directory = True
                elif ch == "F":
                    classify = True
                else:
                    print(f"ls: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: ls [-lahtrSR1AFd] [file...]", file=sys.stderr)
                    sys.exit(2)
        elif arg in ("--help", "-help"):
            print("Usage: ls [-lahtrSR1AFd] [file...]")
            print("  -a    do not ignore entries starting with .")
            print("  -A    do not list implied . and ..")
            print("  -l    use a long listing format")
            print("  -h    with -l, print sizes in human readable format")
            print("  -t    sort by modification time, newest first")
            print("  -r    reverse order while sorting")
            print("  -S    sort by file size, largest first")
            print("  -R    list subdirectories recursively")
            print("  -1    list one file per line")
            print("  -F    append indicator (one of */=>@|) to entries")
            print("  -d    list directories themselves, not their contents")
            sys.exit(0)
        elif arg == "--version":
            print("ls (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    return (
        show_all, long_format, human_readable, one_per_line,
        sort_time, reverse_sort, sort_size, recursive,
        almost_all, directory, classify, targets,
    )


def classify_char(path, mode):
    """Return the classify indicator for -F."""
    if stat.S_ISDIR(mode):
        return "/"
    if stat.S_ISLNK(mode):
        return "@"
    if mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
        return "*"
    return ""


def list_directory(
    path, show_all, long_format, human_readable, one_per_line,
    sort_time, reverse_sort, sort_size, recursive,
    almost_all, classify, prefix="", depth=0,
):
    """List contents of a directory, optionally recursive."""
    if not os.path.exists(path):
        print(f"ls: cannot access '{path}': No such file or directory", file=sys.stderr)
        return

    if not os.path.isdir(path):
        # Single file
        if long_format:
            st = os.stat(path)
            mode = format_mode(st.st_mode)
            size = format_bytes(st.st_size) if human_readable else str(st.st_size)
            mtime = time.strftime("%b %d %H:%M", time.localtime(st.st_mtime))
            entry = f"{mode} {st.st_nlink:>2} user user {size:>8} {mtime} {os.path.basename(path)}"
            if classify:
                entry += classify_char(path, st.st_mode)
            print(entry)
        else:
            print(os.path.basename(path))
        return

    try:
        items = os.listdir(path)
    except PermissionError:
        print(f"ls: cannot open directory '{path}': Permission denied", file=sys.stderr)
        return

    # Filter hidden files
    if not show_all and not almost_all:
        items = [f for f in items if not f.startswith(".")]
    elif almost_all:
        items = [f for f in items if f not in (".", "..")]

    # Build entry data for sorting
    entries = []
    for name in items:
        full_path = os.path.join(path, name)
        try:
            st = os.lstat(full_path)
            entries.append((name, full_path, st))
        except OSError:
            entries.append((name, full_path, None))

    # Sorting
    if sort_time:
        entries.sort(key=lambda e: e[2].st_mtime if e[2] else 0, reverse=True)
    elif sort_size:
        entries.sort(key=lambda e: e[2].st_size if e[2] else 0, reverse=True)
    else:
        entries.sort(key=lambda e: e[0].lower())

    if reverse_sort:
        entries.reverse()

    # Output
    if long_format:
        for name, full_path, st in entries:
            if st is None:
                print(f"? ? ? ? ? {name}")
                continue
            mode = format_mode(st.st_mode)
            size = format_bytes(st.st_size) if human_readable else str(st.st_size)
            mtime = time.strftime("%b %d %H:%M", time.localtime(st.st_mtime))
            indicator = classify_char(full_path, st.st_mode) if classify else ""
            print(f"{mode} {st.st_nlink:>2} user user {size:>8} {mtime} {name}{indicator}")
    else:
        names = []
        for name, full_path, st in entries:
            if classify and st is not None:
                names.append(name + classify_char(full_path, st.st_mode))
            else:
                names.append(name)
        sep = "\n" if one_per_line else "  "
        print(sep.join(names))

    # Recursive listing
    if recursive and depth < 100:  # safety limit
        for name, full_path, st in entries:
            if st is not None and stat.S_ISDIR(st.st_mode) and name not in (".", ".."):
                print(f"\n{full_path}:")
                list_directory(
                    full_path, show_all, long_format, human_readable, one_per_line,
                    sort_time, reverse_sort, sort_size, recursive,
                    almost_all, classify, prefix="", depth=depth + 1,
                )


def main(args):
    (
        show_all, long_format, human_readable, one_per_line,
        sort_time, reverse_sort, sort_size, recursive,
        almost_all, directory, classify, targets,
    ) = parse_flags(args)

    if not targets:
        targets = ["."]

    # Expand globs
    expanded = []
    for t in targets:
        matches = glob_mod.glob(t)
        if matches:
            expanded.extend(matches)
        else:
            expanded.append(t)
    targets = expanded

    for i, target in enumerate(targets):
        if len(targets) > 1 or recursive:
            if os.path.isdir(target) and not directory:
                print(f"{target}:")

        if directory and os.path.isdir(target):
            # -d: list the directory entry itself, not its contents
            st = os.lstat(target)
            if long_format:
                mode = format_mode(st.st_mode)
                size = format_bytes(st.st_size) if human_readable else str(st.st_size)
                mtime = time.strftime("%b %d %H:%M", time.localtime(st.st_mtime))
                ind = classify_char(target, st.st_mode) if classify else ""
                print(f"{mode} {st.st_nlink:>2} user user {size:>8} {mtime} {target}{ind}")
            else:
                ind = classify_char(target, st.st_mode) if classify else ""
                print(f"{target}{ind}")
        else:
            list_directory(
                target, show_all, long_format, human_readable, one_per_line,
                sort_time, reverse_sort, sort_size, recursive,
                almost_all, classify,
            )

        if i < len(targets) - 1:
            print()
