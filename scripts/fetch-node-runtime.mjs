import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = process.cwd();
const manifest = JSON.parse(
  await readFile(path.join(root, "runtime", "node", "manifest.json"), "utf8"),
);
const outputDir = path.join(root, "runtime-packages", "node");
const outputPath = path.join(outputDir, manifest.artifact.file);
const temporaryPath = `${outputPath}.part`;

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const file = createReadStream(filePath);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest("hex");
}

async function validateArtifact(filePath) {
  try {
    const info = await stat(filePath);
    if (info.size !== manifest.artifact.bytes) return false;
    return (await sha256File(filePath)) === manifest.artifact.sha256;
  } catch {
    return false;
  }
}

if (await validateArtifact(outputPath)) {
  console.log(`Edge.js runtime is ready: ${outputPath}`);
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
await rm(temporaryPath, { force: true });

const providedArtifact = String(process.env.EDGEJS_RUNTIME_FILE || "").trim();
if (providedArtifact) {
  await copyFile(path.resolve(providedArtifact), temporaryPath);
} else if (manifest.artifact.source) {
  const response = await fetch(manifest.artifact.source, {
    headers: { accept: "application/webc,application/octet-stream" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download Edge.js runtime: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
} else {
  throw new Error(
    [
      "The pinned Edge.js runtime artifact is not present.",
      `Build Edge.js commit ${manifest.edgejs_commit} and set EDGEJS_RUNTIME_FILE to the resulting ${String(manifest.artifact.format || "WEBC").toUpperCase()} file.`,
      "The artifact is accepted only when its size and SHA-256 match runtime/node/manifest.json.",
    ].join(" "),
  );
}

const info = await stat(temporaryPath);
if (info.size !== manifest.artifact.bytes) {
  await rm(temporaryPath, { force: true });
  throw new Error(
    `Edge.js runtime size mismatch: expected ${manifest.artifact.bytes}, got ${info.size}`,
  );
}
const sha256 = await sha256File(temporaryPath);
if (sha256 !== manifest.artifact.sha256) {
  await rm(temporaryPath, { force: true });
  throw new Error(
    `Edge.js runtime checksum mismatch: expected ${manifest.artifact.sha256}, got ${sha256}`,
  );
}
await rename(temporaryPath, outputPath);
console.log(`Installed and verified Edge.js runtime: ${outputPath}`);
