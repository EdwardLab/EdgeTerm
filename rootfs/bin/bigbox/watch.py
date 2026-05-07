"""
watch — execute program periodically.
Usage: watch [OPTION]... COMMAND [ARG]...
"""
import sys
import os
import time
import subprocess
import shlex


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        print("Usage: watch [OPTION]... COMMAND [ARG]...", file=sys.stderr)
        sys.exit(2)
    if args[0] == "--help":
        print("Usage: watch [OPTION]... COMMAND [ARG]...")
        print("  -n SECS    interval between executions (default 2)")
        print("  -d         highlight differences between consecutive updates")
        print("  -t         no title")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    interval = 2.0
    highlight = False
    no_title = False
    command = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-") and not arg.startswith("--"):
            if arg == "-":
                i += 1
                continue
            for ch in arg[1:]:
                if ch == 'n':
                    i += 1
                    if i < len(args):
                        try:
                            interval = float(args[i])
                        except ValueError:
                            print(f"watch: invalid interval '{args[i]}'", file=sys.stderr)
                            sys.exit(2)
                    else:
                        print("watch: option '-n' requires an argument", file=sys.stderr)
                        sys.exit(2)
                elif ch == 'd':
                    highlight = True
                elif ch == 't':
                    no_title = True
                else:
                    print(f"watch: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        elif arg == "--":
            i += 1
            command = args[i:]
            break
        else:
            command = args[i:]
            break

    if not command:
        print("watch: no command specified", file=sys.stderr)
        sys.exit(2)

    if interval < 0.1:
        interval = 0.1

    try:
        run_loop(command, interval, highlight, no_title)
    except KeyboardInterrupt:
        sys.exit(0)


def run_loop(command, interval, highlight, no_title):
    """Run the command in a loop."""
    previous_output = None

    while True:
        # Clear screen
        sys.stdout.write("\033[2J\033[H")
        sys.stdout.flush()

        current_time = time.strftime("%a %b %d %H:%M:%S %Y")

        if not no_title:
            cmd_str = " ".join(shlex.quote(c) for c in command)
            print(f"Every {interval:.1f}s: {cmd_str}")
            print()
            print(f"  [{current_time}]")
            print()

        # Run the command
        try:
            result = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=interval * 2,
            )
            output = result.stdout
        except subprocess.TimeoutExpired:
            output = "[command timed out]"
        except FileNotFoundError:
            print(f"watch: {command[0]}: No such file or directory", file=sys.stderr)
            sys.exit(2)
        except Exception as e:
            output = f"[error: {e}]"

        if highlight and previous_output is not None and output != previous_output:
            # Simple diff marking
            print_diff(output, previous_output)
        else:
            print(output, end="")

        previous_output = output

        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            break


def print_diff(new, old):
    """Print new output with changes indicated."""
    new_lines = new.splitlines(True)
    old_lines = old.splitlines(True)

    for i, line in enumerate(new_lines):
        if i < len(old_lines) and line != old_lines[i]:
            # Changed line - just print as-is for now
            sys.stdout.write("\033[7m" + line + "\033[0m")
        else:
            sys.stdout.write(line)


if __name__ == "__main__":
    main(sys.argv[1:])
