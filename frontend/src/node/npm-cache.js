const CACHE_NAME = "edgeterm-npm-v1";
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export class BrowserNpmCache {
  constructor({ cacheName = CACHE_NAME, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.cacheName = cacheName;
    this.maxBytes = Number(maxBytes || DEFAULT_MAX_BYTES);
    this.memory = new Map();
    this.putCount = 0;
  }

  async get(url) {
    if (globalThis.caches?.open) {
      const cache = await caches.open(this.cacheName);
      const response = await cache.match(url);
      if (response) return new Uint8Array(await response.arrayBuffer());
    }
    const value = this.memory.get(String(url));
    return value ? value.slice() : null;
  }

  async put(url, bytes, contentType = "application/octet-stream") {
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (globalThis.caches?.open) {
      const cache = await caches.open(this.cacheName);
      await cache.put(
        url,
        new Response(value.slice(), {
          headers: {
            "content-type": contentType,
            "x-edgeterm-cache-bytes": String(value.byteLength),
            "x-edgeterm-cached-at": String(Date.now()),
          },
        }),
      );
      this.putCount += 1;
      if (this.putCount % 20 === 0) await this.trim();
      return;
    }
    this.memory.set(String(url), value.slice());
    await this.trim();
  }

  async clear() {
    this.memory.clear();
    if (globalThis.caches?.delete) return await caches.delete(this.cacheName);
    return true;
  }

  async estimate() {
    if (!globalThis.caches?.open) {
      let bytes = 0;
      for (const value of this.memory.values()) bytes += value.byteLength;
      return { entries: this.memory.size, bytes };
    }
    const cache = await caches.open(this.cacheName);
    const requests = await cache.keys();
    let bytes = 0;
    for (const request of requests) {
      const response = await cache.match(request);
      bytes += Number(
        response?.headers.get("x-edgeterm-cache-bytes") ||
          response?.headers.get("content-length") ||
          0,
      );
    }
    return { entries: requests.length, bytes };
  }

  async trim() {
    if (!globalThis.caches?.open) {
      let total = 0;
      for (const value of this.memory.values()) total += value.byteLength;
      while (total > this.maxBytes && this.memory.size) {
        const [key, value] = this.memory.entries().next().value;
        this.memory.delete(key);
        total -= value.byteLength;
      }
      return { entries: this.memory.size, bytes: total };
    }
    const cache = await caches.open(this.cacheName);
    const entries = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      entries.push({
        request,
        bytes: Number(
          response?.headers.get("x-edgeterm-cache-bytes") ||
            response?.headers.get("content-length") ||
            0,
        ),
        cachedAt: Number(response?.headers.get("x-edgeterm-cached-at") || 0),
      });
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    entries.sort((left, right) => left.cachedAt - right.cachedAt);
    while (total > this.maxBytes && entries.length) {
      const entry = entries.shift();
      await cache.delete(entry.request);
      total -= entry.bytes;
    }
    return { entries: entries.length, bytes: total };
  }
}

export { CACHE_NAME, DEFAULT_MAX_BYTES };
