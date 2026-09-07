import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { CheckpointStore, SecretVault } from "../../frontend/src/development/storage.js";

function cryptoImpl() {
  return { ...webcrypto, subtle: webcrypto.subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: webcrypto.randomUUID.bind(webcrypto) };
}

test("stores encrypted vault values without listing plaintext", async () => {
  const vault = new SecretVault({ indexedDb: new IDBFactory(), cryptoImpl: cryptoImpl() });
  await vault.put("api-token", "secret-value");
  assert.equal(await vault.get("vault:api-token"), "secret-value");
  assert.deepEqual((await vault.list()).map((entry) => entry.id), ["api-token"]);
  assert.equal(JSON.stringify(await vault.list()).includes("secret-value"), false);
});

test("verifies checkpoint integrity and keeps pinned checkpoints", async () => {
  const indexedDb = new IDBFactory();
  const store = new CheckpointStore({ indexedDb, cryptoImpl: cryptoImpl(), retention: 1 });
  const first = await store.create({ workspace_id: "w", label: "first", bytes: new Uint8Array([1]), pinned: true });
  await store.create({ workspace_id: "w", label: "second", bytes: new Uint8Array([2]) });
  await store.create({ workspace_id: "w", label: "third", bytes: new Uint8Array([3]) });
  const items = await store.list("w");
  assert.equal(items.length, 2);
  assert.ok(items.some((entry) => entry.id === first.id && entry.pinned));
  assert.deepEqual([...((await store.get(first.id, { includeArchive: true })).archive)], [1]);
});
