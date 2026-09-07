from edgeterm_pip import main as edgeterm_pip_main


async def main(args):
    mapped_args = ["pygame-ce" if str(arg).strip().lower() == "pygame" else arg for arg in args]
    result = edgeterm_pip_main(mapped_args)
    if hasattr(result, "__await__"):
        await result
