import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("routes native ash diagnostics through the browser output stream", async () => {
  const worker = await readFile(
    path.join(repositoryRoot, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );

  assert.match(worker, /"exec 2>&1"/);
  assert.match(worker, /pumpInteractiveStream\(session, "stdout", instance\.stdout\)/);
});
