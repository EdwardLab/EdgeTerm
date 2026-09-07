import { BackupProvider, BackupProviderError, normalizeObject, readResponseBytes } from "./base.js";
import { oauthFetch, responseJson } from "./oauth.js";

const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

export class DropboxBackupProvider extends BackupProvider {
  constructor(options = {}) {
    super({ id: options.id || "dropbox", label: options.label || "Dropbox" });
    this.tokenProvider = options.tokenProvider;
    this.root = `/${String(options.root || "EdgeTerm Backups").replace(/^\/+|\/+$/g, "")}`;
  }

  capabilities() {
    return { resumable_uploads: true, ranged_downloads: true, conditional_writes: true, server_side_copy: false, private_app_folder: true };
  }

  path(key) {
    return `${this.root}/${this.normalizeKey(key)}`;
  }

  async rpc(method, body) {
    return await responseJson(await oauthFetch(this.tokenProvider, `${API_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), `dropbox_${method.replaceAll("/", "_")}_failed`);
  }

  async ensureParentFolders(key) {
    const parts = this.normalizeKey(key).split("/").slice(0, -1);
    const rootParts = this.root.split("/").filter(Boolean);
    let current = "";
    for (const part of [...rootParts, ...parts]) {
      current += `/${part}`;
      try {
        await this.rpc("files/create_folder_v2", { path: current, autorename: false });
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
  }

  async putObject(key, value, options = {}) {
    const normalized = this.normalizeKey(key);
    const bytes = normalizeObject(value);
    const mode = options.ifNoneMatch ? "add" : "overwrite";
    await this.ensureParentFolders(normalized);
    if (bytes.byteLength <= UPLOAD_CHUNK_SIZE) {
      const response = await oauthFetch(this.tokenProvider, `${CONTENT_BASE}/files/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({ path: this.path(normalized), mode, autorename: false, mute: true, strict_conflict: true }),
        },
        body: bytes,
        signal: options.signal,
      });
      const payload = await responseJson(response, "dropbox_upload_failed");
      options.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
      return { key: normalized, size: bytes.byteLength, etag: payload.content_hash || payload.rev };
    }
    const firstEnd = Math.min(bytes.byteLength, UPLOAD_CHUNK_SIZE);
    const start = await responseJson(await oauthFetch(this.tokenProvider, `${CONTENT_BASE}/files/upload_session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ close: false }) },
      body: bytes.subarray(0, firstEnd),
      signal: options.signal,
    }), "dropbox_upload_start_failed");
    let offset = firstEnd;
    options.onProgress?.({ loaded: offset, total: bytes.byteLength });
    while (offset < bytes.byteLength) {
      const end = Math.min(bytes.byteLength, offset + UPLOAD_CHUNK_SIZE);
      const last = end === bytes.byteLength;
      const endpoint = last ? "files/upload_session/finish" : "files/upload_session/append_v2";
      const arg = last
        ? { cursor: { session_id: start.session_id, offset }, commit: { path: this.path(normalized), mode, autorename: false, mute: true, strict_conflict: true } }
        : { cursor: { session_id: start.session_id, offset }, close: false };
      const response = await oauthFetch(this.tokenProvider, `${CONTENT_BASE}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify(arg) },
        body: bytes.subarray(offset, end),
        signal: options.signal,
      });
      const payload = await responseJson(response, "dropbox_upload_failed");
      offset = end;
      options.onProgress?.({ loaded: offset, total: bytes.byteLength });
      if (last) return { key: normalized, size: bytes.byteLength, etag: payload.content_hash || payload.rev };
    }
    throw new BackupProviderError("dropbox_upload_incomplete", "Dropbox upload did not complete", { recoverable: true });
  }

  async getObject(key, options = {}) {
    const headers = { "Dropbox-API-Arg": JSON.stringify({ path: this.path(key) }) };
    if (options.start != null || options.end != null) {
      const start = Math.max(0, Number(options.start || 0));
      headers.Range = `bytes=${start}-${options.end == null ? "" : Math.max(start, Number(options.end) - 1)}`;
    }
    return await readResponseBytes(await oauthFetch(this.tokenProvider, `${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers,
      signal: options.signal,
    }), "dropbox_download_failed");
  }

  async headObject(key) {
    try {
      const payload = await this.rpc("files/get_metadata", { path: this.path(key), include_deleted: false });
      return { key: this.normalizeKey(key), size: Number(payload.size || 0), updatedAt: payload.server_modified, etag: payload.content_hash || payload.rev };
    } catch (error) {
      if (error.status === 409) return null;
      throw error;
    }
  }

  async deleteObject(key) {
    try {
      await this.rpc("files/delete_v2", { path: this.path(key) });
      return true;
    } catch (error) {
      if (error.status === 409) return false;
      throw error;
    }
  }

  async listObjects(prefix = "") {
    const normalizedPrefix = prefix ? this.normalizeKey(prefix) : "";
    const output = [];
    let payload;
    try {
      payload = await this.rpc("files/list_folder", { path: this.path(normalizedPrefix), recursive: true, include_deleted: false, limit: 2000 });
    } catch (error) {
      if (error.status === 409) return [];
      throw error;
    }
    while (true) {
      for (const entry of payload.entries || []) {
        if (entry[".tag"] !== "file") continue;
        const key = entry.path_display.slice(this.root.length + 1);
        output.push({ key, size: Number(entry.size || 0), updatedAt: entry.server_modified, etag: entry.content_hash || entry.rev });
      }
      if (!payload.has_more) break;
      payload = await this.rpc("files/list_folder/continue", { cursor: payload.cursor });
    }
    return output.sort((left, right) => left.key.localeCompare(right.key));
  }
}
