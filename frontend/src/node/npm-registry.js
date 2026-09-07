import semver from "semver";
import { extractNpmTarball } from "./tar.js";
import { BrowserNpmCache } from "./npm-cache.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const textDecoder = new TextDecoder();

function registryError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function packageRequest(name) {
  return encodeURIComponent(String(name || "").trim());
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseAlias(value) {
  const source = String(value || "").trim();
  if (!source.startsWith("npm:")) return null;
  const target = source.slice(4);
  const separator = target.startsWith("@")
    ? target.indexOf("@", 1 + target.indexOf("/"))
    : target.lastIndexOf("@");
  if (separator <= 0) return { name: target, range: "latest" };
  return { name: target.slice(0, separator), range: target.slice(separator + 1) || "latest" };
}

export function parsePackageSpec(value) {
  const source = String(value || "").trim();
  if (!source) throw registryError("npm_package_spec_invalid", "Package name is required.");
  if (/^(?:https?:|git\+|git:|file:|github:)/i.test(source)) {
    throw registryError(
      "npm_package_source_unsupported",
      "EdgeTerm npm supports public registry package names only.",
    );
  }
  if (source.startsWith("@")) {
    const slash = source.indexOf("/");
    if (slash < 2) throw registryError("npm_package_spec_invalid", `Invalid package: ${source}`);
    const versionSeparator = source.indexOf("@", slash);
    return versionSeparator < 0
      ? { name: source, range: "latest" }
      : {
          name: source.slice(0, versionSeparator),
          range: source.slice(versionSeparator + 1) || "latest",
        };
  }
  const separator = source.lastIndexOf("@");
  return separator > 0
    ? { name: source.slice(0, separator), range: source.slice(separator + 1) || "latest" }
    : { name: source, range: "latest" };
}

export class NpmRegistryClient {
  constructor({
    registry = DEFAULT_REGISTRY,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    cache = new BrowserNpmCache(),
    maxMetadataBytes = 24 * 1024 * 1024,
  } = {}) {
    this.registry = String(registry || DEFAULT_REGISTRY).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.maxMetadataBytes = maxMetadataBytes;
    this.abortController = new AbortController();
    this.offline = false;
    if (new URL(this.registry).origin !== DEFAULT_REGISTRY) {
      throw registryError(
        "npm_registry_unsupported",
        "EdgeTerm currently supports the public npm registry only.",
      );
    }
    if (!this.fetchImpl) throw registryError("npm_fetch_unavailable", "Fetch is unavailable.");
  }

  resetAbort() {
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
  }

  cancel() {
    this.abortController.abort();
  }

  setOffline(value) {
    this.offline = Boolean(value);
  }

  async fetchBytes(url, { accept = "application/octet-stream", maxBytes = 20 * 1024 * 1024 } = {}) {
    const cached = await this.cache.get(url);
    if (cached) return cached;
    if (this.offline) {
      throw registryError(
        "npm_offline_cache_miss",
        `The package is not available in the local npm cache: ${url}`,
      );
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "registry.npmjs.org") {
      throw registryError("npm_tarball_host_invalid", `Blocked package URL: ${parsed.origin}`);
    }
    let response;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await this.fetchImpl(url, {
          headers: { accept },
          cache: "no-cache",
          credentials: "omit",
          mode: "cors",
          redirect: "follow",
          referrerPolicy: "no-referrer",
          signal: this.abortController.signal,
        });
        if (response.ok) break;
        if (![429, 500, 502, 503, 504].includes(response.status)) {
          const error = registryError(
            "npm_registry_request_failed",
            `npm registry returned HTTP ${response.status}.`,
          );
          error.retryable = false;
          throw error;
        }
        lastError = registryError(
          "npm_registry_request_failed",
          `npm registry returned HTTP ${response.status}.`,
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (error?.retryable === false) throw error;
        lastError = error;
      }
      if (attempt < 2) await delay(attempt === 0 ? 250 : 750);
    }
    if (!response?.ok) {
      const requestUrl = new URL(url);
      const cause = String(lastError?.message || "The npm registry request failed.");
      throw registryError(
        "npm_registry_request_failed",
        `Unable to download ${requestUrl.pathname} from the public npm registry: ${cause}`,
        {
          cause,
          url: requestUrl.href,
        },
      );
    }
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) {
      throw registryError("npm_registry_response_too_large", "The npm registry response is too large.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw registryError("npm_registry_response_too_large", "The npm registry response is too large.");
    }
    await this.cache.put(url, bytes, response.headers.get("content-type") || accept);
    return bytes;
  }

  async metadata(name) {
    const url = `${this.registry}/${packageRequest(name)}`;
    const bytes = await this.fetchBytes(url, {
      accept: "application/vnd.npm.install-v1+json,application/json",
      maxBytes: this.maxMetadataBytes,
    });
    try {
      return JSON.parse(textDecoder.decode(bytes));
    } catch {
      throw registryError("npm_registry_metadata_invalid", `Invalid metadata for ${name}.`);
    }
  }

  async distTags(name) {
    const url = `${this.registry}/-/package/${packageRequest(name)}/dist-tags`;
    let bytes;
    try {
      bytes = await this.fetchBytes(url, {
        accept: "application/json",
        maxBytes: 256 * 1024,
      });
    } catch (error) {
      if (error?.code !== "npm_registry_request_failed") throw error;
      const metadata = await this.metadata(name);
      const tags = metadata?.["dist-tags"];
      if (!tags || typeof tags !== "object") {
        throw registryError("npm_registry_metadata_invalid", `Invalid dist-tags for ${name}.`);
      }
      return tags;
    }
    try {
      return JSON.parse(textDecoder.decode(bytes));
    } catch {
      throw registryError("npm_registry_metadata_invalid", `Invalid dist-tags for ${name}.`);
    }
  }

  async versionMetadata(name, version) {
    const url = `${this.registry}/${packageRequest(name)}/${encodeURIComponent(version)}`;
    const bytes = await this.fetchBytes(url, {
      accept: "application/json",
      maxBytes: 2 * 1024 * 1024,
    });
    try {
      return JSON.parse(textDecoder.decode(bytes));
    } catch {
      throw registryError(
        "npm_registry_metadata_invalid",
        `Invalid metadata for ${name}@${version}.`,
      );
    }
  }

  async resolve(name, range = "latest") {
    const alias = parseAlias(range);
    const actualName = alias?.name || name;
    const actualRange = alias?.range || range || "latest";
    let version = semver.valid(actualRange) || "";
    let record = null;
    let tags = null;
    if (version) {
      record = await this.versionMetadata(actualName, version);
    } else if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(actualRange)) {
      tags = await this.distTags(actualName);
      version = String(tags[actualRange] || "");
      if (version) record = await this.versionMetadata(actualName, version);
    }
    if (!record && semver.validRange(actualRange)) {
      tags ||= await this.distTags(actualName);
      version =
        semver.maxSatisfying(
          [...new Set(Object.values(tags).map(String).filter(semver.valid))],
          actualRange,
          { includePrerelease: false },
        ) || "";
      if (version) record = await this.versionMetadata(actualName, version);
    }
    if (!record && semver.validRange(actualRange)) {
      const minimum = semver.minVersion(actualRange)?.version || "";
      if (minimum && minimum !== "0.0.0") {
        try {
          version = minimum;
          record = await this.versionMetadata(actualName, version);
        } catch (error) {
          if (error?.code !== "npm_registry_request_failed") throw error;
          version = "";
        }
      }
    }
    if (!record) {
      const metadata = await this.metadata(actualName);
      version =
        semver.maxSatisfying(Object.keys(metadata.versions || {}), actualRange, {
          includePrerelease: false,
        }) || "";
      record = metadata.versions?.[version];
    }
    if (!version || !record?.dist?.tarball || !record?.dist?.integrity) {
      throw registryError(
        "npm_version_not_found",
        `No compatible version of ${actualName} matches ${actualRange}.`,
      );
    }
    return {
      requestedName: name,
      name: actualName,
      version,
      record,
      resolved: String(record.dist.tarball),
      integrity: String(record.dist.integrity),
    };
  }

  async download(resolution) {
    const bytes = await this.fetchBytes(resolution.resolved, {
      accept: "application/octet-stream",
      maxBytes: 20 * 1024 * 1024,
    });
    const [algorithm, expected] = String(resolution.integrity || "").split("-", 2);
    if (algorithm !== "sha512" || !expected) {
      throw registryError(
        "npm_integrity_unsupported",
        `Unsupported package integrity for ${resolution.name}@${resolution.version}.`,
      );
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
    if (bytesToBase64(digest) !== expected) {
      throw registryError(
        "npm_integrity_mismatch",
        `Integrity verification failed for ${resolution.name}@${resolution.version}.`,
      );
    }
    return await extractNpmTarball(bytes);
  }
}

export { DEFAULT_REGISTRY };
