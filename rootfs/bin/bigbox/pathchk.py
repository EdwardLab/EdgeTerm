"""
pathchk — check pathname validity.
Usage: pathchk [-p] PATH...
"""
import sys
import os

VERSION = "1.0"

# POSIX portable filename character set
PORTABLE_CHARS = set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "abcdefghijklmnopqrstuvwxyz"
    "0123456789._-"
)

# Standard forbidden characters on most Unix systems
FORBIDDEN_CHARS = set("\x00/")  # null byte and slash in components (slash is OK for path separators)


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"pathchk (edgeos-bigbox) {VERSION}")
        return

    flag_p = "-p" in args   # check POSIX portability

    # Collect path arguments (skip flags)
    paths = []
    for a in args:
        if a.startswith("-"):
            continue
        paths.append(a)

    if not paths:
        print("pathchk: missing operand", file=sys.stderr)
        print("Try 'pathchk --help' for more information.", file=sys.stderr)
        sys.exit(2)

    exit_code = 0
    for path in paths:
        if not _check_path(path, flag_p):
            exit_code = 2

    sys.exit(exit_code)


def _check_path(path, portable):
    """Check a path for validity. Returns True if valid, False otherwise."""
    if not path:
        print(f"pathchk: empty pathname", file=sys.stderr)
        return False

    if not portable:
        # Basic check: no null bytes
        if "\x00" in path:
            print(f"pathchk: null byte found in path '{path}'", file=sys.stderr)
            return False

        # Check each component
        components = path.split("/")
        for i, comp in enumerate(components):
            if not comp and i < len(components) - 1:
                # Empty component (e.g., "//") is OK for root but warn
                if i < len(components) - 1:
                    pass
            if not comp:
                continue
            if comp == "." or comp == "..":
                continue
            if len(comp) > 255:
                print(f"pathchk: component too long in '{path}'", file=sys.stderr)
                return False
            # Check for forbidden characters in component (except slash which is separator)
            for ch in comp:
                if ch == "\x00":
                    print(f"pathchk: null byte in path '{path}'", file=sys.stderr)
                    return False
    else:
        # Strict POSIX portability check (-p)
        components = path.split("/")
        for i, comp in enumerate(components):
            if not comp and i < len(components) - 1:
                continue
            if not comp:
                continue
            if comp == "." or comp == "..":
                continue
            # POSIX portable filename char set
            for ch in comp:
                if ch not in PORTABLE_CHARS:
                    print(f"pathchk: non-portable character '{ch}' in path '{path}'", file=sys.stderr)
                    return False
            # Leading hyphen is a problem for many commands
            if comp.startswith("-"):
                print(f"pathchk: leading '-' in path component '{comp}'", file=sys.stderr)
                return False
            if len(comp) > 14:
                print(f"pathchk: component too long (>{14}) in '{comp}'", file=sys.stderr)
                return False

    # Check total path length
    if len(path) > 4096:
        print(f"pathchk: path too long (>4096 bytes) '{path}'", file=sys.stderr)
        return False

    return True


def _help():
    print("Usage: pathchk [-p] PATH...")
    print("Check pathname validity (portability).")
    print()
    print("  -p             check for most POSIX systems")
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
