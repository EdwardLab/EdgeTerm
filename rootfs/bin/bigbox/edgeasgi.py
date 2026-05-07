"""edgeasgi — ASGI wrapper for EdgeServe (alias for edgeserve asgi)"""
import sys

# Import at top level; sys.path setup handled by _run_applet
from edgeserve import main as _edgeserve_main


async def main(args):
    return await _edgeserve_main(["asgi", *args])
