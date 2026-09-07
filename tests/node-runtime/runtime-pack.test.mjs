import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("pins and verifies the browser Edge.js WebC package", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("runtime/node/manifest.json", root), "utf8"),
  );
  const artifact = new URL(`runtime-packages/node/${manifest.artifact.file}`, root);
  const bytes = await readFile(artifact);

  assert.equal(manifest.artifact.format, "webc");
  assert.equal((await stat(artifact)).size, manifest.artifact.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.artifact.sha256);
});

test("keeps the Node runtime sandbox warm and synchronizes workspace-relative files", async () => {
  const worker = await readFile(
    new URL("frontend/static/node-runtime-worker.js", root),
    "utf8",
  );

  assert.match(worker, /wasmer-sdk\/dist\/index\.js/);
  assert.match(worker, /runtimeSandbox = smokeSandbox/);
  assert.match(worker, /sandbox\.fs\.writeFile\(path, contents\)/);
  assert.doesNotMatch(worker, /sandbox\.fs\.writeFile\(`\/workspace\/\$\{path\}`/);
  assert.doesNotMatch(worker, /finally \{[\s\S]{0,160}closeSandbox\(sandbox\)/);
});
