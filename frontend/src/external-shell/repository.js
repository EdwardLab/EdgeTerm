import { readCleartextMessage, readKey, verify } from "openpgp";
import { REPOSITORY_PUBLIC_KEY } from "./repository-key.js";

export const DEFAULT_APT_REPOSITORY_URL = "https://packages.digitalplat.org/local-flat";
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
let repositoryKey;

function repositoryError(code, message) {
  return Object.assign(new Error(message), { code, recoverable: true });
}

export function parseDebianPackageIndex(source) {
  const packages = new Map();
  for (const stanza of String(source || "").split(/\n\s*\n/)) {
    const fields = {};
    let current = "";
    for (const line of stanza.split("\n")) {
      if (/^[ \t]/.test(line) && current) {
        fields[current] = `${fields[current]}\n${line.slice(1)}`;
        continue;
      }
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      current = line.slice(0, separator);
      fields[current] = line.slice(separator + 1).trim();
    }
    const name = String(fields.Package || "").trim();
    if (name && fields.Filename && fields.SHA256) packages.set(name, fields);
  }
  return packages;
}

export async function verifyRepositoryIndex(indexText, inRelease, { now = new Date(), publicKey = REPOSITORY_PUBLIC_KEY } = {}) {
  let release;
  try {
    const key = publicKey === REPOSITORY_PUBLIC_KEY
      ? await (repositoryKey ||= readKey({ armoredKey: publicKey }))
      : await readKey({ armoredKey: publicKey });
    const message = await readCleartextMessage({ cleartextMessage: inRelease });
    const verified = await verify({ message, verificationKeys: key, date: now });
    if (!verified.signatures.length) throw new Error("Missing signature");
    await verified.signatures[0].verified;
    release = verified.data;
  } catch {
    throw repositoryError("external_shell_package_signature_invalid", "The package repository signature is missing or invalid. No package metadata was accepted.");
  }
  const expires = Date.parse(release.match(/^Valid-Until:\s*(.+)$/m)?.[1] || "");
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    throw repositoryError("external_shell_package_index_expired", "The package repository metadata has expired. Run apt update after the publisher refreshes the repository.");
  }
  const record = release.match(/^SHA256:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] || "";
  const expected = record.split("\n").map((line) => line.trim().split(/\s+/)).find((fields) => fields[2] === "Packages");
  const bytes = new TextEncoder().encode(indexText);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!expected || expected[0] !== digest || Number(expected[1]) !== bytes.length) {
    throw repositoryError("external_shell_package_index_checksum_mismatch", "The package index does not match its signed release. No package metadata was accepted.");
  }
  const packages = parseDebianPackageIndex(indexText);
  if (!packages.size) {
    throw repositoryError("external_shell_package_index_invalid", "The package repository is not configured or contains no available packages. Check the repository URL and try apt update again.");
  }
  for (const [name, fields] of packages) {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name) || !fields.Version || !["all", "wasm32-wasix"].includes(fields.Architecture)
      || !/^[a-f0-9]{64}$/.test(fields.SHA256) || !/^\d+$/.test(fields.Size) || Number(fields.Size) <= 0
      || !/^[A-Za-z0-9_+./-]+$/.test(fields.Filename) || fields.Filename.startsWith("/") || fields.Filename.split("/").some((part) => !part || part === ".." || part === ".")) {
      throw repositoryError("external_shell_package_index_invalid", `The repository metadata for ${name} is invalid.`);
    }
  }
  return packages;
}

export async function fetchRepositoryIndex(url, fetchImpl = globalThis.fetch, { refresh = false } = {}) {
  let base;
  try {
    base = new URL(`${String(url || "").replace(/\/+$/, "")}/`, globalThis.location?.href || "http://localhost/");
    if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error();
    if (base.username || base.password || base.search || base.hash) throw new Error();
  } catch {
    throw repositoryError("external_shell_package_source_invalid", "The package repository is not configured with a valid HTTPS URL.");
  }
  async function download(name) {
    let response;
    try {
      response = await fetchImpl(new URL(name, base), { cache: refresh ? "no-cache" : "default", signal: AbortSignal.timeout(30_000) });
    } catch {
      throw repositoryError("external_shell_package_source_unavailable", `The package repository is unavailable: ${base.origin}. Check the connection or repository configuration, then run apt update again.`);
    }
    if (!response.ok) {
      throw repositoryError("external_shell_package_source_unavailable", `The package repository is unavailable or not configured: HTTP ${response.status} for ${name}. Check ${base.href} and run apt update again.`);
    }
    if (Number(response.headers?.get("content-length")) > MAX_INDEX_BYTES) throw repositoryError("external_shell_package_index_invalid", "The package repository metadata exceeds the size limit.");
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_INDEX_BYTES) throw repositoryError("external_shell_package_index_invalid", "The package repository metadata exceeds the size limit.");
    return text;
  }
  const inRelease = await download("InRelease");
  const indexText = await download("Packages");
  const packages = await verifyRepositoryIndex(indexText, inRelease);
  return { indexText, inRelease, packages };
}
