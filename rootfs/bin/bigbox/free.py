"""
free — display amount of free and used memory in the system.
Usage: free [-h] [-b|-k|-m|-g]
"""
import sys
import os

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"free (edgeos-bigbox) {VERSION}")
        return

    # Parse flags
    flag_h = "-h" in args     # human-readable
    flag_bytes = "-b" in args  # bytes
    flag_kilo = "-k" in args   # kilobytes
    flag_mega = "-m" in args   # megabytes
    flag_giga = "-g" in args   # gigabytes

    # Try to get memory info from js.performance.memory (Chrome)
    mem_info = _get_js_memory()
    if mem_info:
        mem_total = mem_info.get("jsHeapSizeLimit", 0)
        mem_used = mem_info.get("usedJSHeapSize", 0)
        mem_available = mem_total - mem_used
    else:
        # Fallback: try /proc/meminfo
        mem_info_fallback = _get_proc_meminfo()
        if mem_info_fallback:
            mem_total = mem_info_fallback.get("MemTotal", 0)
            mem_available = mem_info_fallback.get("MemAvailable", mem_total)
            mem_used = mem_total - mem_available
        else:
            # Default simulated values
            mem_total = 2097152  # 2 GB in KB
            mem_used = 524288    # 512 MB in KB
            mem_available = mem_total - mem_used

    # Determine output unit
    if flag_bytes:
        divisor = 1
        unit = "bytes"
    elif flag_mega:
        divisor = 1024 * 1024
        unit = "Mi"
    elif flag_giga:
        divisor = 1024 * 1024 * 1024
        unit = "Gi"
    elif flag_h:
        divisor = 1024
        # We'll use human-readable formatting instead
        divisor = 1
        unit = ""
    else:
        divisor = 1024  # default: kilobytes
        unit = "Ki"

    # Convert everything to KB first (values from /proc/meminfo are in KB)
    total_kb = mem_total
    used_kb = mem_used
    free_kb = mem_available
    shared_kb = 0
    buffers_kb = 0
    cached_kb = 0
    available_kb = mem_available

    if mem_info:
        # js.performance.memory gives bytes; convert to KB
        total_kb = mem_total // 1024
        used_kb = mem_used // 1024
        available_kb = mem_available // 1024
        free_kb = available_kb
        shared_kb = 0
        buffers_kb = 0
        cached_kb = 0
    elif _get_proc_meminfo():
        info = _get_proc_meminfo()
        total_kb = info.get("MemTotal", total_kb)
        available_kb = info.get("MemAvailable", total_kb)
        free_kb = info.get("MemFree", available_kb)
        shared_kb = info.get("Shmem", 0)
        buffers_kb = info.get("Buffers", 0)
        cached_kb = info.get("Cached", 0)
        used_kb = total_kb - free_kb - (buffers_kb + cached_kb) if total_kb else 0

    def _format(val_kb):
        if flag_h:
            return _human_readable(val_kb * 1024)
        return f"{int(val_kb // divisor):>8}"

    # Print header
    if flag_h:
        print(f"{'':>8}{'total':>8}{'used':>8}{'free':>8}{'shared':>8}{'buff/cache':>10}{'available':>10}")
        print(f"{'Mem:':>8} {_format(total_kb):>8} {_format(used_kb):>8} {_format(free_kb):>8} {_format(shared_kb):>8} {_format(buffers_kb + cached_kb):>10}  {_format(available_kb):>10}")
        swap_total = 0
        swap_used = 0
        swap_free = 0
        print(f"{'Swap:':>8} {_format(swap_total):>8} {_format(swap_used):>8} {_format(swap_free):>8}")
    else:
        u = unit
        print(f"{'':>8}{'total':>8}{'used':>8}{'free':>8}{'shared':>8}{'buff/cache':>10}{'available':>10}")
        print(f"{'Mem:':>8} {_format(total_kb):>8} {_format(used_kb):>8} {_format(free_kb):>8} {_format(shared_kb):>8} {_format(buffers_kb + cached_kb):>10}  {_format(available_kb):>10}")
        print(f"{'Swap:':>8} {'0':>8} {'0':>8} {'0':>8}")


def _get_js_memory():
    """Try to get memory info from JavaScript's performance.memory."""
    try:
        import js
        if hasattr(js, "performance") and hasattr(js.performance, "memory"):
            mem = js.performance.memory
            return {
                "jsHeapSizeLimit": int(mem.jsHeapSizeLimit),
                "totalJSHeapSize": int(mem.totalJSHeapSize),
                "usedJSHeapSize": int(mem.usedJSHeapSize),
            }
    except Exception:
        pass
    return None


def _get_proc_meminfo():
    """Try to read /proc/meminfo."""
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    key = parts[0].strip()
                    val_str = parts[1].strip().split()[0]
                    try:
                        info[key] = int(val_str)
                    except ValueError:
                        pass
        if info:
            return info
    except (FileNotFoundError, IOError):
        pass
    return None


def _human_readable(size_bytes):
    """Format bytes as human-readable string."""
    for unit in ["B", "Ki", "Mi", "Gi", "Ti"]:
        if abs(size_bytes) < 1024.0:
            if isinstance(size_bytes, int) and unit == "B":
                return f"{size_bytes}B"
            return f"{size_bytes:.1f}{unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f}Pi"


def _help():
    print("Usage: free [OPTION]")
    print("Display amount of free and used memory in the system.")
    print()
    print("  -b             show memory in bytes")
    print("  -k             show memory in kilobytes")
    print("  -m             show memory in megabytes")
    print("  -g             show memory in gigabytes")
    print("  -h             show human-readable output")
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
