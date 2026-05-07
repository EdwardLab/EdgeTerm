"""
hostname — show or set the system's host name.
Usage: hostname [OPTION] [NAME]
"""
import os
import sys
import socket

VERSION = "1.0"

HOSTNAME_FILE = "/etc/hostname"
DEFAULT_HOSTNAME = "edgeterm"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"hostname (edgeos-bigbox) {VERSION}")
        return

    flag_s = "-s" in args   # short hostname
    flag_f = "-f" in args   # FQDN
    flag_i = "-i" in args   # IP address
    flag_d = "-d" in args   # domain (optional)
    flag_F = "-F" in args   # read from file

    # Filter args to separate flags from positional
    flags, positional = _parse_flags_strict(args, known_flags="sfidF")
    if flags is None:
        return

    # Read the hostname
    hostname = _read_hostname()
    if not hostname:
        hostname = DEFAULT_HOSTNAME

    # If -F is provided, read hostname from file
    file_source = None
    f_idx = -1
    for i, a in enumerate(args):
        if a == "-F" and i + 1 < len(args):
            file_source = args[i + 1]
            break
    if flag_F and file_source:
        try:
            with open(file_source) as f:
                hostname = f.read().strip().split("\n")[0].strip()
        except (FileNotFoundError, IOError):
            print(f"hostname: {file_source}: No such file or directory", file=sys.stderr)
            sys.exit(2)

    # If positional arguments remain, set hostname
    if positional:
        new_name = positional[0]
        # In browser environment, persist to /etc/hostname
        try:
            os.makedirs(os.path.dirname(HOSTNAME_FILE), exist_ok=True)
            with open(HOSTNAME_FILE, "w") as f:
                f.write(new_name.strip() + "\n")
        except (IOError, OSError):
            pass
        # Also set environment variable as a convenient fallback
        os.environ["EDGE_HOSTNAME"] = new_name.strip()
        return

    # Output
    if flag_s:
        # Short name: first component before the dot
        short = hostname.split(".")[0]
        print(short)
    elif flag_f:
        # FQDN: just return the hostname as-is
        print(hostname)
    elif flag_i:
        # IP address
        ip = _get_ip()
        print(ip)
    elif flag_d:
        # Domain: everything after the first dot
        parts = hostname.split(".", 1)
        if len(parts) > 1:
            print(parts[1])
    else:
        print(hostname)


def _parse_flags_strict(args, known_flags=""):
    flags = set()
    positional = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--help" or a == "--version":
            i += 1
            continue
        if a.startswith("-") and not a.startswith("--") and len(a) > 1:
            for ch in a[1:]:
                if known_flags and ch not in known_flags:
                    print(f"hostname: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
                flags.add(ch)
        elif not a.startswith("-"):
            positional.append(a)
        i += 1
    return flags, positional


def _read_hostname():
    """Read hostname from /etc/hostname, then EDGE_HOSTNAME env var."""
    try:
        with open(HOSTNAME_FILE) as f:
            line = f.read().strip()
            if line:
                return line.split("\n")[0].strip()
    except (FileNotFoundError, IOError):
        pass

    # Try environment variable
    env_host = os.environ.get("EDGE_HOSTNAME")
    if env_host:
        return env_host.strip()

    # Try socket.gethostname()
    try:
        host = socket.gethostname()
        if host and host != "localhost":
            return host
    except Exception:
        pass

    return DEFAULT_HOSTNAME


def _get_ip():
    """Get the IP address of the host."""
    # Try to get from environment
    ip = os.environ.get("EDGE_IP")
    if ip:
        return ip

    # Try socket
    try:
        hostname = _read_hostname()
        ip = socket.gethostbyname(hostname)
        if ip:
            return ip
    except Exception:
        pass

    return "127.0.0.1"


def _help():
    print("Usage: hostname [OPTION] [NAME]")
    print("Show or set the system's host name.")
    print()
    print("  -s, --short     display the short host name")
    print("  -f, --fqdn      display the fully qualified domain name")
    print("  -i, --ip        display the IP address of the host")
    print("  -d, --domain    display the domain name")
    print("  -F, --file      read hostname from file")
    print("      --help      display this help and exit")
    print("      --version   output version information and exit")
