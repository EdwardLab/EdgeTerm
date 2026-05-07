"""
cal — display a calendar.
Usage: cal [[MONTH] YEAR]
"""
import sys
from datetime import datetime, timedelta, date

VERSION = "1.0"

MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
]


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"cal (edgeos-bigbox) {VERSION}")
        return

    flags, positional = _parse_args(args)

    flag_y = "y" in flags   # whole year
    flag_3 = "3" in flags   # three months (prev, current, next)
    flag_j = "j" in flags   # Julian day numbers (not fully supported, just shows day of year)

    now = datetime.now()
    if len(positional) == 0:
        # No args: show current month
        month = now.month
        year = now.year
        if flag_y:
            _print_year(year, flag_j)
            return
        if flag_3:
            _print_three_months(month, year, flag_j)
            return
        _print_month(month, year, flag_j)
    elif len(positional) == 1:
        if flag_y:
            # cal -y 2026 — "y" flag is already set, but extra arg is year
            try:
                year = int(positional[0])
                _print_year(year, flag_j)
                return
            except ValueError:
                print(f"cal: invalid year '{positional[0]}'", file=sys.stderr)
                sys.exit(2)
        else:
            # Single arg: could be year or month
            val = positional[0]
            if len(val) <= 2 and _is_int(val):
                # Probably a month — show that month of current year
                month = int(val)
                year = now.year
                if month < 1 or month > 12:
                    print(f"cal: invalid month '{val}'", file=sys.stderr)
                    sys.exit(2)
                if flag_3:
                    _print_three_months(month, year, flag_j)
                else:
                    _print_month(month, year, flag_j)
            else:
                Year = int(val)
                if flag_3:
                    _print_three_months(now.month, Year, flag_j)
                elif flag_y:
                    _print_year(Year, flag_j)
                else:
                    _print_year(Year, flag_j)
    elif len(positional) == 2:
        # cal MONTH YEAR
        try:
            month = int(positional[0])
            year = int(positional[1])
        except ValueError:
            print("cal: invalid arguments", file=sys.stderr)
            sys.exit(2)
        if month < 1 or month > 12:
            print(f"cal: invalid month '{month}'", file=sys.stderr)
            sys.exit(2)
        if flag_3:
            _print_three_months(month, year, flag_j)
        else:
            _print_month(month, year, flag_j)
    else:
        print("cal: too many arguments", file=sys.stderr)
        sys.exit(2)


def _parse_args(args):
    flags = set()
    positional = []
    for a in args:
        if a.startswith("--"):
            # skip known long options
            continue
        if a.startswith("-") and len(a) > 1:
            for ch in a[1:]:
                flags.add(ch)
        else:
            positional.append(a)
    return flags, positional


def _is_int(s):
    try:
        int(s)
        return True
    except ValueError:
        return False


def _first_weekday_of_month(year, month):
    """Return weekday of the 1st of month. Monday=0 .. Sunday=6."""
    return date(year, month, 1).weekday()


def _days_in_month(year, month):
    if month == 12:
        return (date(year + 1, 1, 1) - date(year, month, 1)).days
    return (date(year, month + 1, 1) - date(year, month, 1)).days


def _is_leap(year):
    return (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)


def _print_month(month, year, flag_j=False):
    # Header line: month name + year, centered
    header = f"{MONTH_NAMES[month]} {year}"
    print(f"{header:^20}")
    print("Mo Tu We Th Fr Sa Su")

    first_wd = _first_weekday_of_month(year, month)
    days = _days_in_month(year, month)

    # Build lines
    lines = []
    # First row: leading spaces + days
    row = ["   "] * first_wd
    for d in range(1, days + 1):
        if flag_j:
            # Day of year
            doy = date(year, month, d).timetuple().tm_yday
            row.append(f"{doy:3}")
        else:
            row.append(f"{d:3}")
        if len(row) == 7:
            lines.append("".join(row))
            row = []
    if row:
        lines.append("".join(row))

    for line in lines:
        print(line)


def _print_three_months(month, year, flag_j=False):
    """Print three months side by side: prev, current, next."""
    prev_month = month - 1 if month > 1 else 12
    prev_year = year if month > 1 else year - 1
    next_month = month + 1 if month < 12 else 1
    next_year = year if month < 12 else year + 1

    months_data = [
        (prev_month, prev_year),
        (month, year),
        (next_month, next_year),
    ]

    headers = []
    calendars = []
    for m, y in months_data:
        headers.append(f"{MONTH_NAMES[m]} {y}")
        cal_lines = _build_month_lines(m, y, flag_j)
        calendars.append(cal_lines)

    # Print header row
    print(f"{headers[0]:^20}  {headers[1]:^20}  {headers[2]:^20}")
    # Print day-of-week row
    print(f"{'Mo Tu We Th Fr Sa Su':^20}  {'Mo Tu We Th Fr Sa Su':^20}  {'Mo Tu We Th Fr Sa Su':^20}")

    max_lines = max(len(c) for c in calendars)
    for i in range(max_lines):
        parts = []
        for c in calendars:
            if i < len(c):
                parts.append(f"{c[i]:20}")
            else:
                parts.append(" " * 20)
        print("  ".join(parts))


def _build_month_lines(month, year, flag_j):
    """Build a list of strings, one per week row."""
    first_wd = _first_weekday_of_month(year, month)
    days = _days_in_month(year, month)
    lines = []
    row = ["   "] * first_wd
    for d in range(1, days + 1):
        if flag_j:
            doy = date(year, month, d).timetuple().tm_yday
            row.append(f"{doy:3}")
        else:
            row.append(f"{d:3}")
        if len(row) == 7:
            lines.append("".join(row))
            row = []
    if row:
        lines.append("".join(row))
    return lines


def _print_year(year, flag_j=False):
    print(f"{year:^64}")
    print()
    for q in range(0, 12, 3):
        quarter_months = [q + 1, q + 2, q + 3]
        headers = [f"{MONTH_NAMES[m]} {year}" for m in quarter_months]
        print(f"{headers[0]:^20}  {headers[1]:^20}  {headers[2]:^20}")
        print(f"{'Mo Tu We Th Fr Sa Su':^20}  {'Mo Tu We Th Fr Sa Su':^20}  {'Mo Tu We Th Fr Sa Su':^20}")
        calendars = [_build_month_lines(m, year, flag_j) for m in quarter_months]
        max_lines = max(len(c) for c in calendars)
        for i in range(max_lines):
            parts = []
            for c in calendars:
                if i < len(c):
                    parts.append(f"{c[i]:20}")
                else:
                    parts.append(" " * 20)
            print("  ".join(parts))
        print()


def _help():
    print("Usage: cal [OPTION]... [[MONTH] YEAR]")
    print("Display a calendar.")
    print()
    print("  -1            display single month (default)")
    print("  -3            display previous, current, and next months")
    print("  -s            Sunday as first day of week (not supported)")
    print("  -m            Monday as first day of week (default)")
    print("  -j            display Julian day numbers (day of year)")
    print("  -y            display a full year calendar")
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
