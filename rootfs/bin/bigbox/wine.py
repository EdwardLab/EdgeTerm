"""wine - launch Win32 programs through EdgeTerm's browser BoxedWine bridge."""

import os
import shlex

import js


HELP = """Usage:
  wine <command> [args...]
  wine --multi-thread <command> [args...]
  wine --single-thread <command> [args...]
  wine explorer
  winecfg
  winetricks [verb...]

EdgeTerm Wine is experimental. It runs BoxedWine/Wine in the browser when the
optional runtime assets are installed with:

  edgepkg install boxedwine
  edgepkg install wine-runtime
"""


async def main(args):
    if args and args[0] in {"-h", "--help"}:
        print(HELP.strip())
        return 0
    normalized_args = []
    for arg in args:
        if arg == "--wine11":
            os.environ["EDGETERM_WINE_VERSION"] = "wine11"
        elif arg in {"--multi-thread", "--multithread", "--threaded"}:
            os.environ["EDGETERM_WINE_THREADING"] = "multi"
        elif arg in {"--single-thread", "--singlethread"}:
            os.environ["EDGETERM_WINE_THREADING"] = "single"
        elif arg.startswith("--threading="):
            value = arg.split("=", 1)[1].strip().lower()
            if value in {"multi", "multithread", "multi-thread", "threaded"}:
                os.environ["EDGETERM_WINE_THREADING"] = "multi"
            elif value in {"single", "singlethread", "single-thread"}:
                os.environ["EDGETERM_WINE_THREADING"] = "single"
            else:
                print(f"wine: unsupported threading mode: {value}")
                return 1
        else:
            normalized_args.append(arg)
    args = normalized_args
    if not args:
        print(HELP.strip())
        return 1

    bridge = getattr(js.window, "EdgeTermWine", None)
    if bridge is None:
        print("wine: EdgeTerm Wine bridge is not available in this browser session.")
        return 1

    cwd = os.environ.get("PWD") or os.getcwd()
    env = {key: str(value) for key, value in os.environ.items()}
    try:
        result = await bridge.runCommand("wine", args, cwd, env)
    except Exception as exc:
        print(f"wine: browser Wine bridge failed: {exc}")
        return 1

    stdout = getattr(result, "stdout", "") if not hasattr(result, "get") else result.get("stdout")
    stderr = getattr(result, "stderr", "") if not hasattr(result, "get") else result.get("stderr")
    code = getattr(result, "code", 1) if not hasattr(result, "get") else result.get("code")
    if stdout:
        print(str(stdout), end="" if str(stdout).endswith("\n") else "\n")
    if stderr:
        print(str(stderr), end="" if str(stderr).endswith("\n") else "\n")
    return int(code or 0)


def quote_command(args):
    return " ".join(shlex.quote(str(arg)) for arg in args)
