"""
mktemp — create a temporary file or directory.
Usage: mktemp [-d] [-p DIR] [TEMPLATE]
"""
import sys
import os
import tempfile
import string

VERSION = "1.0"

TEMP_DIR_VAR = "TMPDIR"
DEFAULT_TEMP_DIR = "/tmp"
DEFAULT_TEMPLATE = "tmp.XXXXXXXXXX"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"mktemp (edgeos-bigbox) {VERSION}")
        return

    flag_d = "-d" in args           # create directory instead of file
    flag_u = "-u" in args           # dry-run (don't create, just print name)
    flag_quiet = "-q" in args        # suppress error messages

    # Parse -p DIR (optional temp directory)
    tmpdir = None
    args_copy = list(args)
    for i, a in enumerate(args_copy):
        if a == "-p" and i + 1 < len(args_copy):
            tmpdir = args_copy[i + 1]
            break

    # Parse template from positional args (skip flags)
    template = None
    for a in args_copy:
        if a.startswith("-"):
            continue
        if a == tmpdir:
            # This is the argument to -p, skip
            continue
        if template is None:
            template = a

    if template is None:
        template = DEFAULT_TEMPLATE

    # Determine the suffix and X's in template
    suffix = ""
    x_count = 0
    if "X" in template:
        # Find the last run of X's
        last_x_start = template.rfind("X")
        x_count = 0
        i = last_x_start
        while i < len(template) and template[i] == "X":
            x_count += 1
            i += 1
        suffix = template[last_x_start + x_count:]
        template_prefix = template[:last_x_start]
        # Must have at least 3 X's
        if x_count < 3:
            print(f"mktemp: too few X's in template '{template}'", file=sys.stderr)
            sys.exit(2)
    else:
        template_prefix = template
        x_count = 10

    # Determine directory
    if tmpdir is None:
        tmpdir = os.environ.get(TEMP_DIR_VAR, DEFAULT_TEMP_DIR)

    # Ensure the directory exists
    if not flag_u:
        os.makedirs(tmpdir, exist_ok=True)

    try:
        if flag_u:
            # Dry-run: just print what would be created
            # Generate a random name
            import random
            random_chars = "".join(random.choices(string.ascii_letters + string.digits, k=x_count))
            name = template_prefix + random_chars + suffix
            result = os.path.join(tmpdir, name)
            print(result)
        elif flag_d:
            # Create temporary directory
            result = tempfile.mkdtemp(suffix=suffix, prefix=template_prefix, dir=tmpdir)
            print(result)
        else:
            # Create temporary file
            fd, result = tempfile.mkstemp(suffix=suffix, prefix=template_prefix, dir=tmpdir)
            os.close(fd)
            print(result)
    except FileNotFoundError:
        print(f"mktemp: {tmpdir}: No such file or directory", file=sys.stderr)
        sys.exit(2)
    except PermissionError:
        print(f"mktemp: {tmpdir}: Permission denied", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        if not flag_quiet:
            print(f"mktemp: {e}", file=sys.stderr)
        sys.exit(2)


def _help():
    print("Usage: mktemp [OPTION]... [TEMPLATE]")
    print("Create a temporary file or directory.")
    print()
    print("  -d               create a directory, not a file")
    print("  -u               do not create anything; merely print a name (unsafe)")
    print("  -q               fail silently on errors")
    print("  -p DIR           use DIR as the temporary directory")
    print("      --help       display this help and exit")
    print("      --version    output version information and exit")
    print()
    print("TEMPLATE must contain at least 3 'X' characters (default: tmp.XXXXXXXXXX)")
