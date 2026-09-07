const textDecoder = new TextDecoder();

async function yieldToBrowser() {
  if (globalThis.scheduler?.yield) {
    await globalThis.scheduler.yield();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function tarError(code, message) {
  return Object.assign(new Error(message), { code });
}

function decodeString(bytes) {
  const zero = bytes.indexOf(0);
  return textDecoder.decode(zero >= 0 ? bytes.subarray(0, zero) : bytes).trim();
}

function parseOctal(bytes) {
  const value = decodeString(bytes).replace(/\0/g, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw tarError("npm_tar_header_invalid", "The package tar header is invalid.");
  }
  return Number.parseInt(value, 8);
}

function assertHeaderChecksum(header) {
  const expected = parseOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (expected !== actual) {
    throw tarError("npm_tar_checksum_invalid", "The package tar header checksum is invalid.");
  }
}

function normalizePackagePath(value) {
  const raw = String(value || "").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw tarError("npm_tar_path_invalid", `Unsafe package path: ${value}`);
  }
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw tarError("npm_tar_path_invalid", `Unsafe package path: ${value}`);
    }
    parts.push(part);
  }
  if (parts[0] === "package") parts.shift();
  const normalized = parts.join("/");
  if (!normalized || normalized.length > 1_024) {
    throw tarError("npm_tar_path_invalid", `Unsafe package path: ${value}`);
  }
  return normalized;
}

function parsePax(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) break;
    const length = Number.parseInt(textDecoder.decode(bytes.subarray(offset, space)), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > bytes.length) break;
    const record = textDecoder.decode(bytes.subarray(space + 1, offset + length - 1));
    const separator = record.indexOf("=");
    if (separator > 0) fields[record.slice(0, separator)] = record.slice(separator + 1);
    offset += length;
  }
  return fields;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw tarError(
      "npm_gzip_unsupported",
      "This browser does not support package decompression.",
    );
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function extractNpmTarball(
  compressedBytes,
  {
    maxCompressedBytes = 24 * 1024 * 1024,
    maxExpandedBytes = 128 * 1024 * 1024,
    maxFiles = 10_000,
  } = {},
) {
  const compressed =
    compressedBytes instanceof Uint8Array
      ? compressedBytes
      : new Uint8Array(compressedBytes || 0);
  if (compressed.byteLength > maxCompressedBytes) {
    throw tarError("npm_package_too_large", "The package archive is too large.");
  }
  const bytes = await gunzip(compressed);
  if (bytes.byteLength > maxExpandedBytes) {
    throw tarError("npm_package_expanded_too_large", "The expanded package is too large.");
  }
  if (compressed.byteLength > 0 && bytes.byteLength > compressed.byteLength * 200) {
    throw tarError(
      "npm_package_expansion_ratio_exceeded",
      "The package archive has an unsafe compression ratio.",
    );
  }
  const files = [];
  const paths = new Set();
  let offset = 0;
  let expandedBytes = 0;
  let pendingPath = "";
  let pendingPax = {};
  let parsedSinceYield = 0;
  let bytesSinceYield = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    assertHeaderChecksum(header);
    const name = decodeString(header.subarray(0, 100));
    const prefix = decodeString(header.subarray(345, 500));
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) {
      throw tarError("npm_tar_truncated", "The package archive is truncated.");
    }
    const data = bytes.slice(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") {
      pendingPax = { ...pendingPax, ...parsePax(data) };
      continue;
    }
    if (type === "L") {
      pendingPath = decodeString(data);
      continue;
    }
    if (["1", "2", "3", "4", "6"].includes(type)) {
      throw tarError(
        "npm_tar_link_unsupported",
        "Package links and device entries are not allowed.",
      );
    }
    const sourcePath =
      pendingPax.path || pendingPath || [prefix, name].filter(Boolean).join("/");
    pendingPax = {};
    pendingPath = "";
    if (type === "5") continue;
    if (!["0", "\0", "7"].includes(type)) continue;
    const path = normalizePackagePath(sourcePath);
    if (paths.has(path)) {
      throw tarError("npm_tar_duplicate_path", `The package contains a duplicate path: ${path}`);
    }
    if (path.toLowerCase().endsWith(".node")) {
      throw tarError(
        "npm_native_addon_unsupported",
        `Native Node add-ons are not supported in EdgeTerm: ${path}`,
      );
    }
    paths.add(path);
    expandedBytes += data.byteLength;
    parsedSinceYield += 1;
    bytesSinceYield += data.byteLength;
    if (expandedBytes > maxExpandedBytes) {
      throw tarError("npm_package_expanded_too_large", "The expanded package is too large.");
    }
    files.push({ path, data });
    if (files.length > maxFiles) {
      throw tarError("npm_package_file_limit", "The package contains too many files.");
    }
    if (parsedSinceYield >= 64 || bytesSinceYield >= 2 * 1024 * 1024) {
      parsedSinceYield = 0;
      bytesSinceYield = 0;
      await yieldToBrowser();
    }
  }
  return { files, expandedBytes };
}

export function validateNpmPackagePath(path) {
  return normalizePackagePath(path);
}
