"""
uptime — tell how long the system has been running.
Usage: uptime [OPTION]
"""
import os
import sys
import time
from datetime import datetime, timezone

VERSION = "1.0"
SESSION_START_VAR = "EDGE_SESSION_START"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"uptime (edgeos-bigbox) {VERSION}")
        return

    # Current time
    now = datetime.now()
    current_time = now.strftime("%H:%M:%S")

    # Uptime: try to get from environment variable or /proc/uptime
    uptime_seconds = _get_uptime_seconds()
    if uptime_seconds is not None:
        uptime_str = _format_uptime(uptime_seconds)
    else:
        uptime_str = "N/A"

    # Load averages — simulated since we're in browser
    load_str = _get_load_string()

    # Number of users — always 1 for now
    users = 1

    # Format: " 14:30:00 up 2:15, 1 user, load average: 0.01, 0.02, 0.03"
    print(f" {current_time} up {uptime_str}, {users} user, load average: {load_str}")


def _get_uptime_seconds():
    """Try to determine uptime from environment or other sources.
    Returns float seconds or None."""
    # Check for EDGE_SESSION_START env var (set by shell on session start)
    start_str = os.environ.get(SESSION_START_VAR)
    if start_str:
        try:
            # Expected format: ISO timestamp like "2026-05-05T10:00:00Z"
            start = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
            delta = datetime.now().astimezone() - start
            return delta.total_seconds()
        except (ValueError, TypeError):
            pass

    # Check /proc/uptime in case we're in a Linux-like environment
    try:
        with open("/proc/uptime") as f:
            parts = f.read().split()
            if parts:
                return float(parts[0])
    except (FileNotFoundError, IOError, ValueError):
        pass

    return None


def _format_uptime(seconds):
    """Format uptime seconds into human-readable string."""
    days = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    minutes = int((seconds % 3600) // 60)

    if days > 0:
        day_str = f"{days} day{'s' if days != 1 else ''}"
        if hours > 0:
            return f"{day_str}, {hours}:{minutes:02d}"
        return day_str
    elif hours > 0:
        return f"{hours}:{minutes:02d}"
    else:
        return f"{minutes} min"


def _get_load_string():
    """Return load averages string. Simulated."""
    try:
        with open("/proc/loadavg") as f:
            load = f.read().strip()
            parts = load.split()
            if parts:
                return " ".join(parts[:3])
    except (FileNotFoundError, IOError):
        pass

    # Simulated load averages for browser environment
    import random
    # Use deterministic-ish values based on time
    base = (time.time() % 3600) / 3600.0
    return f"{base:.2f}, {base * 0.7:.2f}, {base * 0.5:.2f}"


def _help():
    print("Usage: uptime [OPTION]")
    print("Tell how long the system has been running.")
    print()
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
