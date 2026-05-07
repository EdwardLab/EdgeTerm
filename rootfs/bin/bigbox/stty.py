"""
stty — change and print terminal line settings.
Usage: stty [OPTION] [SETTING]
"""
import sys
import os

VERSION = "1.0"


def main(args):
    if "--help" in args:
        _help()
        return
    if "--version" in args:
        print(f"stty (edgeos-bigbox) {VERSION}")
        return

    flag_a = "-a" in args       # show all settings
    flag_g = "-g" in args       # show in stty-readable format
    flag_F = "-F" in args       # open specified device (ignored in browser)

    # Process args
    settings = []
    for i, a in enumerate(args):
        if a.startswith("--"):
            continue
        if a.startswith("-") and a not in ("-a", "-g"):
            continue
        if a in ("-a", "-g", "-F"):
            continue
        if a == "sane":
            settings.append("sane")
        else:
            settings.append(a)

    # If "sane" is requested, reset settings to sensible defaults
    if "sane" in settings:
        _stty_sane()
        return

    # Show all settings
    if flag_a:
        _show_all()
        return

    # Show in stty-readable format
    if flag_g:
        print(_generate_stty_line())
        return

    # No flags: report current settings in compact form
    # In browser environment, just show basic info
    print("speed 38400 baud; line = 0;")
    print(f"rows 24; columns 80;")


def _stty_sane():
    """Reset terminal to sensible defaults."""
    # In browser environment, just acknowledge
    print("stty: terminal settings set to sane defaults")


def _show_all():
    """Show all terminal settings (like stty -a)."""
    print("speed 38400 baud; rows 24; columns 80; line = 0;")
    print("intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>;")
    print("eol2 = <undef>; swtch = <undef>; start = ^Q; stop = ^S; susp = ^Z;")
    print("rprnt = ^R; werase = ^W; lnext = ^V; discard = ^O;")
    print("min = 1; time = 0;")
    print("-parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts")
    print("-ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl -ixon")
    print("-ixoff -iutf8 -iuclc -ixany")
    print("opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt0 ff0")
    print("isig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt")
    print("echoctl echoke -flusho -extproc")


def _generate_stty_line():
    """Generate a line that can be passed back to stty to restore settings."""
    return "38400:0:18b8:3a3:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0"


def _help():
    print("Usage: stty [OPTION] [SETTING]...")
    print("Change and print terminal line settings.")
    print()
    print("  -a, --all             print all current settings in human-readable form")
    print("  -g, --save            print all current settings in stty-readable form")
    print("  -F, --file=DEVICE     open and use DEVICE instead of stdin")
    print("      --help            display this help and exit")
    print("      --version         output version information and exit")
    print()
    print("If SETTING is 'sane', reset terminal to sensible defaults.")
