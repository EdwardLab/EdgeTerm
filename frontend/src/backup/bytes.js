const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return textEncoder.encode(value);
  throw new TypeError("Expected bytes or text");
}

export function utf8Encode(value) {
  return textEncoder.encode(String(value));
}

export function utf8Decode(value) {
  return textDecoder.decode(toBytes(value));
}

export function concatBytes(parts) {
  const values = parts.map(toBytes);
  const output = new Uint8Array(values.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of values) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function bytesToHex(value) {
  return Array.from(toBytes(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value) {
  const normalized = String(value || "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new TypeError("Invalid hexadecimal value");
  }
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

export function bytesToBase64(value) {
  const bytes = toBytes(value);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let result = "";
  const batchSize = 0x8000;
  for (let index = 0; index < bytes.length; index += batchSize) {
    result += String.fromCharCode(...bytes.subarray(index, index + batchSize));
  }
  return btoa(result);
}

export function base64ToBytes(value) {
  const encoded = String(value || "");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(encoded, "base64"));
  const decoded = atob(encoded);
  const output = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) output[index] = decoded.charCodeAt(index);
  return output;
}

export async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(value)));
}

export async function sha256Hex(value) {
  return bytesToHex(await sha256(value));
}

export function randomBytes(length) {
  const output = new Uint8Array(length);
  crypto.getRandomValues(output);
  return output;
}

export function stableStringify(value) {
  const seen = new WeakSet();
  const normalize = (entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    if (seen.has(entry)) throw new TypeError("Cannot serialize circular data");
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map(normalize);
    const output = {};
    for (const key of Object.keys(entry).sort()) {
      const normalized = normalize(entry[key]);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  };
  return JSON.stringify(normalize(value));
}

export function normalizeBackupPath(value) {
  const raw = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new TypeError("Invalid backup path");
  }
  return parts.join("/");
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Operation aborted", "AbortError");
}
