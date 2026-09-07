import assert from "node:assert/strict";
import test from "node:test";

import { BrowserNpmInstaller } from "../../frontend/src/node/npm-installer.js";

function normalizePath(value) {
  const parts = [];
  for (const part of String(value || "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

class MemoryFs {
  constructor(files = {}) {
    this.files = new Map(
      Object.entries(files).map(([path, content]) => [
        normalizePath(path),
        String(content),
      ]),
    );
  }

  async readText(path) {
    const target = normalizePath(path);
    if (!this.files.has(target)) {
      throw Object.assign(new Error(`Missing ${target}`), { code: "fs_not_found" });
    }
    return this.files.get(target);
  }

  async writeText(path, content) {
    this.files.set(normalizePath(path), String(content));
  }

  async writeFiles(entries) {
    for (const entry of entries) {
      const bytes = Buffer.from(entry.data, "base64");
      this.files.set(normalizePath(entry.path), bytes.toString());
    }
  }

  async removeTree(path) {
    const root = normalizePath(path);
    for (const key of [...this.files.keys()]) {
      if (key === root || key.startsWith(`${root}/`)) this.files.delete(key);
    }
  }
}

function packageRecord(name, version, dependencies = {}, peerDependencies = {}) {
  return {
    name,
    version,
    dependencies,
    peerDependencies,
    dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-${Buffer.from(`${name}-${version}`).toString("base64")}`,
    },
  };
}

class FixtureRegistry {
  constructor(records) {
    this.records = records;
  }

  async resolve(name, range) {
    const record = this.records[name];
    if (!record) throw new Error(`Unknown fixture package: ${name}`);
    return {
      name,
      requestedName: name,
      version: record.version,
      record,
      resolved: record.dist.tarball,
      integrity: record.dist.integrity,
      requestedRange: range,
    };
  }

  async download(resolution) {
    const metadata = {
      name: resolution.name,
      version: resolution.version,
      dependencies: resolution.record.dependencies,
      optionalDependencies: resolution.record.optionalDependencies,
      peerDependencies: resolution.record.peerDependencies,
    };
    return {
      expandedBytes: 100,
      files: [
        {
          path: "package.json",
          data: new TextEncoder().encode(JSON.stringify(metadata)),
        },
        {
          path: "index.js",
          data: new TextEncoder().encode("export default true;"),
        },
      ],
    };
  }
}

test("installs dependencies, nested dependencies, peers, and lockfile v3", async () => {
  const fs = new MemoryFs({
    "/workspace/package.json": JSON.stringify({
      name: "fixture-app",
      version: "1.0.0",
      dependencies: { alpha: "^1.0.0" },
      devDependencies: {},
    }),
  });
  const registry = new FixtureRegistry({
    alpha: packageRecord("alpha", "1.2.0", { beta: "^2.0.0" }, { peer: "^3.0.0" }),
    beta: packageRecord("beta", "2.1.0"),
    peer: packageRecord("peer", "3.0.0"),
  });
  const installer = new BrowserNpmInstaller({ fs, registry });
  const result = await installer.install("/workspace");
  assert.equal(result.packages, 3);
  assert.equal(
    JSON.parse(await fs.readText("/workspace/node_modules/alpha/package.json")).version,
    "1.2.0",
  );
  assert.equal(
    JSON.parse(
      await fs.readText(
        "/workspace/node_modules/alpha/node_modules/beta/package.json",
      ),
    ).version,
    "2.1.0",
  );
  assert.equal(
    JSON.parse(await fs.readText("/workspace/node_modules/peer/package.json")).version,
    "3.0.0",
  );
  const lockfile = JSON.parse(await fs.readText("/workspace/package-lock.json"));
  assert.equal(lockfile.lockfileVersion, 3);
  assert.equal(lockfile.packages["node_modules/alpha"].version, "1.2.0");
});

test("reports the number of dependencies removed by uninstall", async () => {
  const fs = new MemoryFs({
    "/workspace/package.json": JSON.stringify({
      name: "fixture-app",
      version: "1.0.0",
      dependencies: { alpha: "1.0.0" },
      devDependencies: {},
    }),
  });
  const installer = new BrowserNpmInstaller({
    fs,
    registry: new FixtureRegistry({ alpha: packageRecord("alpha", "1.0.0") }),
  });

  const result = await installer.uninstall("/workspace", ["alpha", "missing"]);

  assert.equal(result.removed, 1);
  assert.deepEqual(JSON.parse(await fs.readText("/workspace/package.json")).dependencies, {});
});

test("npm ci rejects a package file that differs from the lockfile", async () => {
  const fs = new MemoryFs({
    "/workspace/package.json": JSON.stringify({
      dependencies: { alpha: "^2.0.0" },
      devDependencies: {},
    }),
    "/workspace/package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { alpha: "^1.0.0" },
          devDependencies: {},
        },
      },
    }),
  });
  const installer = new BrowserNpmInstaller({
    fs,
    registry: new FixtureRegistry({}),
  });
  await assert.rejects(
    installer.ci("/workspace"),
    (error) => error.code === "npm_lockfile_out_of_sync",
  );
});

test("skips browser-incompatible optional platform packages", async () => {
  const fs = new MemoryFs({
    "/workspace/package.json": JSON.stringify({
      dependencies: { alpha: "^1.0.0" },
      devDependencies: {},
    }),
  });
  const alpha = packageRecord("alpha", "1.0.0");
  alpha.optionalDependencies = {
    "@rolldown/binding-darwin-arm64": "1.0.0",
    "portable-optional": "1.0.0",
  };
  const installer = new BrowserNpmInstaller({
    fs,
    registry: new FixtureRegistry({
      alpha,
      "portable-optional": packageRecord("portable-optional", "1.0.0"),
    }),
  });
  const result = await installer.install("/workspace");
  assert.equal(result.packages, 2);
  assert.match(result.warnings.join("\n"), /@rolldown\/binding-darwin-arm64/);
  assert.equal(
    JSON.parse(
      await fs.readText(
        "/workspace/node_modules/alpha/node_modules/portable-optional/package.json",
      ),
    ).version,
    "1.0.0",
  );
});
