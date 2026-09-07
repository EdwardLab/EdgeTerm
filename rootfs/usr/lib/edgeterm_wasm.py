import json
import traceback

import js


def _describe_exception(exc):
    parts = []
    for attr in ("name", "message", "stack"):
        value = getattr(exc, attr, None)
        if value:
            parts.append(str(value))
    js_error = getattr(exc, "js_error", None)
    if js_error is not None:
        for attr in ("name", "message", "stack"):
            value = getattr(js_error, attr, None)
            if value:
                parts.append(str(value))
        try:
            json_value = js.JSON.stringify(js_error)
            if json_value and str(json_value) != "{}":
                parts.append(str(json_value))
        except Exception:
            pass
    text = str(exc)
    if text and text != "[object Object]":
        parts.append(text)
    if parts:
        return " | ".join(dict.fromkeys(parts))
    return "".join(traceback.format_exception_only(type(exc), exc)).strip() or "unknown error"


async def run_wasm_command(command, args, stdin_text, cwd, env):
    runtime = getattr(js.window, "EdgeTermWasmCLI", None)
    if runtime is None:
        return {
            "found": True,
            "code": 1,
            "stdout": "",
            "stderr": f"{command}: EdgeTerm WASM runtime is not available\n",
        }
    try:
        runner = getattr(runtime, "runCommandText", None) or runtime.runCommandJSON
        result_json = await runner(
            command,
            json.dumps(list(args)),
            stdin_text or "",
            cwd or "/",
            json.dumps(dict(env or {})),
        )
        return json.loads(str(result_json))
    except Exception as exc:
        return {
            "found": True,
            "code": 1,
            "stdout": "",
            "stderr": f"{command}: EdgeTerm WASM bridge failed: {_describe_exception(exc)}\n",
        }


def which_wasm_command(command):
    runtime = getattr(js.window, "EdgeTermWasmCLI", None)
    if runtime is None:
        return None
    result = runtime.which(command)
    if result is None or result == js.undefined:
        return None
    return str(result)


def resolve_wasm_command_path(path):
    runtime = getattr(js.window, "EdgeTermWasmCLI", None)
    if runtime is None:
        return None
    try:
        result = runtime.commandForPath(path)
        if result is None or result == js.undefined:
            return None
        return str(result)
    except Exception:
        return None
