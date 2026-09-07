import { normalizeBackupPath, toBytes } from "../bytes.js";

export class BackupProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "BackupProviderError";
    this.code = code;
    this.recoverable = options.recoverable !== false;
    this.status = options.status || 0;
    this.cause = options.cause;
  }
}

export class BackupProvider {
  constructor(options = {}) {
    this.id = String(options.id || "provider");
    this.label = String(options.label || this.id);
  }

  capabilities() {
    return {
      resumable_uploads: false,
      ranged_downloads: false,
      conditional_writes: false,
      server_side_copy: false,
    };
  }

  normalizeKey(key) {
    return normalizeBackupPath(key);
  }

  async putObject() {
    throw new BackupProviderError("provider_not_implemented", "This provider cannot upload backup data", {
      recoverable: false,
    });
  }

  async getObject() {
    throw new BackupProviderError("provider_not_implemented", "This provider cannot download backup data", {
      recoverable: false,
    });
  }

  async headObject() {
    throw new BackupProviderError("provider_not_implemented", "This provider cannot inspect backup data", {
      recoverable: false,
    });
  }

  async deleteObject() {
    throw new BackupProviderError("provider_not_implemented", "This provider cannot delete backup data", {
      recoverable: false,
    });
  }

  async listObjects() {
    throw new BackupProviderError("provider_not_implemented", "This provider cannot list backup data", {
      recoverable: false,
    });
  }
}

export async function readResponseBytes(response, code = "provider_download_failed") {
  if (!response.ok) {
    throw new BackupProviderError(code, `Provider request failed with status ${response.status}`, {
      status: response.status,
      recoverable: response.status >= 500 || response.status === 408 || response.status === 429,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function normalizeObject(value) {
  return toBytes(value);
}

export function encodeProviderPath(path) {
  return normalizeBackupPath(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
