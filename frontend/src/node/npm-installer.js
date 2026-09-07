import { NpmRegistryClient, parsePackageSpec } from "./npm-registry.js";

const BLOCKED_OPTIONAL_PACKAGES = [
  /^@esbuild\//,
  /^@rolldown\/binding-/,
  /^@rollup\/rollup-/,
  /^@swc\/core-/,
  /^@next\/swc-/,
  /^@parcel\/watcher-/,
  /^lightningcss$/,
  /^lightningcss-/,
  /^sharp$/,
  /^fsevents$/,
];

function npmError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function joinPath(...values) {
  const parts = [];
  for (const part of values.join("/").replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dependencyEntries(metadata, includeDev = false) {
  return {
    ...(metadata.dependencies || {}),
    ...(includeDev ? metadata.devDependencies || {} : {}),
  };
}

function lifecycleScripts(metadata) {
  return Object.fromEntries(
    ["preinstall", "install", "postinstall", "prepare"]
      .filter((name) => metadata.scripts?.[name])
      .map((name) => [name, String(metadata.scripts[name])]),
  );
}

async function yieldToBrowser() {
  if (globalThis.scheduler?.yield) {
    await globalThis.scheduler.yield();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    if (offset > 0 && offset % 0x80000 === 0) await yieldToBrowser();
  }
  return btoa(binary);
}

function isBlockedOptionalPackage(name) {
  return BLOCKED_OPTIONAL_PACKAGES.some((pattern) => pattern.test(name));
}

export class BrowserNpmInstaller {
  constructor({
    fs,
    registry = new NpmRegistryClient(),
    onProgress = () => {},
    limits = {},
  } = {}) {
    if (!fs) throw new Error("An EdgeTerm filesystem adapter is required.");
    this.fs = fs;
    this.registry = registry;
    this.onProgress = onProgress;
    this.limits = {
      packages: Number(limits.packages || 500),
      files: Number(limits.files || 30_000),
      expandedBytes: Number(limits.expandedBytes || 150 * 1024 * 1024),
      ...limits,
    };
  }

  async readPackageJson(root) {
    const path = joinPath(root, "package.json");
    try {
      return JSON.parse(await this.fs.readText(path));
    } catch (error) {
      if (error?.code === "fs_not_found") {
        throw npmError("npm_package_json_missing", `package.json was not found in ${root}.`);
      }
      throw npmError("npm_package_json_invalid", `Unable to read ${path}: ${error.message || error}`);
    }
  }

  async writePackage(root, installPath, resolution, extracted, state) {
    state.packageCount += 1;
    state.fileCount += extracted.files.length;
    state.expandedBytes += extracted.expandedBytes;
    if (state.packageCount > this.limits.packages) {
      throw npmError("npm_package_limit", "The install exceeds the 500 package limit.");
    }
    if (state.fileCount > this.limits.files) {
      throw npmError("npm_file_limit", "The install exceeds the package file limit.");
    }
    if (state.expandedBytes > this.limits.expandedBytes) {
      throw npmError("npm_install_size_limit", "The install exceeds the expanded size limit.");
    }
    const targetRoot = joinPath(root, installPath);
    await this.fs.removeTree(targetRoot);
    const batchSize = 40;
    for (let offset = 0; offset < extracted.files.length; offset += batchSize) {
      const entries = [];
      for (const file of extracted.files.slice(offset, offset + batchSize)) {
        entries.push({
          path: joinPath(targetRoot, file.path),
          encoding: "base64",
          data: await bytesToBase64(file.data),
        });
      }
      await this.fs.writeFiles(entries);
      await yieldToBrowser();
    }
    const metadata = JSON.parse(
      new TextDecoder().decode(
        extracted.files.find((file) => file.path === "package.json")?.data ||
          new TextEncoder().encode("{}"),
      ),
    );
    const scripts = lifecycleScripts(metadata);
    if (Object.keys(scripts).length) {
      state.blockedScripts.push({
        package: `${resolution.name}@${resolution.version}`,
        installPath,
        scripts,
      });
    }
    state.lockPackages[installPath] = {
      version: resolution.version,
      resolved: resolution.resolved,
      integrity: resolution.integrity,
      dependencies: resolution.record.dependencies || {},
      optionalDependencies: resolution.record.optionalDependencies || {},
      peerDependencies: resolution.record.peerDependencies || {},
      ...(Object.keys(scripts).length ? { hasInstallScript: true } : {}),
    };
    return metadata;
  }

  async installDependency(root, installPath, name, range, state, ancestors = []) {
    if (ancestors.some((entry) => entry.name === name && entry.range === range)) return;
    this.onProgress({
      phase: "resolve",
      message: `Resolving ${name}@${range}...`,
      package: name,
    });
    const resolution = await this.registry.resolve(name, range);
    const key = `${installPath}:${resolution.name}@${resolution.version}`;
    if (state.installed.has(key)) return;
    state.installed.add(key);
    this.onProgress({
      phase: "download",
      message: `Installing ${resolution.name}@${resolution.version}...`,
      package: resolution.name,
      version: resolution.version,
    });
    const extracted = await this.registry.download(resolution);
    const packageMetadata = await this.writePackage(
      root,
      installPath,
      resolution,
      extracted,
      state,
    );
    const nextAncestors = [...ancestors, { name, range }];
    for (const [dependency, dependencyRange] of Object.entries(
      resolution.record.dependencies || packageMetadata.dependencies || {},
    )) {
      await this.installDependency(
        root,
        `${installPath}/node_modules/${dependency}`,
        dependency,
        dependencyRange,
        state,
        nextAncestors,
      );
    }
    for (const [dependency, dependencyRange] of Object.entries(
      resolution.record.optionalDependencies || packageMetadata.optionalDependencies || {},
    )) {
      if (isBlockedOptionalPackage(dependency)) {
        state.warnings.push(
          `Skipped optional platform package ${dependency}; EdgeTerm uses browser WASM adapters.`,
        );
        continue;
      }
      try {
        await this.installDependency(
          root,
          `${installPath}/node_modules/${dependency}`,
          dependency,
          dependencyRange,
          state,
          nextAncestors,
        );
      } catch (error) {
        state.warnings.push(
          `Skipped optional dependency ${dependency}: ${error.message || error}`,
        );
      }
    }
    for (const [peer, peerRange] of Object.entries(
      resolution.record.peerDependencies || packageMetadata.peerDependencies || {},
    )) {
      state.peerRequirements.push({
        package: `${resolution.name}@${resolution.version}`,
        peer,
        range: peerRange,
        optional: Boolean(
          resolution.record.peerDependenciesMeta?.[peer]?.optional ||
            packageMetadata.peerDependenciesMeta?.[peer]?.optional,
        ),
      });
    }
  }

  createState(rootMetadata) {
    return {
      packageCount: 0,
      fileCount: 0,
      expandedBytes: 0,
      installed: new Set(),
      blockedScripts: [],
      warnings: [],
      peerRequirements: [],
      lockPackages: {
        "": {
          name: String(rootMetadata.name || ""),
          version: String(rootMetadata.version || ""),
          dependencies: rootMetadata.dependencies || {},
          devDependencies: rootMetadata.devDependencies || {},
        },
      },
    };
  }

  async install(root, { packages = [], dev = false, production = false } = {}) {
    const metadata = await this.readPackageJson(root);
    const requested = packages.map(parsePackageSpec);
    if (requested.length) {
      const target = dev ? "devDependencies" : "dependencies";
      metadata[target] ||= {};
      for (const request of requested) metadata[target][request.name] = request.range;
      await this.fs.writeText(
        joinPath(root, "package.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    }
    const state = this.createState(metadata);
    await this.fs.removeTree(joinPath(root, "node_modules"));
    const dependencies = dependencyEntries(metadata, !production);
    for (const [name, range] of Object.entries(dependencies)) {
      await this.installDependency(
        root,
        `node_modules/${name}`,
        name,
        range,
        state,
      );
    }
    const installedTopLevel = new Set(Object.keys(dependencies));
    for (let index = 0; index < state.peerRequirements.length; index += 1) {
      const requirement = state.peerRequirements[index];
      if (requirement.optional || installedTopLevel.has(requirement.peer)) continue;
      await this.installDependency(
        root,
        `node_modules/${requirement.peer}`,
        requirement.peer,
        requirement.range,
        state,
      );
      installedTopLevel.add(requirement.peer);
    }
    const lockfile = {
      name: String(metadata.name || ""),
      version: String(metadata.version || ""),
      lockfileVersion: 3,
      requires: true,
      packages: state.lockPackages,
    };
    await this.fs.writeText(
      joinPath(root, "package-lock.json"),
      `${JSON.stringify(lockfile, null, 2)}\n`,
    );
    return {
      packages: state.packageCount,
      files: state.fileCount,
      expandedBytes: state.expandedBytes,
      blockedScripts: state.blockedScripts,
      peerRequirements: state.peerRequirements,
      warnings: state.warnings,
      lockfileVersion: 3,
    };
  }

  async ci(root) {
    const metadata = await this.readPackageJson(root);
    let lockfile;
    try {
      lockfile = JSON.parse(await this.fs.readText(joinPath(root, "package-lock.json")));
    } catch {
      throw npmError("npm_lockfile_missing", "npm ci requires package-lock.json.");
    }
    if (Number(lockfile.lockfileVersion) !== 3 || !lockfile.packages?.[""]) {
      throw npmError("npm_lockfile_invalid", "npm ci requires a lockfile v3 generated by EdgeTerm.");
    }
    const expected = JSON.stringify({
      dependencies: metadata.dependencies || {},
      devDependencies: metadata.devDependencies || {},
    });
    const locked = JSON.stringify({
      dependencies: lockfile.packages[""].dependencies || {},
      devDependencies: lockfile.packages[""].devDependencies || {},
    });
    if (expected !== locked) {
      throw npmError("npm_lockfile_out_of_sync", "package.json and package-lock.json are not in sync.");
    }
    await this.fs.removeTree(joinPath(root, "node_modules"));
    let packages = 0;
    let files = 0;
    let expandedBytes = 0;
    const blockedScripts = [];
    const warnings = [];
    const entries = Object.entries(lockfile.packages)
      .filter(([path]) => path)
      .sort(([left], [right]) => left.split("/").length - right.split("/").length);
    for (const [installPath, record] of entries) {
      const name = installPath.split("/node_modules/").pop().replace(/^node_modules\//, "");
      const resolution = {
        name,
        version: record.version,
        resolved: record.resolved,
        integrity: record.integrity,
        record,
      };
      this.onProgress({
        phase: "download",
        message: `Restoring ${name}@${record.version}...`,
        package: name,
      });
      const extracted = await this.registry.download(resolution);
      const state = {
        packageCount: packages,
        fileCount: files,
        expandedBytes,
        blockedScripts,
        warnings,
        lockPackages: {},
      };
      await this.writePackage(root, installPath, resolution, extracted, state);
      packages = state.packageCount;
      files = state.fileCount;
      expandedBytes = state.expandedBytes;
    }
    return {
      packages,
      files,
      expandedBytes,
      blockedScripts,
      warnings,
      lockfileVersion: 3,
    };
  }

  async uninstall(root, packageNames = []) {
    const metadata = await this.readPackageJson(root);
    const removed = packageNames.filter(
      (name) => metadata.dependencies?.[name] || metadata.devDependencies?.[name],
    ).length;
    for (const name of packageNames) {
      delete metadata.dependencies?.[name];
      delete metadata.devDependencies?.[name];
    }
    await this.fs.writeText(
      joinPath(root, "package.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    return {
      ...(await this.install(root)),
      removed,
    };
  }

  async installTransient(root, packageSpec) {
    const request = parsePackageSpec(packageSpec);
    const prefix = ".edgeterm/npm-exec";
    const metadata = {
      name: "edgeterm-npm-exec",
      version: "0.0.0",
      dependencies: {},
      devDependencies: {},
    };
    const state = this.createState(metadata);
    await this.fs.removeTree(joinPath(root, prefix));
    await this.installDependency(
      root,
      `${prefix}/node_modules/${request.name}`,
      request.name,
      request.range,
      state,
    );
    return {
      packageName: request.name,
      modulesPath: `${prefix}/node_modules`,
      packages: state.packageCount,
      files: state.fileCount,
      expandedBytes: state.expandedBytes,
      blockedScripts: state.blockedScripts,
      warnings: state.warnings,
    };
  }

  async list(root) {
    const metadata = await this.readPackageJson(root);
    const result = [];
    for (const [name, range] of Object.entries(dependencyEntries(metadata, true))) {
      try {
        const installed = JSON.parse(
          await this.fs.readText(joinPath(root, "node_modules", name, "package.json")),
        );
        result.push({ name, requested: range, version: installed.version || "", installed: true });
      } catch {
        result.push({ name, requested: range, version: "", installed: false });
      }
    }
    return result;
  }
}
