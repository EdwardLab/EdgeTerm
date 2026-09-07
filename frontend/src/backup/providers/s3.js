import {
  bytesToHex,
  sha256Hex,
  toBytes,
  utf8Encode,
} from "../bytes.js";
import { BackupProvider, BackupProviderError, normalizeObject, readResponseBytes } from "./base.js";

const MULTIPART_THRESHOLD = 16 * 1024 * 1024;
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(pathname) {
  return pathname.split("/").map((part) => encodeRfc3986(decodeURIComponent(part))).join("/") || "/";
}

function canonicalQuery(searchParams) {
  return Array.from(searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", toBytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8Encode(value)));
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1]) : "";
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TypeError("S3 endpoints must use HTTPS");
  }
  return url;
}

export class S3BackupProvider extends BackupProvider {
  constructor(options = {}) {
    super({ id: options.id || "s3", label: options.label || "S3-compatible storage" });
    this.endpoint = validateEndpoint(options.endpoint);
    this.bucket = String(options.bucket || "").trim();
    this.region = String(options.region || "us-east-1");
    this.rootPrefix = String(options.rootPrefix || "EdgeTerm Backups").replace(/^\/+|\/+$/g, "");
    this.forcePathStyle = options.forcePathStyle !== false;
    this.credentialsProvider = options.credentialsProvider;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,254}$/.test(this.bucket)) throw new TypeError("A valid S3 bucket is required");
  }

  capabilities() {
    return { resumable_uploads: true, ranged_downloads: true, conditional_writes: true, server_side_copy: true };
  }

  fullKey(key) {
    return `${this.rootPrefix}/${this.normalizeKey(key)}`;
  }

  objectUrl(key = "", query = {}) {
    const fullKey = key ? this.fullKey(key) : "";
    const url = new URL(this.endpoint.toString());
    const basePath = url.pathname.replace(/\/+$/, "");
    if (this.forcePathStyle) {
      url.pathname = `${basePath}/${encodeRfc3986(this.bucket)}${fullKey ? `/${fullKey.split("/").map(encodeRfc3986).join("/")}` : ""}`;
    } else {
      url.hostname = `${this.bucket}.${url.hostname}`;
      url.pathname = `${basePath}${fullKey ? `/${fullKey.split("/").map(encodeRfc3986).join("/")}` : "/"}`;
    }
    url.search = "";
    for (const [name, value] of Object.entries(query)) url.searchParams.append(name, value == null ? "" : String(value));
    return url;
  }

  async credentials() {
    const value = typeof this.credentialsProvider === "function" ? await this.credentialsProvider() : this.credentialsProvider;
    const credentials = value || {};
    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new BackupProviderError("provider_auth_required", "S3 credentials are required", { status: 401, recoverable: true });
    }
    return credentials;
  }

  async signedFetch(method, url, options = {}) {
    const credentials = await this.credentials();
    const body = options.body == null ? new Uint8Array() : toBytes(options.body);
    const payloadHash = await sha256Hex(body);
    const amzDate = timestamp(options.date || new Date());
    const date = amzDate.slice(0, 8);
    const headers = new Headers(options.headers || {});
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", amzDate);
    if (credentials.sessionToken) headers.set("x-amz-security-token", credentials.sessionToken);
    const canonicalHeadersMap = new Map([
      ["host", url.host],
      ...Array.from(headers.entries())
        .filter(([name]) => name.toLowerCase().startsWith("x-amz-"))
        .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")]),
    ]);
    const sortedHeaders = Array.from(canonicalHeadersMap.entries()).sort(([left], [right]) => left.localeCompare(right));
    const canonicalHeaders = `${sortedHeaders.map(([name, value]) => `${name}:${value}`).join("\n")}\n`;
    const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
    const canonicalRequest = [
      method.toUpperCase(),
      canonicalPath(url.pathname),
      canonicalQuery(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
    const dateKey = await hmac(utf8Encode(`AWS4${credentials.secretAccessKey}`), date);
    const regionKey = await hmac(dateKey, this.region);
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = bytesToHex(await hmac(signingKey, stringToSign));
    headers.set("Authorization", `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
    const response = await fetch(url, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : body,
      signal: options.signal,
    });
    if (response.status === 429 || response.status >= 500) {
      throw new BackupProviderError("s3_temporarily_unavailable", `S3 request failed with status ${response.status}`, {
        status: response.status,
        recoverable: true,
      });
    }
    return response;
  }

  async requireOk(response, code) {
    if (response.ok) return response;
    let message = "";
    try {
      const xml = await response.text();
      message = xmlValue(xml, "Message");
    } catch {}
    throw new BackupProviderError(code, message || `S3 request failed with status ${response.status}`, {
      status: response.status,
      recoverable: response.status === 408 || response.status === 409,
    });
  }

  async putObject(key, value, options = {}) {
    const normalized = this.normalizeKey(key);
    const bytes = normalizeObject(value);
    if (options.ifNoneMatch && await this.headObject(normalized)) {
      throw new BackupProviderError("provider_precondition_failed", "The backup object already exists", { status: 412, recoverable: false });
    }
    if (bytes.byteLength < MULTIPART_THRESHOLD) {
      const response = await this.signedFetch("PUT", this.objectUrl(normalized), {
        body: bytes,
        headers: { "Content-Type": options.contentType || "application/octet-stream" },
        signal: options.signal,
      });
      await this.requireOk(response, "s3_upload_failed");
      options.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
      return { key: normalized, size: bytes.byteLength, etag: response.headers.get("ETag")?.replaceAll('"', "") || "" };
    }
    const createResponse = await this.signedFetch("POST", this.objectUrl(normalized, { uploads: "" }), {
      headers: { "Content-Type": options.contentType || "application/octet-stream" },
      signal: options.signal,
    });
    const createXml = await (await this.requireOk(createResponse, "s3_multipart_start_failed")).text();
    const uploadId = xmlValue(createXml, "UploadId");
    if (!uploadId) throw new BackupProviderError("s3_upload_id_missing", "S3 did not return a multipart upload ID", { recoverable: true });
    const parts = [];
    try {
      let offset = 0;
      let partNumber = 1;
      while (offset < bytes.byteLength) {
        const end = Math.min(bytes.byteLength, offset + MULTIPART_PART_SIZE);
        const response = await this.signedFetch("PUT", this.objectUrl(normalized, { partNumber, uploadId }), {
          body: bytes.subarray(offset, end),
          signal: options.signal,
        });
        await this.requireOk(response, "s3_multipart_part_failed");
        const etag = response.headers.get("ETag")?.replaceAll('"', "");
        if (!etag) throw new BackupProviderError("s3_etag_not_exposed", "The S3 CORS policy must expose the ETag response header", { recoverable: false });
        parts.push({ partNumber, etag });
        offset = end;
        partNumber += 1;
        options.onProgress?.({ loaded: offset, total: bytes.byteLength });
      }
      const completeBody = utf8Encode(`<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>\"${xmlEscape(part.etag)}\"</ETag></Part>`).join("")}</CompleteMultipartUpload>`);
      const completeResponse = await this.signedFetch("POST", this.objectUrl(normalized, { uploadId }), {
        body: completeBody,
        headers: { "Content-Type": "application/xml" },
        signal: options.signal,
      });
      const completeXml = await (await this.requireOk(completeResponse, "s3_multipart_complete_failed")).text();
      const errorCode = xmlValue(completeXml, "Code");
      if (errorCode) throw new BackupProviderError("s3_multipart_complete_failed", xmlValue(completeXml, "Message") || errorCode, { recoverable: true });
      return { key: normalized, size: bytes.byteLength, etag: xmlValue(completeXml, "ETag").replaceAll('"', "") };
    } catch (error) {
      try {
        await this.signedFetch("DELETE", this.objectUrl(normalized, { uploadId }), { signal: options.signal });
      } catch {}
      throw error;
    }
  }

  async getObject(key, options = {}) {
    const headers = {};
    if (options.start != null || options.end != null) {
      const start = Math.max(0, Number(options.start || 0));
      headers.Range = `bytes=${start}-${options.end == null ? "" : Math.max(start, Number(options.end) - 1)}`;
    }
    const response = await this.signedFetch("GET", this.objectUrl(this.normalizeKey(key)), { headers, signal: options.signal });
    return await readResponseBytes(await this.requireOk(response, "s3_download_failed"), "s3_download_failed");
  }

  async headObject(key) {
    const normalized = this.normalizeKey(key);
    const response = await this.signedFetch("HEAD", this.objectUrl(normalized));
    if (response.status === 404) return null;
    await this.requireOk(response, "s3_metadata_failed");
    return {
      key: normalized,
      size: Number(response.headers.get("Content-Length") || 0),
      updatedAt: response.headers.get("Last-Modified") || "",
      etag: response.headers.get("ETag")?.replaceAll('"', "") || "",
    };
  }

  async deleteObject(key) {
    const response = await this.signedFetch("DELETE", this.objectUrl(this.normalizeKey(key)));
    if (response.status === 404) return false;
    await this.requireOk(response, "s3_delete_failed");
    return true;
  }

  async listObjects(prefix = "") {
    const normalizedPrefix = prefix ? this.normalizeKey(prefix) : "";
    const fullPrefix = `${this.rootPrefix}/${normalizedPrefix}`.replace(/\/$/, "");
    const output = [];
    let continuationToken = "";
    do {
      const query = { "list-type": "2", prefix: fullPrefix, "max-keys": "1000" };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const response = await this.signedFetch("GET", this.objectUrl("", query));
      const xml = await (await this.requireOk(response, "s3_list_failed")).text();
      const contents = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g), (match) => match[1]);
      for (const content of contents) {
        const fullKey = xmlValue(content, "Key");
        if (!fullKey.startsWith(`${this.rootPrefix}/`)) continue;
        output.push({
          key: fullKey.slice(this.rootPrefix.length + 1),
          size: Number(xmlValue(content, "Size") || 0),
          updatedAt: xmlValue(content, "LastModified"),
          etag: xmlValue(content, "ETag").replaceAll('"', ""),
        });
      }
      continuationToken = xmlValue(xml, "NextContinuationToken");
    } while (continuationToken);
    return output.sort((left, right) => left.key.localeCompare(right.key));
  }
}
