"""
nproc — print the number of processing units available.
Usage: nproc [OPTION]...
"""
import sys

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"nproc (edgeos-bigbox) {VERSION}")
        return

    # Parse --ignore=N
    ignore = 0
    flag_all = "--all" in args

    filtered_args = [a for a in args if a not in ("--help", "--version", "--all")]
    for a in filtered_args:
        if a.startswith("--ignore="):
            try:
                ignore = int(a.split("=", 1)[1])
            except ValueError:
                print(f"nproc: invalid number '{a.split('=', 1)[1]}'", file=sys.stderr)
                sys.exit(2)
        elif a.startswith("-") and len(a) > 1:
            print(f"nproc: invalid option -- '{a[1:]}'", file=sys.stderr)
            sys.exit(2)

    # Get CPU count from various sources
    count = _get_cpu_count()

    if not flag_all and ignore > 0:
        count = max(1, count - ignore)

    print(count)


def _get_cpu_count():
    """Try to get CPU count from JS or /proc/cpuinfo."""
    # Try JavaScript navigator.hardwareConcurrency
    try:
        import js
        if hasattr(js, "navigator") and hasattr(js.navigator, "hardwareConcurrency"):
            return int(js.navigator.hardwareConcurrency)
    except Exception:
        pass

    # Try /proc/cpuinfo
    try:
        count = 0
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("processor"):
                    count += 1
        if count > 0:
            return count
    except (FileNotFoundError, IOError):
        pass

    # Fallback to os.cpu_count()
    try:
        import os
        c = os.cpu_count()
        if c and c > 0:
            return c
    except Exception:
        pass

    # Default fallback
    return 1


def _help():
    print("Usage: nproc [OPTION]...")
    print("Print the number of processing units available to the current process.")
    print()
    print("      --all       print the number of installed processors")
    print("      --ignore=N  if possible, exclude N processing units")
    print("      --help      display this help and exit")
    print("      --version   output version information and exit")
