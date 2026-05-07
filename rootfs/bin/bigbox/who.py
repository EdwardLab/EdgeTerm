"""
who — show who is logged on.
Usage: who [OPTION]...
"""
import sys
import os
import time
import struct


VERSION = "1.0.0 (bigbox)"


def main(args):
    if not args:
        args = ["--help"]
    if args[0] == "--help":
        print("Usage: who [OPTION]...")
        print("  -a    all (equivalent to -b -H -u)")
        print("  -b    time of last system boot")
        print("  -q    count of logged-in users")
        print("  -H    print column headers")
        print("  -u    show idle time")
        sys.exit(0)
    if args[0] == "--version":
        print(VERSION)
        sys.exit(0)

    all_mode = False
    boot_time = False
    count_mode = False
    headers = False
    idle_mode = False

    for arg in args:
        if arg.startswith("-"):
            for ch in arg[1:]:
                if ch == 'a':
                    all_mode = True
                elif ch == 'b':
                    boot_time = True
                elif ch == 'q':
                    count_mode = True
                elif ch == 'H':
                    headers = True
                elif ch == 'u':
                    idle_mode = True

    # Try to read from /var/run/utmp
    users = read_utmp()

    if boot_time and not all_mode:
        if headers:
            print("NAME   LINE         TIME         IDLE   PID   COMMENTS")
        # Show boot time if available
        for u in users:
            if u["type"] == "BOOT_TIME":
                print(f"{'':-8s} {'':-12s} {format_time(u['time']):12s}")
        return

    if all_mode:
        boot_time = True
        headers = True

    if count_mode:
        logged_in = [u for u in users if u["type"] == "USER_PROCESS"]
        print(f"{len(logged_in)} users")
        return

    if headers:
        print("NAME     LINE         TIME           IDLE   FROM")

    # Filter to USER_PROCESS entries
    user_count = 0
    for u in users:
        if u["type"] == "USER_PROCESS":
            user_count += 1
            name = u["name"]
            line = u["line"]
            t = format_time(u["time"])
            if idle_mode or all_mode:
                idle = format_idle(u.get("idle", 0))
                host = u.get("host", "")
                print(f"{name:<8s} {line:<12s} {t}  {idle:<5s} {host}")
            else:
                print(f"{name:<8s} {line:<12s} {t}")

    if all_mode:
        for u in users:
            if u["type"] == "BOOT_TIME":
                print(f"{'':-8s} {'':-12s} {format_time(u['time']):12s}")

    if all_mode and user_count == 0:
        # No user processes found, show current user info
        pass


def read_utmp():
    """Read utmp file if available, otherwise return info about current session."""
    result = []

    utmp_path = "/var/run/utmp"
    if os.path.exists(utmp_path):
        try:
            with open(utmp_path, "rb") as fh:
                utmp_size = struct.calcsize("hi32s4s32s256shiiiii")
                while True:
                    data = fh.read(utmp_size)
                    if len(data) < utmp_size:
                        break
                    ut = struct.unpack("hi32s4s32s256shiiiii", data)
                    entry = {
                        "type": ut[0],
                        "pid": ut[1],
                        "line": ut[2].split(b"\x00")[0].decode("utf-8", errors="replace"),
                        "id": ut[3].split(b"\x00")[0].decode("utf-8", errors="replace"),
                        "name": ut[4].split(b"\x00")[0].decode("utf-8", errors="replace"),
                        "host": ut[5].split(b"\x00")[0].decode("utf-8", errors="replace"),
                        "time": ut[6],
                        "idle": 0,
                    }
                    result.append(entry)
        except Exception:
            pass

    # If no utmp data, use current environment
    if not result:
        username = os.environ.get("EDGE_USER", "user")
        now = int(time.time())
        result.append({
            "type": 7,  # USER_PROCESS
            "pid": os.getpid(),
            "line": "tty1",
            "id": "",
            "name": username,
            "host": "",
            "time": now,
            "idle": 0,
        })
        result.append({
            "type": 2,  # BOOT_TIME
            "pid": 0,
            "line": "~",
            "id": "",
            "name": "",
            "host": "",
            "time": now - 3600,  # Approximate boot time 1 hour ago
            "idle": 0,
        })

    return result


def format_time(timestamp):
    """Format a Unix timestamp for display."""
    try:
        return time.strftime("%b %d %H:%M", time.localtime(timestamp))
    except (OSError, ValueError):
        return ""

UNIX_EPOCH = 0


def format_idle(idle_seconds):
    """Format idle time."""
    if idle_seconds < 0:
        return "."
    if idle_seconds < 60:
        return f"{idle_seconds:2d}"
    if idle_seconds < 3600:
        mins = idle_seconds // 60
        return f"{mins:2d}m"
    hours = idle_seconds // 3600
    return f"{hours:2d}h"


if __name__ == "__main__":
    main(sys.argv[1:])
