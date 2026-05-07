"""
tee — read from stdin and write to stdout and files.
Usage: tee [OPTION]... [FILE]...
"""
import signal
import sys
import bigbox_utils


VERSION = "tee (EdgeTerm bigbox)"
PROG = "tee"


def main(args):
    append = False
    ignore_interrupts = False
    files = []

    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                PROG,
                "[OPTION]... [FILE]...",
                [("-a", "append to the given FILEs, do not overwrite"),
                 ("-i", "ignore interrupt signals"),
                 ("", "Copy standard input to each FILE, and also to standard output.")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

        if arg.startswith("-") and len(arg) > 1 and arg != "-":
            for ch in arg[1:]:
                if ch == "a":
                    append = True
                elif ch == "i":
                    ignore_interrupts = True
                else:
                    print(f"{PROG}: invalid option -- '{ch}'", file=sys.stderr)
                    sys.exit(2)
        else:
            files.append(arg)

    if ignore_interrupts:
        signal.signal(signal.SIGINT, signal.SIG_IGN)

    # Open output files
    out_handles = []
    try:
        for fname in files:
            mode = "a" if append else "w"
            handle = open(fname, mode, encoding="utf-8", errors="replace")
            out_handles.append(handle)
    except IOError as e:
        print(f"{PROG}: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        # Read in chunks for streaming feel
        CHUNK_SIZE = 8192
        while True:
            chunk = sys.stdin.buffer.read(CHUNK_SIZE)
            if not chunk:
                break
            # Decode for text output
            text = chunk.decode("utf-8", errors="replace")
            sys.stdout.write(text)
            sys.stdout.flush()
            for handle in out_handles:
                handle.write(text)
                handle.flush()
    except KeyboardInterrupt:
        if not ignore_interrupts:
            pass
    finally:
        for handle in out_handles:
            handle.close()


if __name__ == "__main__":
    main(sys.argv[1:])
