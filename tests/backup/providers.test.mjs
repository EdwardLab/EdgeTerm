import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { DropboxBackupProvider } from "../../frontend/src/backup/providers/dropbox.js";
import { GoogleDriveBackupProvider } from "../../frontend/src/backup/providers/google-drive.js";
import { S3BackupProvider } from "../../frontend/src/backup/providers/s3.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value, options = {}) {
  return new Response(JSON.stringify(value), {
    status: options.status || 200,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
}

test("S3 signs path-style uploads and parses object listings", async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (options.method === "PUT") {
      return new Response("", { status: 200, headers: { ETag: '"etag-upload"' } });
    }
    return new Response(
      "<ListBucketResult><Contents><Key>EdgeTerm Backups/manifests/one.enc</Key><Size>12</Size><LastModified>2026-08-02T00:00:00Z</LastModified><ETag>\"etag-list\"</ETag></Contents></ListBucketResult>",
      { status: 200, headers: { "Content-Type": "application/xml" } },
    );
  };
  const provider = new S3BackupProvider({
    endpoint: "https://s3.example.com",
    bucket: "edge-backups",
    region: "us-east-1",
    credentialsProvider: {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    },
  });

  const uploaded = await provider.putObject("packs/one.pack", new Uint8Array([1, 2, 3]));
  const listed = await provider.listObjects("manifests");

  assert.equal(uploaded.etag, "etag-upload");
  assert.equal(requests[0].url, "https://s3.example.com/edge-backups/EdgeTerm%20Backups/packs/one.pack");
  assert.match(requests[0].options.headers.get("Authorization"), /^AWS4-HMAC-SHA256 Credential=test-access-key\//);
  assert.equal(requests[0].options.headers.get("x-amz-content-sha256").length, 64);
  assert.deepEqual(listed, [{
    key: "manifests/one.enc",
    size: 12,
    updatedAt: "2026-08-02T00:00:00Z",
    etag: "etag-list",
  }]);
  assert.match(requests[1].url, /list-type=2/);
});

test("Google Drive stores backup objects in appDataFolder", async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, options });
    if (requestUrl.includes("www.googleapis.com/drive/v3/files")) {
      return jsonResponse({ files: [] });
    }
    if (requestUrl.includes("www.googleapis.com/upload/drive/v3/files")) {
      return jsonResponse({}, { headers: { Location: "https://upload.example/session" } });
    }
    if (requestUrl === "https://upload.example/session") {
      return jsonResponse({ id: "drive-file", md5Checksum: "drive-etag" });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
  const provider = new GoogleDriveBackupProvider({ tokenProvider: "drive-token" });

  const result = await provider.putObject("catalog/catalog.enc", new Uint8Array([4, 5]));

  assert.equal(result.etag, "drive-etag");
  const start = requests.find((entry) => entry.url.includes("upload/drive/v3/files"));
  const metadata = JSON.parse(start.options.body);
  assert.deepEqual(metadata.parents, ["appDataFolder"]);
  assert.equal(metadata.appProperties.edgetermBackup, "1");
  assert.equal(metadata.appProperties.edgetermKey, "catalog/catalog.enc");
  assert.equal(start.options.headers.get("Authorization"), "Bearer drive-token");
});

test("Dropbox creates its app-folder path before uploading", async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, options });
    if (requestUrl.includes("files/create_folder_v2")) return jsonResponse({ metadata: {} });
    if (requestUrl.includes("content.dropboxapi.com/2/files/upload")) {
      return jsonResponse({ rev: "dropbox-rev", content_hash: "dropbox-hash" });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };
  const provider = new DropboxBackupProvider({ tokenProvider: "dropbox-token" });

  const result = await provider.putObject("packs/one.pack", new Uint8Array([8, 9]));

  assert.equal(result.etag, "dropbox-hash");
  assert.equal(requests[0].url, "https://api.dropboxapi.com/2/files/create_folder_v2");
  const upload = requests.at(-1);
  assert.equal(upload.options.headers.get("Authorization"), "Bearer dropbox-token");
  assert.equal(
    JSON.parse(upload.options.headers.get("Dropbox-API-Arg")).path,
    "/EdgeTerm Backups/packs/one.pack",
  );
});
