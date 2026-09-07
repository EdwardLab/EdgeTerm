import { BackupProvider, BackupProviderError, normalizeObject } from "./base.js";

export class MemoryBackupProvider extends BackupProvider {
  constructor(options = {}) {
    super({ id: options.id || "memory", label: options.label || "Memory" });
    this.objects = options.objects || new Map();
  }

  capabilities() {
    return {
      resumable_uploads: true,
      ranged_downloads: true,
      conditional_writes: true,
      server_side_copy: false,
    };
  }

  async putObject(key, value, options = {}) {
    const normalized = this.normalizeKey(key);
    if (options.ifNoneMatch && this.objects.has(normalized)) {
      throw new BackupProviderError("provider_precondition_failed", "The backup object already exists", {
        status: 412,
        recoverable: false,
      });
    }
    const bytes = normalizeObject(value).slice();
    this.objects.set(normalized, {
      bytes,
      contentType: options.contentType || "application/octet-stream",
      updatedAt: new Date().toISOString(),
      etag: `memory-${bytes.byteLength}-${Date.now()}`,
    });
    options.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
    return { key: normalized, size: bytes.byteLength, etag: this.objects.get(normalized).etag };
  }

  async getObject(key, options = {}) {
    const normalized = this.normalizeKey(key);
    const item = this.objects.get(normalized);
    if (!item) {
      throw new BackupProviderError("provider_object_not_found", "The backup object was not found", {
        status: 404,
        recoverable: false,
      });
    }
    const start = Math.max(0, Number(options.start || 0));
    const end = options.end == null ? item.bytes.byteLength : Math.min(item.bytes.byteLength, Number(options.end));
    return item.bytes.slice(start, end);
  }

  async headObject(key) {
    const normalized = this.normalizeKey(key);
    const item = this.objects.get(normalized);
    if (!item) return null;
    return {
      key: normalized,
      size: item.bytes.byteLength,
      contentType: item.contentType,
      updatedAt: item.updatedAt,
      etag: item.etag,
    };
  }

  async deleteObject(key) {
    return this.objects.delete(this.normalizeKey(key));
  }

  async listObjects(prefix = "") {
    const normalizedPrefix = prefix ? this.normalizeKey(prefix) : "";
    return Array.from(this.objects.entries())
      .filter(([key]) => key.startsWith(normalizedPrefix))
      .map(([key, item]) => ({
        key,
        size: item.bytes.byteLength,
        updatedAt: item.updatedAt,
        etag: item.etag,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}
