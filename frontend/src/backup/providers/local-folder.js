import { BackupProvider, BackupProviderError, normalizeObject } from "./base.js";

async function descend(root, key, options = {}) {
  const parts = key.split("/");
  let directory = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    directory = await directory.getDirectoryHandle(parts[index], { create: options.create === true });
  }
  return { directory, name: parts.at(-1) };
}

async function collect(directory, prefix, output) {
  for await (const [name, handle] of directory.entries()) {
    const key = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") await collect(handle, key, output);
    else {
      const file = await handle.getFile();
      output.push({
        key,
        size: file.size,
        updatedAt: new Date(file.lastModified).toISOString(),
        etag: `local-${file.size}-${file.lastModified}`,
      });
    }
  }
}

export class LocalFolderBackupProvider extends BackupProvider {
  constructor(directoryHandle, options = {}) {
    super({ id: options.id || "local-folder", label: options.label || directoryHandle?.name || "Local folder" });
    if (!directoryHandle) throw new TypeError("A directory handle is required");
    this.directoryHandle = directoryHandle;
  }

  capabilities() {
    return {
      resumable_uploads: false,
      ranged_downloads: true,
      conditional_writes: false,
      server_side_copy: false,
    };
  }

  async requestPermission(mode = "readwrite") {
    const options = { mode };
    if ((await this.directoryHandle.queryPermission?.(options)) === "granted") return true;
    return (await this.directoryHandle.requestPermission?.(options)) === "granted";
  }

  async putObject(key, value, options = {}) {
    const normalized = this.normalizeKey(key);
    if (!(await this.requestPermission("readwrite"))) {
      throw new BackupProviderError("provider_permission_denied", "Local folder access was not granted", {
        recoverable: true,
      });
    }
    const bytes = normalizeObject(value);
    const { directory, name } = await descend(this.directoryHandle, normalized, { create: true });
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort?.(error);
      throw error;
    }
    options.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
    return { key: normalized, size: bytes.byteLength };
  }

  async getObject(key, options = {}) {
    const normalized = this.normalizeKey(key);
    try {
      const { directory, name } = await descend(this.directoryHandle, normalized);
      const file = await (await directory.getFileHandle(name)).getFile();
      const start = Math.max(0, Number(options.start || 0));
      const end = options.end == null ? file.size : Math.min(file.size, Number(options.end));
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    } catch (error) {
      if (error?.name === "NotFoundError") {
        throw new BackupProviderError("provider_object_not_found", "The backup object was not found", {
          status: 404,
          recoverable: false,
        });
      }
      throw error;
    }
  }

  async headObject(key) {
    try {
      const normalized = this.normalizeKey(key);
      const { directory, name } = await descend(this.directoryHandle, normalized);
      const file = await (await directory.getFileHandle(name)).getFile();
      return {
        key: normalized,
        size: file.size,
        updatedAt: new Date(file.lastModified).toISOString(),
        etag: `local-${file.size}-${file.lastModified}`,
      };
    } catch (error) {
      if (error?.name === "NotFoundError") return null;
      throw error;
    }
  }

  async deleteObject(key) {
    try {
      const { directory, name } = await descend(this.directoryHandle, this.normalizeKey(key));
      await directory.removeEntry(name);
      return true;
    } catch (error) {
      if (error?.name === "NotFoundError") return false;
      throw error;
    }
  }

  async listObjects(prefix = "") {
    const output = [];
    await collect(this.directoryHandle, "", output);
    const normalizedPrefix = prefix ? this.normalizeKey(prefix) : "";
    return output.filter((entry) => entry.key.startsWith(normalizedPrefix));
  }
}
