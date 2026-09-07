import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { generateKey, readPrivateKey, createCleartextMessage, sign } from "openpgp";
import { fetchRepositoryIndex, verifyRepositoryIndex } from "../../frontend/src/external-shell/repository.js";
import { configureStagedAptRepository } from "../../frontend/static/apt-repository.js";

const now = new Date("2026-09-07T00:00:00Z");
const keys = await generateKey({ type: "ecc", curve: "ed25519", userIDs: [{ name: "Repository test" }], date: new Date("2026-09-01T00:00:00Z") });
const privateKey = await readPrivateKey({ armoredKey: keys.privateKey });
const index = `Package: git\nVersion: 2.55.0-1\nArchitecture: wasm32-wasix\nFilename: current/git.deb\nSize: 100\nSHA256: ${"a".repeat(64)}\n\n`;
async function release(text = index, expires = "Mon, 14 Sep 2026 00:00:00 GMT") {
  const body = `Origin: Test\nValid-Until: ${expires}\nSHA256:\n ${createHash("sha256").update(text).digest("hex")} ${Buffer.byteLength(text)} Packages\n`;
  return sign({ message: await createCleartextMessage({ text: body }), signingKeys: privateKey, date: now });
}
const verification = { now, publicKey: keys.publicKey };

test("accepts a signed package index from the configured key", async () => {
  assert.equal((await verifyRepositoryIndex(index, await release(), verification)).get("git").Version, "2.55.0-1");
});
test("rejects an altered package index", async () => {
  await assert.rejects(verifyRepositoryIndex(index.replace("2.55.0", "9.99.0"), await release(), verification), { code: "external_shell_package_index_checksum_mismatch" });
});
test("rejects an unsigned repository", async () => {
  await assert.rejects(verifyRepositoryIndex(index, "missing", verification), { code: "external_shell_package_signature_invalid" });
});
test("rejects an expired release", async () => {
  await assert.rejects(verifyRepositoryIndex(index, await release(index, "Sun, 06 Sep 2026 00:00:00 GMT"), verification), { code: "external_shell_package_index_expired" });
});
test("rejects an empty signed index instead of reporting up to date", async () => {
  await assert.rejects(verifyRepositoryIndex("", await release(""), verification), { code: "external_shell_package_index_invalid" });
});
test("rejects path traversal in signed metadata", async () => {
  const malicious = index.replace("current/git.deb", "../git.deb");
  await assert.rejects(verifyRepositoryIndex(malicious, await release(malicious), verification), { code: "external_shell_package_index_invalid" });
});
test("reports repository connection failures with an actionable message", async () => {
  await assert.rejects(fetchRepositoryIndex("https://packages.example.test", async () => { throw new TypeError("Failed to fetch"); }), (error) => error.code === "external_shell_package_source_unavailable" && /apt update/.test(error.message));
});
test("reports missing repository paths instead of silently using no packages", async () => {
  await assert.rejects(fetchRepositoryIndex("https://packages.example.test", async () => ({ ok: false, status: 404 })), (error) => error.code === "external_shell_package_source_unavailable" && /HTTP 404/.test(error.message));
});
test("rejects insecure remote repository URLs", async () => {
  await assert.rejects(fetchRepositoryIndex("http://packages.example.test", () => { throw new Error("must not fetch"); }), { code: "external_shell_package_source_invalid" });
});
test("staged index configures native APT and repeated refresh does not clear the source", async () => {
  const files = new Map();
  const etc = { writeFile: async (path, bytes) => files.set(path, new TextDecoder().decode(bytes)) };
  const directory = { readFile: async () => new TextEncoder().encode(index) };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await configureStagedAptRepository(etc, directory), true);
    const source = files.get("/apt/sources.list.d/edgeterm-local.sources");
    assert.match(source, /URIs: file:\/home\/user\/apt-repository/);
    assert.match(source, /Suites: \.\//);
  }
});
test("a missing index does not replace an existing APT source with an empty file", async () => {
  const directory = { readFile: async () => { throw new Error("not found"); } };
  const etc = { writeFile: async () => assert.fail("must not overwrite source") };
  assert.equal(await configureStagedAptRepository(etc, directory), false);
});
