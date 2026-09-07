function debugError(code, message) {
  return Object.assign(new Error(message), { code, recoverable: false });
}

export class PythonDebugAdapter {
  constructor({ workerUrl, readFile }) {
    this.workerUrl = workerUrl;
    this.readFile = readFile;
    this.capabilities = {
      breakpoints: true,
      continue: true,
      step: true,
      call_stack: true,
      locals: true,
      stop: true,
      scope: "single-file",
    };
  }

  async start(configuration = {}) {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
      throw debugError("debug_isolation_required", "Python debugging requires cross-origin isolation and SharedArrayBuffer.");
    }
    const path = String(configuration.path || "").trim();
    if (!path.endsWith(".py")) throw debugError("debug_python_path_required", "Choose a Python file to debug.");
    const source = await this.readFile(path);
    const worker = new Worker(this.workerUrl, { name: "edgeterm-python-debugger" });
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const control = new Int32Array(shared);
    const handle = {
      worker,
      control,
      path,
      state: "starting",
      line: null,
      locals: {},
      stack: [],
      error: "",
      exit_code: null,
    };
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(debugError("debug_start_timeout", "The Python debugger did not start in time.")), 30_000);
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.type === "ready") {
          clearTimeout(timeout);
          handle.state = "running";
          resolve();
        } else if (message.type === "paused") {
          handle.state = "paused";
          handle.line = Number(message.line || 0);
          handle.locals = message.locals || {};
          handle.stack = message.stack || [];
        } else if (["completed", "stopped", "error"].includes(message.type)) {
          handle.state = message.type;
          handle.error = String(message.error || "");
          handle.exit_code = Number(message.exit_code ?? (message.type === "completed" ? 0 : 1));
          if (message.type === "error") {
            clearTimeout(timeout);
            reject(debugError("debug_program_failed", handle.error || "The Python program failed."));
          }
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(debugError("debug_worker_failed", String(event.message || "The Python debugger worker failed.")));
      };
    });
    worker.postMessage({
      type: "start",
      source,
      path,
      breakpoints: configuration.breakpoints || [],
      packages: Array.isArray(configuration.packages) ? configuration.packages : [],
      control: shared,
    });
    await ready;
    return handle;
  }

  async command(handle, command) {
    if (command === "status") return this.snapshot(handle);
    const commands = { continue: 1, step: 2, stop: 3 };
    const value = commands[command];
    if (!value) throw debugError("debug_command_invalid", "Choose continue, step, status, or stop.");
    if (["completed", "stopped", "error"].includes(handle.state)) return this.snapshot(handle);
    handle.state = command === "stop" ? "stopping" : "running";
    Atomics.store(handle.control, 0, value);
    Atomics.notify(handle.control, 0);
    return this.snapshot(handle);
  }

  async stop(handle) {
    if (!["completed", "stopped", "error"].includes(handle.state)) {
      Atomics.store(handle.control, 0, 3);
      Atomics.notify(handle.control, 0);
    }
    handle.worker.terminate();
    handle.state = "stopped";
    handle.error = "";
  }

  snapshot(handle) {
    return {
      state: handle.state,
      path: handle.path,
      line: handle.line,
      locals: { ...handle.locals },
      stack: [...handle.stack],
      error: handle.error,
      exit_code: handle.exit_code,
    };
  }
}
