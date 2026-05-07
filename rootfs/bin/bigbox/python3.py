import importlib.util


async def main(args):
    spec = importlib.util.spec_from_file_location("bigbox.python", "/bin/bigbox/python.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    result = mod.main(args)
    if hasattr(result, "__await__"):
        await result
