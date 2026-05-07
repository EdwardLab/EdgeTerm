import os

import js


HELP = """Usage:
  edgeserve flask module:app
  edgeserve asgi module:app
  edgeserve django project.wsgi:application
  edgeserve static .

Aliases:
  edgeflask module:app  -> edgeserve flask module:app
  edgeasgi module:app   -> edgeserve asgi module:app
"""


async def main(args):
    if not args or args[0] in {"-h", "--help"}:
        print(HELP.strip())
        return 0 if args else 1

    mode = args[0].lower()
    if mode in {"flask", "wsgi", "django", "asgi", "fastapi", "starlette", "static"}:
        target_args = args[1:]
    else:
        mode = "flask"
        target_args = args

    if not target_args:
        print(f"edgeserve: missing target for {mode}")
        print(HELP.strip())
        return 1

    target = target_args[0]
    cwd = os.environ.get("PWD") or os.getcwd()
    try:
        opened = await js.window.EdgeTermServe.start(mode, target, cwd)
        prefix = opened.get("routePrefix") if hasattr(opened, "get") else opened.routePrefix
        instance_id = opened.get("id") if hasattr(opened, "get") else opened.id
        print(f"[edgeserve] {mode} serving {target} at {prefix}/")
        print(f"[edgeserve] instance {instance_id}; no TCP sockets or OS subprocesses are used.")
        return 0
    except Exception as exc:
        print(f"edgeserve: failed to start {mode} app: {exc}")
        suggestion = _suggest_local_app_spec(target, cwd) if mode in {"flask", "wsgi"} else ""
        if suggestion:
            print(f"edgeserve: did you mean `{suggestion}`?")
        return 1


def _suggest_local_app_spec(spec, cwd):
    module_name = str(spec or "").split(":", 1)[0].strip()
    if os.path.isfile(os.path.join(cwd, f"{module_name}.py")):
        return ""
    try:
        for name in sorted(os.listdir(cwd)):
            if not name.endswith(".py") or name.startswith("."):
                continue
            path = os.path.join(cwd, name)
            with open(path, encoding="utf-8") as handle:
                text = handle.read(4096)
            if "Flask(" in text and "app" in text:
                return f"{name[:-3]}:app"
    except Exception:
        return ""
    return ""
