"""
unxz — decompress XZ files.
Thin wrapper that calls xz.main with -d flag prepended.
"""
import sys
import xz  # local module


def main(args):
    new_args = ["-d"] + list(args)
    xz.main(new_args)


if __name__ == "__main__":
    main(sys.argv[1:])
