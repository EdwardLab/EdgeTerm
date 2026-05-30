"""wineconsole - EdgeTerm Wine console alias."""

from wine import main as _wine_main


async def main(args):
    return await _wine_main(["wineconsole", *args])
