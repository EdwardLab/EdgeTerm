"""
type - display information about command type.
"""
import os
import sys


# Common shell builtins
SHELL_BUILTINS = {
    ".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "case",
    "cd", "command", "continue", "declare", "dirs", "disown", "echo", "enable",
    "eval", "exec", "exit", "export", "fc", "fg", "getopts", "hash", "help",
    "history", "jobs", "kill", "let", "local", "logout", "mapfile", "popd",
    "printf", "pushd", "pwd", "read", "readarray", "readonly", "return", "set",
    "shift", "shopt", "source", "suspend", "test", "times", "trap", "type",
    "typeset", "ulimit", "umask", "unalias", "unset", "wait",
}

# Common aliases
COMMON_ALIASES = {
    "ll": "ls -alF",
    "la": "ls -A",
    "l": "ls -CF",
    "grep": "grep --color=auto",
    "egrep": "grep -E",
    "fgrep": "grep -F",
    "cls": "clear",
}


def find_bigbox_applet(name):
    """Check if name is a bigbox applet."""
    bigbox_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bigbox")
    # Also check /bin/bigbox
    alt_dirs = ["/bin/bigbox"]
    if os.path.isdir(bigbox_dir):
        alt_dirs.append(bigbox_dir)
    for d in alt_dirs:
        applet_path = os.path.join(d, f"{name}.py")
        if os.path.isfile(applet_path):
            return applet_path
    return None


def find_in_path(name):
    """Search PATH for an executable."""
    path = os.environ.get("PATH", "")
    for p in path.split(os.pathsep):
        if not p:
            continue
        full = os.path.join(p, name)
        if os.path.isfile(full) and os.access(full, os.X_OK):
            return full
    return None


def check_command(name, all_matches, show_type_only):
    """Check what type a command is. Returns True if found."""
    found = False

    # Check alias
    if name in COMMON_ALIASES:
        if show_type_only:
            print("alias")
        else:
            print(f"{name} is aliased to `{COMMON_ALIASES[name]}'")
        found = True
        if not all_matches:
            return True

    # Check shell builtin
    if name in SHELL_BUILTINS:
        if show_type_only:
            print("builtin")
        else:
            print(f"{name} is a shell builtin")
        found = True
        if not all_matches:
            return True

    # Check bigbox applet
    applet_path = find_bigbox_applet(name)
    if applet_path:
        if show_type_only:
            print("file")
        else:
            print(f"{name} is {applet_path}")
        found = True
        if not all_matches:
            return True

    # Check PATH
    path_cmd = find_in_path(name)
    if path_cmd:
        if show_type_only:
            print("file")
        else:
            print(f"{name} is {path_cmd}")
        found = True
        if not all_matches:
            return True

    # Check WASM binary (if /bin/NAME exists)
    wasm_path = f"/bin/{name}"
    if os.path.isfile(wasm_path):
        if show_type_only:
            print("file")
        else:
            print(f"{name} is {wasm_path}")
        found = True
        if not all_matches:
            return True

    return found


def main(args):
    all_matches = False
    show_type_only = False
    targets = []

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "a":
                    all_matches = True
                elif ch == "t":
                    show_type_only = True
                else:
                    print(f"type: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: type [-a] [-t] NAME...", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: type [-a] [-t] NAME...")
            print("  -a    display all locations of the command")
            print("  -t    print a single word: 'builtin', 'file', 'alias', or nothing")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("type (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)

    if not targets:
        print("type: missing operand", file=sys.stderr)
        print("Usage: type [-a] [-t] NAME...", file=sys.stderr)
        sys.exit(1)

    exit_code = 0
    for target in targets:
        found = check_command(target, all_matches, show_type_only)
        if not found:
            if show_type_only:
                print(file=sys.stderr)
            else:
                print(f"type: {target}: not found", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
