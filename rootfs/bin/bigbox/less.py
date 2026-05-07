import os
import sys

VERSION = "less (EdgeTerm bigbox) 1.0"


def print_help():
    print("Usage: less [OPTION]... [FILE]...")
    print("File pager (display file contents).")
    print("")
    print("  -N            print line numbers")
    print("  -i            ignore case in search (no-op in this simple version)")
    print("  -S            chop long lines (don't wrap)")
    print("  -F            quit if one screen (no-op, always prints all)")
    print("  -R            output raw control characters")
    print("  -e            quit at end of file (no-op)")
    print("")
    print("      --help    display this help and exit")
    print("      --version output version information and exit")


def get_terminal_height():
    """Get terminal height from environment or default."""
    try:
        lines = int(os.environ.get("LINES", 0))
        if lines > 0:
            return lines
    except (ValueError, TypeError):
        pass
    try:
        import shutil
        rows, _ = shutil.get_terminal_size(fallback=(80, 24))
        return rows
    except Exception:
        pass
    return 24


def get_terminal_width():
    """Get terminal width from environment or default."""
    try:
        import shutil
        cols, _ = shutil.get_terminal_size(fallback=(80, 24))
        return cols
    except Exception:
        pass
    return 80


def read_file_content(filepath):
    """Read file content, return list of lines."""
    try:
        if filepath == "-":
            return sys.stdin.read().splitlines(keepends=True)
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            return f.readlines()
    except FileNotFoundError:
        print(f"less: {filepath}: No such file or directory", file=sys.stderr)
        return None
    except IsADirectoryError:
        print(f"less: {filepath}: Is a directory", file=sys.stderr)
        return None
    except PermissionError:
        print(f"less: {filepath}: Permission denied", file=sys.stderr)
        return None
    except Exception as e:
        print(f"less: {filepath}: {e}", file=sys.stderr)
        return None


def display_pages(lines, line_numbers=False, chop_long_lines=False):
    """Display content page by page."""
    if not lines:
        return

    term_height = get_terminal_height()
    term_width = get_terminal_width()
    page_size = term_height - 2  # Leave room for prompt

    if page_size < 1:
        page_size = term_height

    total_lines = len(lines)
    start = 0

    while start < total_lines:
        end = min(start + page_size, total_lines)

        for i in range(start, end):
            line = lines[i].rstrip("\n").rstrip("\r")
            if line_numbers:
                # Pad line number
                num_width = len(str(total_lines))
                prefix = f"{i + 1:>{num_width}} "
                line = prefix + line

            if chop_long_lines and len(line) > term_width:
                line = line[:term_width]

            sys.stdout.write(line + "\n")

        start = end

        if start < total_lines:
            remaining = total_lines - start
            percent = (start * 100) // total_lines
            prompt = f"--More--({percent}%)"

            # Write to stderr so it doesn't get captured in redirects
            print(prompt, file=sys.stderr, end="\r")
            try:
                # Read a single character (non-blocking approach not available,
                # so just wait for any input)
                sys.stdin.read(1)
            except (EOFError, KeyboardInterrupt):
                break
            finally:
                # Clear the prompt
                print(" " * len(prompt), file=sys.stderr, end="\r")


def main(args):
    line_numbers = False
    ignore_case = False
    chop_long_lines = False
    quit_one_screen = False
    raw_control = False
    quit_at_eof = False
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
                if ch == "N":
                    line_numbers = True
                elif ch == "i":
                    ignore_case = True
                elif ch == "S":
                    chop_long_lines = True
                elif ch == "F":
                    quit_one_screen = True
                elif ch == "R":
                    raw_control = True
                elif ch == "e":
                    quit_at_eof = True
                else:
                    print(f"less: invalid option -- '{ch}'", file=sys.stderr)
                    print("Try 'less --help' for more information.", file=sys.stderr)
                    sys.exit(1)
        else:
            files.append(arg)
        i += 1

    if not files:
        files.append("-")

    all_lines = []
    for f in files:
        content = read_file_content(f)
        if content is None:
            continue

        if len(files) > 1:
            # Show filename header
            all_lines.append(f"\n<<< {f} >>>\n")

        all_lines.extend(content)

    if not all_lines:
        return

    display_pages(all_lines, line_numbers=line_numbers, chop_long_lines=chop_long_lines)
