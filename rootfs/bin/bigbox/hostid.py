"""
hostid — print the numeric identifier for the current host.
Usage: hostid [OPTION]
"""
import os
import sys
import hashlib

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"hostid (edgeos-bigbox) {VERSION}")
        return

    # Generate a stable 8-digit hex host ID
    host_id = _get_host_id()
    print(host_id)


def _get_host_id():
    """Generate a stable host ID from available identifiers."""
    # Try to read from a stored hostid file
    try:
        hostid_path = "/etc/hostid"
        if os.path.exists(hostid_path):
            with open(hostid_path, "rb") as f:
                data = f.read().strip()
                if len(data) == 4:
                    return data.hex()
                if len(data) == 8:
                    return data.decode("ascii")
    except (FileNotFoundError, IOError):
        pass

    # Generate a stable ID from hostname
    hostname = os.environ.get("EDGE_HOSTNAME", "edgeterm")
    # Create a deterministic 8-char hex from the hostname
    digest = hashlib.md5(hostname.encode()).hexdigest()[:8]

    # Optionally store it for consistency
    try:
        os.makedirs("/etc", exist_ok=True)
        with open("/etc/hostid", "w") as f:
            f.write(digest + "\n")
    except (IOError, OSError):
        pass

    return digest


def _help():
    print("Usage: hostid [OPTION]")
    print("Print the numeric identifier for the current host.")
    print()
    print("      --help     display this help and exit")
    print("      --version  output version information and exit")
