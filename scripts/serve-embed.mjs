import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve(process.cwd(), "build");
const host = process.env.EDGETERM_EMBED_HOST || "127.0.0.1";
const port = Math.max(1, Math.min(65_535, Number(process.env.EDGETERM_EMBED_PORT) || 3_200));
const externalRuntimeRoot = String(process.env.EDGETERM_EXTERNAL_RUNTIME_LOCAL_DIR || "").trim()
  ? path.resolve(process.env.EDGETERM_EXTERNAL_RUNTIME_LOCAL_DIR)
  : null;
const externalRuntimePrefix = "/external-runtime-package/";
const packagesRoot = path.resolve(
  String(process.env.EDGETERM_PACKAGES_LOCAL_DIR || "").trim()
    || path.join(process.cwd(), "../EdgeTerm-Packages/repository/local-flat"),
);
const packagesPrefix = "/edgeterm-packages/local-flat/";

function parseAllowedOrigins(rawValue) {
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

const allowedOrigins = parseAllowedOrigins(
  process.env.EDGETERM_BRIDGE_ALLOWED_ORIGINS ||
    "http://127.0.0.1:3100,http://localhost:3100",
);
if (allowedOrigins.length === 0) {
  throw new Error("EdgeTerm Embed requires at least one allowed parent origin.");
}
const frameAncestors = allowedOrigins.join(" ");

async function validateEmbedBuild() {
  const manifestPath = path.join(root, "bridge-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `EdgeTerm Embed cannot read ${manifestPath}. Run npm run build:embed before npm run serve:embed.`,
      { cause: error },
    );
  }

  if (manifest?.schema !== "edgeterm.embed.manifest.v1" || manifest?.build_mode !== "embed") {
    throw new Error(
      "EdgeTerm Embed refused to serve a non-embed build. Run npm run build:embed before npm run serve:embed.",
    );
  }

  const builtOrigins = Array.isArray(manifest.allowed_parent_origins)
    ? [...new Set(manifest.allowed_parent_origins)].sort()
    : [];
  const servedOrigins = [...allowedOrigins].sort();
  if (
    builtOrigins.length !== servedOrigins.length ||
    builtOrigins.some((origin, index) => origin !== servedOrigins[index])
  ) {
    throw new Error(
      `EdgeTerm Embed origin mismatch. The build allows [${builtOrigins.join(", ")}], but the server allows [${servedOrigins.join(", ")}]. Rebuild with the same EDGETERM_BRIDGE_ALLOWED_ORIGINS value.`,
    );
  }
}

await validateEmbedBuild();

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".deb", "application/vnd.debian.binary-package"],
  [".wasm", "application/wasm"],
  [".zip", "application/zip"],
]);

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl || "/", `http://${host}:${port}`).pathname);
  const requestUsesExternalRuntime = Boolean(
    externalRuntimeRoot && pathname.startsWith(externalRuntimePrefix),
  );
  const requestUsesPackages = pathname === packagesPrefix.slice(0, -1)
    || pathname.startsWith(packagesPrefix);
  const requestRoot = requestUsesExternalRuntime
    ? externalRuntimeRoot
    : requestUsesPackages
      ? packagesRoot
      : root;
  const relative = requestUsesExternalRuntime
    ? pathname.slice(externalRuntimePrefix.length)
    : requestUsesPackages
      ? pathname.slice(packagesPrefix.length)
      : pathname === "/"
        ? "index.html"
        : pathname.replace(/^\/+/, "");
  if (!relative) return null;
  const candidate = path.resolve(requestRoot, relative);
  if (candidate !== requestRoot && !candidate.startsWith(`${requestRoot}${path.sep}`)) return null;
  return candidate;
}

const server = createServer(async (request, response) => {
  const filePath = resolveRequestPath(request.url);
  if (!filePath) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid path");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": info.size,
      "Content-Security-Policy": `frame-ancestors ${frameAncestors}`,
      "Content-Type": path.basename(filePath) === "Packages"
        ? "text/plain; charset=utf-8"
        : mimeTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Origin-Agent-Cluster": "?1",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`EdgeTerm Embed is available at http://${host}:${port}/index.html`);
  if (externalRuntimeRoot) {
    console.log(
      `Local external runtime is available at http://${host}:${port}${externalRuntimePrefix}`,
    );
  }
  console.log(`Local APT repository is available at http://${host}:${port}${packagesPrefix}`);
});
