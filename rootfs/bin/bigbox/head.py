"""head — output the first part of files (bigbox standalone)"""
import sys
import bigbox_utils


def main(args):
    count = 10
    files = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "-n" and i + 1 < len(args):
            count = int(args[i + 1])
            i += 2
        elif arg.startswith("-n"):
            count = int(arg[2:])
            i += 1
        elif arg == "-c" and i + 1 < len(args):
            count = int(args[i + 1])
            i += 2
        elif arg == "--help":
            print("Usage: head [-n NUM] [-c NUM] [FILE...]")
            print("  -n NUM   print first NUM lines (default 10)")
            print("  -c NUM   print first NUM bytes")
            sys.exit(0)
        elif arg == "--version":
            print("head (EdgeTerm bigbox)")
            sys.exit(0)
        elif not arg.startswith("-"):
            files.append(arg)
            i += 1
        else:
            i += 1

    lines = bigbox_utils.read_input(files)

    if len(files) > 1:
        for f in files:
            flines = bigbox_utils.read_input([f])
            print(f"==> {f} <==")
            for line in flines[:count]:
                sys.stdout.write(line)
                if not line.endswith("\n"):
                    sys.stdout.write("\n")
    else:
        for line in lines[:count]:
            sys.stdout.write(line)
            if not line.endswith("\n"):
                sys.stdout.write("\n")

    sys.exit(0)
