import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("pins and packages the upstream Fastfetch WASIX port", async () => {
  const build = await readFile(
    path.join(repositoryRoot, "ports/fastfetch-wasix/build.sh"),
    "utf8",
  );
  const packaging = await readFile(
    path.join(repositoryRoot, "ports/fastfetch-wasix/build-deb.sh"),
    "utf8",
  );
  const patch = await readFile(
    path.join(repositoryRoot, "ports/fastfetch-wasix/fastfetch-wasix.patch"),
    "utf8",
  );

  assert.match(build, /08698098579bb8b043b0a343159b8018f5cea4fc/);
  assert.match(build, /-DBINARY_LINK_TYPE=static/);
  assert.match(packaging, /Architecture: wasm32-wasix/);
  assert.match(packaging, /usr\/local\/bin\/fastfetch/);
  assert.match(patch, /CMAKE_SYSTEM_NAME.*WASI/);
  assert.match(patch, /CLOCK_MONOTONIC/);
});
