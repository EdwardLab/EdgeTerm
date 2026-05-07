"""
Shared utilities for EdgeTerm bigbox commands.
Provides consistent flag parsing, glob expansion, stdin/file reading,
and common output helpers used across all bigbox applets.
"""
import glob as glob_mod
import os
import sys


def parse_flags(args, known_flags=""):
    """Split combined short flags like -rf into individual chars.
    Returns (flag_chars_set, positional_args_list).

    known_flags: string of valid flag characters (e.g., "rfv").
    Unknown flags print a warning but are still collected.
    """
    flags = set()
    positional = []
    for arg in args:
        if arg == "--":
            continue  # end-of-options marker, rest handled elsewhere
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if known_flags and ch not in known_flags:
                    print(f"warning: invalid option -- '{ch}'", file=sys.stderr)
                flags.add(ch)
        else:
            positional.append(arg)
    return flags, positional


def parse_flags_strict(args, known_flags=""):
    """Like parse_flags but exits with code 2 on unknown flags."""
    flags = set()
    positional = []
    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if known_flags and ch not in known_flags:
                    print(f"{sys.argv[0] if sys.argv else 'cmd'}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
                flags.add(ch)
        else:
            positional.append(arg)
    return flags, positional


def expand_globs(targets):
    """Expand glob patterns in a list of file targets."""
    expanded = []
    for t in targets:
        matches = glob_mod.glob(t)
        if matches:
            expanded.extend(matches)
        else:
            expanded.append(t)
    return expanded


def read_input(files, stdin_text=""):
    """Read content from file list or stdin. Returns list of lines."""
    lines = []
    if not files:
        # Read from stdin
        if stdin_text:
            return stdin_text.splitlines(keepends=True)
        return sys.stdin.read().splitlines(keepends=True)
    for f in files:
        if f == "-":
            if stdin_text:
                lines.extend(stdin_text.splitlines(keepends=True))
            else:
                lines.extend(sys.stdin.read().splitlines(keepends=True))
        elif not os.path.exists(f):
            print(f"{sys.argv[0] if sys.argv else 'cmd'}: {f}: No such file or directory", file=sys.stderr)
        elif os.path.isdir(f):
            print(f"{sys.argv[0] if sys.argv else 'cmd'}: {f}: Is a directory", file=sys.stderr)
        else:
            with open(f, "r", encoding="utf-8", errors="replace") as handle:
                lines.extend(handle.readlines())
    return lines


def read_input_raw(files, stdin_bytes=b""):
    """Read raw bytes from file list or stdin."""
    if not files:
        if stdin_bytes:
            return stdin_bytes
        return sys.stdin.buffer.read()
    data = bytearray()
    for f in files:
        if f == "-":
            if stdin_bytes:
                data.extend(stdin_bytes)
            else:
                data.extend(sys.stdin.buffer.read())
        elif not os.path.exists(f):
            print(f"{sys.argv[0] if sys.argv else 'cmd'}: {f}: No such file or directory", file=sys.stderr)
        else:
            with open(f, "rb") as handle:
                data.extend(handle.read())
    return bytes(data)


def print_help(prog, description, options):
    """Print a standard help message."""
    print(f"Usage: {prog} [OPTION]... {description}")
    for flag, desc in options:
        print(f"  {flag:<10} {desc}")
    print(f"      --help     display this help and exit")
    print(f"      --version  output version information and exit")


def resolve_path(path):
    """Resolve a path, expanding ~ to HOME."""
    if path.startswith("~"):
        home = os.environ.get("HOME", "/home/user")
        if path == "~":
            return home
        if path.startswith("~/"):
            return os.path.join(home, path[2:])
    return os.path.abspath(path)


def human_size(size, base=1024):
    """Format bytes as human-readable string."""
    units = ["B", "K", "M", "G", "T", "P"] if base == 1024 else ["B", "KB", "MB", "GB", "TB"]
    for unit in units:
        if abs(size) < base:
            return f"{size:.1f}{unit}"
        size /= base
    return f"{size:.1f}{units[-1]}"
