import { mkdir, cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const mode = process.argv[2] || "offline";
const root = process.cwd();
const frontendDir = path.join(root, "frontend");
const buildDir = path.join(root, "build");
const cloudEnabled = mode === "cloud";
  const assetVersion = "refresh-worker-unload-v119";

function assetBaseFor(modeName) {
  return modeName === "cloud" ? "/static/" : "./";
}

async function ensureCleanBuild() {
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(path.join(buildDir, "assets"), { recursive: true });
}

async function writeOfflineHtml() {
  const templatePath = path.join(frontendDir, "index.html");
  const template = await readFile(templatePath, "utf8");
  const globals = `
    <script>
      window.EDGETERM_CLOUD_ENABLED = ${cloudEnabled ? "true" : "false"};
      window.EDGETERM_PAGE_KIND = "main";
      window.EDGETERM_ASSET_BASE = "${assetBaseFor(mode)}";
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
  await cp(path.join(root, "rootfs.zip"), path.join(buildDir, "rootfs.zip"));
  await cp(path.join(root, "wasm-cli-worker.js"), path.join(buildDir, "wasm-cli-worker.js"));
  await cp(path.join(frontendDir, "static", "pyodide-shell-worker.js"), path.join(buildDir, "pyodide-shell-worker.js"));
}

async function walkFiles(dir, base = dir) {
  const entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
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
    "bin/bigbox/cat.py",
    "bin/bigbox/clear.py",
    "bin/bigbox/cp.py",
    "bin/bigbox/date.py",
    "bin/bigbox/echo.py",
    "bin/bigbox/env.py",
    "bin/bigbox/find.py",
    "bin/bigbox/grep.py",
    "bin/bigbox/head.py",
    "bin/bigbox/ls.py",
    "bin/bigbox/mkdir.py",
    "bin/bigbox/mv.py",
    "bin/bigbox/pwd.py",
    "bin/bigbox/python.py",
    "bin/bigbox/python3.py",
    "bin/bigbox/rm.py",
    "bin/bigbox/touch.py",
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
    normalized === "etc/appmode/config.json" ||
    normalized.startsWith("usr/lib/")
  );
}

async function collectBootRootfsFiles() {
  const rootfsDir = path.join(root, "rootfs");
  const includeDirs = ["bin", path.join("usr", "lib"), "etc", "packages"];
  const files = [];
  for (const relDir of includeDirs) {
    const fullDir = path.join(rootfsDir, relDir);
    try {
      for (const file of await walkFiles(fullDir, rootfsDir)) {
        if (isDeferredPackageAsset(file.path)) continue;
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
  }
  return files;
}

function isDeferredPackageAsset(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized.startsWith("packages/") && /\.(wasm|so)$/i.test(normalized);
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
  await mkdir(path.join(staticDir, "assets"), { recursive: true });
  await cp(path.join(buildDir, "index.html"), path.join(staticDir, "index.html"));
  await cp(path.join(buildDir, "rootfs.zip"), path.join(staticDir, "rootfs.zip"));
  await cp(path.join(buildDir, "bootfs.json"), path.join(staticDir, "bootfs.json"));
  await cp(path.join(buildDir, "bootfs-critical.json"), path.join(staticDir, "bootfs-critical.json"));
  await cp(path.join(buildDir, "bootfs-packages.json"), path.join(staticDir, "bootfs-packages.json"));
  await cp(path.join(buildDir, "wasm-cli-worker.js"), path.join(staticDir, "wasm-cli-worker.js"));
  await cp(path.join(buildDir, "pyodide-shell-worker.js"), path.join(staticDir, "pyodide-shell-worker.js"));
  await cp(path.join(buildDir, "assets", "main.js"), path.join(staticDir, "assets", "main.js"));
  await cp(path.join(buildDir, "assets", "styles.css"), path.join(staticDir, "assets", "styles.css"));
}

async function copyCss() {
  await cp(path.join(frontendDir, "src", "ui", "styles.css"), path.join(buildDir, "assets", "styles.css"));
}

async function bundleJs() {
  await build({
    entryPoints: [path.join(frontendDir, "src", "main.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    outfile: path.join(buildDir, "assets", "main.js"),
    define: {
      __EDGETERM_CLOUD_ENABLED__: cloudEnabled ? "true" : "false",
    },
  });
}

await ensureCleanBuild();
await writeBootRootfsManifest();
await Promise.all([bundleJs(), copyCss(), copyStaticRuntimeAssets()]);
await writeOfflineHtml();
await writeCloudAppShell();
await copyCloudStaticRuntimeAssets();
