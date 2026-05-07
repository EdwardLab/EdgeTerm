"""fgrep — grep with fixed strings (same as grep -F)"""
import sys

# Import grep at top level so it resolves during exec_module when
# /bin/bigbox is temporarily on sys.path.
import grep as _grep


def main(args):
    """Run grep with -F flag for fixed-string matching."""
    _grep.main(["-F"] + args)
