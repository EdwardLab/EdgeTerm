"""winetricks - EdgeTerm Wine helper alias."""

from wine import main as _wine_main


async def main(args):
    return await _wine_main(["winetricks", *args])
