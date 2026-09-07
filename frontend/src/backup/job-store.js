const DATABASE_NAME = "edgeterm.backups.v1";
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from "./bytes.js";

const DATABASE_VERSION = 2;
const JOB_STORE = "jobs";
const CONNECTION_STORE = "connections";
const SCHEDULE_STORE = "schedules";
const VAULT_KEY_STORE = "vault_keys";
const SECRET_STORE = "secrets";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted"));
  });
}

export class BackupJobStore {
  constructor(options = {}) {
    this.databaseName = options.databaseName || DATABASE_NAME;
    this.database = null;
  }

  async open() {
    if (this.database) return this.database;
    if (typeof indexedDB === "undefined") throw new Error("Backup job storage is not available in this browser");
    const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(JOB_STORE)) {
        const jobs = database.createObjectStore(JOB_STORE, { keyPath: "id" });
        jobs.createIndex("workspace_id", "workspace_id", { unique: false });
        jobs.createIndex("status", "status", { unique: false });
        jobs.createIndex("updated_at", "updated_at", { unique: false });
      }
      if (!database.objectStoreNames.contains(CONNECTION_STORE)) {
        database.createObjectStore(CONNECTION_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SCHEDULE_STORE)) {
        database.createObjectStore(SCHEDULE_STORE, { keyPath: "workspace_id" });
      }
      if (!database.objectStoreNames.contains(VAULT_KEY_STORE)) {
        database.createObjectStore(VAULT_KEY_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SECRET_STORE)) {
        database.createObjectStore(SECRET_STORE, { keyPath: "id" });
      }
    };
    this.database = await requestResult(request);
    this.database.onversionchange = () => {
      this.database?.close();
      this.database = null;
    };
    return this.database;
  }

  async put(storeName, value) {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(structuredClone(value));
    await transactionDone(transaction);
    return value;
  }

  async get(storeName, key) {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readonly");
    const value = await requestResult(transaction.objectStore(storeName).get(key));
    await transactionDone(transaction);
    return value || null;
  }

  async getAll(storeName) {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readonly");
    const values = await requestResult(transaction.objectStore(storeName).getAll());
    await transactionDone(transaction);
    return values;
  }

  async delete(storeName, key) {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  }

  async createJob(input) {
    const timestamp = new Date().toISOString();
    const job = {
      id: input.id || crypto.randomUUID(),
      type: input.type || "backup",
      workspace_id: String(input.workspace_id || ""),
      repository_id: String(input.repository_id || ""),
      snapshot_id: input.snapshot_id || crypto.randomUUID(),
      provider_connection_id: String(input.provider_connection_id || ""),
      status: "queued",
      phase: "queued",
      progress: {},
      error: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.put(JOB_STORE, job);
    return job;
  }

  async updateJob(id, patch) {
    const job = await this.get(JOB_STORE, id);
    if (!job) throw new Error("Backup job was not found");
    const updated = {
      ...job,
      ...structuredClone(patch),
      id: job.id,
      updated_at: new Date().toISOString(),
    };
    await this.put(JOB_STORE, updated);
    return updated;
  }

  async listJobs(filters = {}) {
    let jobs = await this.getAll(JOB_STORE);
    if (filters.workspace_id) jobs = jobs.filter((job) => job.workspace_id === filters.workspace_id);
    if (filters.status) jobs = jobs.filter((job) => job.status === filters.status);
    return jobs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async markInterruptedJobs() {
    const jobs = await this.getAll(JOB_STORE);
    const interrupted = jobs.filter((job) => ["running", "uploading", "restoring", "verifying"].includes(job.status));
    for (const job of interrupted) {
      await this.updateJob(job.id, {
        status: "paused",
        phase: "awaiting_resume",
        error: {
          code: "browser_closed",
          message: "The browser closed before this job completed. Resume it to continue.",
          recoverable: true,
        },
      });
    }
    return interrupted.length;
  }

  async saveConnection(connection) {
    const value = {
      ...structuredClone(connection),
      id: String(connection.id || crypto.randomUUID()),
      updated_at: new Date().toISOString(),
    };
    await this.put(CONNECTION_STORE, value);
    return value;
  }

  async getConnection(id) {
    return await this.get(CONNECTION_STORE, id);
  }

  async listConnections() {
    return await this.getAll(CONNECTION_STORE);
  }

  async deleteConnection(id) {
    await this.delete(CONNECTION_STORE, id);
  }

  async saveSchedule(schedule) {
    const value = {
      ...structuredClone(schedule),
      workspace_id: String(schedule.workspace_id),
      updated_at: new Date().toISOString(),
    };
    await this.put(SCHEDULE_STORE, value);
    return value;
  }

  async getSchedule(workspaceId) {
    return await this.get(SCHEDULE_STORE, String(workspaceId));
  }

  async vaultKey() {
    const existing = await this.get(VAULT_KEY_STORE, "default");
    if (existing?.key) return existing.key;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await this.put(VAULT_KEY_STORE, { id: "default", key, created_at: new Date().toISOString() });
    return key;
  }

  async setSecret(id, value) {
    const key = await this.vaultKey();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, utf8Encode(JSON.stringify(value)));
    await this.put(SECRET_STORE, {
      id: String(id),
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      updated_at: new Date().toISOString(),
    });
  }

  async getSecret(id) {
    const record = await this.get(SECRET_STORE, String(id));
    if (!record) return null;
    const key = await this.vaultKey();
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: base64ToBytes(record.nonce),
    }, key, base64ToBytes(record.ciphertext));
    return JSON.parse(utf8Decode(new Uint8Array(plaintext)));
  }

  async deleteSecret(id) {
    await this.delete(SECRET_STORE, String(id));
  }
}

export const backupStoreNames = Object.freeze({
  jobs: JOB_STORE,
  connections: CONNECTION_STORE,
  schedules: SCHEDULE_STORE,
  secrets: SECRET_STORE,
});
