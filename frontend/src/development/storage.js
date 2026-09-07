const DATABASE_NAME = "edgeterm-development-v1";
const DATABASE_VERSION = 1;

function storageError(code, message, recoverable = false) {
  return Object.assign(new Error(message), { code, recoverable });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || storageError("storage_request_failed", "Browser storage failed."));
  });
}

export function openDevelopmentDatabase(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) {
    return Promise.reject(storageError("indexeddb_unavailable", "Browser development storage is unavailable."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("checkpoints")) {
        const store = db.createObjectStore("checkpoints", { keyPath: "id" });
        store.createIndex("workspace_created", ["workspace_id", "created_at"]);
      }
      if (!db.objectStoreNames.contains("vault")) {
        db.createObjectStore("vault", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || storageError("indexeddb_open_failed", "Could not open browser development storage."));
  });
}

async function transaction(storeName, mode, operation, indexedDb) {
  const db = await openDevelopmentDatabase(indexedDb);
  try {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const value = await operation(store);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || storageError("storage_transaction_failed", "Browser storage transaction failed."));
      tx.onabort = () => reject(tx.error || storageError("storage_transaction_aborted", "Browser storage transaction was aborted."));
    });
    return value;
  } finally {
    db.close();
  }
}

async function sha256(bytes, cryptoImpl = globalThis.crypto) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const digest = await cryptoImpl.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class CheckpointStore {
  constructor({ indexedDb = globalThis.indexedDB, cryptoImpl = globalThis.crypto, retention = 30 } = {}) {
    this.indexedDb = indexedDb;
    this.crypto = cryptoImpl;
    this.retention = Math.max(1, Math.min(200, Number(retention) || 30));
  }

  async create({ workspace_id, label, root, bytes, generation = "", evidence = {}, pinned = false }) {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (!payload.byteLength) throw storageError("checkpoint_empty", "The checkpoint does not contain any data.");
    const item = {
      id: this.crypto.randomUUID(),
      workspace_id: String(workspace_id || "default"),
      label: String(label || "Checkpoint").trim().slice(0, 120) || "Checkpoint",
      root: String(root || "/home/user"),
      generation: String(generation || ""),
      evidence: evidence && typeof evidence === "object" ? evidence : {},
      pinned: Boolean(pinned),
      bytes: payload.byteLength,
      sha256: await sha256(payload, this.crypto),
      created_at: new Date().toISOString(),
      archive: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
    await transaction("checkpoints", "readwrite", (store) => requestResult(store.add(item)), this.indexedDb);
    await this.prune(item.workspace_id);
    return this.publicItem(item);
  }

  publicItem(item) {
    if (!item) return null;
    const { archive, ...metadata } = item;
    return metadata;
  }

  async get(id, { includeArchive = false } = {}) {
    const item = await transaction("checkpoints", "readonly", (store) => requestResult(store.get(String(id || ""))), this.indexedDb);
    if (!item) throw storageError("checkpoint_not_found", "The checkpoint was not found.");
    if (!includeArchive) return this.publicItem(item);
    const archive = new Uint8Array(item.archive || 0);
    if (await sha256(archive, this.crypto) !== item.sha256) {
      throw storageError("checkpoint_hash_mismatch", "The checkpoint archive failed integrity verification.");
    }
    return { ...this.publicItem(item), archive };
  }

  async list(workspaceId) {
    const all = await transaction("checkpoints", "readonly", (store) => requestResult(store.getAll()), this.indexedDb);
    return all
      .filter((item) => item.workspace_id === String(workspaceId || "default"))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .map((item) => this.publicItem(item));
  }

  async pin(id, pinned = true) {
    return await transaction("checkpoints", "readwrite", async (store) => {
      const item = await requestResult(store.get(String(id || "")));
      if (!item) throw storageError("checkpoint_not_found", "The checkpoint was not found.");
      item.pinned = Boolean(pinned);
      await requestResult(store.put(item));
      return this.publicItem(item);
    }, this.indexedDb);
  }

  async remove(id) {
    await transaction("checkpoints", "readwrite", (store) => requestResult(store.delete(String(id || ""))), this.indexedDb);
    return { id: String(id || ""), deleted: true };
  }

  async prune(workspaceId) {
    const items = await this.list(workspaceId);
    const removable = items.filter((item) => !item.pinned).slice(this.retention);
    for (const item of removable) await this.remove(item.id);
    return { removed: removable.length };
  }
}

export class SecretVault {
  constructor({ indexedDb = globalThis.indexedDB, cryptoImpl = globalThis.crypto } = {}) {
    this.indexedDb = indexedDb;
    this.crypto = cryptoImpl;
  }

  async key() {
    const existing = await transaction("keys", "readonly", (store) => requestResult(store.get("vault")), this.indexedDb);
    if (existing?.key) return existing.key;
    const key = await this.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await transaction("keys", "readwrite", (store) => requestResult(store.put({ id: "vault", key })), this.indexedDb);
    return key;
  }

  async put(name, value) {
    const id = String(name || "").trim();
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) {
      throw storageError("vault_name_invalid", "Vault names may contain letters, numbers, dots, dashes, and underscores.");
    }
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const key = await this.key();
    const ciphertext = await this.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
      key,
      new TextEncoder().encode(String(value ?? "")),
    );
    await transaction("vault", "readwrite", (store) => requestResult(store.put({
      id,
      iv: iv.buffer,
      ciphertext,
      updated_at: new Date().toISOString(),
    })), this.indexedDb);
    return { id, stored: true };
  }

  async get(name) {
    const id = String(name || "").replace(/^vault:/, "");
    const item = await transaction("vault", "readonly", (store) => requestResult(store.get(id)), this.indexedDb);
    if (!item) throw storageError("vault_entry_not_found", `Vault entry not found: ${id}`);
    const key = await this.key();
    const plaintext = await this.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(item.iv), additionalData: new TextEncoder().encode(id) },
      key,
      item.ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  }

  async list() {
    const items = await transaction("vault", "readonly", (store) => requestResult(store.getAll()), this.indexedDb);
    return items.map(({ id, updated_at }) => ({ id, updated_at }));
  }

  async remove(name) {
    const id = String(name || "").replace(/^vault:/, "");
    await transaction("vault", "readwrite", (store) => requestResult(store.delete(id)), this.indexedDb);
    return { id, deleted: true };
  }
}
