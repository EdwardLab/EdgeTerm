"""wine11 - run Wine commands with the bundled Wine 11 root filesystem."""

import os

from wine import main as _wine_main


async def main(args):
    os.environ["EDGETERM_WINE_VERSION"] = "wine11"
    return await _wine_main(args)
