import assert from "node:assert/strict";
import test from "node:test";

import {
  EdgeTermNodeRuntime,
  frontendAdapterOptions,
  inlineNodeCodeNeedsWorkspace,
  isNodeCommand,
  tokenizeCommand,
} from "../../frontend/src/node/runtime-controller.js";
import { BrowserNpmCache } from "../../frontend/src/node/npm-cache.js";
import {
  NpmRegistryClient,
  parsePackageSpec,
} from "../../frontend/src/node/npm-registry.js";

test("tokenizes npm commands without losing quoted arguments", () => {
  assert.deepEqual(
    tokenizeCommand('npm run build -- --base "/project files/"'),
    ["npm", "run", "build", "--", "--base", "/project files/"],
  );
});

test("recognizes Node command chains and an optional leading cd", () => {
  assert.equal(isNodeCommand("npm install && npm run build"), true);
  assert.equal(isNodeCommand("cd app && npm run dev"), true);
  assert.equal(isNodeCommand("cd app"), false);
  assert.equal(isNodeCommand("npm install && rm -rf /"), false);
});

test("maps Next.js scripts to the browser-local static adapter", () => {
  assert.deepEqual(frontendAdapterOptions("next", ["dev"]), {
    framework: "nextjs-static",
    mode: "dev",
    production: false,
    preview: true,
    watch: true,
  });
  assert.deepEqual(frontendAdapterOptions("next", ["build"]), {
    framework: "nextjs-static",
    mode: "build",
    production: true,
    preview: false,
    watch: false,
  });
  assert.equal(frontendAdapterOptions("next", ["lint"]).unsupported, true);
});

test("skips workspace hydration only for file-independent inline Node code", () => {
  assert.equal(inlineNodeCodeNeedsWorkspace(["-e", "console.log(6 * 7)"]), false);
  assert.equal(inlineNodeCodeNeedsWorkspace(["-p", "require('fixture')"]), true);
  assert.equal(inlineNodeCodeNeedsWorkspace(["-e", "require('node:fs').readFileSync('a')"]), true);
  assert.equal(inlineNodeCodeNeedsWorkspace(["app.js"]), true);
});

test("reports npm task progress and a completed state", async () => {
  const states = [];
  const runtime = new EdgeTermNodeRuntime({
    fs: {},
    assetUrl: (value) => value,
    onStatus: (state) => states.push(state),
  });
  runtime.runNpm = async () => {
    runtime.reportProgress({ phase: "download", message: "Installing react..." });
    return { exitCode: 0, packages: 1 };
  };
  const result = await runtime.executeNpm("/home/user/app", ["install"]);
  assert.equal(result.exitCode, 0);
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().progress.percent, 100);
  assert.ok(states.some((state) => state.progress?.message === "Installing react..."));
});

test("replaces the EdgeServe preview when switching projects", async () => {
  const started = [];
  const stopped = [];
  const refreshed = [];
  const runtime = new EdgeTermNodeRuntime({
    fs: {
      async removeTree() {},
      async writeFiles() {},
    },
    assetUrl: (value) => value,
    startPreview: async (options) => {
      started.push(options);
      return { id: `preview-${started.length}` };
    },
    stopPreview: (preview) => stopped.push(preview.id),
    refreshPreview: async (preview) => refreshed.push(preview.id),
  });
  runtime.projectFiles = async () => [];
  runtime.buildWorker.request = async () => ({
    files: [],
    outputDirectory: "dist",
    warnings: [],
  });

  await runtime.buildFrontend("/home/user/one", { preview: true });
  await runtime.buildFrontend("/home/user/two", { preview: true });
  await runtime.buildFrontend("/home/user/two", { preview: true });

  assert.equal(started.length, 2);
  assert.deepEqual(stopped, ["preview-1"]);
  assert.deepEqual(refreshed, ["preview-2"]);
  assert.equal(runtime.state.preview.projectRoot, "/home/user/two");
});

test("parses public registry package specifications", () => {
  assert.deepEqual(parsePackageSpec("react@18.3.1"), {
    name: "react",
    range: "18.3.1",
  });
  assert.deepEqual(parsePackageSpec("@scope/pkg@^2.0.0"), {
    name: "@scope/pkg",
    range: "^2.0.0",
  });
  assert.throws(
    () => parsePackageSpec("git+https://example.com/repo.git"),
    (error) => error.code === "npm_package_source_unsupported",
  );
});

test("retries a temporary npm registry failure", async () => {
  let attempts = 0;
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  const client = new NpmRegistryClient({
    cache,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response("", { status: 503 });
      return new Response(JSON.stringify({ name: "fixture" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal((await client.metadata("fixture")).name, "fixture");
  assert.equal(attempts, 2);
});

test("resolves npm dist-tags without downloading the full package history", async () => {
  const urls = [];
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  const client = new NpmRegistryClient({
    cache,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/dist-tags")) {
        return new Response(JSON.stringify({ latest: "14.2.31" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          name: "next",
          version: "14.2.31",
          dist: {
            tarball: "https://registry.npmjs.org/next/-/next-14.2.31.tgz",
            integrity: `sha512-${"A".repeat(88)}`,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  const resolution = await client.resolve("next", "latest");
  assert.equal(resolution.version, "14.2.31");
  assert.equal(urls.length, 2);
  assert.equal(urls.some((url) => url.endsWith("/next")), false);
});

test("resolves compatible semver ranges from dist-tags before full package history", async () => {
  const urls = [];
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  const client = new NpmRegistryClient({
    cache,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/dist-tags")) {
        return new Response(
          JSON.stringify({
            latest: "18.3.1",
            legacy: "17.0.2",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          name: "react",
          version: "18.3.1",
          dist: {
            tarball: "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
            integrity: `sha512-${"A".repeat(88)}`,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  const resolution = await client.resolve("react", "^18.2.0");
  assert.equal(resolution.version, "18.3.1");
  assert.equal(urls.length, 2);
  assert.equal(urls.some((url) => url.endsWith("/react")), false);
});

test("uses the minimum compatible version when dist-tags do not satisfy a range", async () => {
  const urls = [];
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  const client = new NpmRegistryClient({
    cache,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/dist-tags")) {
        return new Response(JSON.stringify({ latest: "15.4.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/next/14.2.5")) {
        return new Response(
          JSON.stringify({
            name: "next",
            version: "14.2.5",
            dist: {
              tarball: "https://registry.npmjs.org/next/-/next-14.2.5.tgz",
              integrity: `sha512-${"A".repeat(88)}`,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const resolution = await client.resolve("next", "^14.2.5");
  assert.equal(resolution.version, "14.2.5");
  assert.equal(urls.some((url) => url.endsWith("/next")), false);
});

test("falls back to package metadata when the dist-tags endpoint is unavailable to browsers", async () => {
  const urls = [];
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  const client = new NpmRegistryClient({
    cache,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith("/dist-tags")) throw new TypeError("Failed to fetch");
      if (url.endsWith("/streamsearch")) {
        return new Response(
          JSON.stringify({ "dist-tags": { latest: "1.1.0" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          name: "streamsearch",
          version: "1.1.0",
          dist: {
            tarball: "https://registry.npmjs.org/streamsearch/-/streamsearch-1.1.0.tgz",
            integrity: `sha512-${"A".repeat(88)}`,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const resolution = await client.resolve("streamsearch", "latest");
  assert.equal(resolution.version, "1.1.0");
  assert.equal(urls.filter((url) => url.endsWith("/dist-tags")).length, 3);
  assert.equal(urls.some((url) => url.endsWith("/streamsearch")), true);
});

test("evicts the oldest in-memory npm cache entries", async () => {
  const cache = new BrowserNpmCache({ maxBytes: 3 });
  await cache.put("https://registry.npmjs.org/one", new Uint8Array([1, 2]));
  await cache.put("https://registry.npmjs.org/two", new Uint8Array([3, 4]));
  assert.equal(await cache.get("https://registry.npmjs.org/one"), null);
  assert.deepEqual(
    await cache.get("https://registry.npmjs.org/two"),
    new Uint8Array([3, 4]),
  );
});
