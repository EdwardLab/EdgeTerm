def main(args):
    commands = {
        # --- File Operations ---
        "cat":      "concatenate files and print on the standard output",
        "cp":       "copy files and directories",
        "mv":       "move or rename files",
        "rm":       "remove files or directories",
        "mkdir":    "make directories",
        "rmdir":    "remove empty directories",
        "touch":    "change file timestamps or create empty files",
        "ln":       "make links between files",
        "install":  "copy files and set attributes",
        "chown":    "change file owner and group",
        "chgrp":    "change file group ownership",
        "chmod":    "change file mode bits",
        "umask":    "get or set the file mode creation mask",
        "stat":     "display file or file system status",
        "ls":       "list directory contents",
        "dir":      "briefly list directory contents",
        "vdir":     "verbosely list directory contents",
        "du":       "estimate file space usage",
        "df":       "report file system disk space usage",
        "pathchk":  "check pathname validity",
        "mktemp":   "create a temporary file or directory",
        "readlink": "print the value of a symbolic link or canonical file name",
        "realpath": "print the resolved absolute pathname",
        "basename": "strip directory and suffix from filenames",
        "dirname":  "strip last component from file name",

        # --- Text Processing ---
        "echo":     "display a line of text",
        "printf":   "format and print data",
        "tee":      "read from stdin and write to stdout and files",
        "cut":      "remove sections from each line of files",
        "paste":    "merge lines of files",
        "join":     "join lines of two files on a common field",
        "tr":       "translate or delete characters",
        "expand":   "convert tabs to spaces",
        "unexpand": "convert spaces to tabs",
        "fold":     "wrap each input line to fit in specified width",
        "fmt":      "simple optimal text formatter",
        "nl":       "number lines of files",
        "od":       "dump files in octal and other formats",
        "hexdump":  "display file contents in hexadecimal (also: xxd, hd)",
        "rev":      "reverse lines characterwise",
        "column":   "columnate lists",
        "comm":     "compare two sorted files line by line",
        "cmp":      "compare two files byte by byte",
        "diff":     "compare files line by line",
        "sort":     "sort lines of text files",
        "uniq":     "report or omit repeated lines",
        "wc":       "print newline, word, and byte counts for each file",
        "strings":  "print the strings of printable characters in files",
        "dos2unix": "convert DOS text to Unix format",
        "unix2dos": "convert Unix text to DOS format",
        "iconv":    "convert text from one character encoding to another",
        "base64":   "encode or decode base64 data",

        # --- System Information ---
        "uname":    "print system information",
        "arch":     "print machine architecture",
        "hostname": "show or set the system hostname",
        "hostid":   "print the numeric identifier for the current host",
        "logname":  "print the user's login name",
        "whoami":   "print effective user name",
        "id":       "print real and effective user and group IDs",
        "groups":   "print the group names the user is in",
        "who":      "show who is logged on",
        "users":    "print the user names of users currently logged in",
        "tty":      "print the file name of the terminal connected to stdin",
        "uptime":   "tell how long the system has been running",
        "free":     "display amount of free and used memory",
        "vmstat":   "report virtual memory statistics",
        "nproc":    "print the number of processing units",
        "date":     "print or set the system date and time",
        "cal":      "display a calendar",
        "timeout":  "run a command with a time limit",
        "type":     "describe a command",
        "which":    "locate a command",
        "whereis":  "locate the binary, source, and manual page for a command",

        # --- Archives & Compression ---
        "tar":      "archive utility",
        "gzip":     "compress or expand files (gunzip, zcat)",
        "gunzip":   "decompress gzip files",
        "zcat":     "decompress gzip files to stdout",
        "zip":      "package and compress (archive) files",
        "unzip":    "list, test and extract compressed files in a ZIP archive",
        "xz":       "compress or decompress .xz files",
        "unxz":     "decompress .xz files",

        # --- Search & Find ---
        "grep":     "search for patterns in files (also: egrep, fgrep)",
        "find":     "search for files in a directory hierarchy",
        "locate":   "find files by name (updatedb-style)",
        "strings":  "print printable strings in binary files",

        # --- Math & Evaluation ---
        "expr":     "evaluate expressions",
        "bc":       "arbitrary-precision arithmetic language",
        "factor":   "factor numbers",
        "seq":      "print a sequence of numbers",
        "shuf":     "generate random permutations",
        "test":     "check file types and compare values (also: [)",

        # --- Hash & Checksum ---
        "md5sum":   "compute and check MD5 message digest",
        "sha1sum":  "compute and check SHA-1 message digest",
        "sha256sum": "compute and check SHA-256 message digest",
        "sha512sum": "compute and check SHA-512 message digest",

        # --- Networking ---
        "curl":     "transfer a URL",
        "wget":     "non-interactive network downloader",

        # --- Terminal / TTY ---
        "clear":    "clear the terminal screen",
        "reset":    "reset the terminal",
        "stty":     "change and print terminal line settings",
        "tty":      "print terminal name",

        # --- Process / Execution ---
        "sleep":    "delay for a specified amount of time",
        "true":     "do nothing, successfully",
        "false":    "do nothing, unsuccessfully",
        "yes":      "output a string repeatedly until killed",
        "watch":    "execute a program periodically, showing output fullscreen",
        "xargs":    "build and execute command lines from stdin",
        "timeout":  "run a command with a time limit",

        # --- Text Editors ---
        "nano":     "open the web-based text editor (also: vi, vim, code)",
        "less":     "pager -- view file contents page by page (also: more)",
        "more":     "pager -- view file contents page by page",

        # --- Scripting / Recording ---
        "script":   "make a typescript of a terminal session",

        # --- File splitting / combining ---
        "split":    "split a file into pieces",
        "tee":      "read from stdin and write to stdout and files",

        # --- Environment / Shell ---
        "cd":       "change the working directory",
        "pwd":      "print name of current/working directory",
        "exit":     "exit the shell",

        # --- Python / App Hosting ---
        "python":   "run the Python interpreter (python3, pip, pip3, micropip)",
        "edgeserve":   "start a local WSGI/ASGI app server",
        "edgepkg":     "install optional browser runtime packages",
        "pkg":         "install browser-native packages",
        "wine":        "run Win32 programs through browser BoxedWine/Wine",
        "wine11":      "run Win32 programs with the Wine 11 root filesystem",
        "wineconsole": "run a Wine console program",
        "winecfg":     "open Wine configuration",
        "winetricks":  "run Wine helper verbs",
        "edgeflask":   "Flask wrapper for EdgeServe",
        "edgeasgi":    "ASGI wrapper for EdgeServe",

        # --- Databases ---
        "sqlite3":  "SQLite interactive terminal",
    }

    print("EdgeTerm bigbox -- available commands:\n")

    # Organize into section groups
    sections = [
        ("File Operations", [
            "cat", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "ln",
            "install", "chown", "chgrp", "chmod", "umask", "stat",
            "ls", "dir", "vdir", "du", "df", "pathchk", "mktemp",
            "readlink", "realpath", "basename", "dirname",
        ]),
        ("Text Processing", [
            "echo", "printf", "tee", "cut", "paste", "join", "tr",
            "expand", "unexpand", "fold", "fmt", "nl", "od", "hexdump",
            "rev", "column", "comm", "cmp", "diff", "sort", "uniq",
            "wc", "strings", "dos2unix", "unix2dos", "iconv", "base64",
        ]),
        ("System Information", [
            "uname", "arch", "hostname", "hostid", "logname", "whoami",
            "id", "groups", "who", "users", "tty", "uptime", "free",
            "vmstat", "nproc", "date", "cal", "type", "which", "whereis",
        ]),
        ("Archives & Compression", [
            "tar", "gzip", "gunzip", "zcat", "zip", "unzip", "xz", "unxz",
        ]),
        ("Search & Find", [
            "grep", "find", "locate",
        ]),
        ("Math & Evaluation", [
            "expr", "bc", "factor", "seq", "shuf", "test",
        ]),
        ("Hash & Checksum", [
            "md5sum", "sha1sum", "sha256sum", "sha512sum",
        ]),
        ("Networking", [
            "curl", "wget",
        ]),
        ("Terminal / TTY", [
            "clear", "reset", "stty", "tty",
        ]),
        ("Process / Execution", [
            "sleep", "true", "false", "yes", "watch", "xargs", "timeout",
        ]),
        ("Text Editors & Pagers", [
            "nano", "vi", "vim", "code", "less", "more",
        ]),
        ("Scripting / Recording", [
            "script",
        ]),
        ("Python / App Hosting", [
            "python", "python3", "pip", "pip3", "micropip",
            "edgeserve", "edgeflask", "edgeasgi", "edgepkg",
            "wine", "wine11", "wineconsole", "winecfg", "winetricks",
        ]),
        ("Databases", [
            "sqlite3",
        ]),
        ("Environment / Shell", [
            "cd", "pwd", "exit", "help",
        ]),
    ]

    max_len = max(len(cmd) for cmd in commands)

    for section_name, cmd_list in sections:
        print(f"  [{section_name}]")
        for cmd in cmd_list:
            desc = commands.get(cmd, "")
            if desc:
                print(f"    {cmd:<{max_len}}  {desc}")
        print()

    print("Use '<command> --help' for detailed options on each command.")
