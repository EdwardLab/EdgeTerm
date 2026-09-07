import {
  concatBytes,
  normalizeBackupPath,
  sha256Hex,
  stableStringify,
  throwIfAborted,
  toBytes,
  utf8Decode,
  utf8Encode,
} from "./bytes.js";
import { chunkFile, compressChunk, decompressChunk } from "./chunker.js";
import {
  createKeyCheck,
  decryptChunk,
  decryptJson,
  deriveRepositoryKey,
  encryptChunk,
  encryptJson,
  verifyKeyCheck,
} from "./crypto.js";

export const BACKUP_FORMAT = "edgeterm-incremental-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const DEFAULT_PACK_SIZE = 32 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function safeIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(normalized)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return normalized;
}

function formatProviderError(error, action) {
  if (error?.name === "AbortError") return error;
  const wrapped = new Error(`${action}: ${error?.message || error}`);
  wrapped.code = error?.code || "backup_provider_failed";
  wrapped.recoverable = error?.recoverable !== false;
  wrapped.cause = error;
  return wrapped;
}

async function readJson(provider, key) {
  return JSON.parse(utf8Decode(await provider.getObject(key)));
}

async function putJson(provider, key, value, options = {}) {
  return await provider.putObject(key, utf8Encode(stableStringify(value)), {
    ...options,
    contentType: "application/json",
  });
}

async function collectEntries(source, signal) {
  const entries = [];
  for await (const rawEntry of source.listEntries({ signal })) {
    throwIfAborted(signal);
    const path = normalizeBackupPath(rawEntry.path);
    const type = String(rawEntry.type || "file");
    if (!new Set(["file", "directory", "symlink"]).has(type)) {
      throw new TypeError(`Unsupported backup entry type: ${type}`);
    }
    entries.push({ ...rawEntry, path, type });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function updateProgress(callback, phase, details = {}) {
  callback?.({ phase, ...details });
}

function validateManifest(manifest, repositoryId, snapshotId) {
  if (
    manifest?.format !== BACKUP_FORMAT
    || Number(manifest?.version) !== BACKUP_FORMAT_VERSION
    || manifest?.repository_id !== repositoryId
    || manifest?.snapshot_id !== snapshotId
    || !Array.isArray(manifest?.entries)
    || manifest.entries.length > 250_000
  ) {
    throw new Error("Invalid backup manifest");
  }
  const paths = new Set();
  for (const entry of manifest.entries) {
    const path = String(entry?.path || "");
    let normalizedPath = "";
    try {
      normalizedPath = normalizeBackupPath(path);
    } catch {
      throw new Error("Invalid backup manifest path");
    }
    if (path !== normalizedPath || path.length > 1024 || paths.has(path)) {
      throw new Error("Invalid backup manifest path");
    }
    paths.add(path);
    if (!new Set(["file", "directory", "symlink"]).has(entry.type)) {
      throw new Error("Invalid backup manifest entry");
    }
    if (entry.type === "file") {
      if (
        !Number.isSafeInteger(entry.size)
        || entry.size < 0
        || !/^[0-9a-f]{64}$/.test(String(entry.hash || ""))
        || !Array.isArray(entry.chunks)
        || entry.chunks.length > 1_000_000
      ) {
        throw new Error("Invalid backup file entry");
      }
      let chunkBytes = 0;
      for (const chunk of entry.chunks) {
        if (
          !/^[0-9a-f]{64}$/.test(String(chunk?.hash || ""))
          || !Number.isSafeInteger(chunk?.size)
          || chunk.size < 0
        ) {
          throw new Error("Invalid backup chunk entry");
        }
        chunkBytes += chunk.size;
      }
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes !== entry.size) {
        throw new Error("Invalid backup file size");
      }
    }
    if (entry.type === "symlink") {
      const target = String(entry.target || "");
      if (!target || target.length > 4096 || target.includes("\0")) {
        throw new Error("Invalid backup symbolic link");
      }
    }
  }
  return manifest;
}

export class BackupRepository {
  constructor(provider, options) {
    this.provider = provider;
    this.repositoryId = safeIdentifier(options.repositoryId, "repository ID");
    this.repositoryKey = toBytes(options.repositoryKey);
    this.prefix = normalizeBackupPath(options.prefix || `EdgeTerm Backups/${this.repositoryId}`);
    this.metadata = options.metadata;
    this.catalog = options.catalog || { version: 1, generation: 0, chunks: {} };
  }

  key(relativePath) {
    return `${this.prefix}/${normalizeBackupPath(relativePath)}`;
  }

  static async create(provider, options = {}) {
    const repositoryId = safeIdentifier(options.repositoryId || crypto.randomUUID(), "repository ID");
    const prefix = normalizeBackupPath(options.prefix || `EdgeTerm Backups/${repositoryId}`);
    const metadataKey = `${prefix}/repository.json`;
    if (await provider.headObject(metadataKey)) throw new Error("A backup repository already exists at this location");
    const derived = await deriveRepositoryKey(options.password, options.kdf);
    const createdAt = nowIso();
    const metadata = {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      repository_id: repositoryId,
      created_at: createdAt,
      kdf: derived.kdf,
      key_check: await createKeyCheck(derived.key, repositoryId),
    };
    const repository = new BackupRepository(provider, {
      repositoryId,
      repositoryKey: derived.key,
      prefix,
      metadata,
      catalog: { version: 1, generation: 0, chunks: {} },
    });
    await putJson(provider, metadataKey, metadata, { ifNoneMatch: true });
    await repository.saveCatalog();
    return repository;
  }

  static async open(provider, options = {}) {
    const repositoryId = safeIdentifier(options.repositoryId, "repository ID");
    const prefix = normalizeBackupPath(options.prefix || `EdgeTerm Backups/${repositoryId}`);
    const metadata = await readJson(provider, `${prefix}/repository.json`);
    if (metadata.format !== BACKUP_FORMAT || Number(metadata.version) !== BACKUP_FORMAT_VERSION) {
      throw new Error("Unsupported EdgeTerm backup repository");
    }
    if (metadata.repository_id !== repositoryId) throw new Error("Backup repository ID mismatch");
    const derived = await deriveRepositoryKey(options.password, {
      salt: Uint8Array.from(atobCompatible(metadata.kdf.salt), (value) => value.charCodeAt(0)),
      iterations: metadata.kdf.iterations,
    });
    await verifyKeyCheck(derived.key, repositoryId, metadata.key_check);
    const repository = new BackupRepository(provider, {
      repositoryId,
      repositoryKey: derived.key,
      prefix,
      metadata,
    });
    await repository.loadCatalog();
    return repository;
  }

  async loadCatalog() {
    try {
      const envelope = await readJson(this.provider, this.key("catalog.enc.json"));
      const catalog = await decryptJson(this.repositoryKey, envelope, "repository-catalog");
      if (Number(catalog.version) !== 1 || typeof catalog.chunks !== "object") {
        throw new Error("Invalid backup catalog");
      }
      this.catalog = catalog;
      return catalog;
    } catch (error) {
      if (error?.code === "provider_object_not_found") {
        this.catalog = { version: 1, generation: 0, chunks: {} };
        return this.catalog;
      }
      throw error;
    }
  }

  async saveCatalog() {
    const envelope = await encryptJson(this.repositoryKey, this.catalog, "repository-catalog");
    await putJson(this.provider, this.key("catalog.enc.json"), envelope);
  }

  async createBackup(source, options = {}) {
    const signal = options.signal;
    const onProgress = options.onProgress;
    const snapshotId = safeIdentifier(options.snapshotId || crypto.randomUUID(), "snapshot ID");
    const createdAt = nowIso();
    throwIfAborted(signal);
    updateProgress(onProgress, "flush", { message: "Saving workspace changes" });
    await source.flush?.({ signal });
    updateProgress(onProgress, "scan", { message: "Scanning workspace" });
    const sourceEntries = await collectEntries(source, signal);
    const manifestEntries = [];
    const pendingChunks = new Map();
    let sourceBytes = 0;
    let reusedBytes = 0;
    let completedFiles = 0;
    const files = sourceEntries.filter((entry) => entry.type === "file");

    for (const entry of sourceEntries) {
      throwIfAborted(signal);
      if (entry.type === "directory") {
        manifestEntries.push({
          path: entry.path,
          type: "directory",
          mode: Number(entry.mode || 0o755),
          mtime: Number(entry.mtime || 0),
        });
        continue;
      }
      if (entry.type === "symlink") {
        manifestEntries.push({
          path: entry.path,
          type: "symlink",
          target: String(entry.target || ""),
          mode: Number(entry.mode || 0o777),
          mtime: Number(entry.mtime || 0),
        });
        continue;
      }
      const bytes = toBytes(await entry.getData({ signal }));
      sourceBytes += bytes.byteLength;
      const chunks = await chunkFile(bytes, { signal, ...options.chunking });
      const chunkRefs = [];
      for (const chunk of chunks) {
        chunkRefs.push({ hash: chunk.hash, size: chunk.size });
        if (this.catalog.chunks[chunk.hash]) {
          reusedBytes += chunk.size;
          continue;
        }
        if (!pendingChunks.has(chunk.hash)) pendingChunks.set(chunk.hash, chunk.bytes.slice());
      }
      manifestEntries.push({
        path: entry.path,
        type: "file",
        mode: Number(entry.mode || 0o644),
        mtime: Number(entry.mtime || 0),
        size: bytes.byteLength,
        hash: await sha256Hex(bytes),
        chunks: chunkRefs,
      });
      completedFiles += 1;
      updateProgress(onProgress, "scan", {
        message: `Scanned ${completedFiles} of ${files.length} files`,
        completed_files: completedFiles,
        total_files: files.length,
        source_bytes: sourceBytes,
      });
    }

    const maxPackSize = Math.max(4 * 1024 * 1024, Number(options.packSize || DEFAULT_PACK_SIZE));
    const pendingPacks = [];
    let activePack = [];
    let activePackSize = 0;
    for (const [hash, bytes] of pendingChunks) {
      throwIfAborted(signal);
      const compressed = await compressChunk(bytes, { enabled: options.compression !== false });
      const encrypted = await encryptChunk(this.repositoryKey, hash, compressed.bytes);
      if (activePack.length && activePackSize + encrypted.byteLength > maxPackSize) {
        pendingPacks.push(activePack);
        activePack = [];
        activePackSize = 0;
      }
      activePack.push({
        hash,
        encrypted,
        compression: compressed.algorithm,
        plainSize: bytes.byteLength,
        storedSize: compressed.bytes.byteLength,
      });
      activePackSize += encrypted.byteLength;
    }
    if (activePack.length) pendingPacks.push(activePack);

    let uploadedBytes = 0;
    let uploadedChunks = 0;
    for (let packIndex = 0; packIndex < pendingPacks.length; packIndex += 1) {
      throwIfAborted(signal);
      const pack = pendingPacks[packIndex];
      const packId = await sha256Hex(utf8Encode(pack.map((chunk) => chunk.hash).join("\n")));
      const packKey = this.key(`packs/${createdAt.slice(0, 10)}/${packId}.pack`);
      const payload = concatBytes(pack.map((chunk) => chunk.encrypted));
      updateProgress(onProgress, "upload", {
        message: `Uploading data pack ${packIndex + 1} of ${pendingPacks.length}`,
        pack: packIndex + 1,
        total_packs: pendingPacks.length,
        uploaded_bytes: uploadedBytes,
      });
      try {
        await this.provider.putObject(packKey, payload, {
          contentType: "application/vnd.edgeterm.backup-pack",
          signal,
        });
      } catch (error) {
        throw formatProviderError(error, "Backup upload failed");
      }
      let offset = 0;
      for (const chunk of pack) {
        this.catalog.chunks[chunk.hash] = {
          pack_key: packKey,
          offset,
          length: chunk.encrypted.byteLength,
          plain_size: chunk.plainSize,
          stored_size: chunk.storedSize,
          compression: chunk.compression,
          created_at: createdAt,
        };
        offset += chunk.encrypted.byteLength;
        uploadedChunks += 1;
      }
      uploadedBytes += payload.byteLength;
      this.catalog.generation = Number(this.catalog.generation || 0) + 1;
      this.catalog.updated_at = nowIso();
      await this.saveCatalog();
      await options.onCheckpoint?.({
        snapshot_id: snapshotId,
        phase: "upload",
        completed_packs: packIndex + 1,
        total_packs: pendingPacks.length,
        uploaded_bytes: uploadedBytes,
      });
    }

    if (!pendingPacks.length) {
      this.catalog.updated_at = nowIso();
    }

    const manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      repository_id: this.repositoryId,
      snapshot_id: snapshotId,
      created_at: createdAt,
      workspace: {
        id: String(source.workspaceId || ""),
        name: String(source.workspaceName || "EdgeTerm workspace"),
        rootfs_version: String(source.rootfsVersion || ""),
      },
      parent_snapshot_id: options.parentSnapshotId || null,
      entries: manifestEntries,
      stats: {
        files: files.length,
        entries: manifestEntries.length,
        source_bytes: sourceBytes,
        uploaded_bytes: uploadedBytes,
        reused_bytes: reusedBytes,
        uploaded_chunks: uploadedChunks,
        reused_chunks: Array.from(manifestEntries)
          .filter((entry) => entry.type === "file")
          .flatMap((entry) => entry.chunks)
          .filter((chunk) => !pendingChunks.has(chunk.hash)).length,
      },
    };
    const manifestEnvelope = await encryptJson(this.repositoryKey, manifest, `snapshot-manifest:${snapshotId}`);
    const manifestBytes = utf8Encode(stableStringify(manifestEnvelope));
    const manifestKey = this.key(`snapshots/${snapshotId}.manifest.enc.json`);
    await this.provider.putObject(manifestKey, manifestBytes, {
      contentType: "application/vnd.edgeterm.backup-manifest+json",
      signal,
    });
    const commit = {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      repository_id: this.repositoryId,
      snapshot_id: snapshotId,
      created_at: createdAt,
      manifest_key: manifestKey,
      manifest_sha256: await sha256Hex(manifestBytes),
      workspace_name: manifest.workspace.name,
      stats: manifest.stats,
    };
    await putJson(this.provider, this.key(`snapshots/${snapshotId}.commit.json`), commit, {
      ifNoneMatch: true,
      signal,
    });
    updateProgress(onProgress, "complete", {
      message: "Backup complete",
      snapshot_id: snapshotId,
      ...manifest.stats,
    });
    return { commit, manifest };
  }

  async listBackups() {
    const objects = await this.provider.listObjects(this.key("snapshots"));
    const commits = [];
    for (const object of objects.filter((entry) => entry.key.endsWith(".commit.json"))) {
      try {
        const commit = await readJson(this.provider, object.key);
        if (commit.repository_id === this.repositoryId && commit.format === BACKUP_FORMAT) commits.push(commit);
      } catch {}
    }
    return commits.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  }

  async loadManifest(snapshotId) {
    const normalizedId = safeIdentifier(snapshotId, "snapshot ID");
    const commit = await readJson(this.provider, this.key(`snapshots/${normalizedId}.commit.json`));
    const expectedManifestKey = this.key(`snapshots/${normalizedId}.manifest.enc.json`);
    if (
      commit?.format !== BACKUP_FORMAT
      || Number(commit?.version) !== BACKUP_FORMAT_VERSION
      || commit?.repository_id !== this.repositoryId
      || commit?.snapshot_id !== normalizedId
      || commit?.manifest_key !== expectedManifestKey
      || !/^[0-9a-f]{64}$/.test(String(commit?.manifest_sha256 || ""))
    ) {
      throw new Error("Invalid backup commit marker");
    }
    const manifestBytes = await this.provider.getObject(expectedManifestKey);
    if ((await sha256Hex(manifestBytes)) !== commit.manifest_sha256) {
      throw new Error("Backup manifest integrity check failed");
    }
    const manifest = validateManifest(await decryptJson(
      this.repositoryKey,
      JSON.parse(utf8Decode(manifestBytes)),
      `snapshot-manifest:${normalizedId}`,
    ), this.repositoryId, normalizedId);
    return { commit, manifest };
  }

  async readChunk(hash, cache, signal) {
    const location = this.catalog.chunks[hash];
    if (!location) throw new Error(`Backup data is missing for chunk ${hash}`);
    throwIfAborted(signal);
    let pack = cache.get(location.pack_key);
    if (!pack) {
      pack = await this.provider.getObject(location.pack_key, { signal });
      cache.set(location.pack_key, pack);
      while (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    const ciphertext = pack.subarray(location.offset, location.offset + location.length);
    const compressed = await decryptChunk(this.repositoryKey, hash, ciphertext);
    const bytes = await decompressChunk(compressed, location.compression);
    if ((await sha256Hex(bytes)) !== hash) throw new Error(`Backup chunk integrity check failed: ${hash}`);
    return bytes;
  }

  async restoreBackup(snapshotId, target, options = {}) {
    const signal = options.signal;
    const onProgress = options.onProgress;
    const { manifest } = await this.loadManifest(snapshotId);
    const stage = await target.begin?.({ manifest, signal });
    const packCache = new Map();
    let restoredFiles = 0;
    let restoredBytes = 0;
    try {
      for (const entry of manifest.entries) {
        throwIfAborted(signal);
        if (entry.type === "directory") await target.createDirectory(entry, { stage, signal });
        else if (entry.type === "symlink") await target.createSymlink(entry, { stage, signal });
        else {
          const chunks = [];
          for (const chunk of entry.chunks) chunks.push(await this.readChunk(chunk.hash, packCache, signal));
          const bytes = concatBytes(chunks);
          if (bytes.byteLength !== entry.size || (await sha256Hex(bytes)) !== entry.hash) {
            throw new Error(`Restored file integrity check failed: ${entry.path}`);
          }
          await target.writeFile(entry, bytes, { stage, signal });
          restoredFiles += 1;
          restoredBytes += bytes.byteLength;
          updateProgress(onProgress, "restore", {
            message: `Restored ${restoredFiles} files`,
            restored_files: restoredFiles,
            restored_bytes: restoredBytes,
          });
        }
      }
      await target.commit?.({ stage, manifest, signal });
      updateProgress(onProgress, "complete", {
        message: "Restore complete",
        restored_files: restoredFiles,
        restored_bytes: restoredBytes,
      });
      return { manifest, restoredFiles, restoredBytes };
    } catch (error) {
      await target.rollback?.({ stage, manifest, error });
      throw error;
    }
  }

  async verifyBackup(snapshotId, options = {}) {
    const { manifest } = await this.loadManifest(snapshotId);
    const files = manifest.entries.filter((entry) => entry.type === "file");
    const sampleSize = options.full ? files.length : Math.min(files.length, Math.max(1, Number(options.sampleSize || 5)));
    const selected = options.full
      ? files
      : files.filter((_, index) => index % Math.max(1, Math.floor(files.length / sampleSize)) === 0).slice(0, sampleSize);
    const cache = new Map();
    let checkedBytes = 0;
    for (const entry of selected) {
      const chunks = [];
      for (const chunk of entry.chunks) chunks.push(await this.readChunk(chunk.hash, cache, options.signal));
      const bytes = concatBytes(chunks);
      if ((await sha256Hex(bytes)) !== entry.hash) throw new Error(`Backup verification failed: ${entry.path}`);
      checkedBytes += bytes.byteLength;
      updateProgress(options.onProgress, "verify", {
        message: `Verified ${entry.path}`,
        checked_files: selected.indexOf(entry) + 1,
        total_files: selected.length,
      });
    }
    return {
      snapshot_id: snapshotId,
      verified: true,
      full: options.full === true,
      checked_files: selected.length,
      checked_bytes: checkedBytes,
    };
  }

  async previewRestore(snapshotId, currentEntries = []) {
    const { manifest } = await this.loadManifest(snapshotId);
    const current = new Map(currentEntries.map((entry) => [normalizeBackupPath(entry.path), entry]));
    const incoming = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const added = [];
    const changed = [];
    const unchanged = [];
    const removed = [];
    for (const [path, entry] of incoming) {
      const before = current.get(path);
      if (!before) added.push(path);
      else if (entry.type === before.type && entry.hash && entry.hash === before.hash) unchanged.push(path);
      else if (entry.type === before.type && entry.type !== "file") unchanged.push(path);
      else changed.push(path);
    }
    for (const path of current.keys()) if (!incoming.has(path)) removed.push(path);
    return { snapshot_id: snapshotId, added, changed, unchanged, removed, stats: manifest.stats };
  }

  async deleteBackup(snapshotId) {
    const normalizedId = safeIdentifier(snapshotId, "snapshot ID");
    let commit;
    try {
      commit = await readJson(this.provider, this.key(`snapshots/${normalizedId}.commit.json`));
    } catch (error) {
      if (error?.code === "provider_object_not_found") return false;
      throw error;
    }
    await this.provider.deleteObject(this.key(`snapshots/${normalizedId}.commit.json`));
    await this.provider.deleteObject(commit.manifest_key);
    return true;
  }
}

function atobCompatible(value) {
  if (typeof atob === "function") return atob(value);
  return Buffer.from(String(value), "base64").toString("binary");
}
