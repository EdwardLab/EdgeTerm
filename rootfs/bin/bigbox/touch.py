import calendar
import glob as glob_mod
import os
import sys
import time


def parse_datetime_stamp(stamp):
    """Parse [[CC]YY]MMDDhhmm[.ss] timestamp format."""
    stamp = stamp.strip()
    ss = 0
    if "." in stamp:
        stamp, frac = stamp.split(".", 1)
        ss = int(frac[:2].ljust(2, "0"))
    if len(stamp) == 8:
        # MMDDhhmm
        month = int(stamp[0:2])
        day = int(stamp[2:4])
        hour = int(stamp[4:6])
        minute = int(stamp[6:8])
        year = time.localtime().tm_year
    elif len(stamp) == 10:
        # YYMMDDhhmm
        year = int(stamp[0:2]) + 2000
        month = int(stamp[2:4])
        day = int(stamp[4:6])
        hour = int(stamp[6:8])
        minute = int(stamp[8:10])
    elif len(stamp) == 12:
        # CCYYMMDDhhmm
        year = int(stamp[0:4])
        month = int(stamp[4:6])
        day = int(stamp[6:8])
        hour = int(stamp[8:10])
        minute = int(stamp[10:12])
    else:
        raise ValueError(f"invalid date format '{stamp}'")
    return calendar.timegm((year, month, day, hour, minute, ss))


def parse_flags(args):
    """Parse flags for touch."""
    no_create = False    # -c: do not create any files
    access_only = False  # -a: change only the access time
    mod_only = False     # -m: change only the modification time
    timestamp = None     # -t STAMP: use [[CC]YY]MMDDhhmm[.ss]
    ref_file = None      # -r FILE: use this file's times
    date_string = None   # -d STRING: parse date string
    targets = []
    i = 0

    while i < len(args):
        arg = args[i]
        if arg == "--":
            i += 1
            targets.extend(args[i:])
            break
        if arg.startswith("-") and not arg.startswith("--"):
            flags = arg[1:]
            if "t" in flags:
                # -t takes next argument
                if flags == "t" or flags.endswith("t"):
                    i += 1
                    if i >= len(args):
                        print("touch: option requires an argument -- 't'", file=sys.stderr)
                        sys.exit(1)
                    timestamp = args[i]
                    flags = flags.replace("t", "")
                else:
                    # Attached: -t202501011200
                    idx = flags.index("t")
                    timestamp = flags[idx + 1:]
                    flags = flags[:idx]
            for ch in flags:
                if ch == "c":
                    no_create = True
                elif ch == "a":
                    access_only = True
                elif ch == "m":
                    mod_only = True
                elif ch == "r":
                    i += 1
                    if i >= len(args):
                        print("touch: option requires an argument -- 'r'", file=sys.stderr)
                        sys.exit(1)
                    ref_file = args[i]
                elif ch == "d":
                    i += 1
                    if i >= len(args):
                        print("touch: option requires an argument -- 'd'", file=sys.stderr)
                        sys.exit(1)
                    date_string = args[i]
                else:
                    print(f"touch: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: touch [-acm] [-r FILE] [-t STAMP] [-d DATE] <file...>", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: touch [-acm] [-r FILE] [-t STAMP] [-d DATE] <file...>")
            print("  -a    change only the access time")
            print("  -c    do not create any files")
            print("  -m    change only the modification time")
            print("  -r    use this file's times instead of current time")
            print("  -t    use [[CC]YY]MMDDhhmm[.ss] instead of current time")
            print("  -d    parse STRING and use it instead of current time")
            sys.exit(0)
        elif arg == "--version":
            print("touch (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    return no_create, access_only, mod_only, timestamp, ref_file, date_string, targets


def main(args):
    (no_create, access_only, mod_only, timestamp,
     ref_file, date_string, targets) = parse_flags(args)

    if not targets:
        print("touch: missing file operand", file=sys.stderr)
        print("Usage: touch [-acm] [-r FILE] [-t STAMP] <file...>", file=sys.stderr)
        sys.exit(1)

    # Determine the target time
    if timestamp is not None:
        try:
            target_time = parse_datetime_stamp(timestamp)
        except ValueError as e:
            print(f"touch: {e}", file=sys.stderr)
            sys.exit(1)
    elif ref_file is not None:
        if not os.path.exists(ref_file):
            print(f"touch: cannot stat '{ref_file}': No such file or directory", file=sys.stderr)
            sys.exit(1)
        target_time = os.stat(ref_file).st_mtime
    elif date_string is not None:
        # Simple date parsing — try common formats
        # For EdgeTerm, support ISO-like strings: YYYY-MM-DD [HH:MM:SS]
        print(f"touch: warning: -d parsing is limited; using current time", file=sys.stderr)
        target_time = time.time()
    else:
        target_time = time.time()

    # Expand globs
    expanded = []
    for t in targets:
        matches = glob_mod.glob(t)
        if matches:
            expanded.extend(matches)
        else:
            expanded.append(t)

    exit_code = 0
    for path in expanded:
        if not os.path.exists(path):
            if no_create:
                continue
            # Create the file
            try:
                os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
                with open(path, "a"):
                    pass
            except OSError as e:
                print(f"touch: cannot create '{path}': {e}", file=sys.stderr)
                exit_code = 1
                continue

        # Update timestamps
        try:
            st = os.stat(path)
            if access_only:
                os.utime(path, (target_time, st.st_mtime))
            elif mod_only:
                os.utime(path, (st.st_atime, target_time))
            else:
                os.utime(path, (target_time, target_time))
        except OSError as e:
            print(f"touch: cannot touch '{path}': {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
