function debugError(code, message, recoverable = false) {
  return Object.assign(new Error(message), { code, recoverable });
}

export class EdgeTermDebugController extends EventTarget {
  constructor({ adapters = {} } = {}) {
    super();
    this.adapters = new Map(Object.entries(adapters));
    this.sessions = new Map();
  }

  register(type, adapter) {
    this.adapters.set(String(type || ""), adapter);
  }

  async start(configuration = {}) {
    const type = String(configuration.type || "").toLowerCase();
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw debugError("debug_adapter_unavailable", `The ${type || "requested"} debugger is not available in this runtime.`);
    }
    const id = String(configuration.session_id || crypto.randomUUID());
    const session = {
      id,
      type,
      name: String(configuration.name || `${type} debug session`).slice(0, 120),
      state: "starting",
      breakpoints: Array.isArray(configuration.breakpoints) ? configuration.breakpoints : [],
      started_at: new Date().toISOString(),
      stopped_at: null,
      adapter,
      handle: null,
    };
    this.sessions.set(id, session);
    session.handle = await adapter.start({ ...configuration, session_id: id });
    session.state = String(session.handle?.state || "running");
    this.dispatchEvent(new CustomEvent("debug.started", { detail: this.describe(id) }));
    return this.describe(id);
  }

  async command(id, command, params = {}) {
    const session = this.sessions.get(String(id || ""));
    if (!session) throw debugError("debug_session_not_found", "The debug session was not found.");
    if (!session.adapter.command) throw debugError("debug_command_unavailable", "This debugger does not support commands.");
    const result = await session.adapter.command(session.handle, String(command || ""), params);
    if (result?.state) session.state = result.state;
    this.dispatchEvent(new CustomEvent("debug.updated", { detail: { session: this.describe(id), result } }));
    return { session: this.describe(id), result };
  }

  async stop(id) {
    const session = this.sessions.get(String(id || ""));
    if (!session) throw debugError("debug_session_not_found", "The debug session was not found.");
    await session.adapter.stop?.(session.handle);
    session.state = "stopped";
    session.stopped_at = new Date().toISOString();
    this.dispatchEvent(new CustomEvent("debug.stopped", { detail: this.describe(id) }));
    return this.describe(id);
  }

  describe(id) {
    const session = this.sessions.get(String(id || ""));
    if (!session) throw debugError("debug_session_not_found", "The debug session was not found.");
    const { adapter, handle, ...publicSession } = session;
    const runtime = typeof adapter.snapshot === "function" && handle
      ? adapter.snapshot(handle)
      : {};
    return { ...publicSession, ...runtime };
  }

  capabilities() {
    return [...this.adapters.entries()].map(([type, adapter]) => ({ type, ...(adapter.capabilities || {}) }));
  }
}
