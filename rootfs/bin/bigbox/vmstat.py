"""
vmstat — report virtual memory statistics.
Usage: vmstat [OPTION] [DELAY [COUNT]]
"""
import sys
import os
import time

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"vmstat (edgeos-bigbox) {VERSION}")
        return

    flag_a = "-a" in args  # active/inactive memory
    flag_s = "-s" in args  # display memory stats in table format
    flag_d = "-d" in args  # disk statistics
    flag_w = "-w" in args  # wide output

    # Parse delay and count from positional args
    delay = None
    count = None
    positional = []

    for a in args:
        if a.startswith("-"):
            continue
        positional.append(a)

    if len(positional) >= 1:
        try:
            delay = float(positional[0])
        except ValueError:
            pass
    if len(positional) >= 2:
        try:
            count = int(positional[1])
        except ValueError:
            pass

    if flag_s:
        _show_summary_stats()
        return

    if flag_a:
        _show_active_stats()
        return

    if flag_d:
        _show_disk_stats()
        return

    # Default: show once or loop with delay
    iteration = 0
    while True:
        if count is not None and iteration >= count:
            break
        _show_default(delay is not None, flag_w)
        if delay is None:
            break
        iteration += 1
        if iteration < (count or 999999):
            time.sleep(delay)


def _get_memory_kb():
    """Get memory info from various sources. Returns dict with values in KB."""
    info = {
        "total": 2097152,
        "used": 524288,
        "free": 1572864,
        "buffers": 0,
        "cache": 0,
        "swap_total": 0,
        "swap_used": 0,
        "swap_free": 0,
        "active": 0,
        "inactive": 0,
    }

    # Try /proc/meminfo first
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    key = parts[0].strip()
                    val_str = parts[1].strip().split()[0]
                    try:
                        val = int(val_str)
                    except ValueError:
                        continue
                    if key == "MemTotal":
                        info["total"] = val
                    elif key == "MemFree":
                        info["free"] = val
                    elif key == "MemAvailable":
                        info["available"] = val
                    elif key == "Buffers":
                        info["buffers"] = val
                    elif key == "Cached":
                        info["cache"] = val
                    elif key == "SwapTotal":
                        info["swap_total"] = val
                    elif key == "SwapFree":
                        info["swap_free"] = val
                        info["swap_used"] = info["swap_total"] - info["swap_free"]
                    elif key == "Active":
                        info["active"] = val
                    elif key == "Inactive":
                        info["inactive"] = val
            info["used"] = info["total"] - info["free"]
        return info
    except (FileNotFoundError, IOError):
        pass

    # Try js.navigator.storage
    try:
        import js
        estimate = js.navigator.storage.estimate()
        quota = int(estimate.quota) if estimate.quota else 0
        usage = int(estimate.usage) if estimate.usage else 0
        if quota > 0:
            # Convert bytes to KB
            info["total"] = quota // 1024
            info["used"] = usage // 1024
            info["free"] = (quota - usage) // 1024
    except Exception:
        pass

    return info


def _get_cpu_stats():
    """Get CPU stats from /proc/stat if available."""
    info = {
        "user": 0,
        "system": 0,
        "idle": 0,
        "iowait": 0,
        "stolen": 0,
        "procs_running": 1,
        "procs_blocked": 0,
    }
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("cpu "):
                    fields = line.split()
                    if len(fields) >= 5:
                        info["user"] = int(fields[1])
                        info["system"] = int(fields[3])
                        info["idle"] = int(fields[4])
                        if len(fields) > 5:
                            info["iowait"] = int(fields[5])
                        if len(fields) > 8:
                            info["stolen"] = int(fields[8])
                elif line.startswith("procs_running"):
                    parts = line.split()
                    if len(parts) >= 2:
                        info["procs_running"] = int(parts[1])
                elif line.startswith("procs_blocked"):
                    parts = line.split()
                    if len(parts) >= 2:
                        info["procs_blocked"] = int(parts[1])
        return info
    except (FileNotFoundError, IOError):
        pass
    return info


def _get_io_stats():
    """Get I/O stats (swaps in/out, interrupts, context switches)."""
    info = {"si": 0, "so": 0, "bi": 0, "bo": 0, "in": 0, "cs": 0}
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("intr "):
                    parts = line.split()
                    if len(parts) > 1:
                        info["in"] = int(parts[1])
                elif line.startswith("ctxt "):
                    parts = line.split()
                    if len(parts) > 1:
                        info["cs"] = int(parts[1])
    except (FileNotFoundError, IOError):
        pass
    try:
        with open("/proc/vmstat") as f:
            for line in f:
                if line.startswith("pgpgin "):
                    info["bi"] = int(line.split()[1])
                elif line.startswith("pgpgout "):
                    info["bo"] = int(line.split()[1])
                elif line.startswith("pswpin "):
                    info["si"] = int(line.split()[1])
                elif line.startswith("pswpout "):
                    info["so"] = int(line.split()[1])
    except (FileNotFoundError, IOError):
        pass
    return info


def _show_default(with_header, wide=False):
    """Show default vmstat output."""
    mem = _get_memory_kb()
    cpu = _get_cpu_stats()
    io = _get_io_stats()

    # Format: procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
    if wide:
        header = "procs -----------------------memory---------------------- ---swap-- -----io---- -system-- --------cpu--------"
    else:
        header = "procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----"

    r = cpu.get("procs_running", 0)
    b = cpu.get("procs_blocked", 0)

    total = mem.get("total", 0)
    free = mem.get("free", 0)
    used = total - free
    buff = mem.get("buffers", 0)
    cache = mem.get("cache", 0)

    swap_used = mem.get("swap_used", 0)
    swap_free = mem.get("swap_free", 0)

    si = io.get("si", 0)
    so = io.get("so", 0)
    bi = io.get("bi", 0)
    bo = io.get("bo", 0)
    intr = io.get("in", 0)
    cs = io.get("cs", 0)

    us = cpu.get("user", 0)
    sy = cpu.get("system", 0)
    id_ = cpu.get("idle", 0)
    wa = cpu.get("iowait", 0)
    st = cpu.get("stolen", 0)

    if with_header:
        print(header)
        print(f"{'r':>5} {'b':>5} {'swpd':>8} {'free':>8} {'buff':>8} {'cache':>8} {'si':>8} {'so':>8} {'bi':>8} {'bo':>8} {'in':>8} {'cs':>8} {'us':>5} {'sy':>5} {'id':>5} {'wa':>5} {'st':>5}")

    print(f"{r:>5} {b:>5} {swap_used:>8} {free:>8} {buff:>8} {cache:>8} {si:>8} {so:>8} {bi:>8} {bo:>8} {intr:>8} {cs:>8} {us:>5} {sy:>5} {id_:>5} {wa:>5} {st:>5}")


def _show_active_stats():
    """Show active/inactive memory (vmstat -a)."""
    mem = _get_memory_kb()
    total = mem.get("total", 0)
    free = mem.get("free", 0)
    active = mem.get("active", 0)
    inactive = mem.get("inactive", 0)
    used = total - free

    print(f"{'':>5}{'total':>10}{'used':>10}{'free':>10}{'active':>10}{'inactive':>10}")
    print(f"{'Mem:':>5}{total:>10}{used:>10}{free:>10}{active:>10}{inactive:>10}")
    print(f"{'Swap:':>5}{mem.get('swap_total', 0):>10}{mem.get('swap_used', 0):>10}{mem.get('swap_free', 0):>10}{'-':>10}{'-':>10}")


def _show_summary_stats():
    """Show summary statistics (vmstat -s)."""
    mem = _get_memory_kb()
    total = mem.get("total", 0)
    used = mem.get("used", total - mem.get("free", 0))
    free = mem.get("free", 0)
    buff = mem.get("buffers", 0)
    cache = mem.get("cache", 0)

    print(f"{total:>12} K total memory")
    print(f"{used:>12} K used memory")
    print(f"{free:>12} K free memory")
    print(f"{buff:>12} K buffers")
    print(f"{cache:>12} K cache")
    print(f"       0 K swap total")
    print(f"       0 K swap used")
    print(f"       0 K swap free")


def _show_disk_stats():
    """Show disk statistics (vmstat -d)."""
    print(f"{'':<10} {'reads':>8} {'read/s':>8} {'writes':>8} {'write/s':>8}")
    print(f"{'loop0':<10} {'0':>8} {'0.0':>8} {'0':>8} {'0.0':>8}")
    print(f"{'sda':<10} {'0':>8} {'0.0':>8} {'0':>8} {'0.0':>8}")


def _help():
    print("Usage: vmstat [OPTION] [DELAY [COUNT]]")
    print("Report virtual memory statistics.")
    print()
    print("  -a, --active           display active/inactive memory")
    print("  -s, --stats            display memory statistics in table format")
    print("  -d, --disk             report disk statistics")
    print("  -w, --wide             wide output")
    print("      --help             display this help and exit")
    print("      --version          output version information and exit")
