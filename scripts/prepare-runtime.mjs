import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "runtime/assets.json"), "utf8"));
async function matches(file, asset) {
  try {
    if ((await stat(file)).size !== asset.bytes) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === asset.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
for (const asset of manifest.assets) {
  const file = path.resolve(root, asset.path);
  if (!file.startsWith(root + path.sep) || !/^https:\/\//.test(asset.url)) throw new Error("Invalid runtime asset path or URL");
  if (await matches(file, asset)) { console.log(`Verified ${asset.path}`); continue; }
  if (process.argv.includes("--check")) throw new Error(`Missing or modified runtime asset: ${asset.path}. Run npm run prepare:runtime.`);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.download`;
  let handle;
  try {
    console.log(`Downloading ${asset.name} (${Math.round(asset.bytes / 1024 / 1024)} MiB)`);
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} downloading ${asset.url}`);
    handle = await open(temporary, "wx");
    let bytes = 0;
    const stream = asset.compression === "gzip" ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > asset.bytes) throw new Error(`Runtime download exceeds its declared size: ${asset.name}`);
      await handle.writeFile(chunk);
    }
    await handle.close();
    handle = null;
    if (!await matches(temporary, asset)) throw new Error(`Runtime checksum mismatch: ${asset.name}`);
    await rename(temporary, file);
    console.log(`Verified ${asset.path}`);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
