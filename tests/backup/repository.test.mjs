import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex, stableStringify, utf8Encode } from "../../frontend/src/backup/bytes.js";
import { encryptJson } from "../../frontend/src/backup/crypto.js";
import { MemoryBackupProvider } from "../../frontend/src/backup/providers/memory.js";
import { BackupRepository } from "../../frontend/src/backup/repository.js";

function sourceFromFiles(files, options = {}) {
  return {
    workspaceId: options.workspaceId || "workspace-test",
    workspaceName: options.workspaceName || "Test workspace",
    rootfsVersion: "test-rootfs",
    async flush() {},
    async *listEntries() {
      yield { path: "home", type: "directory", mode: 0o755, mtime: 1 };
      yield { path: "home/user", type: "directory", mode: 0o755, mtime: 1 };
      for (const [path, target] of Object.entries(options.symlinks || {})) {
        yield { path, type: "symlink", target, mode: 0o777, mtime: 2 };
      }
      for (const [path, value] of Object.entries(files)) {
        const bytes = new TextEncoder().encode(value);
        yield {
          path,
          type: "file",
          mode: 0o644,
          mtime: 2,
          size: bytes.byteLength,
          async getData() {
            return bytes;
          },
        };
      }
    },
  };
}

function memoryTarget() {
  const files = new Map();
  const directories = new Set();
  const symlinks = new Map();
  let committed = false;
  return {
    files,
    directories,
    symlinks,
    get committed() {
      return committed;
    },
    async begin() {
      return { files: new Map(), directories: new Set(), symlinks: new Map() };
    },
    async createDirectory(entry, { stage }) {
      stage.directories.add(entry.path);
    },
    async createSymlink(entry, { stage }) {
      stage.symlinks.set(entry.path, entry.target);
    },
    async writeFile(entry, bytes, { stage }) {
      stage.files.set(entry.path, bytes.slice());
    },
    async commit({ stage }) {
      files.clear();
      directories.clear();
      symlinks.clear();
      for (const [key, value] of stage.files) files.set(key, value);
      for (const value of stage.directories) directories.add(value);
      for (const [key, value] of stage.symlinks) symlinks.set(key, value);
      committed = true;
    },
  };
}

test("creates an encrypted backup and restores it", async () => {
  const provider = new MemoryBackupProvider();
  const repository = await BackupRepository.create(provider, {
    repositoryId: "repo-test",
    prefix: "Backups/repo-test",
    password: "correct horse battery staple",
    kdf: { iterations: 100_000 },
  });
  const created = await repository.createBackup(sourceFromFiles({
    "home/user/hello.txt": "Hello from EdgeTerm",
    "home/user/settings.json": "{\"theme\":\"dark\"}",
  }), { compression: false });

  assert.equal(created.manifest.stats.files, 2);
  assert.equal(created.manifest.stats.uploaded_chunks, 2);
  const rawObjects = await provider.listObjects("Backups/repo-test");
  assert.ok(rawObjects.some((entry) => entry.key.endsWith(".pack")));
  assert.ok(rawObjects.some((entry) => entry.key.endsWith(".commit.json")));

  const target = memoryTarget();
  const restored = await repository.restoreBackup(created.commit.snapshot_id, target);
  assert.equal(restored.restoredFiles, 2);
  assert.equal(target.committed, true);
  assert.equal(new TextDecoder().decode(target.files.get("home/user/hello.txt")), "Hello from EdgeTerm");
  assert.equal(new TextDecoder().decode(target.files.get("home/user/settings.json")), "{\"theme\":\"dark\"}");
});

test("reuses unchanged chunks across incremental backups", async () => {
  const provider = new MemoryBackupProvider();
  const repository = await BackupRepository.create(provider, {
    repositoryId: "repo-incremental",
    prefix: "Backups/repo-incremental",
    password: "backup password",
    kdf: { iterations: 100_000 },
  });
  const first = await repository.createBackup(sourceFromFiles({
    "home/user/a.txt": "unchanged",
    "home/user/b.txt": "first version",
  }), { compression: false });
  const second = await repository.createBackup(sourceFromFiles({
    "home/user/a.txt": "unchanged",
    "home/user/b.txt": "second version",
  }), { compression: false, parentSnapshotId: first.commit.snapshot_id });

  assert.equal(second.manifest.stats.uploaded_chunks, 1);
  assert.equal(second.manifest.stats.reused_chunks, 1);
  assert.equal(second.manifest.stats.reused_bytes, new TextEncoder().encode("unchanged").byteLength);
  assert.equal((await repository.listBackups()).length, 2);
});

test("rejects a wrong password and detects damaged backup data", async () => {
  const provider = new MemoryBackupProvider();
  const repository = await BackupRepository.create(provider, {
    repositoryId: "repo-integrity",
    prefix: "Backups/repo-integrity",
    password: "right password",
    kdf: { iterations: 100_000 },
  });
  await assert.rejects(
    BackupRepository.open(provider, {
      repositoryId: "repo-integrity",
      prefix: "Backups/repo-integrity",
      password: "wrong password",
    }),
  );

  const created = await repository.createBackup(sourceFromFiles({
    "home/user/file.txt": "integrity protected",
  }), { compression: false });
  const chunkHash = created.manifest.entries.find((entry) => entry.type === "file").chunks[0].hash;
  const location = repository.catalog.chunks[chunkHash];
  const pack = await provider.getObject(location.pack_key);
  pack[location.offset] ^= 0xff;
  await provider.putObject(location.pack_key, pack);
  await assert.rejects(repository.verifyBackup(created.commit.snapshot_id, { full: true }));
});

test("restore preview reports added, changed, unchanged, and removed paths", async () => {
  const provider = new MemoryBackupProvider();
  const repository = await BackupRepository.create(provider, {
    repositoryId: "repo-preview",
    prefix: "Backups/repo-preview",
    password: "preview password",
    kdf: { iterations: 100_000 },
  });
  const created = await repository.createBackup(sourceFromFiles({
    "home/user/same.txt": "same",
    "home/user/changed.txt": "after",
    "home/user/new.txt": "new",
  }), { compression: false });
  const preview = await repository.previewRestore(created.commit.snapshot_id, [
    { path: "home", type: "directory" },
    { path: "home/user", type: "directory" },
    { path: "home/user/same.txt", type: "file", hash: await sha256Hex("same") },
    { path: "home/user/changed.txt", type: "file", hash: await sha256Hex("before") },
    { path: "home/user/removed.txt", type: "file", hash: await sha256Hex("removed") },
  ]);
  assert.ok(preview.unchanged.includes("home/user/same.txt"));
  assert.ok(preview.changed.includes("home/user/changed.txt"));
  assert.ok(preview.added.includes("home/user/new.txt"));
  assert.ok(preview.removed.includes("home/user/removed.txt"));
});

test("preserves symbolic links in a restore point", async () => {
  const provider = new MemoryBackupProvider();
  const repository = await BackupRepository.create(provider, {
    repositoryId: "repo-symlink",
    prefix: "Backups/repo-symlink",
    password: "symbolic link password",
    kdf: { iterations: 100_000 },
  });
  const created = await repository.createBackup(
    sourceFromFiles(
      { "home/user/target.txt": "target" },
      { symlinks: { "home/user/current.txt": "target.txt" } },
    ),
    { compression: false },
  );
  const target = memoryTarget();

  await repository.restoreBackup(created.commit.snapshot_id, target);

  assert.equal(target.symlinks.get("home/user/current.txt"), "target.txt");
});

test("rejects a manifest path that escapes the restore workspace", async () => {
  const provider = new MemoryBackupProvider();
  const repository = await BackupRepository.create(provider, {
    repositoryId: "repo-path-validation",
    prefix: "Backups/repo-path-validation",
    password: "manifest validation password",
    kdf: { iterations: 100_000 },
  });
  const created = await repository.createBackup(sourceFromFiles({
    "home/user/safe.txt": "safe",
  }), { compression: false });
  const snapshotId = created.commit.snapshot_id;
  const malicious = structuredClone(created.manifest);
  malicious.entries.find((entry) => entry.type === "file").path = "/outside.txt";
  const envelope = await encryptJson(
    repository.repositoryKey,
    malicious,
    `snapshot-manifest:${snapshotId}`,
  );
  const manifestBytes = utf8Encode(stableStringify(envelope));
  await provider.putObject(created.commit.manifest_key, manifestBytes);
  await provider.putObject(
    repository.key(`snapshots/${snapshotId}.commit.json`),
    utf8Encode(stableStringify({
      ...created.commit,
      manifest_sha256: await sha256Hex(manifestBytes),
    })),
  );

  await assert.rejects(
    repository.restoreBackup(snapshotId, memoryTarget()),
    /Invalid backup manifest path/,
  );
});
