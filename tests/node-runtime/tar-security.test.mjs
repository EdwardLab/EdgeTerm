import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";

import {
  extractNpmTarball,
  validateNpmPackagePath,
} from "../../frontend/src/node/tar.js";

function writeOctal(target, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  target.set(Buffer.from(encoded), offset);
}

function tarEntry(path, contents, type = "0") {
  const data = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.set(Buffer.from(path), 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(Buffer.from("ustar\0"), 257);
  header.set(Buffer.from("00"), 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0") + "\0 ";
  header.set(Buffer.from(checksumText), 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function makeArchive(entries) {
  return gzipSync(
    Buffer.concat([
      ...entries.map(([path, contents, type]) => tarEntry(path, contents, type)),
      Buffer.alloc(1024),
    ]),
  );
}

test("extracts a valid npm tarball", async () => {
  const archive = makeArchive([
    ["package/package.json", '{"name":"fixture","version":"1.0.0"}'],
    ["package/index.js", "export default 1;"],
  ]);
  const result = await extractNpmTarball(archive);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["package.json", "index.js"],
  );
});

test("rejects traversal, links, duplicates, and native addons", async () => {
  assert.throws(
    () => validateNpmPackagePath("package/../escape.js"),
    (error) => error.code === "npm_tar_path_invalid",
  );
  await assert.rejects(
    extractNpmTarball(makeArchive([["package/link", "target", "2"]])),
    (error) => error.code === "npm_tar_link_unsupported",
  );
  await assert.rejects(
    extractNpmTarball(
      makeArchive([
        ["package/index.js", "one"],
        ["package/index.js", "two"],
      ]),
    ),
    (error) => error.code === "npm_tar_duplicate_path",
  );
  await assert.rejects(
    extractNpmTarball(makeArchive([["package/native.node", "binary"]])),
    (error) => error.code === "npm_native_addon_unsupported",
  );
});

test("rejects a modified tar header", async () => {
  const archive = makeArchive([["package/index.js", "ok"]]);
  const expanded = Buffer.from(await new Response(
    new Blob([archive]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer());
  expanded[10] ^= 1;
  const corrupted = gzipSync(expanded);
  await assert.rejects(
    extractNpmTarball(corrupted),
    (error) => error.code === "npm_tar_checksum_invalid",
  );
});
