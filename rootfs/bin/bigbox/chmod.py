"""chmod — change file mode bits (bigbox standalone)

For full functionality including symbolic modes, chmod is handled
as a shell built-in. This standalone applet provides basic octal-only
chmod for bigbox invocation.
"""
import os
import sys


def main(args):
    if not args or args[0] in ("--help", "-help"):
        print("Usage: chmod [OPTION]... MODE FILE...")
        print("  MODE can be octal (e.g., 755) or symbolic (e.g., u+x)")
        print("  -R       change files and directories recursively")
        print("  --help   display this help")
        sys.exit(0)

    if args[0] == "--version":
        print("chmod (EdgeTerm bigbox)")
        sys.exit(0)

    recursive = False
    mode_spec = None
    files = []
    i = 0

    while i < len(args):
        arg = args[i]
        if arg == "-R":
            recursive = True
            i += 1
        elif mode_spec is None:
            mode_spec = arg
            i += 1
        else:
            files.append(arg)
            i += 1

    if mode_spec is None or not files:
        print("chmod: missing operand", file=sys.stderr)
        sys.exit(1)

    # Try octal
    try:
        mode = int(mode_spec, 8)
    except ValueError:
        print(f"chmod: invalid mode: '{mode_spec}'", file=sys.stderr)
        print("chmod: symbolic modes require the EdgeTerm shell built-in", file=sys.stderr)
        print("chmod: use octal modes (e.g., 755) with the bigbox applet", file=sys.stderr)
        sys.exit(1)

    for path in files:
        targets = [path]
        if recursive and os.path.isdir(path):
            targets = []
            for root, _, names in os.walk(path):
                targets.append(root)
                for name in names:
                    targets.append(os.path.join(root, name))

        for target in targets:
            if not os.path.exists(target):
                print(f"chmod: cannot access '{target}': No such file or directory", file=sys.stderr)
                continue
            try:
                os.chmod(target, mode)
            except OSError:
                print(f"chmod: changing permissions of '{target}': Operation not supported on this filesystem", file=sys.stderr)

    sys.exit(0)
