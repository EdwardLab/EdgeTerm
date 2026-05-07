"""egrep — grep with extended regular expressions (same as grep -E)"""
import sys

# Import grep at top level so it resolves during exec_module when
# /bin/bigbox is temporarily on sys.path.  We do NOT manipulate sys.path
# here — that's handled by the shell's _run_applet.
import grep as _grep


def main(args):
    """Run grep with -E flag for extended regex support."""
    _grep.main(["-E"] + args)
