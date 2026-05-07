"""
umask - display or set file mode mask.
"""
import os
import sys


# Symbolic mode names
MODE_NAMES = {
    0: "u=rwx,g=rwx,o=rwx",
    0o1: "u=rwx,g=rwx,o=rw",
    0o2: "u=rwx,g=rwx,o=rx",
    0o3: "u=rwx,g=rwx,o=r",
    0o4: "u=rwx,g=rwx,o=wx",
    0o5: "u=rwx,g=rwx,o=w",
    0o6: "u=rwx,g=rwx,o=x",
    0o7: "u=rwx,g=rwx,o=",
    0o10: "u=rwx,g=rw,o=rwx",
    0o11: "u=rwx,g=rw,o=rw",
    0o12: "u=rwx,g=rw,o=rx",
    0o13: "u=rwx,g=rw,o=r",
    0o14: "u=rwx,g=rw,o=wx",
    0o15: "u=rwx,g=rw,o=w",
    0o16: "u=rwx,g=rw,o=x",
    0o17: "u=rwx,g=rw,o=",
    0o20: "u=rwx,g=rx,o=rwx",
    0o21: "u=rwx,g=rx,o=rw",
    0o22: "u=rwx,g=rx,o=rx",
    0o23: "u=rwx,g=rx,o=r",
    0o24: "u=rwx,g=rx,o=wx",
    0o25: "u=rwx,g=rx,o=w",
    0o26: "u=rwx,g=rx,o=x",
    0o27: "u=rwx,g=rx,o=",
    0o30: "u=rwx,g=r,o=rwx",
    0o31: "u=rwx,g=r,o=rw",
    0o32: "u=rwx,g=r,o=rx",
    0o33: "u=rwx,g=r,o=r",
    0o34: "u=rwx,g=r,o=wx",
    0o35: "u=rwx,g=r,o=w",
    0o36: "u=rwx,g=r,o=x",
    0o37: "u=rwx,g=r,o=",
    0o40: "u=rwx,g=wx,o=rwx",
    0o41: "u=rwx,g=wx,o=rw",
    0o42: "u=rwx,g=wx,o=rx",
    0o43: "u=rwx,g=wx,o=r",
    0o44: "u=rwx,g=wx,o=wx",
    0o45: "u=rwx,g=wx,o=w",
    0o46: "u=rwx,g=wx,o=x",
    0o47: "u=rwx,g=wx,o=",
    0o50: "u=rwx,g=w,o=rwx",
    0o51: "u=rwx,g=w,o=rw",
    0o52: "u=rwx,g=w,o=rx",
    0o53: "u=rwx,g=w,o=r",
    0o54: "u=rwx,g=w,o=wx",
    0o55: "u=rwx,g=w,o=w",
    0o56: "u=rwx,g=w,o=x",
    0o57: "u=rwx,g=w,o=",
    0o60: "u=rwx,g=x,o=rwx",
    0o61: "u=rwx,g=x,o=rw",
    0o62: "u=rwx,g=x,o=rx",
    0o63: "u=rwx,g=x,o=r",
    0o64: "u=rwx,g=x,o=wx",
    0o65: "u=rwx,g=x,o=w",
    0o66: "u=rwx,g=x,o=x",
    0o67: "u=rwx,g=x,o=",
    0o70: "u=rwx,g=,o=rwx",
    0o71: "u=rwx,g=,o=rw",
    0o72: "u=rwx,g=,o=rx",
    0o73: "u=rwx,g=,o=r",
    0o74: "u=rwx,g=,o=wx",
    0o75: "u=rwx,g=,o=w",
    0o76: "u=rwx,g=,o=x",
    0o77: "u=rwx,g=,o=",
}


def mask_to_symbolic(mask):
    """Convert a numeric umask to symbolic string."""
    # Default if exact match not found
    u = ""
    g = ""
    o = ""
    if not (mask & 0o700):
        u = "u=rwx"
    else:
        parts = []
        if not (mask & 0o400):
            parts.append("r")
        if not (mask & 0o200):
            parts.append("w")
        if not (mask & 0o100):
            parts.append("x")
        u = "u=" + "".join(parts) if parts else "u="

    if not (mask & 0o070):
        g = "g=rwx"
    else:
        parts = []
        if not (mask & 0o040):
            parts.append("r")
        if not (mask & 0o020):
            parts.append("w")
        if not (mask & 0o010):
            parts.append("x")
        g = "g=" + "".join(parts) if parts else "g="

    if not (mask & 0o007):
        o = "o=rwx"
    else:
        parts = []
        if not (mask & 0o004):
            parts.append("r")
        if not (mask & 0o002):
            parts.append("w")
        if not (mask & 0o001):
            parts.append("x")
        o = "o=" + "".join(parts) if parts else "o="

    return f"{u},{g},{o}"


def main(args):
    portable = False
    symbolic = False
    mask_arg = None

    for arg in args:
        if arg == "--":
            continue
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "p":
                    portable = True
                elif ch == "S":
                    symbolic = True
                else:
                    print(f"umask: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: umask [-pS] [MASK]", file=sys.stderr)
                    sys.exit(1)
        elif arg in ("--help", "-help"):
            print("Usage: umask [-pS] [MASK]")
            print("  -p    output in a format that can be reused as input")
            print("  -S    output symbolic format")
            print("      --help     display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("umask (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            # Could be a mask
            mask_arg = arg

    current_mask = os.umask(0)
    os.umask(current_mask)  # restore

    if mask_arg is not None:
        # Set new mask
        try:
            if mask_arg.startswith("0"):
                new_mask = int(mask_arg, 8)
            else:
                # Try to parse as octal number
                new_mask = int(mask_arg, 8)
        except ValueError:
            print(f"umask: invalid mask: '{mask_arg}'", file=sys.stderr)
            sys.exit(1)

        # Print old mask
        if symbolic:
            print(mask_to_symbolic(current_mask))
        elif portable:
            print(f"umask {oct(current_mask)[2:]}")
        else:
            print(oct(current_mask)[2:])

        # Set new mask
        os.umask(new_mask)
    else:
        # Display current mask
        if symbolic:
            print(mask_to_symbolic(current_mask))
        elif portable:
            print(f"umask {oct(current_mask)[2:]}")
        else:
            print(oct(current_mask)[2:])
