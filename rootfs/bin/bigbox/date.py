"""
date — print or set the system date and time.
Usage: date [-u] [-R] [-I[FORMAT]] [+FORMAT]
"""
import sys
from datetime import datetime, timezone

VERSION = "1.0"


def main(args):
    # === Help/version ===
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"date (edgeos-bigbox) {VERSION}")
        return

    # === Parse flags ===
    flag_u = "-u" in args         # use UTC
    flag_R = "-R" in args         # RFC 5322 (RFC 2822) format
    flag_I = "-I" in args         # ISO 8601 date (can have optional arg like -Idate)
    fmt_flag = None

    _args = list(args)
    for a in _args:
        if a.startswith("-I"):
            flag_I = True

    # Look for +FORMAT argument
    format_str = None
    leftovers = []
    for a in _args:
        if a.startswith("+"):
            format_str = a[1:]  # strip leading "+"
        elif a == "--help" or a == "--version":
            pass
        elif a == "-u" or a == "-R" or a == "-I":
            pass
        elif a.startswith("-I") and len(a) > 2:
            # -I[FMT] like -Idate or -Iseconds
            fmt = a[2:]
            if fmt in ("date", "hours", "minutes", "seconds", "ns"):
                flag_I = True
            else:
                print(f"date: invalid option -- '{a}'", file=sys.stderr)
                sys.exit(2)
        else:
            leftovers.append(a)

    if leftovers:
        print(f"date: extra operand '{leftovers[0]}'", file=sys.stderr)
        print("Try 'date --help' for more information.", file=sys.stderr)
        sys.exit(2)

    # Determine the timezone
    if flag_u:
        now = datetime.now(timezone.utc)
    else:
        now = datetime.now().astimezone()

    # Format output
    if format_str:
        print(now.strftime(format_str))
    elif flag_R:
        # RFC 5322 format: e.g. "Mon, 04 May 2026 14:30:00 +0000"
        print(now.strftime("%a, %d %b %Y %H:%M:%S %z"))
    elif flag_I:
        # ISO 8601 date (basic)
        print(now.strftime("%Y-%m-%d"))
    else:
        # Default: "Mon May  4 14:30:00 EDT 2026"
        print(now.strftime("%a %b %d %H:%M:%S %Z %Y"))


def _help():
    print("Usage: date [OPTION]... [+FORMAT]")
    print("  or:  date [-u]... [MMDDhhmm[[CC]YY][.ss]]")
    print("Display or set the system date and time.")
    print()
    print("  -d, --date=STRING      display time described by STRING, not 'now'")
    print("  -I[FMT]                output date/time in ISO 8601 format")
    print("  -R                     output date and time in RFC 5322 format")
    print("  -u, --utc              print or set Coordinated Universal Time")
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
    print()
    print("FORMAT controls the output. Interpreted sequences include:")
    print("  %%Y   year                          %%m   month (01-12)")
    print("  %%d   day of month (01-31)          %%H   hour (00-23)")
    print("  %%M   minute (00-59)                %%S   second (00-60)")
    print("  %%A   full weekday name             %%B   full month name")
    print("  %%u   day of week (1-7)             %%j   day of year (001-366)")
    print("  %%s   seconds since 1970-01-01      %%z   timezone offset")
    print("  %%Z   timezone abbreviation")
