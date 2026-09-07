export const EDGETERM_BRIDGE_PROTOCOL = "edgeterm.bridge.v3";
export const EDGETERM_BRIDGE_VERSION = "3.0.0";

export class EdgeTermBridgeError extends Error {
  constructor(message, code = "bridge_request_failed", options = {}) {
    super(message);
    this.name = "EdgeTermBridgeError";
    this.code = code;
    this.recoverable = Boolean(options.recoverable);
    this.requestId = String(options.requestId || "");
    this.idempotencyKey = String(options.idempotencyKey || "");
    this.details = options.details || null;
  }
}

export class EdgeTermBridgeClient extends EventTarget {
  constructor({ iframe, targetOrigin, timeoutMs = 60_000 }) {
    super();
    if (!iframe?.contentWindow) {
      throw new EdgeTermBridgeError("The EdgeTerm iframe is not ready.", "bridge_iframe_unavailable");
    }
    const parsedTargetOrigin = new URL(targetOrigin);
    if (!["http:", "https:"].includes(parsedTargetOrigin.protocol)) {
      throw new EdgeTermBridgeError(
        "EdgeTerm Bridge requires an HTTP or HTTPS target origin.",
        "bridge_target_origin_invalid",
      );
    }
    this.iframe = iframe;
    this.targetOrigin = parsedTargetOrigin.origin;
    this.timeoutMs = Math.max(1_000, Math.min(Number(timeoutMs) || 60_000, 300_000));
    this.port = null;
    this.sessionId = "";
    this.capabilities = {};
    this.pending = new Map();
    this.sequence = 0;
    this.hostRequestHandler = null;
  }

  async connect() {
    this.close();
    const channel = new MessageChannel();
    const nonce = crypto.randomUUID().replaceAll("-", "");
    this.port = channel.port1;
    this.port.addEventListener("message", (event) => this.#handleMessage(event.data || {}));
    this.port.start();
    const connected = new Promise((resolve, reject) => {
      const pendingKey = `connect:${nonce}`;
      const timeout = setTimeout(() => {
        this.pending.delete(pendingKey);
        reject(new EdgeTermBridgeError("EdgeTerm Bridge did not respond.", "bridge_connect_timeout"));
      }, this.timeoutMs);
      this.pending.set(pendingKey, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.iframe.contentWindow.postMessage(
      {
        type: "edgeterm.bridge.connect",
        protocol: EDGETERM_BRIDGE_PROTOCOL,
        nonce,
      },
      this.targetOrigin,
      [channel.port2],
    );
    console.info("[EDGETERM HOST] Bridge connection requested.", {
      protocol: EDGETERM_BRIDGE_PROTOCOL,
      target_origin: this.targetOrigin,
    });
    return await connected;
  }

  async request(method, params = {}, options = {}) {
    if (!this.port || !this.sessionId) {
      throw new EdgeTermBridgeError("EdgeTerm Bridge is not connected.", "bridge_not_connected");
    }
    this.sequence += 1;
    const id = `${Date.now().toString(36)}-${this.sequence.toString(36)}`;
    const timeoutMs = Math.max(
      1_000,
      Math.min(Number(options.timeoutMs) || this.timeoutMs, 300_000),
    );
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new EdgeTermBridgeError(`EdgeTerm did not complete ${method}.`, "bridge_request_timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.port.postMessage({
      protocol: EDGETERM_BRIDGE_PROTOCOL,
      session_id: this.sessionId,
      kind: "request",
      id,
      method,
      params: {
        ...params,
        request_id: params.request_id || id,
        idempotency_key: params.idempotency_key || id,
      },
    });
    return await response;
  }

  setHostRequestHandler(handler) {
    if (handler !== null && typeof handler !== "function") {
      throw new EdgeTermBridgeError(
        "The host request handler must be a function.",
        "bridge_host_handler_invalid",
      );
    }
    this.hostRequestHandler = handler;
  }

  close() {
    for (const pending of this.pending.values()) {
      pending.reject(new EdgeTermBridgeError("EdgeTerm Bridge was closed.", "bridge_closed"));
    }
    this.pending.clear();
    try {
      this.port?.close();
    } catch {}
    this.port = null;
    this.sessionId = "";
    this.capabilities = {};
  }

  #handleMessage(message) {
    if (message.protocol !== EDGETERM_BRIDGE_PROTOCOL) return;
    if (message.kind === "connected") {
      const pending = this.pending.get(`connect:${message.nonce}`);
      if (!pending) return;
      this.pending.delete(`connect:${message.nonce}`);
      this.sessionId = String(message.session_id || "");
      this.capabilities = message.capabilities || {};
      console.info("[EDGETERM HOST] Bridge connected.", {
        protocol: EDGETERM_BRIDGE_PROTOCOL,
        bridge_version: message.bridge_version,
      });
      pending.resolve(message);
      return;
    }
    if (message.session_id !== this.sessionId) return;
    if (message.kind === "host_request") {
      void this.#handleHostRequest(message);
      return;
    }
    if (message.kind === "event") {
      this.dispatchEvent(new CustomEvent(String(message.event || "event"), { detail: message.data }));
      this.dispatchEvent(new CustomEvent("bridge.event", { detail: message }));
      return;
    }
    if (message.kind !== "response") return;
    const pending = this.pending.get(String(message.id || ""));
    if (!pending) return;
    this.pending.delete(String(message.id || ""));
    if (message.ok) pending.resolve(message.result);
    else {
      pending.reject(
        new EdgeTermBridgeError(
          String(message.error?.message || "EdgeTerm Bridge request failed."),
          String(message.error?.code || "bridge_request_failed"),
          {
            recoverable: Boolean(message.error?.recoverable),
            requestId: message.error?.request_id,
            idempotencyKey: message.error?.idempotency_key,
            details: message.error || null,
          },
        ),
      );
    }
  }

  async #handleHostRequest(message) {
    const id = String(message.id || "");
    const method = String(message.method || "");
    if (!id || !method || !this.port || !this.sessionId) return;
    if (!this.hostRequestHandler) {
      this.port.postMessage({
        protocol: EDGETERM_BRIDGE_PROTOCOL,
        session_id: this.sessionId,
        kind: "host_response",
        id,
        ok: false,
        error: {
          code: "bridge_host_method_unavailable",
          message: "DigitalPlat did not register this Bridge capability.",
          recoverable: false,
        },
      });
      return;
    }
    try {
      const result = await this.hostRequestHandler(method, message.params || {});
      this.port.postMessage({
        protocol: EDGETERM_BRIDGE_PROTOCOL,
        session_id: this.sessionId,
        kind: "host_response",
        id,
        ok: true,
        result,
      });
    } catch (error) {
      this.port.postMessage({
        protocol: EDGETERM_BRIDGE_PROTOCOL,
        session_id: this.sessionId,
        kind: "host_response",
        id,
        ok: false,
        error: {
          code: String(error?.code || "bridge_host_request_failed"),
          message: String(error?.message || "DigitalPlat could not complete the request").slice(0, 500),
          recoverable: Boolean(error?.recoverable),
        },
      });
    }
  }
}
