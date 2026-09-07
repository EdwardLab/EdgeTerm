import { sha256Hex } from "../bytes.js";
import { BackupProvider, BackupProviderError, normalizeObject, readResponseBytes } from "./base.js";
import { oauthFetch, responseJson } from "./oauth.js";

const API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

function escapeQueryValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function encodedName(key) {
  const tail = key.split("/").at(-1).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "backup-object";
  return `${tail}-${key.length}`;
}

export class GoogleDriveBackupProvider extends BackupProvider {
  constructor(options = {}) {
    super({ id: options.id || "google-drive", label: options.label || "Google Drive" });
    this.tokenProvider = options.tokenProvider;
    this.fileCache = new Map();
  }

  capabilities() {
    return {
      resumable_uploads: true,
      ranged_downloads: true,
      conditional_writes: false,
      server_side_copy: false,
      private_app_folder: true,
    };
  }

  async findFile(key) {
    const normalized = this.normalizeKey(key);
    if (this.fileCache.has(normalized)) return this.fileCache.get(normalized);
    const keyHash = await sha256Hex(normalized);
    const query = [
      "'appDataFolder' in parents",
      "trashed = false",
      `appProperties has { key='edgetermKeyHash' and value='${escapeQueryValue(keyHash)}' }`,
    ].join(" and ");
    const url = new URL(`${API_BASE}/files`);
    url.searchParams.set("spaces", "appDataFolder");
    url.searchParams.set("q", query);
    url.searchParams.set("pageSize", "2");
    url.searchParams.set("fields", "files(id,name,size,modifiedTime,md5Checksum,appProperties)");
    const payload = await responseJson(await oauthFetch(this.tokenProvider, url), "google_drive_lookup_failed");
    const file = payload.files?.find((entry) => entry.appProperties?.edgetermKey === normalized) || null;
    if (file) this.fileCache.set(normalized, file);
    return file;
  }

  async startUpload(key, bytes, existing) {
    const keyHash = await sha256Hex(key);
    const metadata = {
      name: encodedName(key),
      appProperties: {
        edgetermBackup: "1",
        edgetermKey: key,
        edgetermKeyHash: keyHash,
      },
    };
    if (!existing) metadata.parents = ["appDataFolder"];
    const url = existing
      ? `${UPLOAD_BASE}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=id,name,size,modifiedTime,appProperties`
      : `${UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,size,modifiedTime,appProperties`;
    const response = await oauthFetch(this.tokenProvider, url, {
      method: existing ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(bytes.byteLength),
      },
      body: JSON.stringify(metadata),
    });
    if (!response.ok) await responseJson(response, "google_drive_upload_start_failed");
    const sessionUrl = response.headers.get("Location");
    if (!sessionUrl) throw new BackupProviderError("google_drive_upload_session_missing", "Google Drive did not return an upload session", { recoverable: true });
    return sessionUrl;
  }

  async putObject(key, value, options = {}) {
    const normalized = this.normalizeKey(key);
    const bytes = normalizeObject(value);
    const existing = await this.findFile(normalized);
    if (options.ifNoneMatch && existing) {
      throw new BackupProviderError("provider_precondition_failed", "The backup object already exists", {
        status: 412,
        recoverable: false,
      });
    }
    const sessionUrl = await this.startUpload(normalized, bytes, existing);
    let uploaded = 0;
    let result = existing;
    if (bytes.byteLength === 0) {
      const response = await oauthFetch(this.tokenProvider, sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Type": options.contentType || "application/octet-stream",
          "Content-Length": "0",
          "Content-Range": "bytes */0",
        },
        body: bytes,
        signal: options.signal,
      });
      result = await responseJson(response, "google_drive_upload_failed");
    }
    while (uploaded < bytes.byteLength) {
      const end = Math.min(bytes.byteLength, uploaded + UPLOAD_CHUNK_SIZE);
      const response = await oauthFetch(this.tokenProvider, sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Type": options.contentType || "application/octet-stream",
          "Content-Length": String(end - uploaded),
          "Content-Range": `bytes ${uploaded}-${end - 1}/${bytes.byteLength}`,
        },
        body: bytes.subarray(uploaded, end),
        signal: options.signal,
      });
      if (response.status === 200 || response.status === 201) result = await response.json();
      else if (response.status !== 308) await responseJson(response, "google_drive_upload_failed");
      uploaded = end;
      options.onProgress?.({ loaded: uploaded, total: bytes.byteLength });
    }
    this.fileCache.set(normalized, { ...result, appProperties: { edgetermKey: normalized } });
    return { key: normalized, size: bytes.byteLength, etag: result?.md5Checksum || result?.id };
  }

  async getObject(key, options = {}) {
    const file = await this.findFile(key);
    if (!file) throw new BackupProviderError("provider_object_not_found", "The Google Drive backup object was not found", { status: 404, recoverable: false });
    const headers = {};
    if (options.start != null || options.end != null) {
      const start = Math.max(0, Number(options.start || 0));
      headers.Range = `bytes=${start}-${options.end == null ? "" : Math.max(start, Number(options.end) - 1)}`;
    }
    return await readResponseBytes(
      await oauthFetch(this.tokenProvider, `${API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`, { headers, signal: options.signal }),
      "google_drive_download_failed",
    );
  }

  async headObject(key) {
    const normalized = this.normalizeKey(key);
    const file = await this.findFile(normalized);
    return file ? {
      key: normalized,
      size: Number(file.size || 0),
      updatedAt: file.modifiedTime,
      etag: file.md5Checksum || file.id,
    } : null;
  }

  async deleteObject(key) {
    const normalized = this.normalizeKey(key);
    const file = await this.findFile(normalized);
    if (!file) return false;
    const response = await oauthFetch(this.tokenProvider, `${API_BASE}/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) await responseJson(response, "google_drive_delete_failed");
    this.fileCache.delete(normalized);
    return true;
  }

  async listObjects(prefix = "") {
    const normalizedPrefix = prefix ? this.normalizeKey(prefix) : "";
    const output = [];
    let pageToken = "";
    do {
      const url = new URL(`${API_BASE}/files`);
      url.searchParams.set("spaces", "appDataFolder");
      url.searchParams.set("q", "'appDataFolder' in parents and trashed = false and appProperties has { key='edgetermBackup' and value='1' }");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("fields", "nextPageToken,files(id,name,size,modifiedTime,md5Checksum,appProperties)");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await responseJson(await oauthFetch(this.tokenProvider, url), "google_drive_list_failed");
      for (const file of payload.files || []) {
        const key = file.appProperties?.edgetermKey;
        if (!key || !key.startsWith(normalizedPrefix)) continue;
        this.fileCache.set(key, file);
        output.push({ key, size: Number(file.size || 0), updatedAt: file.modifiedTime, etag: file.md5Checksum || file.id });
      }
      pageToken = payload.nextPageToken || "";
    } while (pageToken);
    return output.sort((left, right) => left.key.localeCompare(right.key));
  }
}
