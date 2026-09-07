import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const build = path.resolve(process.env.EDGETERM_TEST_BUILD_DIR || path.join(root, "build"));
const repository = path.resolve(process.env.EDGETERM_PACKAGES_LOCAL_DIR || path.join(root, "../edgeterm-packages/repository/local-flat"));
const port = Number(process.env.EDGETERM_TEST_PORT || 3100);
const report = process.env.EDGETERM_TEST_REPORT || "/tmp/edgeterm-browser-acceptance.json";
const indexText = await readFile(path.join(repository, "Packages"), "utf8");
const artifacts = Object.fromEntries(indexText.split(/\n\s*\n/).filter((entry) => /^Package:/m.test(entry)).map((entry) => [
  entry.match(/^Package:\s*(.+)$/m)[1],
  { version: entry.match(/^Version:\s*(.+)$/m)[1], sha256: entry.match(/^SHA256:\s*(.+)$/m)[1] },
]));
let repositoryUnavailable = false;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "POST" && ["/__test/results", "/__test/repository-mode"].includes(url.pathname)) {
      if (req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString());
      if (url.pathname.endsWith("results")) await writeFile(report, JSON.stringify({ ...value, artifacts, repository_origin: process.env.EDGETERM_TEST_REPOSITORY_ORIGIN || "local-fixture", index_sha256: createHash("sha256").update(indexText).digest("hex") }, null, 2));
      else repositoryUnavailable = value.unavailable === true;
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    let base;
    let relative;
    if (url.pathname.startsWith("/edgeterm-packages/local-flat/")) {
      if (repositoryUnavailable) { res.writeHead(503).end("Repository temporarily unavailable"); return; }
      base = repository;
      relative = url.pathname.slice("/edgeterm-packages/local-flat/".length);
    } else if (url.pathname.startsWith("/edgeterm/")) {
      base = build;
      relative = url.pathname.slice("/edgeterm/".length);
    } else {
      base = root;
      relative = ({ "/": "tests/browser/index.html", "/suite.js": "tests/browser/suite.js", "/host-client.js": "packages/bridge/index.js" })[url.pathname];
      if (!relative) { res.writeHead(404).end(); return; }
    }
    const file = path.resolve(base, decodeURIComponent(relative || "index.html"));
    if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Content-Length": info.size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  } catch (error) {
    res.writeHead(error.code === "ENOENT" ? 404 : 500).end("Test server request failed");
  }
}).listen(port, "127.0.0.1", () => console.log(`Browser acceptance: http://127.0.0.1:${port}/\nReport: ${report}`));
