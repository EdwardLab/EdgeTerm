import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("does not expose a scripted APT or dpkg replacement", () => {
  const forbiddenPaths = [
    "rootfs/bin/bigbox/apt.py",
    "rootfs/bin/bigbox/apt-cache.py",
    "rootfs/bin/bigbox/dpkg.py",
    "rootfs/bin/bigbox/dpkg-deb.py",
    "rootfs/etc/apt/sources.list",
  ];

  for (const relativePath of forbiddenPaths) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, relativePath)), false, relativePath);
  }
});

test("pins the upstream Debian APT source", () => {
  const probe = fs.readFileSync(
    path.join(repositoryRoot, "ports/apt-wasix/probe-build.sh"),
    "utf8",
  );
  assert.match(probe, /https:\/\/salsa\.debian\.org\/apt-team\/apt\.git/);
  assert.match(probe, /APT_COMMIT="[0-9a-f]{40}"/);
});

test("keeps APT list output inside the EdgeTerm terminal", () => {
  const probe = fs.readFileSync(
    path.join(repositoryRoot, "ports/apt-wasix/probe-build.sh"),
    "utf8",
  );
  const outputPatch = fs.readFileSync(
    path.join(repositoryRoot, "ports/apt-wasix/wasix-terminal-output.patch"),
    "utf8",
  );

  assert.match(probe, /wasix-terminal-output\.patch/);
  assert.match(outputPatch, /bool InitOutputPager\(\)/);
  assert.match(outputPatch, /#ifdef __wasi__/);
  assert.match(outputPatch, /return true;/);
});

test("generated boot files do not contain the removed replacement", () => {
  const bootFiles = [
    "backend/static/bootfs-critical.json",
    "backend/static/bootfs-packages.json",
    "backend/static/bootfs.json",
  ];
  const forbidden = /(^|\/)(apt(?:-cache)?|dpkg(?:-deb)?)\.py$|^etc\/apt\//;

  for (const relativePath of bootFiles) {
    const payload = JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
    const entries = Array.isArray(payload) ? payload : payload.files ?? [];
    for (const entry of entries) {
      assert.doesNotMatch(entry.path ?? "", forbidden, relativePath);
    }
  }
});
