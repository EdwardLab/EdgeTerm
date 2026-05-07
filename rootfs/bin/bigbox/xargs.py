"""
xargs — build and execute commands from stdin.
Usage: xargs [OPTION]... [COMMAND [ARGS...]]
"""
import sys
import os
import subprocess
import shlex


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: xargs [OPTION]... [COMMAND [ARGS...]]")
        print("  -n MAX-ARGS    max arguments per command line")
        print("  -I REPLSTR     replace string in arguments")
        print("  -0             input items are null-terminated")
        print("  -d DELIM       input delimiter")
        print("  -P MAX-PROCS   max parallel processes")
        print("  -p             prompt before running each command")
        print("  -t             print command before executing")
        print("  -r             no run if empty input")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    max_args = None
    replace_str = None
    null_terminated = False
    delimiter = None
    max_procs = 1
    prompt = False
    print_command = False
    no_run_if_empty = False
    command = ["echo"]
    command_has_args = False

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-") and not arg.startswith("--"):
            if arg == "-":
                i += 1
                continue
            for j, ch in enumerate(arg[1:], 1):
                if ch == 'n':
                    # Next arg
                    if j < len(arg) - 1:
                        val = arg[j+1:]
                        max_args = parse_integer(val)
                        if max_args is None:
                            print(f"xargs: invalid number '{val}'", file=sys.stderr)
                            sys.exit(2)
                        break
                    else:
                        i += 1
                        if i < len(args):
                            val = args[i]
                            max_args = parse_integer(val)
                            if max_args is None:
                                print(f"xargs: invalid number '{val}'", file=sys.stderr)
                                sys.exit(2)
                elif ch == 'I':
                    if j < len(arg) - 1:
                        replace_str = arg[j+1:]
                        break
                    i += 1
                    if i < len(args):
                        replace_str = args[i]
                elif ch == '0':
                    null_terminated = True
                elif ch == 'd':
                    if j < len(arg) - 1:
                        delimiter = arg[j+1:]
                        break
                    i += 1
                    if i < len(args):
                        delimiter = args[i]
                elif ch == 'P':
                    if j < len(arg) - 1:
                        val = arg[j+1:]
                        max_procs = parse_integer(val)
                        if max_procs is None:
                            max_procs = 1
                        break
                    i += 1
                    if i < len(args):
                        max_procs = parse_integer(args[i])
                        if max_procs is None:
                            max_procs = 1
                elif ch == 'p':
                    prompt = True
                elif ch == 't':
                    print_command = True
                elif ch == 'r':
                    no_run_if_empty = True
                else:
                    print(f"xargs: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        elif arg == "--":
            i += 1
            command = args[i:] if i < len(args) else ["echo"]
            break
        else:
            command = args[i:]
            break

    # Read input items
    if null_terminated:
        raw = sys.stdin.buffer.read()
        items = raw.split(b"\x00")
        items = [item.decode("utf-8", errors="replace") for item in items if item]
    elif delimiter:
        raw = sys.stdin.read()
        items = raw.split(delimiter)
        items = [item.strip() for item in items if item.strip()]
    else:
        items = []
        for line in sys.stdin:
            line = line.strip()
            if line:
                # Split each line into words (like standard xargs)
                items.extend(line.split())

    if not items:
        if no_run_if_empty:
            sys.exit(0)
        return

    # Execute command with items as arguments
    if max_args:
        for chunk in chunk_list(items, max_args):
            execute_command(command, chunk, replace_str, prompt, print_command)
    else:
        execute_command(command, items, replace_str, prompt, print_command)


def parse_integer(s):
    """Parse an integer, returning None on failure."""
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


def chunk_list(items, n):
    """Split a list into chunks of size n."""
    for i in range(0, len(items), n):
        yield items[i:i + n]


def execute_command(cmd_template, items, replace_str, prompt_user, print_cmd):
    """Execute a command with the given items as arguments."""
    if replace_str is not None:
        # Replace each occurrence of replace_str with items
        args = []
        for arg in cmd_template:
            if replace_str in arg:
                # Replace with all items joined
                args.append(arg.replace(replace_str, " ".join(items)))
            else:
                args.append(arg)
    else:
        args = list(cmd_template) + items

    if print_cmd:
        print(" ".join(shlex.quote(a) for a in args), file=sys.stderr)

    if prompt_user:
        print(f"?  {' '.join(shlex.quote(a) for a in args)}? ", end="", file=sys.stderr)
        try:
            response = sys.stdin.readline().strip().lower()
        except EOFError:
            response = "n"
        if response not in ("y", "yes"):
            return

    try:
        subprocess.run(args)
    except FileNotFoundError:
        print(f"xargs: {args[0]}: No such file or directory", file=sys.stderr)
        sys.exit(127)
    except Exception as e:
        print(f"xargs: {e}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
