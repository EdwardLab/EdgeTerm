import os
import site
import sys
import builtins

import js

ROOTFS_LIB = os.environ.get("EDGETERM_ROOTFS_LIB", "")

if ROOTFS_LIB and os.path.isdir(ROOTFS_LIB) and ROOTFS_LIB not in sys.path:
    sys.path.insert(0, ROOTFS_LIB)
if os.path.isdir("/usr/lib") and "/usr/lib" not in sys.path:
    sys.path.insert(0, "/usr/lib")

from edgeterm_shell import EdgeTermShell, ShellExit


print("[BOOTLOADER] EdgeTerm, kernel 0.27.5")
print(f"[BOOT] Python {os.sys.version}")


def print_motd():
    motd_path = "/etc/motd"
    if os.path.isfile(motd_path):
        try:
            with open(motd_path, encoding="utf-8") as handle:
                motd = handle.read().strip()
            motd = motd.replace(" User:         user", f" User:         {os.environ.get('EDGE_USER', 'user')}")
            print(motd)
        except Exception as exc:
            print(f"[SHELL] failed to read motd or not found: {exc}")


def init_filesystem():
    user = os.environ.get("EDGE_USER", "user")
    home = f"/home/{user}"
    os.environ["USER"] = user
    os.environ["HOME"] = home
    os.makedirs(home, exist_ok=True)
    # Emscripten's default umask can be 0o777, causing all new files to
    # have mode 0o000 (unreadable).  Set a reasonable umask so that
    # `open(path, 'w')`, `startproject`, etc. create files with 0o644.
    try:
        os.umask(0o022)
    except Exception:
        pass
    user_site = f"{home}/.local/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages"
    os.makedirs(user_site, exist_ok=True)
    if ROOTFS_LIB and os.path.isdir(ROOTFS_LIB) and ROOTFS_LIB not in sys.path:
        sys.path.insert(0, ROOTFS_LIB)
    if os.path.isdir("/usr/lib") and "/usr/lib" not in sys.path:
        sys.path.insert(0, "/usr/lib")
    site.addsitedir(user_site)
    os.chdir(home)


async def safe_input(prompt=""):
    try:
        if hasattr(js, "terminal") and hasattr(js.terminal, "input"):
            return await js.terminal.input(prompt)
        if hasattr(js, "term") and hasattr(js.term, "read"):
            return await js.term.read(prompt)
        result = js.eval(f"prompt({prompt!r})") or ""
        return str(result)
    except Exception as exc:
        raise RuntimeError(f"[input] failed: {exc}")


print_motd()
init_filesystem()
builtins.input = safe_input
EDGETERM_SHELL = EdgeTermShell(input_func=safe_input)
builtins.EDGETERM_SHELL = EDGETERM_SHELL
builtins.EdgeTermShellExit = ShellExit

try:
    import edgeterm_subprocess

    edgeterm_subprocess.install(EDGETERM_SHELL)
except Exception as exc:
    print(f"[BOOT] subprocess compatibility layer unavailable: {exc}")


async def run_rc_local():
    return await EDGETERM_SHELL.run_rc_local()
