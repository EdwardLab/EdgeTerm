const DEFAULT_INTERFACES = {
  "wasi:cli/environment": { capability: "environment", permission: "granted" },
  "wasi:cli/stdin": { capability: "terminal", permission: "granted" },
  "wasi:cli/stdout": { capability: "terminal", permission: "granted" },
  "wasi:cli/stderr": { capability: "terminal", permission: "granted" },
  "wasi:filesystem/types": { capability: "filesystem", permission: "workspace" },
  "wasi:filesystem/preopens": { capability: "filesystem", permission: "workspace" },
  "wasi:clocks/monotonic-clock": { capability: "clocks", permission: "granted" },
  "wasi:clocks/wall-clock": { capability: "clocks", permission: "granted" },
  "wasi:random/random": { capability: "random", permission: "granted" },
  "wasi:http/outgoing-handler": { capability: "http", permission: "ask" },
  "wasi:sockets/tcp": { capability: "sockets", permission: "unavailable" },
  "wasi:sockets/udp": { capability: "sockets", permission: "unavailable" },
};

function componentError(code, message) {
  return Object.assign(new Error(message), { code, recoverable: false });
}

export class EdgeTermComponentHost {
  constructor({ permissions = {}, interfaces = {} } = {}) {
    this.interfaces = new Map();
    this.handlers = new Map();
    for (const [name, descriptor] of Object.entries({ ...DEFAULT_INTERFACES, ...interfaces })) {
      this.interfaces.set(name, {
        name,
        ...descriptor,
        permission: permissions[descriptor.capability] || descriptor.permission,
      });
    }
  }

  register(name, handler, descriptor = {}) {
    if (typeof handler !== "function") {
      throw componentError("component_handler_invalid", "A component interface handler must be a function.");
    }
    const current = this.interfaces.get(name) || { name, capability: "custom", permission: "ask" };
    this.interfaces.set(name, { ...current, ...descriptor, name });
    this.handlers.set(name, handler);
  }

  async invoke(name, operation, payload = {}, context = {}) {
    const descriptor = this.interfaces.get(String(name || ""));
    if (!descriptor) throw componentError("component_interface_unknown", `Unknown component interface: ${name}`);
    if (descriptor.permission === "unavailable") {
      throw componentError(
        "component_capability_unavailable",
        `${descriptor.capability} is not available in this browser runtime.`,
      );
    }
    if (descriptor.permission === "ask" && context.approved !== true) {
      throw componentError(
        "component_permission_required",
        `${descriptor.capability} requires separate approval.`,
      );
    }
    const handler = this.handlers.get(descriptor.name);
    if (!handler) {
      throw componentError(
        "component_interface_not_implemented",
        `${descriptor.name} is declared but does not have a host implementation yet.`,
      );
    }
    return await handler(String(operation || ""), payload, context);
  }

  manifest() {
    return {
      schema: "edgeterm.component-host.v1",
      experimental: true,
      wasi_versions: ["0.2", "0.3-preview"],
      interfaces: [...this.interfaces.values()].map((descriptor) => ({ ...descriptor })),
    };
  }
}
