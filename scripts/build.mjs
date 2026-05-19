import { mkdir, cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const mode = process.argv[2] || "offline";
const root = process.cwd();
const frontendDir = path.join(root, "frontend");
const buildDir = path.join(root, "build");
const cloudEnabled = mode === "cloud";
const assetVersion = "php-wasm-v140";

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
}

async function copyCloudStaticRuntimeAssets() {
  if (!cloudEnabled) return;
  const staticDir = path.join(root, "backend", "static");
  await mkdir(path.join(staticDir, "assets"), { recursive: true });
  await cp(path.join(buildDir, "index.html"), path.join(staticDir, "index.html"));
  await cp(path.join(buildDir, "rootfs.zip"), path.join(staticDir, "rootfs.zip"));
  await cp(path.join(buildDir, "wasm-cli-worker.js"), path.join(staticDir, "wasm-cli-worker.js"));
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
await Promise.all([bundleJs(), copyCss(), copyStaticRuntimeAssets()]);
await writeOfflineHtml();
await writeCloudAppShell();
await copyCloudStaticRuntimeAssets();
