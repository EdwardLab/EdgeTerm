export const EDGETERM_BRIDGE_PROTOCOL = "edgeterm.bridge.v3";
export const EDGETERM_BRIDGE_VERSION = "3.0.0";

const MAX_REQUEST_BYTES = 1_048_576;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function normalizeAllowedOrigins(origins) {
  const normalized = new Set();
  for (const candidate of Array.isArray(origins) ? origins : []) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        continue;
      }
      normalized.add(parsed.origin);
    } catch {}
  }
  return normalized;
}

function serializeError(error, params = {}, startedAt = new Date().toISOString()) {
  const code = String(error?.code || "bridge_request_failed");
  return {
    code,
    error_code: code,
    message: String(error?.message || error || "EdgeTerm Bridge request failed").slice(0, 2_000),
    recoverable:
      typeof error?.recoverable === "boolean"
        ? error.recoverable
        : [
            "bridge_file_exists",
            "bridge_file_changed",
            "bridge_patch_context_missing",
            "bridge_patch_context_ambiguous",
            "bridge_execution_busy",
            "runtime_not_ready",
          ].includes(code),
    request_id: String(params.request_id || ""),
    idempotency_key: String(params.idempotency_key || ""),
    status: "failed",
    summary: String(error?.message || error || "EdgeTerm Bridge request failed").slice(0, 500),
    artifact_handles: [],
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}

function payloadSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_REQUEST_BYTES + 1;
  }
}

export function createEdgeTermBridgeServer({
  enabled = false,
  allowedOrigins = [],
  runtimeVersion = "development",
  targetWindow = globalThis.window,
  invoke,
  getCapabilities,
}) {
  const origins = normalizeAllowedOrigins(allowedOrigins);
  let activePort = null;
  let activeSessionId = "";
  let activeOrigin = "";
  let started = false;
  let hostSequence = 0;
  const pendingHostRequests = new Map();

  const send = (payload) => {
    if (!activePort) return false;
    activePort.postMessage({
      protocol: EDGETERM_BRIDGE_PROTOCOL,
      session_id: activeSessionId,
      ...payload,
    });
    return true;
  };

  const emit = (event, data = {}) =>
    send({
      kind: "event",
      event: String(event || ""),
      data,
    });

  const closeSession = () => {
    for (const pending of pendingHostRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        Object.assign(new Error("The embedding host connection was closed."), {
          code: "bridge_host_closed",
          recoverable: true,
        }),
      );
    }
    pendingHostRequests.clear();
    try {
      activePort?.close?.();
    } catch {}
    activePort = null;
    activeSessionId = "";
    activeOrigin = "";
  };

  const handlePortMessage = async (event) => {
    const message = event.data || {};
    if (
      message.protocol !== EDGETERM_BRIDGE_PROTOCOL ||
      message.session_id !== activeSessionId
    ) {
      return;
    }
    if (message.kind === "host_response") {
      const pending = pendingHostRequests.get(String(message.id || ""));
      if (!pending) return;
      pendingHostRequests.delete(String(message.id || ""));
      clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message.result);
      else {
        pending.reject(
          Object.assign(
            new Error(String(message.error?.message || "The embedding host request failed.")),
            {
              code: String(message.error?.code || "bridge_host_request_failed"),
              recoverable: Boolean(message.error?.recoverable),
            },
          ),
        );
      }
      return;
    }
    if (message.kind !== "request") return;
    const id = String(message.id || "");
    const method = String(message.method || "");
    if (!id || !method) return;
    const startedAt = new Date().toISOString();
    if (payloadSize(message) > MAX_REQUEST_BYTES) {
      send({
        kind: "response",
        id,
        ok: false,
        error: serializeError(
          Object.assign(
            new Error("The EdgeTerm Bridge request is too large."),
            { code: "bridge_request_too_large" },
          ),
          message.params || {},
          startedAt,
        ),
      });
      return;
    }
    try {
      const result = await invoke(method, message.params || {}, {
        origin: activeOrigin,
        sessionId: activeSessionId,
        emit,
      });
      send({ kind: "response", id, ok: true, result });
    } catch (error) {
      send({
        kind: "response",
        id,
        ok: false,
        error: serializeError(error, message.params || {}, startedAt),
      });
    }
  };

  const handleWindowMessage = (event) => {
    if (!enabled || event.source !== targetWindow.parent) return;
    const message = event.data || {};
    if (message.type === "edgeterm.bridge.connect") {
      console.info("[BRIDGE] Connection request received.", {
        origin: event.origin,
        protocol: message.protocol,
        nonce_valid: NONCE_PATTERN.test(String(message.nonce || "")),
        origin_allowed: origins.has(event.origin),
        port_received: Boolean(event.ports?.[0]),
      });
    }
    if (
      message.type !== "edgeterm.bridge.connect" ||
      message.protocol !== EDGETERM_BRIDGE_PROTOCOL ||
      !NONCE_PATTERN.test(String(message.nonce || "")) ||
      !origins.has(event.origin)
    ) {
      return;
    }
    const port = event.ports?.[0];
    if (!port) return;
    closeSession();
    activePort = port;
    activeOrigin = event.origin;
    activeSessionId = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
    activePort.addEventListener("message", handlePortMessage);
    activePort.start?.();
    send({
      kind: "connected",
      nonce: message.nonce,
      bridge_version: EDGETERM_BRIDGE_VERSION,
      runtime_version: runtimeVersion,
      capabilities: getCapabilities(),
    });
    console.info("[BRIDGE] Connection established.", {
      origin: activeOrigin,
      protocol: EDGETERM_BRIDGE_PROTOCOL,
      version: EDGETERM_BRIDGE_VERSION,
    });
  };

  return {
    start() {
      if (!enabled || started) return false;
      if (!origins.size) {
        console.warn("[BRIDGE] Embed mode is enabled without an allowed parent origin.");
        return false;
      }
      targetWindow.addEventListener("message", handleWindowMessage);
      started = true;
      return true;
    },
    emit,
    requestHost(method, params = {}, options = {}) {
      if (!activePort || !activeSessionId) {
        return Promise.reject(
          Object.assign(new Error("DigitalPlat Bridge is not connected."), {
            code: "bridge_host_unavailable",
            recoverable: true,
          }),
        );
      }
      hostSequence += 1;
      const id = `host-${Date.now().toString(36)}-${hostSequence.toString(36)}`;
      const timeoutMs = Math.max(
        1_000,
        Math.min(Number(options.timeoutMs) || 30_000, 300_000),
      );
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingHostRequests.delete(id);
          reject(
            Object.assign(new Error(`DigitalPlat did not complete ${method}.`), {
              code: "bridge_host_timeout",
              recoverable: true,
            }),
          );
        }, timeoutMs);
        pendingHostRequests.set(id, { resolve, reject, timeout });
      });
      send({
        kind: "host_request",
        id,
        method: String(method || ""),
        params,
      });
      return response;
    },
    closeSession,
    dispose() {
      if (started) targetWindow.removeEventListener("message", handleWindowMessage);
      closeSession();
      started = false;
    },
    get connected() {
      return !!activePort;
    },
  };
}
