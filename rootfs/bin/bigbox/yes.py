import signal
import sys
import bigbox_utils


VERSION = "yes (EdgeTerm bigbox)"


def main(args):
    # Handle --help and --version
    for arg in args:
        if arg in ("--help", "-help"):
            bigbox_utils.print_help(
                "yes",
                "",
                [("", "output a string repeatedly until killed"),
                 ("STRING", "the string to output (default 'y')")],
            )
            sys.exit(0)
        if arg == "--version":
            print(VERSION)
            sys.exit(0)

    # Ignore SIGPIPE so broken pipe doesn't kill us with an exception
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

    string = " ".join(args) if args else "y"

    try:
        while True:
            sys.stdout.write(string + "\n")
    except BrokenPipeError:
        sys.stderr.close()
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(0)
