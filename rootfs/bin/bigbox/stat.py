"""
stat - display file or filesystem status.
"""
import os
import stat as stat_mod
import sys
import time


def format_mode(mode):
    """Generate permission string like '-rw-r--r--'."""
    is_dir = "d" if stat_mod.S_ISDIR(mode) else "-"
    perms = ""
    for who in ("USR", "GRP", "OTH"):
        for what in ("R", "W", "X"):
            perms += (mode & getattr(stat_mod, f"S_I{what}{who}")) and what.lower() or "-"
    return is_dir + perms


def get_file_type(mode):
    """Return single char for file type."""
    if stat_mod.S_ISREG(mode):
        return "regular file"
    if stat_mod.S_ISDIR(mode):
        return "directory"
    if stat_mod.S_ISCHR(mode):
        return "character special file"
    if stat_mod.S_ISBLK(mode):
        return "block special file"
    if stat_mod.S_ISFIFO(mode):
        return "fifo"
    if stat_mod.S_ISLNK(mode):
        return "symbolic link"
    if stat_mod.S_ISSOCK(mode):
        return "socket"
    return "unknown"


def format_time(t):
    """Format a timestamp like 'stat' does."""
    return time.strftime("%Y-%m-%d %H:%M:%S.%f", time.localtime(t)) + f" +0000"


def apply_format(fmt, st, filename):
    """Apply stat format codes and return the string."""
    result = []
    i = 0
    while i < len(fmt):
        if fmt[i] == "%" and i + 1 < len(fmt):
            code = fmt[i + 1]
            if code == "a":
                result.append(str(oct(stat_mod.S_IMODE(st.st_mode)))[2:])
            elif code == "A":
                result.append(format_mode(st.st_mode))
            elif code == "b":
                result.append(str(st.st_blocks))
            elif code == "B":
                result.append("512")  # traditional block size
            elif code == "d":
                result.append(str(st.st_dev))
            elif code == "D":
                result.append(f"{st.st_dev:#x}")
            elif code == "f":
                result.append(f"{st.st_mode:#x}")
            elif code == "F":
                result.append(get_file_type(st.st_mode))
            elif code == "g":
                result.append(str(st.st_gid))
            elif code == "G":
                result.append(str(st.st_gid))
            elif code == "h":
                result.append(str(st.st_nlink))
            elif code == "i":
                result.append(str(st.st_ino))
            elif code == "n":
                result.append(filename)
            elif code == "N":
                if stat_mod.S_ISLNK(st.st_mode):
                    try:
                        link = os.readlink(filename)
                        result.append(f"'{filename}' -> '{link}'")
                    except OSError:
                        result.append(f"'{filename}'")
                else:
                    result.append(f"'{filename}'")
            elif code == "o":
                result.append("512")  # IO block size
            elif code == "s":
                result.append(str(st.st_size))
            elif code == "u":
                result.append(str(st.st_uid))
            elif code == "U":
                result.append(str(st.st_uid))
            elif code == "x":
                result.append(format_time(st.st_atime))
            elif code == "X":
                result.append(str(int(st.st_atime)))
            elif code == "y":
                result.append(format_time(st.st_mtime))
            elif code == "Y":
                result.append(str(int(st.st_mtime)))
            elif code == "z":
                result.append(format_time(st.st_ctime))
            elif code == "Z":
                result.append(str(int(st.st_ctime)))
            elif code == "%":
                result.append("%")
            else:
                result.append(f"%{code}")
            i += 2
        else:
            result.append(fmt[i])
            i += 1
    return "".join(result)


def default_output(st, filename, follow_links):
    """Print default stat output similar to GNU stat."""
    mode_str = format_mode(st.st_mode)
    file_type = get_file_type(st.st_mode)
    print(f"  File: {filename}")
    if stat_mod.S_ISLNK(st.st_mode) and not follow_links:
        try:
            link = os.readlink(filename)
            print(f"  Size: {st.st_size:<10} Blocks: {st.st_blocks:<10} IO Block: 512  {file_type}")
            print(f"Device: {st.st_dev:#x}  Inode: {st.st_ino:<10} Links: {st.st_nlink}")
            print(f"Access: ({oct(stat_mod.S_IMODE(st.st_mode))[2:]}/{mode_str})  Uid: ({st.st_uid:>5}/{st.st_uid})  Gid: ({st.st_gid:>5}/{st.st_gid})")
            print(f"Access: {format_time(st.st_atime)}")
            print(f"Modify: {format_time(st.st_mtime)}")
            print(f"Change: {format_time(st.st_ctime)}")
            print(f" Link: {link}")
        except OSError:
            print(f"  Size: {st.st_size:<10} Blocks: {st.st_blocks:<10} IO Block: 512  {file_type}")
            print(f"Device: {st.st_dev:#x}  Inode: {st.st_ino:<10} Links: {st.st_nlink}")
            print(f"Access: ({oct(stat_mod.S_IMODE(st.st_mode))[2:]}/{mode_str})  Uid: ({st.st_uid:>5}/{st.st_uid})  Gid: ({st.st_gid:>5}/{st.st_gid})")
            print(f"Access: {format_time(st.st_atime)}")
            print(f"Modify: {format_time(st.st_mtime)}")
            print(f"Change: {format_time(st.st_ctime)}")
    else:
        print(f"  Size: {st.st_size:<10} Blocks: {st.st_blocks:<10} IO Block: 512  {file_type}")
        print(f"Device: {st.st_dev:#x}  Inode: {st.st_ino:<10} Links: {st.st_nlink}")
        print(f"Access: ({oct(stat_mod.S_IMODE(st.st_mode))[2:]}/{mode_str})  Uid: ({st.st_uid:>5}/{st.st_uid})  Gid: ({st.st_gid:>5}/{st.st_gid})")
        print(f"Access: {format_time(st.st_atime)}")
        print(f"Modify: {format_time(st.st_mtime)}")
        print(f"Change: {format_time(st.st_ctime)}")


def main(args):
    follow_links = False
    format_str = None
    targets = []
    i = 0

    while i < len(args):
        arg = args[i]
        if arg == "--":
            i += 1
            targets.extend(args[i:])
            break
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 1:
            for ch in arg[1:]:
                if ch == "L":
                    follow_links = True
                elif ch == "c":
                    # -c FORMAT
                    i += 1
                    if i >= len(args):
                        print("stat: option requires an argument -- 'c'", file=sys.stderr)
                        sys.exit(1)
                    format_str = args[i]
                else:
                    print(f"stat: invalid option -- '{ch}'", file=sys.stderr)
                    print("Usage: stat [-L] [-c FORMAT] FILE...", file=sys.stderr)
                    sys.exit(1)
        elif arg.startswith("--format="):
            format_str = arg[len("--format="):]
        elif arg == "--format":
            i += 1
            if i >= len(args):
                print("stat: option --format requires an argument", file=sys.stderr)
                sys.exit(1)
            format_str = args[i]
        elif arg in ("--help", "-help"):
            print("Usage: stat [-L] [-c FORMAT] FILE...")
            print("  -L           follow symlinks")
            print("  -c FORMAT    use specified format (%%a %%A %%b %%B %%d %%D %%f %%F %%g %%G %%h %%i %%n %%N %%o %%s %%u %%U %%x %%X %%y %%Y %%z %%Z)")
            print("      --help   display this help and exit")
            print("      --version  output version information and exit")
            sys.exit(0)
        elif arg == "--version":
            print("stat (EdgeTerm bigbox)")
            sys.exit(0)
        else:
            targets.append(arg)
        i += 1

    if not targets:
        print("stat: missing operand", file=sys.stderr)
        print("Usage: stat [-L] [-c FORMAT] FILE...", file=sys.stderr)
        sys.exit(1)

    exit_code = 0
    for target in targets:
        if not os.path.lexists(target):
            print(f"stat: cannot stat '{target}': No such file or directory", file=sys.stderr)
            exit_code = 1
            continue

        try:
            if follow_links:
                st = os.stat(target)
            else:
                st = os.lstat(target)

            if format_str is not None:
                print(apply_format(format_str, st, target))
            else:
                if len(targets) > 1:
                    print(f"{target}:")
                default_output(st, target, follow_links)
                if len(targets) > 1:
                    print()
        except OSError as e:
            print(f"stat: cannot stat '{target}': {e}", file=sys.stderr)
            exit_code = 1

    sys.exit(exit_code)
