"""
gunzip — decompress files.
Thin wrapper that calls gzip.main with -d flag prepended.
"""
import sys
import gzip  # local module


def main(args):
    # Prepend -d flag to args
    new_args = ["-d"] + list(args)
    gzip.main(new_args)


if __name__ == "__main__":
    main(sys.argv[1:])
