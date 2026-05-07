import re
import sys
import time
import bigbox_utils


VERSION = "sleep (EdgeTerm bigbox)"


def parse_duration(arg):
    """Parse sleep duration string like 5, 5s, 5m, 5h, 5d. Returns seconds."""
    match = re.match(r'^(\d+(?:\.\d+)?)([smhd]?)$', arg)
    if not match:
        print(f"sleep: invalid time interval '{arg}'", file=sys.stderr)
        sys.exit(1)

    value = float(match.group(1))
    unit = match.group(2) or 's'

    multipliers = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}
    return value * multipliers[unit]


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "sleep",
                "NUMBER[smhd]...",
                [("NUMBER[smhd]", "sleep for NUMBER seconds; s=seconds, m=minutes, h=hours, d=days"),
                 ("", "If multiple numbers given, sleep for the sum of their durations")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

    if not args:
        print("sleep: missing operand", file=sys.stderr)
        print("Usage: sleep NUMBER[smhd]...", file=sys.stderr)
        sys.exit(1)

    total = 0.0
    for arg in args:
        total += parse_duration(arg)

    try:
        time.sleep(total)
    except KeyboardInterrupt:
        sys.exit(0)
