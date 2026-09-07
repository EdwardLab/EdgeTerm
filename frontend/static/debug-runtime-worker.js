let control = null;
let pyodide = null;

function post(type, detail = {}) {
  self.postMessage({ type, ...detail });
}

function pause(line, locals, stack) {
  post("paused", { line: Number(line), locals: JSON.parse(String(locals || "{}")), stack: JSON.parse(String(stack || "[]")) });
  Atomics.store(control, 1, 1);
  Atomics.wait(control, 0, 0);
  Atomics.store(control, 1, 0);
  return Atomics.exchange(control, 0, 0);
}

async function start(message) {
  control = new Int32Array(message.control);
  const indexURL = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/";
  importScripts(`${indexURL}pyodide.js`);
  pyodide = await loadPyodide({ indexURL, fullStdLib: false });
  const packages = Array.isArray(message.packages)
    ? message.packages.map(String).filter((value) => /^[A-Za-z0-9_.-]+(?:[<>=!~]=?[A-Za-z0-9_.-]+)?$/.test(value)).slice(0, 50)
    : [];
  if (packages.length) {
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    try {
      await micropip.install(packages);
    } finally {
      micropip.destroy();
    }
  }
  pyodide.globals.set("__edge_debug_source", String(message.source || ""));
  pyodide.globals.set("__edge_debug_path", String(message.path || "debug.py"));
  pyodide.globals.set("__edge_debug_breakpoints", (message.breakpoints || []).map((value) => Number(value)).filter(Number.isFinite));
  pyodide.globals.set("__edge_debug_pause", pause);
  post("ready");
  try {
    await pyodide.runPythonAsync(`
import json
import sys
import traceback

_edge_breakpoints = set(int(value) for value in __edge_debug_breakpoints)
_edge_step = False

def _edge_safe_locals(frame):
    result = {}
    for key, value in frame.f_locals.items():
        if key.startswith("__"):
            continue
        try:
            text = repr(value)
        except Exception:
            text = "<unavailable>"
        result[str(key)] = text[:500]
    return result

def _edge_trace(frame, event, argument):
    global _edge_step
    if event != "line" or frame.f_code.co_filename != __edge_debug_path:
        return _edge_trace
    line = frame.f_lineno
    if line not in _edge_breakpoints and not _edge_step:
        return _edge_trace
    stack = [{"path": item.filename, "line": item.lineno, "name": item.name} for item in traceback.extract_stack(frame)[-30:]]
    command = int(__edge_debug_pause(line, json.dumps(_edge_safe_locals(frame)), json.dumps(stack)))
    if command == 3:
        raise KeyboardInterrupt("Debug session stopped")
    _edge_step = command == 2
    return _edge_trace

_edge_namespace = {"__name__": "__main__", "__file__": __edge_debug_path}
sys.settrace(_edge_trace)
try:
    exec(compile(__edge_debug_source, __edge_debug_path, "exec"), _edge_namespace, _edge_namespace)
finally:
    sys.settrace(None)
`);
    post("completed", { exit_code: 0 });
  } catch (error) {
    const stopped = String(error?.message || error).includes("Debug session stopped");
    post(stopped ? "stopped" : "error", { error: String(error?.message || error), exit_code: stopped ? 130 : 1 });
  }
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "start") start(message).catch((error) => post("error", { error: String(error?.message || error), exit_code: 1 }));
};
