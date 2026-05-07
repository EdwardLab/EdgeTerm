"""
zcat — decompress to stdout.
Thin wrapper that calls gzip.main with -c -d flags.
"""
import sys
import gzip  # local module


def main(args):
    new_args = ["-c", "-d"] + list(args)
    gzip.main(new_args)


if __name__ == "__main__":
    main(sys.argv[1:])
