import { sha256Hex, throwIfAborted, toBytes } from "./bytes.js";

export const DEFAULT_SMALL_FILE_LIMIT = 8 * 1024 * 1024;
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export async function chunkFile(value, options = {}) {
  const bytes = toBytes(value);
  const chunkSize = Math.max(256 * 1024, Number(options.chunkSize || DEFAULT_CHUNK_SIZE));
  const smallFileLimit = Math.max(chunkSize, Number(options.smallFileLimit || DEFAULT_SMALL_FILE_LIMIT));
  const signal = options.signal;
  const chunks = [];
  if (bytes.byteLength <= smallFileLimit) {
    throwIfAborted(signal);
    chunks.push({
      offset: 0,
      size: bytes.byteLength,
      hash: await sha256Hex(bytes),
      bytes,
    });
    return chunks;
  }
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    throwIfAborted(signal);
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    chunks.push({
      offset,
      size: chunk.byteLength,
      hash: await sha256Hex(chunk),
      bytes: chunk,
    });
    if (options.yieldEvery !== false) await Promise.resolve();
  }
  return chunks;
}

export async function compressChunk(value, options = {}) {
  const bytes = toBytes(value);
  if (options.enabled === false || typeof CompressionStream === "undefined" || bytes.byteLength < 1024) {
    return { algorithm: "none", bytes };
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  if (compressed.byteLength >= bytes.byteLength * 0.98) return { algorithm: "none", bytes };
  return { algorithm: "gzip", bytes: compressed };
}

export async function decompressChunk(value, algorithm) {
  const bytes = toBytes(value);
  if (!algorithm || algorithm === "none") return bytes;
  if (algorithm !== "gzip") throw new Error(`Unsupported backup compression: ${algorithm}`);
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress this backup");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
