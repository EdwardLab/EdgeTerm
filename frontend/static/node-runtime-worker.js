import { Wasmer } from "./wasmer-sdk/dist/index.js?v=node-runtime-v9-sdk011";

const textDecoder = new TextDecoder();
let manifest = null;
let wasmer = null;
let edgePackage = null;
let preparing = null;
let activeProcess = null;
let activeSandbox = null;
let runtimeSandbox = null;
let runtimeFilePaths = new Set();

function post(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

function errorDetails(error, fallbackCode = "node_runtime_failed") {
  return {
    code: String(error?.code || fallbackCode),
    message: String(error?.message || error || "Node runtime failed"),
    stack: String(error?.stack || ""),
  };
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertRuntimeFeatures() {
  if (!self.isSecureContext) {
    throw Object.assign(new Error("Edge.js requires a secure browser context."), {
      code: "node_runtime_insecure_context",
    });
  }
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw Object.assign(
      new Error("Edge.js requires cross-origin isolation and SharedArrayBuffer support."),
      { code: "node_runtime_cross_origin_isolation_required" },
    );
  }
  if (typeof WebAssembly === "undefined") {
    throw Object.assign(new Error("WebAssembly is not available in this browser."), {
      code: "node_runtime_webassembly_unavailable",
    });
  }
}

async function loadRuntimeArtifact(nextManifest) {
  post("progress", {
    phase: "download",
    message: "Loading Edge.js runtime...",
    bytes: Number(nextManifest.artifact.bytes || 0),
  });
  const artifactResponse = await fetch(`./${nextManifest.artifact.file}`, {
    cache: "force-cache",
  });
  if (!artifactResponse.ok) {
    throw Object.assign(
      new Error(`Unable to load Edge.js runtime: HTTP ${artifactResponse.status}`),
      { code: "node_runtime_artifact_unavailable" },
    );
  }
  const artifactBytes = new Uint8Array(await artifactResponse.arrayBuffer());
  if (
    Number(nextManifest.artifact.bytes || 0) > 0 &&
    artifactBytes.byteLength !== Number(nextManifest.artifact.bytes)
  ) {
    throw Object.assign(new Error("The Edge.js runtime size is invalid."), {
      code: "node_runtime_size_mismatch",
    });
  }
  const actualSha256 = await sha256(artifactBytes);
  if (actualSha256 !== String(nextManifest.artifact.sha256 || "")) {
    throw Object.assign(new Error("The Edge.js runtime checksum is invalid."), {
      code: "node_runtime_checksum_mismatch",
    });
  }
  return artifactBytes;
}

async function closeSandbox(sandbox) {
  if (!sandbox) return;
  try {
    await sandbox.close();
  } catch {
  }
}

async function prepareRuntime() {
  if (edgePackage && wasmer && manifest) return manifest;
  if (preparing) return await preparing;
  preparing = (async () => {
    assertRuntimeFeatures();
    post("progress", { phase: "manifest", message: "Checking Edge.js runtime..." });
    const manifestResponse = await fetch("./runtime-manifest.json", { cache: "no-cache" });
    if (!manifestResponse.ok) {
      throw Object.assign(
        new Error(`Unable to load Edge.js runtime manifest: HTTP ${manifestResponse.status}`),
        { code: "node_runtime_manifest_unavailable" },
      );
    }
    const nextManifest = await manifestResponse.json();
    if (!nextManifest?.artifact?.available) {
      throw Object.assign(
        new Error(
          "The Edge.js runtime pack is not installed. Run npm run prepare:node-runtime before building EdgeTerm.",
        ),
        { code: "node_runtime_pack_missing" },
      );
    }
    if (nextManifest.artifact.format !== "webc") {
      throw Object.assign(
        new Error("The self-hosted Edge.js runtime must use the pinned WebC package."),
        { code: "node_runtime_artifact_format_invalid" },
      );
    }

    const artifactBytes = await loadRuntimeArtifact(nextManifest);
    post("progress", { phase: "initialize", message: "Starting WASIX runtime..." });
    const nextWasmer = new Wasmer({ cache: "memory", parallelism: 2 });
    await nextWasmer.ready();
    post("progress", { phase: "compile", message: "Compiling Edge.js for this browser..." });
    const nextPackage = await nextWasmer.packages.load(artifactBytes);
    if (!nextPackage.commands.includes("edge")) {
      await nextWasmer.close();
      throw Object.assign(new Error("The Edge.js package does not export the edge command."), {
        code: "node_runtime_command_missing",
      });
    }

    let smokeSandbox = null;
    try {
      post("progress", { phase: "smoke-test", message: "Checking the Edge.js command runtime..." });
      smokeSandbox = await nextWasmer.sandboxes.create({ packages: [nextPackage] });
      const smokeResult = await smokeSandbox
        .command(nextPackage.command("edge"), ["--version"])
        .run({ check: false, timeoutMs: 30_000 });
      if (!smokeResult.ok || !smokeResult.stdout.text().trim()) {
        throw new Error(
          smokeResult.stderr.text().trim() || `Edge.js exited with code ${smokeResult.exitCode}.`,
        );
      }
    } catch (error) {
      await closeSandbox(smokeSandbox);
      await nextWasmer.close();
      throw Object.assign(
        new Error(`The Edge.js runtime did not pass its startup check: ${error.message || error}`),
        { code: "node_runtime_smoke_failed" },
      );
    }
    runtimeSandbox = smokeSandbox;
    runtimeFilePaths = new Set();
    wasmer = nextWasmer;
    edgePackage = nextPackage;
    manifest = nextManifest;
    post("progress", { phase: "ready", message: "Edge.js runtime is ready." });
    return manifest;
  })();
  try {
    return await preparing;
  } finally {
    preparing = null;
  }
}

function normalizeEntryPath(value) {
  const raw = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw Object.assign(new Error(`Unsafe runtime file path: ${value}`), {
        code: "node_runtime_path_invalid",
      });
    }
    parts.push(part);
  }
  return parts.join("/");
}

function decodeFile(file) {
  if (file.encoding !== "base64") return String(file.data ?? file.text ?? "");
  return Uint8Array.from(atob(String(file.data || "")), (character) =>
    character.charCodeAt(0),
  );
}

function createWorkspaceFiles(files = []) {
  const workspace = {};
  for (const file of Array.isArray(files) ? files : []) {
    const path = normalizeEntryPath(file?.path);
    if (path) workspace[path] = decodeFile(file);
  }
  return workspace;
}

async function ensureParentDirectories(fs, path) {
  const parts = String(path || "").split("/").filter(Boolean);
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await fs.mkdir(current, { recursive: true });
    } catch {
    }
  }
}

async function syncWorkspaceFiles(sandbox, files = []) {
  const workspace = createWorkspaceFiles(files);
  const nextPaths = new Set(Object.keys(workspace));
  for (const path of runtimeFilePaths) {
    if (nextPaths.has(path)) continue;
    try {
      await sandbox.fs.remove(path);
    } catch {
    }
  }
  for (const [path, contents] of Object.entries(workspace)) {
    await ensureParentDirectories(sandbox.fs, path);
    await sandbox.fs.writeFile(path, contents);
  }
  runtimeFilePaths = nextPaths;
}

async function pumpStream(stream, name, requestId, chunks) {
  if (!stream) return;
  for await (const value of stream) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(bytes);
    const text = textDecoder.decode(bytes, { stream: true });
    if (text) post("output", { requestId, stream: name, text });
  }
}

function joinChunks(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return textDecoder.decode(result);
}

async function runEdge(requestId, payload = {}) {
  const currentManifest = await prepareRuntime();
  const args = Array.isArray(payload.args) ? payload.args.map((value) => String(value)) : [];
  const cwd = String(payload.cwd || "/workspace");
  const env = Object.fromEntries(
    Object.entries(payload.env || {}).map(([key, value]) => [String(key), String(value)]),
  );
  post("progress", {
    requestId,
    phase: "execute",
    message: `Running Edge.js ${args.join(" ")}`.trim(),
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  const sandbox = runtimeSandbox;
  if (!sandbox) {
    throw Object.assign(new Error("The Edge.js runtime sandbox is not ready."), {
      code: "node_runtime_sandbox_unavailable",
    });
  }
  await syncWorkspaceFiles(sandbox, payload.files);
  activeSandbox = sandbox;
  try {
    const process = await sandbox
      .command(edgePackage.command("edge"), args, { cwd, env })
      .spawn({ stdin: "closed", stdout: "pipe", stderr: "pipe" });
    activeProcess = process;
    const stdout = pumpStream(process.stdout, "stdout", requestId, stdoutChunks);
    const stderr = pumpStream(process.stderr, "stderr", requestId, stderrChunks);
    const result = await process.wait({ check: false });
    await Promise.allSettled([stdout, stderr]);
    return {
      exitCode: Number(result.exitCode || 0),
      ok: Boolean(result.ok),
      runtimeVersion: String(currentManifest.version || ""),
      stdout: joinChunks(stdoutChunks),
      stderr: joinChunks(stderrChunks),
    };
  } finally {
    activeProcess = null;
    activeSandbox = null;
  }
}

async function cancelActiveProcess() {
  try {
    await activeProcess?.kill();
  } catch {
  }
  activeProcess = null;
  activeSandbox = null;
}

self.onmessage = (event) => {
  const message = event.data || {};
  const requestId = String(message.requestId || "");
  if (message.type === "prepare") {
    prepareRuntime()
      .then((currentManifest) =>
        post("result", {
          requestId,
          result: {
            ready: true,
            runtimeVersion: String(currentManifest.version || ""),
            edgejsCommit: String(currentManifest.edgejs_commit || ""),
          },
        }),
      )
      .catch((error) =>
        post("error", { requestId, error: errorDetails(error, "node_runtime_prepare_failed") }),
      );
    return;
  }
  if (message.type === "run") {
    runEdge(requestId, message.payload || {})
      .then((result) => post("result", { requestId, result }))
      .catch((error) => {
        activeProcess = null;
        activeSandbox = null;
        post("error", { requestId, error: errorDetails(error) });
      });
    return;
  }
  if (message.type === "cancel") {
    cancelActiveProcess().finally(() =>
      post("result", { requestId, result: { cancelled: true } }),
    );
    return;
  }
  if (message.type === "status") {
    post("result", {
      requestId,
      result: {
        ready: Boolean(edgePackage && wasmer),
        running: Boolean(activeProcess),
        runtimeVersion: String(manifest?.version || ""),
      },
    });
  }
};
