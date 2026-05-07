import os
import shutil
import sys

VERSION = "more (EdgeTerm bigbox) 1.0"


def print_help():
    print("Usage: more [OPTION]... [FILE]...")
    print("File perusal filter for viewing text.")
    print("")
    print("  -d            prompt with '[Press space to continue, 'q' to quit.]'")
    print("  -c            clear screen before displaying each page")
    print("  -NUM          specify the number of lines per screen")
    print("")
    print("      --help    display this help and exit")
    print("      --version output version information and exit")


def get_terminal_height():
    """Get terminal height."""
    try:
        lines = int(os.environ.get("LINES", 0))
        if lines > 0:
            return lines
    except (ValueError, TypeError):
        pass
    try:
        _, rows = shutil.get_terminal_size(fallback=(80, 24))
        return rows
    except Exception:
        pass
    return 24


def clear_screen():
    """Clear the terminal screen."""
    # Use ANSI escape codes
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def read_file_content(filepath):
    """Read file content, return list of lines."""
    try:
        if filepath == "-":
            return sys.stdin.read().splitlines(keepends=True)
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            return f.readlines()
    except FileNotFoundError:
        print(f"more: {filepath}: No such file or directory", file=sys.stderr)
        return None
    except IsADirectoryError:
        print(f"more: {filepath}: Is a directory", file=sys.stderr)
        return None
    except PermissionError:
        print(f"more: {filepath}: Permission denied", file=sys.stderr)
        return None
    except Exception as e:
        print(f"more: {filepath}: {e}", file=sys.stderr)
        return None


def display_pages(lines, page_size=0, show_prompt=True, clear_between=False):
    """Display content page by page."""
    if not lines:
        return

    if page_size <= 0:
        term_height = get_terminal_height()
        page_size = term_height - 2  # Leave room for prompt line

    if page_size < 1:
        page_size = 24

    total_lines = len(lines)
    start = 0

    while start < total_lines:
        if clear_between and start > 0:
            clear_screen()

        end = min(start + page_size, total_lines)

        for i in range(start, end):
            line = lines[i].rstrip("\n").rstrip("\r")
            sys.stdout.write(line + "\n")

        sys.stdout.flush()
        start = end

        if start < total_lines:
            remaining = total_lines - start
            percent = (start * 100) // total_lines

            if show_prompt:
                prompt = f"--More--({percent}%)"
            else:
                prompt = f"--More--({percent}%)"

            # Display prompt on stderr
            print(prompt, file=sys.stderr, end="\r")
            try:
                response = sys.stdin.read(1)
                if response and response.lower() == "q":
                    # Clear prompt and exit
                    print(" " * len(prompt), file=sys.stderr, end="\r")
                    break
            except (EOFError, KeyboardInterrupt):
                break
            finally:
                print(" " * len(prompt), file=sys.stderr, end="\r")


def main(args):
    custom_lines = 0
    show_d_prompt = False
    clear_between = False
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
                if ch == "d":
                    show_d_prompt = True
                elif ch == "c":
                    clear_between = True
                elif ch.isdigit():
                    # Handle -NUM
                    # Re-read the full arg to get the number
                    try:
                        custom_lines = int(arg[1:])
                    except ValueError:
                        print(f"more: invalid number '{arg[1:]}'", file=sys.stderr)
                        sys.exit(1)
                    break  # Don't process remaining chars in this arg
                else:
                    print(f"more: invalid option -- '{ch}'", file=sys.stderr)
                    print("Try 'more --help' for more information.", file=sys.stderr)
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
            all_lines.append(f"\n<<< {f} >>>\n")

        all_lines.extend(content)

    if not all_lines:
        return

    display_pages(
        all_lines,
        page_size=custom_lines,
        show_prompt=show_d_prompt,
        clear_between=clear_between
    )
