"""
timeout — run command with time limit.
Usage: timeout [OPTION]... DURATION COMMAND [ARG]...
"""
import sys
import os
import time
import subprocess
import signal


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        print("Usage: timeout [OPTION]... DURATION COMMAND [ARG]...", file=sys.stderr)
        sys.exit(2)
    if args[0] == "--help":
        print("Usage: timeout [OPTION]... DURATION COMMAND [ARG]...")
        print("  -s SIGNAL         signal to send on timeout (default TERM)")
        print("  -k DURATION       kill signal after DURATION if still running")
        print("  --preserve-status  exit with status of command even on timeout")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    signal_name = "SIGTERM"
    kill_duration = None
    preserve_status = False
    duration_str = None
    command = []

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--preserve-status":
            preserve_status = True
            i += 1
        elif arg == "--":
            i += 1
            if duration_str is None:
                duration_str = args[i] if i < len(args) else None
                i += 1
            command = args[i:]
            break
        elif arg.startswith("-") and not arg.startswith("--"):
            for ch in arg[1:]:
                if ch == 's':
                    # Next arg is signal name/number
                    i += 1
                    if i < len(args):
                        signal_name = args[i]
                elif ch == 'k':
                    # Next arg is kill-after duration
                    i += 1
                    if i < len(args):
                        kill_duration = args[i]
                else:
                    print(f"timeout: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
            i += 1
        else:
            if duration_str is None:
                duration_str = arg
            else:
                command = args[i:]
                break
            i += 1

    if duration_str is None:
        print("timeout: missing duration", file=sys.stderr)
        sys.exit(2)

    duration_seconds = parse_duration(duration_str)
    if duration_seconds is None:
        print(f"timeout: invalid duration '{duration_str}'", file=sys.stderr)
        sys.exit(2)

    kill_seconds = None
    if kill_duration is not None:
        kill_seconds = parse_duration(kill_duration)
        if kill_seconds is None:
            print(f"timeout: invalid kill duration '{kill_duration}'", file=sys.stderr)
            sys.exit(2)

    if not command:
        print("timeout: no command specified", file=sys.stderr)
        sys.exit(2)

    # Determine signal number
    sig = parse_signal(signal_name)

    # Run command with timeout
    try:
        proc = subprocess.Popen(command)
    except FileNotFoundError:
        print(f"timeout: {command[0]}: No such file or directory", file=sys.stderr)
        sys.exit(127)
    except PermissionError:
        print(f"timeout: {command[0]}: Permission denied", file=sys.stderr)
        sys.exit(126)

    start_time = time.time()
    timed_out = False

    try:
        proc.wait(timeout=duration_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        # Send the signal
        try:
            os.kill(proc.pid, sig)
        except (OSError, PermissionError):
            pass

        # If kill-after duration specified, wait then force kill
        if kill_seconds is not None:
            try:
                proc.wait(timeout=kill_seconds)
            except subprocess.TimeoutExpired:
                try:
                    os.kill(proc.pid, signal.SIGKILL)
                except (OSError, PermissionError):
                    pass
                proc.wait()

    rc = proc.poll()
    if rc is None:
        proc.kill()
        rc = proc.wait()

    if timed_out and preserve_status:
        sys.exit(rc if rc is not None else 0)
    elif timed_out:
        sys.exit(124)
    else:
        sys.exit(rc if rc is not None else 0)


def parse_duration(s):
    """Parse a duration string like 10, 10s, 5m, 2h, 1d."""
    s = s.strip()
    if not s:
        return None

    multiplier = 1
    if s.endswith("s"):
        s = s[:-1]
    elif s.endswith("m"):
        s = s[:-1]
        multiplier = 60
    elif s.endswith("h"):
        s = s[:-1]
        multiplier = 3600
    elif s.endswith("d"):
        s = s[:-1]
        multiplier = 86400

    try:
        return float(s) * multiplier
    except ValueError:
        return None


def parse_signal(s):
    """Parse a signal name or number."""
    signal_map = {
        "SIGTERM": signal.SIGTERM,
        "SIGKILL": signal.SIGKILL,
        "SIGINT": signal.SIGINT,
        "SIGQUIT": signal.SIGQUIT,
        "SIGHUP": signal.SIGHUP,
        "SIGALRM": signal.SIGALRM,
        "SIGUSR1": signal.SIGUSR1,
        "SIGUSR2": signal.SIGUSR2,
        "SIGSTOP": signal.SIGSTOP,
        "SIGCONT": signal.SIGCONT,
        "TERM": signal.SIGTERM,
        "KILL": signal.SIGKILL,
        "INT": signal.SIGINT,
        "QUIT": signal.SIGQUIT,
        "HUP": signal.SIGHUP,
        "ALRM": signal.SIGALRM,
        "USR1": signal.SIGUSR1,
        "USR2": signal.SIGUSR2,
        "STOP": signal.SIGSTOP,
        "CONT": signal.SIGCONT,
    }

    if s in signal_map:
        return signal_map[s]

    try:
        return int(s)
    except ValueError:
        return signal.SIGTERM


if __name__ == "__main__":
    main(sys.argv[1:])
