import { createHash } from "node:crypto";
import { access, mkdir, cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import JSZip from "jszip";

const mode = process.argv[2] || "offline";
if (!["offline", "cloud", "embed"].includes(mode)) {
  throw new Error(`Unsupported EdgeTerm build mode: ${mode}`);
}
const root = process.cwd();
const frontendDir = path.join(root, "frontend");
const buildDir = path.join(root, "build");
const cloudEnabled = mode === "cloud";
const embedEnabled = mode === "embed";
const assetVersion = "startup-main-v384-release-readiness";
const bridgeProtocol = "edgeterm.bridge.v3";
const bridgeVersion = "3.0.0";

function parseBridgeAllowedOrigins(rawValue) {
  const origins = [];
  for (const candidate of String(rawValue || "").split(",")) {
    const value = candidate.trim();
    if (!value) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Invalid EdgeTerm Bridge parent origin: ${value}`);
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(`Invalid EdgeTerm Bridge parent origin: ${value}`);
    }
    origins.push(parsed.origin);
  }
  return [...new Set(origins)];
}

const bridgeAllowedOrigins = embedEnabled
  ? parseBridgeAllowedOrigins(
      process.env.EDGETERM_BRIDGE_ALLOWED_ORIGINS ||
        "http://127.0.0.1:3100,http://localhost:3100",
    )
  : [];
if (embedEnabled && bridgeAllowedOrigins.length === 0) {
  throw new Error("EdgeTerm Embed requires at least one allowed parent origin.");
}

function assetBaseFor(modeName) {
  return modeName === "cloud" ? "/static/" : "./";
}

async function ensureCleanBuild() {
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(path.join(buildDir, "assets"), { recursive: true });
  if (embedEnabled) await mkdir(path.join(buildDir, "bridge"), { recursive: true });
}

async function writeOfflineHtml() {
  const templatePath = path.join(frontendDir, "index.html");
  const template = await readFile(templatePath, "utf8");
  const globals = `
    <script>
      window.EDGETERM_CLOUD_ENABLED = ${cloudEnabled ? "true" : "false"};
      window.EDGETERM_PAGE_KIND = "main";
      window.EDGETERM_ASSET_BASE = "${assetBaseFor(mode)}";
      window.EDGETERM_EMBED_ENABLED = ${embedEnabled ? "true" : "false"};
      window.EDGETERM_BRIDGE_ALLOWED_ORIGINS = ${JSON.stringify(bridgeAllowedOrigins)};
      window.EDGETERM_BUILD_VERSION = "${assetVersion}";
      window.EDGETERM_PACKAGE_REPOSITORY_URL = ${JSON.stringify(process.env.EDGETERM_APT_REPOSITORY_URL || "https://packages.digitalplat.org/local-flat")};
    </script>`;
  const html = template
    .replace('./src/ui/styles.css', './assets/styles.css')
    .replace(
      '<script type="module" src="./src/main.js"></script>',
      `${globals}\n    <script type="module" src="./assets/main.js?v=${assetVersion}"></script>`
    );
  await writeFile(path.join(buildDir, "index.html"), html, "utf8");
}

async function writeCloudAppShell() {
  if (!cloudEnabled) return;
  const templatePath = path.join(frontendDir, "index.html");
  const template = await readFile(templatePath, "utf8");
  const globals = `
    <script>
      window.EDGETERM_CLOUD_ENABLED = true;
      window.EDGETERM_PAGE_KIND = "{{ page_kind }}";
      window.EDGETERM_ASSET_BASE = "{{ url_for('static', filename='') }}";
      window.EDGETERM_EMBED_ENABLED = false;
      window.EDGETERM_BRIDGE_ALLOWED_ORIGINS = [];
      window.EDGETERM_PACKAGE_REPOSITORY_URL = ${JSON.stringify(process.env.EDGETERM_APT_REPOSITORY_URL || "https://packages.digitalplat.org/local-flat")};
      window.EDGETERM_BUILD_VERSION = "${assetVersion}";
    </script>`;
  const html = template
    .replace('./src/ui/styles.css', "{{ url_for('static', filename='assets/styles.css') }}")
    .replace(
      '<script type="module" src="./src/main.js"></script>',
      `${globals}\n    <script type="module" src="{{ url_for('static', filename='assets/main.js') }}?v=${assetVersion}"></script>`
    );
  await writeFile(path.join(root, "backend", "templates", "app_shell.html"), html, "utf8");
}

async function copyStaticRuntimeAssets() {
  const zip = new JSZip();
  const rootfsDir = path.join(root, "rootfs");
  for (const file of await walkFiles(rootfsDir)) {
    zip.file(file.path, await readFile(file.fullPath), { date: new Date("2000-01-01T00:00:00Z"), createFolders: false });
  }
  await writeFile(path.join(buildDir, "rootfs.zip"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  await cp(path.join(root, "wasm-cli-worker.js"), path.join(buildDir, "wasm-cli-worker.js"));
  await cp(path.join(frontendDir, "static", "pyodide-shell-worker.js"), path.join(buildDir, "pyodide-shell-worker.js"));
  await cp(path.join(frontendDir, "static", "language-service-worker.js"), path.join(buildDir, "language-service-worker.js"));
  await cp(path.join(frontendDir, "static", "debug-runtime-worker.js"), path.join(buildDir, "debug-runtime-worker.js"));
  if (embedEnabled) {
    await cp(path.join(root, "packages", "bridge", "index.js"), path.join(buildDir, "bridge", "host-client.js"));
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildNodeRuntimeAssets() {
  const outputDir = path.join(buildDir, "node-runtime");
  const sdkRoot = path.join(root, "node_modules", "@wasmer", "sdk");
  const legacySdkDir = path.join(root, "runtime", "wasmer-sdk", "dist");
  const esbuildWasm = path.join(root, "node_modules", "esbuild-wasm", "esbuild.wasm");
  const sourceManifestPath = path.join(root, "runtime", "node", "manifest.json");
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const artifactPath = path.join(
    root,
    "runtime-packages",
    "node",
    sourceManifest.artifact.file,
  );
  const artifactAvailable = await pathExists(artifactPath);

  await mkdir(path.join(outputDir, "wasmer-sdk"), { recursive: true });
  await cp(path.join(sdkRoot, "dist"), path.join(outputDir, "wasmer-sdk", "dist"), {
    recursive: true,
  });
  await cp(path.join(sdkRoot, "pkg"), path.join(outputDir, "wasmer-sdk", "pkg"), {
    recursive: true,
  });
  await cp(path.join(sdkRoot, "LICENSE"), path.join(outputDir, "wasmer-sdk", "LICENSE"));
  await cp(path.join(legacySdkDir, "index.mjs"), path.join(outputDir, "wasmer-sdk", "index.mjs"));
  await cp(path.join(legacySdkDir, "worker.mjs"), path.join(outputDir, "wasmer-sdk", "worker.mjs"));
  await cp(
    path.join(legacySdkDir, "wasmer_js_bg.wasm"),
    path.join(outputDir, "wasmer-sdk", "wasmer_js_bg.wasm"),
  );
  await cp(esbuildWasm, path.join(outputDir, "esbuild.wasm"));
  await cp(
    path.join(frontendDir, "static", "node-runtime-worker.js"),
    path.join(outputDir, "node-runtime-worker.js"),
  );
  await cp(
    path.join(frontendDir, "static", "node-runtime-worker.js"),
    path.join(outputDir, "node-runtime-worker-v9-sdk011.js"),
  );
  await build({
    entryPoints: [path.join(frontendDir, "src", "node", "frontend-build-worker.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    outfile: path.join(outputDir, "frontend-build-worker.js"),
  });

  if (artifactAvailable) {
    const actualSha256 = await sha256File(artifactPath);
    if (actualSha256 !== sourceManifest.artifact.sha256) {
      throw new Error(
        `Edge.js runtime checksum mismatch: expected ${sourceManifest.artifact.sha256}, got ${actualSha256}`,
      );
    }
    await cp(artifactPath, path.join(outputDir, sourceManifest.artifact.file));
  }

  await writeFile(
    path.join(outputDir, "runtime-manifest.json"),
    JSON.stringify(
      {
        ...sourceManifest,
        artifact: {
          ...sourceManifest.artifact,
          available: artifactAvailable,
        },
        sdk: {
          package: "@wasmer/sdk",
          version: "0.11.0",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function buildExternalShellAssets() {
  const outputDir = path.join(buildDir, "external-runtime");
  const sourceConfig = JSON.parse(
    await readFile(path.join(root, "runtime", "external-shell.json"), "utf8"),
  );
  const localManifestPath = path.join(
    root,
    "runtime-packages",
    "external-shell",
    "runtime-manifest.json",
  );
  const configuredManifestUrl = String(
    process.env.EDGETERM_EXTERNAL_SHELL_MANIFEST_URL || "",
  ).trim();
  let manifestUrl = configuredManifestUrl;
  await mkdir(outputDir, { recursive: true });
  if (!configuredManifestUrl && (await pathExists(localManifestPath))) {
    const localManifest = JSON.parse(await readFile(localManifestPath, "utf8"));
    const artifactName = String(localManifest?.artifact?.file || "").trim();
    const expectedSha256 = String(localManifest?.artifact?.sha256 || "").trim();
    const expectedBytes = Number(localManifest?.artifact?.bytes);
    if (!artifactName || !expectedSha256 || !Number.isSafeInteger(expectedBytes)) {
      throw new Error("The local external shell manifest is incomplete.");
    }
    const artifactPath = path.join(path.dirname(localManifestPath), artifactName);
    const artifactInfo = await stat(artifactPath);
    if (artifactInfo.size !== expectedBytes) {
      throw new Error(
        `External shell runtime size mismatch: expected ${expectedBytes}, got ${artifactInfo.size}`,
      );
    }
    const actualSha256 = await sha256File(artifactPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `External shell runtime checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }
    await cp(localManifestPath, path.join(outputDir, "runtime-manifest.json"));
    await cp(artifactPath, path.join(outputDir, artifactName));
    manifestUrl = "./runtime-manifest.json";
  } else if (!manifestUrl) {
    manifestUrl = String(sourceConfig.manifest_url || "").trim();
  }
  if (!manifestUrl) throw new Error("The external shell manifest URL is required.");
  await cp(
    path.join(frontendDir, "static", "external-runtime-worker.js"),
    path.join(outputDir, "external-runtime-worker.js"),
  );
  await cp(
    path.join(frontendDir, "static", "external-runtime-worker.js"),
    path.join(outputDir, "external-runtime-worker-v261-apt-repository.js"),
  );
  await cp(
    path.join(frontendDir, "static", "posix-profile.js"),
    path.join(outputDir, "posix-profile.js"),
  );
  await cp(path.join(frontendDir, "static", "apt-repository.js"), path.join(outputDir, "apt-repository.js"));
  await writeFile(
    path.join(outputDir, "runtime-config.json"),
    JSON.stringify({ ...sourceConfig, manifest_url: manifestUrl }, null, 2),
    "utf8",
  );
}

async function walkFiles(dir, base = dir) {
  const entries = [];
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of children) {
    if (entry.name === "__pycache__") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await walkFiles(fullPath, base)));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(fullPath);
    entries.push({
      path: path.relative(base, fullPath).replaceAll(path.sep, "/"),
      size: info.size,
      fullPath,
    });
  }
  return entries;
}

async function writeBootRootfsManifest() {
  const files = await collectBootRootfsFiles();
  const criticalFiles = files.filter((file) => isCriticalBootFile(file.path));
  await mkdir(path.join(frontendDir, "src", "generated"), { recursive: true });
  await writeFile(
    path.join(buildDir, "bootfs.json"),
    JSON.stringify({ version: assetVersion, files }),
    "utf8"
  );
  await writeFile(
    path.join(buildDir, "bootfs-critical.json"),
    JSON.stringify({ version: assetVersion, files: criticalFiles }),
    "utf8"
  );
  await writeFile(
    path.join(buildDir, "bootfs-packages.json"),
    JSON.stringify({ version: assetVersion, files: await collectPackageAssetFiles() }),
    "utf8"
  );
  await writeFile(
    path.join(frontendDir, "src", "generated", "bootfs-critical.js"),
    `export let BOOTFS_CRITICAL_FILES = ${JSON.stringify(criticalFiles)};\nexport function clearBootfsCriticalFiles() { BOOTFS_CRITICAL_FILES = []; }\n`,
    "utf8"
  );
}

function isCriticalBootFile(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const criticalCommands = new Set([
    "bin/bigbox/bigbox.py",
    "bin/bigbox/bigbox_utils.py",
    "bin/bigbox/cat.py",
    "bin/bigbox/cd.py",
    "bin/bigbox/clear.py",
    "bin/bigbox/cp.py",
    "bin/bigbox/curl.py",
    "bin/bigbox/date.py",
    "bin/bigbox/django-admin.py",
    "bin/bigbox/edgepkg.py",
    "bin/bigbox/edgeserve.py",
    "bin/bigbox/echo.py",
    "bin/bigbox/env.py",
    "bin/bigbox/find.py",
    "bin/bigbox/grep.py",
    "bin/bigbox/head.py",
    "bin/bigbox/help.py",
    "bin/bigbox/ls.py",
    "bin/bigbox/mkdir.py",
    "bin/bigbox/mv.py",
    "bin/bigbox/pip.py",
    "bin/bigbox/pip3.py",
    "bin/bigbox/pkg.py",
    "bin/bigbox/pwd.py",
    "bin/bigbox/python.py",
    "bin/bigbox/python3.py",
    "bin/bigbox/rm.py",
    "bin/bigbox/touch.py",
    "bin/bigbox/test.py",
    "bin/bigbox/unzip.py",
    "bin/bigbox/wget.py",
    "bin/bigbox/which.py",
    "bin/bigbox/wine.py",
    "bin/bigbox/wine11.py",
    "bin/bigbox/winecfg.py",
    "bin/bigbox/wineconsole.py",
    "bin/bigbox/winetricks.py",
  ]);
  return (
    normalized === "bin/shell.py" ||
    criticalCommands.has(normalized) ||
    normalized === "etc/motd" ||
    normalized === "etc/profile" ||
    normalized === "etc/sources.list" ||
    normalized === "etc/appmode/config.json" ||
    normalized.startsWith("usr/lib/")
  );
}

async function collectBootRootfsFiles() {
  const rootfsDir = path.join(root, "rootfs");
  const includeDirs = ["bin", path.join("usr", "lib"), "etc", "packages"];
  const filesByPath = new Map();
  for (const relDir of includeDirs) {
    const fullDir = path.join(rootfsDir, relDir);
    try {
      for (const file of await walkFiles(fullDir, rootfsDir)) {
        if (isDeferredPackageAsset(file.path)) continue;
        const bytes = await readFile(file.fullPath);
        filesByPath.set(file.path, {
          path: file.path,
          encoding: "base64",
          data: bytes.toString("base64"),
        });
      }
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  return [...filesByPath.values()];
}

function isDeferredPackageAsset(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.startsWith("etc/apt/")
    || (normalized.startsWith("packages/") && /\.(wasm|so)$/i.test(normalized));
}

async function collectPackageAssetFiles() {
  const rootfsDir = path.join(root, "rootfs");
  const packageDir = path.join(rootfsDir, "packages");
  const files = [];
  try {
    for (const file of await walkFiles(packageDir, rootfsDir)) {
      const bytes = await readFile(file.fullPath);
      files.push({
        path: file.path,
        encoding: "base64",
        data: bytes.toString("base64"),
      });
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  return files;
}

async function copyCloudStaticRuntimeAssets() {
  if (!cloudEnabled) return;
  const staticDir = path.join(root, "backend", "static");
  for (const directory of ["assets", "node-runtime", "external-runtime"]) {
    await rm(path.join(staticDir, directory), { recursive: true, force: true });
  }
  await mkdir(path.join(staticDir, "assets"), { recursive: true });
  await cp(path.join(buildDir, "index.html"), path.join(staticDir, "index.html"));
  await cp(path.join(buildDir, "rootfs.zip"), path.join(staticDir, "rootfs.zip"));
  await cp(path.join(buildDir, "bootfs.json"), path.join(staticDir, "bootfs.json"));
  await cp(path.join(buildDir, "bootfs-critical.json"), path.join(staticDir, "bootfs-critical.json"));
  await cp(path.join(buildDir, "bootfs-packages.json"), path.join(staticDir, "bootfs-packages.json"));
  await cp(path.join(buildDir, "wasm-cli-worker.js"), path.join(staticDir, "wasm-cli-worker.js"));
  await cp(path.join(buildDir, "pyodide-shell-worker.js"), path.join(staticDir, "pyodide-shell-worker.js"));
  await cp(path.join(buildDir, "language-service-worker.js"), path.join(staticDir, "language-service-worker.js"));
  await cp(path.join(buildDir, "debug-runtime-worker.js"), path.join(staticDir, "debug-runtime-worker.js"));
  await cp(path.join(buildDir, "assets", "main.js"), path.join(staticDir, "assets", "main.js"));
  await cp(path.join(buildDir, "assets", "styles.css"), path.join(staticDir, "assets", "styles.css"));
  await cp(path.join(buildDir, "node-runtime"), path.join(staticDir, "node-runtime"), {
    recursive: true,
  });
  await cp(path.join(buildDir, "external-runtime"), path.join(staticDir, "external-runtime"), {
    recursive: true,
  });
}

async function copyCss() {
  await cp(path.join(frontendDir, "src", "ui", "styles.css"), path.join(buildDir, "assets", "styles.css"));
}

async function bundleJs() {
  const outputFile = path.join(buildDir, "assets", "main.js");
  await build({
    entryPoints: [path.join(frontendDir, "src", "main.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    outfile: outputFile,
    define: {
      __EDGETERM_CLOUD_ENABLED__: cloudEnabled ? "true" : "false",
    },
  });
  const bundledSource = await readFile(outputFile, "utf8");
  await writeFile(outputFile, bundledSource.replace(/[ \t]+$/gm, ""), "utf8");
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeBridgeManifest() {
  if (!embedEnabled) return;
  const files = await walkFiles(buildDir);
  const assets = {};
  for (const file of files) {
    if (file.path === "bridge-manifest.json") continue;
    assets[file.path] = {
      bytes: file.size,
      sha256: await sha256File(file.fullPath),
    };
  }
  await writeFile(
    path.join(buildDir, "bridge-manifest.json"),
    JSON.stringify(
      {
        schema: "edgeterm.embed.manifest.v1",
        runtime_version: assetVersion,
        bridge_protocol: bridgeProtocol,
        bridge_version: bridgeVersion,
        build_mode: mode,
        allowed_parent_origins: bridgeAllowedOrigins,
        capabilities: {
          local_workspace: true,
          cloud_storage: false,
          browser_worker: true,
        },
        assets,
      },
      null,
      2,
    ),
    "utf8",
  );
}

await ensureCleanBuild();
await writeBootRootfsManifest();
await Promise.all([
  bundleJs(),
  copyCss(),
  copyStaticRuntimeAssets(),
  buildNodeRuntimeAssets(),
  buildExternalShellAssets(),
]);
await writeOfflineHtml();
await writeCloudAppShell();
await copyCloudStaticRuntimeAssets();
await writeBridgeManifest();
