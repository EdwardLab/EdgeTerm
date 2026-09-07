const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

function processError(code, message, recoverable = false) {
  return Object.assign(new Error(message), { code, recoverable });
}

function normalizeDimensions(value = {}) {
  const columns = Math.max(20, Math.min(500, Number(value.columns || value.cols || 80)));
  const rows = Math.max(5, Math.min(200, Number(value.rows || 24)));
  return { columns: Math.round(columns), rows: Math.round(rows) };
}

export class EdgeTermProcessHost extends EventTarget {
  constructor({ driver, workspaceGeneration = () => "" } = {}) {
    super();
    if (!driver?.start || !driver?.status || !driver?.output) {
      throw processError(
        "process_driver_invalid",
        "The process driver must provide start, status, and output methods.",
      );
    }
    this.driver = driver;
    this.workspaceGeneration = workspaceGeneration;
    this.processes = new Map();
  }

  emit(type, process, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { process: { ...process }, ...detail } }));
  }

  record(id) {
    const process = this.processes.get(String(id || ""));
    if (!process) throw processError("process_not_found", "The process was not found.");
    return process;
  }

  async start(spec = {}) {
    const command = String(spec.command || "").trim();
    if (!command) throw processError("process_command_required", "Enter a command to start.");
    const id = String(spec.process_id || crypto.randomUUID());
    if (this.processes.has(id)) {
      throw processError("process_id_conflict", "A process already uses this identifier.");
    }
    const process = {
      id,
      command,
      cwd: String(spec.cwd || "/home/user"),
      state: "starting",
      foreground: spec.foreground !== false,
      pty: spec.pty !== false,
      dimensions: normalizeDimensions(spec.dimensions),
      started_at: new Date().toISOString(),
      finished_at: null,
      exit_code: null,
      error_code: null,
      workspace_generation: String(this.workspaceGeneration() || ""),
    };
    this.processes.set(id, process);
    this.emit("process.started", process);
    try {
      const started = await this.driver.start({
        ...spec,
        process_id: id,
        command,
        cwd: process.cwd,
        dimensions: process.dimensions,
      });
      process.driver_id = String(started?.execution_id || started?.process_id || id);
      process.state = String(started?.status || "running");
      if (TERMINAL_STATES.has(process.state)) {
        process.exit_code = Number(started?.exit_code ?? (process.state === "completed" ? 0 : 1));
        process.finished_at = new Date().toISOString();
      }
      this.emit("process.updated", process);
      return this.describe(id);
    } catch (error) {
      process.state = "failed";
      process.error_code = String(error?.code || "process_start_failed");
      process.finished_at = new Date().toISOString();
      this.emit("process.completed", process, { error });
      throw error;
    }
  }

  async status(id) {
    const process = this.record(id);
    if (TERMINAL_STATES.has(process.state)) return this.describe(id);
    const status = await this.driver.status({ execution_id: process.driver_id || process.id });
    const execution = status?.execution || status || {};
    process.state = String(execution.status || (status?.running ? "running" : process.state));
    if (TERMINAL_STATES.has(process.state)) {
      process.exit_code = Number(execution.exit_code ?? (process.state === "completed" ? 0 : 1));
      process.finished_at = execution.completed_at || new Date().toISOString();
      this.emit("process.completed", process);
    } else {
      this.emit("process.updated", process);
    }
    return this.describe(id);
  }

  async output(id, options = {}) {
    const process = this.record(id);
    return await this.driver.output({
      execution_id: process.driver_id || process.id,
      offset: Number(options.offset || 0),
      max_chars: Number(options.max_chars || 24_000),
    });
  }

  async input(id, data) {
    const process = this.record(id);
    if (TERMINAL_STATES.has(process.state)) {
      throw processError("process_not_running", "The process is no longer running.");
    }
    if (!this.driver.input) {
      throw processError("process_input_unavailable", "This runtime does not accept process input.");
    }
    return await this.driver.input({ execution_id: process.driver_id || process.id, data: String(data ?? "") });
  }

  async signal(id, signal = "SIGINT") {
    const process = this.record(id);
    const normalized = String(signal || "SIGINT").toUpperCase();
    if (!new Set(["SIGINT", "SIGTERM", "SIGKILL"]).has(normalized)) {
      throw processError("process_signal_invalid", "Choose SIGINT, SIGTERM, or SIGKILL.");
    }
    if (!this.driver.signal) {
      throw processError("process_signal_unavailable", "This runtime does not support signals.");
    }
    const result = await this.driver.signal({ execution_id: process.driver_id || process.id, signal: normalized });
    if (result?.cancelled || normalized === "SIGKILL") {
      process.state = "cancelled";
      process.exit_code = 128 + (normalized === "SIGINT" ? 2 : normalized === "SIGTERM" ? 15 : 9);
      process.finished_at = new Date().toISOString();
      this.emit("process.completed", process);
    }
    return { ...result, process: this.describe(id) };
  }

  async resize(id, dimensions = {}) {
    const process = this.record(id);
    if (!this.driver.resize) {
      throw processError("process_resize_unavailable", "This runtime does not support terminal resizing.");
    }
    process.dimensions = normalizeDimensions(dimensions);
    await this.driver.resize({ execution_id: process.driver_id || process.id, ...process.dimensions });
    this.emit("process.updated", process);
    return this.describe(id);
  }

  async wait(id, { interval_ms = 100, timeout_ms = 0 } = {}) {
    const started = performance.now();
    while (true) {
      const process = await this.status(id);
      if (TERMINAL_STATES.has(process.state)) return process;
      if (timeout_ms > 0 && performance.now() - started >= timeout_ms) {
        throw processError("process_wait_timeout", "The process is still running.", true);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.min(2_000, interval_ms))));
    }
  }

  describe(id) {
    return { ...this.record(id) };
  }

  list() {
    return [...this.processes.values()].map((process) => ({ ...process }));
  }
}

export function processCapabilities(overrides = {}) {
  return {
    version: 1,
    stdin: true,
    stdout: true,
    stderr: true,
    pty: true,
    resize: true,
    signals: ["SIGINT", "SIGTERM", "SIGKILL"],
    background: true,
    raw_sockets: false,
    fork: false,
    devices: false,
    ...overrides,
  };
}
