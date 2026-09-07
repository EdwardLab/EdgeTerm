function languageError(code, message, recoverable = false) {
  return Object.assign(new Error(message), { code, recoverable });
}

export class EdgeTermLanguageClient extends EventTarget {
  constructor({ workerUrl, workerFactory = (url) => new Worker(url, { type: "module" }) } = {}) {
    super();
    this.workerUrl = workerUrl;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = new Map();
    this.sequence = 0;
    this.ready = false;
    this.startPromise = null;
  }

  async start() {
    if (this.worker && this.ready) return this.status();
    if (this.startPromise) return await this.startPromise;
    const startPromise = (async () => {
      this.stop();
      this.worker = this.workerFactory(this.workerUrl);
      this.worker.addEventListener("message", (event) => this.handle(event.data || {}));
      this.worker.addEventListener("error", (event) => {
        for (const pending of this.pending.values()) pending.reject(languageError("language_worker_failed", event.message || "Language worker failed.", true));
        this.pending.clear();
        this.ready = false;
      });
      const result = await this.request("initialize", {
        processId: null,
        rootUri: "file:///home/user",
        capabilities: {},
        workspaceFolders: [{ uri: "file:///home/user", name: "EdgeTerm workspace" }],
      });
      this.ready = true;
      await this.notify("initialized", {});
      return { ...this.status(), capabilities: result.capabilities || {} };
    })();
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  handle(message) {
    if (message.method) {
      this.dispatchEvent(new CustomEvent(String(message.method), { detail: message.params }));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(languageError(String(message.error.code || "language_request_failed"), String(message.error.message || "Language request failed.")));
    else pending.resolve(message.result);
  }

  request(method, params = {}) {
    if (!this.worker) return Promise.reject(languageError("language_worker_unavailable", "Language services are not running.", true));
    const id = ++this.sequence;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  async notify(method, params = {}) {
    if (!this.worker) throw languageError("language_worker_unavailable", "Language services are not running.", true);
    this.worker.postMessage({ jsonrpc: "2.0", method, params });
  }

  async open({ uri, languageId, text, version = 1 }) {
    await this.start();
    await this.notify("textDocument/didOpen", { textDocument: { uri, languageId, text, version } });
  }

  async change({ uri, text, version }) {
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  diagnostics(uri) {
    return this.request("textDocument/diagnostic", { textDocument: { uri } });
  }

  status() {
    return { ready: this.ready, running: Boolean(this.worker), pending: this.pending.size };
  }

  stop() {
    this.worker?.terminate?.();
    this.worker = null;
    this.ready = false;
    for (const pending of this.pending.values()) pending.reject(languageError("language_worker_stopped", "Language services were stopped.", true));
    this.pending.clear();
  }
}
