import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  hexToBytes,
  randomBytes,
  sha256,
  stableStringify,
  toBytes,
  utf8Decode,
  utf8Encode,
} from "./bytes.js";

export const BACKUP_CRYPTO_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

async function importAesKey(value, usages) {
  return await crypto.subtle.importKey("raw", toBytes(value), "AES-GCM", false, usages);
}

async function importHkdfKey(value) {
  return await crypto.subtle.importKey("raw", toBytes(value), "HKDF", false, ["deriveBits"]);
}

export async function deriveRepositoryKey(password, options = {}) {
  const salt = options.salt ? toBytes(options.salt) : randomBytes(16);
  const iterations = Number(options.iterations || DEFAULT_PBKDF2_ITERATIONS);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) {
    throw new TypeError("The password derivation work factor is too low");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    utf8Encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const key = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations,
  }, material, 256));
  return {
    key,
    kdf: {
      name: "pbkdf2-sha256",
      salt: bytesToBase64(salt),
      iterations,
    },
  };
}

export async function deriveChunkMaterial(repositoryKey, chunkHash) {
  const hash = typeof chunkHash === "string" ? hexToBytes(chunkHash) : toBytes(chunkHash);
  const material = await importHkdfKey(repositoryKey);
  const output = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: hash,
    info: utf8Encode("EdgeTerm backup chunk v1"),
  }, material, 352));
  return {
    key: output.subarray(0, 32),
    nonce: output.subarray(32, 44),
  };
}

export async function encryptChunk(repositoryKey, chunkHash, plaintext) {
  const { key, nonce } = await deriveChunkMaterial(repositoryKey, chunkHash);
  const aesKey = await importAesKey(key, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: utf8Encode(`EdgeTerm:${chunkHash}`),
    tagLength: 128,
  }, aesKey, toBytes(plaintext));
  return new Uint8Array(ciphertext);
}

export async function decryptChunk(repositoryKey, chunkHash, ciphertext) {
  const { key, nonce } = await deriveChunkMaterial(repositoryKey, chunkHash);
  const aesKey = await importAesKey(key, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: utf8Encode(`EdgeTerm:${chunkHash}`),
    tagLength: 128,
  }, aesKey, toBytes(ciphertext));
  return new Uint8Array(plaintext);
}

export async function encryptJson(repositoryKey, value, purpose) {
  const nonce = randomBytes(12);
  const aesKey = await importAesKey(repositoryKey, ["encrypt"]);
  const plaintext = utf8Encode(stableStringify(value));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: utf8Encode(`EdgeTerm:${purpose}:v${BACKUP_CRYPTO_VERSION}`),
    tagLength: 128,
  }, aesKey, plaintext);
  return {
    version: BACKUP_CRYPTO_VERSION,
    algorithm: "aes-256-gcm",
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptJson(repositoryKey, envelope, purpose) {
  if (Number(envelope?.version) !== BACKUP_CRYPTO_VERSION || envelope?.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported backup encryption format");
  }
  const aesKey = await importAesKey(repositoryKey, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: base64ToBytes(envelope.nonce),
    additionalData: utf8Encode(`EdgeTerm:${purpose}:v${BACKUP_CRYPTO_VERSION}`),
    tagLength: 128,
  }, aesKey, base64ToBytes(envelope.ciphertext));
  return JSON.parse(utf8Decode(new Uint8Array(plaintext)));
}

export async function createKeyCheck(repositoryKey, repositoryId) {
  const digest = await sha256(concatBytes([
    utf8Encode("EdgeTerm backup repository"),
    utf8Encode(repositoryId),
    repositoryKey,
  ]));
  return await encryptJson(repositoryKey, {
    repository_id: repositoryId,
    digest: bytesToBase64(digest),
  }, "repository-key-check");
}

export async function verifyKeyCheck(repositoryKey, repositoryId, envelope) {
  const value = await decryptJson(repositoryKey, envelope, "repository-key-check");
  if (value.repository_id !== repositoryId) throw new Error("Backup password does not match this repository");
  const expected = await sha256(concatBytes([
    utf8Encode("EdgeTerm backup repository"),
    utf8Encode(repositoryId),
    repositoryKey,
  ]));
  const actual = base64ToBytes(value.digest);
  if (actual.byteLength !== expected.byteLength) throw new Error("Backup password does not match this repository");
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual[index] ^ expected[index];
  if (mismatch !== 0) throw new Error("Backup password does not match this repository");
  return true;
}
