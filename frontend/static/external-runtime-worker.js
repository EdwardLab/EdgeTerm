let Directory;
let Runtime;
let Wasmer;
let initWasmer;
let runWasix;
let createPosixProfile;

self.addEventListener("error", (event) => {
  self.postMessage({
    type: "bootstrap-error",
    error: {
      code: "external_shell_worker_uncaught_error",
      message: String(event.message || "The external shell worker reported an uncaught error."),
      stack: String(event.error?.stack || ""),
      filename: String(event.filename || ""),
      line: Number(event.lineno || 0),
      column: Number(event.colno || 0),
      recoverable: true,
    },
  });
});

self.addEventListener("unhandledrejection", (event) => {
  self.postMessage({
    type: "bootstrap-error",
    error: {
      code: "external_shell_worker_unhandled_rejection",
      message: String(event.reason?.message || event.reason || "The external shell worker rejected a runtime operation."),
      stack: String(event.reason?.stack || ""),
      recoverable: true,
    },
  });
});

try {
  const sdk = await import("../node-runtime/wasmer-sdk/index.mjs?v=apt-wasix-v93");
  const profile = await import("./posix-profile.js?v=apt-wasix-v93");
  ({ Directory, Runtime, Wasmer, runWasix } = sdk);
  initWasmer = sdk.init;
  createPosixProfile = profile.createPosixProfile;
} catch (error) {
  self.postMessage({
    type: "bootstrap-error",
    error: {
      code: "external_shell_worker_bootstrap_failed",
      message: String(error?.message || error || "The external shell worker could not load its runtime modules."),
      stack: String(error?.stack || ""),
      recoverable: true,
    },
  });
}

let config = null;
let manifest = null;
let artifactBytes = null;
let runtimePackage = null;
let runtimeBinaries = null;
let runtimeDataEntries = null;
let wasixRuntime = null;
let commandRuntime = null;
const PROCESS_STREAM_DRAIN_TIMEOUT_MS = 120;
const PROCESS_STREAM_CANCEL_TIMEOUT_MS = 80;
const PROCESS_CAPTURE_DRAIN_TIMEOUT_MS = 1000;
let commandSystemCache = null;
const installedRuntimePackages = new Map();
let wasmerInitialized = false;
let preparing = null;
let interactiveSession = null;
const ASH_PROMPT_PREFIX = "\u001eEDGETERM_ASH_PROMPT:";
const ASH_PROMPT_SUFFIX = "\u001f";
const ASH_CONTINUATION_MARKER = "\u001eEDGETERM_ASH_CONTINUE\u001f";
const ASH_CWD_QUERY_PREFIX = "__EDGETERM_ASH_CWD:";
const ASH_CWD_QUERY_SUFFIX = ":EDGETERM_CWD_END__";
const ASH_COMMAND_QUERY_PREFIX = "\u001eEDGETERM_ASH_COMMAND:";
const POSIX_SEED_ROOT = "/.edgeterm-posix";
const WORKSPACE_MOUNT_ROOT = "/home/user";
const WORKSPACE_RUNTIME_ROOT = WORKSPACE_MOUNT_ROOT;
const DIRECT_RUNTIME_ROOT = "/.edgeterm-direct-workspace";
const WORKSPACE_TEMP_ROOT = ".edgeterm-posix/tmp";
const PACKAGE_SYSTEM_MOUNTS = new Set([
  "/usr",
  "/opt",
  "/etc",
  "/var",
]);
const POSIX_VIRTUAL_ROOT_MOUNTS = [
  "/boot",
  "/dev",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/overlay",
  "/packages",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/workspace-store",
];
const WASMER_SDK_CACHE_VERSION = "apt-wasix-v73-path-times-runtime";
const RUNTIME_BINARY_NAMES = [
  "busybox",
  "apt",
  "apt-cache",
  "apt-get",
  "apt-config",
  "apt-mark",
  "file",
  "copy",
  "store",
  "http",
  "gpgv",
  "dpkg",
  "dpkg-deb",
  "dpkg-query",
  "dpkg-divert",
  "dpkg-realpath",
  "dpkg-split",
  "dpkg-statoverride",
  "dpkg-trigger",
];
const BUSYBOX_APPLET_NAMES = [
  "ar", "ash", "awk", "base64", "basename", "bunzip2", "bzcat", "bzip2",
  "cat", "chgrp", "chmod", "chown", "cksum", "cmp", "comm", "cp", "cpio",
  "cut", "date", "dd", "diff", "dirname", "du", "echo", "env", "expand",
  "expr", "false", "find", "fold", "grep", "gzip", "gunzip", "head", "id",
  "install", "ln", "ls", "mkdir", "mktemp", "mv", "paste", "patch", "printf",
  "ps", "pwd", "readlink", "realpath", "rm", "rmdir", "run-parts", "sed", "seq",
  "sh", "sha256sum", "sleep", "sort", "stat", "tail", "tar", "tee", "test",
  "touch", "tr", "true", "truncate", "tty", "uname", "uniq", "unlink", "unxz",
  "unzip", "wc", "which", "whoami", "xargs", "xz", "yes", "zcat",
];
function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function runtimeError(code, message, recoverable = true) {
  return Object.assign(new Error(message), { code, recoverable });
}

function errorDetails(error, fallbackCode = "external_shell_worker_failed") {
  return {
    code: String(error?.code || fallbackCode),
    message: String(error?.message || error || "The external shell worker failed."),
    recoverable: error?.recoverable !== false,
  };
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertRuntimeFeatures() {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw runtimeError(
      "external_shell_cross_origin_isolation_required",
      "The external WASIX shell requires cross-origin isolation and SharedArrayBuffer support.",
    );
  }
}

async function fetchJson(url, code, label) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw runtimeError(code, `${label}: HTTP ${response.status}`);
  return await response.json();
}

async function prepareRuntime(configUrl) {
  if (runtimePackage && manifest) return manifest;
  if (preparing) return await preparing;
  preparing = (async () => {
    assertRuntimeFeatures();
    post("progress", { phase: "config", message: "Checking the external shell runtime..." });
    const resolvedConfigUrl = new URL(String(configUrl || "runtime-config.json"), self.location.href);
    config = await fetchJson(
      resolvedConfigUrl,
      "external_shell_config_unavailable",
      "Unable to load the external shell configuration",
    );
    if (!config.enabled) throw runtimeError("external_shell_disabled", "The external shell runtime is disabled.");
    const manifestUrl = new URL(String(config.manifest_url || ""), resolvedConfigUrl);
    post("progress", { phase: "manifest", message: "Checking the POSIX runtime manifest..." });
    const nextManifest = await fetchJson(
      manifestUrl,
      "external_shell_manifest_unavailable",
      "Unable to load the external shell manifest",
    );
    if (
      nextManifest.schema !== "edgeterm.external-runtime.v1" ||
      nextManifest.runtime !== config.expected_runtime ||
      nextManifest.license !== config.expected_license
    ) {
      throw runtimeError("external_shell_manifest_invalid", "The external shell manifest is not compatible with EdgeTerm.");
    }
    const artifactUrl = new URL(String(nextManifest.artifact?.file || ""), manifestUrl);
    artifactUrl.searchParams.set("sha256", String(nextManifest.artifact?.sha256 || ""));
    post("progress", { phase: "download", message: "Loading the POSIX runtime..." });
    const response = await fetch(artifactUrl, { cache: "force-cache" });
    if (!response.ok) {
      throw runtimeError("external_shell_artifact_unavailable", `Unable to load the external shell artifact: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (Number(nextManifest.artifact?.bytes || 0) !== bytes.byteLength) {
      throw runtimeError("external_shell_size_mismatch", "The external shell artifact size is invalid.");
    }
    if (await sha256(bytes) !== String(nextManifest.artifact?.sha256 || "")) {
      throw runtimeError("external_shell_checksum_mismatch", "The external shell artifact checksum is invalid.");
    }
    const sdkUrl = new URL("../node-runtime/wasmer-sdk/index.mjs", import.meta.url);
    const moduleUrl = new URL("../node-runtime/wasmer-sdk/wasmer_js_bg.wasm", import.meta.url);
    const workerUrl = new URL("../node-runtime/wasmer-sdk/worker.mjs", import.meta.url);
    sdkUrl.searchParams.set("v", WASMER_SDK_CACHE_VERSION);
    moduleUrl.searchParams.set("v", WASMER_SDK_CACHE_VERSION);
    workerUrl.searchParams.set("v", WASMER_SDK_CACHE_VERSION);
    if (!wasmerInitialized) {
      await initWasmer({
        module: moduleUrl,
        sdkUrl,
        workerUrl,
        log: "warn",
      });
      wasmerInitialized = true;
    }
    if (!wasixRuntime) wasixRuntime = new Runtime();
    if (!commandRuntime) commandRuntime = new Runtime();
    artifactBytes = bytes;
    runtimePackage = await Wasmer.fromFile(artifactBytes);
    runtimeBinaries = new Map();
    for (const name of RUNTIME_BINARY_NAMES) {
      const command = runtimePackage.commands?.[name];
      if (!command) {
        throw runtimeError(
          "external_shell_command_missing",
          `The POSIX runtime does not provide the ${name} command.`,
          false,
        );
      }
      runtimeBinaries.set(name, new Uint8Array(command.binary()));
    }
    for (const name of BUSYBOX_APPLET_NAMES) {
      runtimeBinaries.set(name, runtimeBinaries.get("busybox"));
    }
    runtimeBinaries.set("https", runtimeBinaries.get("http"));
    runtimeDataEntries = {};
    for (const [path, file] of Object.entries(nextManifest.filesystem || {})) {
      const normalized = normalizeRelativePath(path);
      if (!normalized.startsWith("usr/share/dpkg/")) {
        throw runtimeError("external_shell_manifest_invalid", `The runtime data path is not allowed: ${path}`);
      }
      const data = Uint8Array.from(atob(String(file?.data || "")), (character) => character.charCodeAt(0));
      if (data.byteLength > 64 * 1024 || await sha256(data) !== String(file?.sha256 || "")) {
        throw runtimeError("external_shell_manifest_invalid", `The runtime data file is invalid: ${path}`);
      }
      runtimeDataEntries[normalized.slice("usr/share/dpkg/".length)] = data;
    }
    post("progress", { phase: "smoke-test", message: "Checking the POSIX command runtime..." });
    if (!WebAssembly.validate(runtimeBinaries.get("busybox"))) {
      throw runtimeError("external_shell_smoke_failed", "The POSIX runtime startup check failed.");
    }
    await warmRuntimeWorker();
    manifest = nextManifest;
    post("progress", { phase: "ready", message: "The POSIX runtime is ready." });
    return manifest;
  })();
  try {
    return await preparing;
  } finally {
    preparing = null;
  }
}

async function runPackagedCommand(program, options = {}) {
  const packagedCommand = runtimePackage?.commands?.[program];
  if (packagedCommand) {
    return await packagedCommand.run({ runtime: wasixRuntime, ...options });
  }
  const binary = runtimeBinaries?.get(program);
  if (!binary) {
    throw runtimeError(
      "external_shell_command_missing",
      `The POSIX runtime does not provide the ${program} command.`,
      false,
    );
  }
  return await runWasix(binary, { program, runtime: wasixRuntime, ...options });
}

async function closeProcessStdin(instance, input = "") {
  if (!instance?.stdin) return;
  const writer = instance.stdin.getWriter();
  try {
    const bytes = input instanceof Uint8Array
      ? input
      : new TextEncoder().encode(String(input ?? ""));
    if (bytes.byteLength) await writer.write(bytes);
    await writer.close();
  } finally {
    try {
      writer.releaseLock();
    } catch {
    }
  }
}

async function waitForRuntimeProcess(instance) {
  try {
    return await instance.wait();
  } catch (error) {
    const message = String(error?.message || error || "");
    const match = message.match(/ExitCode::(\d+)/);
    if (match) return { code: Number(match[1]), stdout: "", stderr: "" };
    throw error;
  }
}

function stripRuntimeExitNoise(value) {
  return String(value || "").replace(
    /^Runtime execution failed: .*ExitCode::\d+.*\r?\n?/gm,
    "",
  );
}

async function warmRuntimeWorker() {
  post("progress", { phase: "warmup", message: "Preparing the command runtime..." });
  const instance = await runWasix(runtimeBinaries.get("busybox"), {
    program: "busybox",
    args: ["true"],
    cwd: "/",
    env: {},
    mount: { "/tmp": new Directory() },
    runtime: await getSharedCommandRuntime(),
  });
  await closeProcessStdin(instance);
  const result = await waitForRuntimeProcess(instance);
  if (Number(result.code || 0) !== 0) {
    throw runtimeError("external_shell_warmup_failed", "The command runtime startup check failed.");
  }
}

async function prepareMountedDirectoryPermissions(directory) {
  const mount = {};
  mountWorkspaceDirectory(mount, directory);
  const instance = await runWasix(runtimeBinaries.get("busybox"), {
    program: "busybox",
    args: ["chmod", "u+rwx,go+rx", WORKSPACE_RUNTIME_ROOT],
    cwd: "/",
    env: {},
    mount,
    runtime: await getSharedCommandRuntime(mount),
  });
  await closeProcessStdin(instance);
  const result = await waitForRuntimeProcess(instance);
  if (Number(result.code || 0) !== 0) {
    throw runtimeError(
      "external_shell_workspace_permissions_failed",
      "Unable to prepare workspace permissions.",
    );
  }
}

async function getSharedCommandRuntime(mounts = {}) {
  void mounts;
  if (!commandRuntime) commandRuntime = new Runtime();
  return commandRuntime;
}

function packageNameFromArchivePath(archivePath) {
  const basename = String(archivePath || "").split("/").pop() || "";
  const separator = basename.indexOf("_");
  if (separator <= 0) return "";
  const name = basename.slice(0, separator);
  return /^[a-z0-9][a-z0-9+.-]*$/.test(name) ? name : "";
}

async function hydratedInstalledPackages(systemDirectories) {
  const usr = systemDirectories?.get("/usr");
  const hydrated = new Set();
  if (!usr) return hydrated;
  const commands = await readInstalledCommandMetadata(systemDirectories);
  for (const [command, metadata] of commands) {
    const packageName = String(metadata?.package || "");
    if (!packageName || hydrated.has(packageName)) continue;
    const candidates = metadata?.bundle
      ? [String(metadata.bundle).slice("/usr".length)]
      : [`/local/bin/${command}`, `/local/sbin/${command}`];
    for (const path of candidates) {
      try {
        const bytes = new Uint8Array(await usr.readFile(path));
        if (bytes.byteLength > 0) {
          hydrated.add(packageName);
          break;
        }
      } catch {
      }
    }
  }
  return hydrated;
}

async function restoreInstalledPackagePayloads({
  archivePaths,
  mounts,
  env,
  workspaceRoot,
  systemDirectories,
  force = false,
}) {
  const hydrated = await hydratedInstalledPackages(systemDirectories);
  const unavailable = new Set();
  const systemChanges = [];
  const paths = [...new Set((Array.isArray(archivePaths) ? archivePaths : [])
    .map((path) => String(path || ""))
    .filter((path) => {
      if (!path) return false;
      const packageName = packageNameFromArchivePath(path);
      return force || !packageName || !hydrated.has(packageName);
    }))];
  for (let index = 0; index < paths.length; index += 1) {
    const archivePath = paths[index];
    const repositoryPrefix = `${String(workspaceRoot || "/home/user").replace(/\/+$/, "")}/apt-repository/`;
    if (!archivePath.startsWith(repositoryPrefix) || !archivePath.endsWith(".deb") || archivePath.includes("..")) {
      throw runtimeError(
        "external_shell_package_archive_path_invalid",
        `The installed package archive path is invalid: ${archivePath}`,
        false,
      );
    }
    post("progress", {
      phase: "packages",
      message: `Restoring installed packages (${index + 1}/${paths.length})`,
    });
    const workspaceDirectory = mounts[WORKSPACE_MOUNT_ROOT];
    const workspaceRelativeArchive = normalizeRelativePath(
      archivePath.slice(`${String(workspaceRoot || "/home/user").replace(/\/+$/, "")}/`.length),
    );
    let archiveBytes;
    try {
      archiveBytes = new Uint8Array(
        await workspaceDirectory.readFile(`/${workspaceRelativeArchive}`),
      );
    } catch (error) {
      const packageName = packageNameFromArchivePath(archivePath);
      if (packageName) unavailable.add(packageName);
      post("progress", {
        phase: "packages",
        message: `Skipping unavailable cached package ${packageName || archivePath.split("/").pop()}`,
      });
      continue;
    }
    const runtime = new Runtime();
    const extractionMounts = { ...mounts };
    const archiveMountPath = "/.edgeterm-package-archive";
    const archiveName = archivePath.split("/").pop();
    extractionMounts[archiveMountPath] = new Directory({ [archiveName]: archiveBytes });
    const extractedDirectories = new Map();
    for (const path of PACKAGE_SYSTEM_MOUNTS) {
      const directory = new Directory();
      extractionMounts[path] = directory;
      extractedDirectories.set(path, directory);
    }
    const instance = await runWasix(runtimeBinaries.get("dpkg-deb"), {
      program: "dpkg-deb",
      runtime,
      args: ["--fsys-tarfile", `${archiveMountPath}/${archiveName}`],
      cwd: "/",
      env,
      mount: extractionMounts,
      stdin: "",
    });
    const stdoutCapture = startProcessStreamCapture(instance.stdout);
    const stderrCapture = startProcessStreamCapture(instance.stderr);
    const result = await waitForRuntimeProcess(instance);
    await Promise.allSettled([stdoutCapture.done, stderrCapture.done]);
    if (Number(result.code || 0) !== 0) {
      throw runtimeError(
        "external_shell_package_restore_failed",
        `Unable to restore ${archivePath.split("/").pop()}: ${String(stderrCapture.output() || result.stderr || "dpkg-deb failed").trim()}`,
        true,
      );
    }
    const tarBytes = stdoutCapture.bytes();
    const extractedEntries = await extractPackageTar(tarBytes, extractedDirectories);
    if (!extractedEntries) {
      throw runtimeError(
        "external_shell_package_tar_empty",
        `The package payload tar contained no supported entries (${tarBytes.byteLength} bytes).`,
        true,
      );
    }
    for (const [path, source] of extractedDirectories) {
      const target = mounts[path];
      if (!target) continue;
      const before = emptySnapshot();
      const after = await snapshotDirectory(source);
      const changes = diffSnapshots(before, after);
      await applySnapshotChanges(target, changes, after, before);
      if (changes.length) systemChanges.push({ path, changes });
    }
  }
  return { unavailable, systemChanges };
}

async function extractPackageTar(bytes, directories) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const decoder = new TextDecoder();
  const text = (start, length) => decoder.decode(view.subarray(start, start + length)).replace(/\0.*$/, "");
  let offset = 0;
  let extractedEntries = 0;
  while (offset + 512 <= view.byteLength) {
    const header = view.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(offset, 100);
    const prefix = text(offset + 345, 155);
    const archivePath = [prefix, name].filter(Boolean).join("/").replace(/^\.\//, "");
    const sizeText = text(offset + 124, 12).trim().replace(/\0/g, "");
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > view.byteLength) {
      throw runtimeError("external_shell_package_tar_invalid", "The package payload contains an invalid tar entry.", false);
    }
    const type = String.fromCharCode(view[offset + 156] || 0);
    const normalized = normalizeRelativePath(archivePath);
    if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
      if (normalized) throw runtimeError("external_shell_package_tar_path_invalid", "The package payload contains an unsafe path.", false);
    } else {
      const mountName = normalized.split("/", 1)[0];
      const mountPath = `/${mountName}`;
      const directory = directories.get(mountPath);
      const relative = normalized.slice(mountName.length).replace(/^\/+/, "");
      if (directory && relative) {
        if (type === "5" || archivePath.endsWith("/")) {
          await ensureDirectory(directory, relative);
          extractedEntries += 1;
        } else if (type === "" || type === "\0" || type === "0") {
          const parent = relative.split("/").slice(0, -1).join("/");
          if (parent) await ensureDirectory(directory, parent);
          await directory.writeFile(`/${relative}`, view.slice(offset + 512, offset + 512 + size));
          extractedEntries += 1;
        }
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return extractedEntries;
}

async function readInstalledRuntimeBinary(posix, program) {
  const usr = posix?.systemDirectories?.get("/usr");
  const bundlePath = String(posix?.installedCommands?.get(program)?.bundle || "");
  if (bundlePath.startsWith("/usr/") && !bundlePath.includes("..")) {
    try {
      return new Uint8Array(await usr?.readFile(bundlePath.slice("/usr".length)));
    } catch {
    }
  }
  for (const path of [`/bin/${program}`, `/sbin/${program}`]) {
    try {
      const candidate = new Uint8Array(await usr?.readFile(`/local${path}`));
      if (
        candidate[0] === 0x00
        && candidate[1] === 0x61
        && candidate[2] === 0x73
        && candidate[3] === 0x6d
      ) {
        return candidate;
      }
    } catch {
    }
  }
  const opt = posix?.systemDirectories?.get("/opt");
  if (opt) {
    let entries = [];
    try {
      entries = directoryEntries(await opt.readDir("/"));
    } catch {
    }
    for (const entry of entries) {
      const packageName = typeof entry === "string"
        ? entry
        : String(entry?.name || entry?.path || "").split("/").pop();
      if (!packageName || packageName === "." || packageName === "..") continue;
      try {
        const candidate = new Uint8Array(await opt.readFile(`/${packageName}/bin/${program}`));
        if (
          candidate[0] === 0x00
          && candidate[1] === 0x61
          && candidate[2] === 0x73
          && candidate[3] === 0x6d
        ) {
          return candidate;
        }
      } catch {
      }
    }
  }
  return null;
}

async function getInstalledRuntimeCommand(program, binary) {
  const digest = await sha256(binary);
  const cacheKey = `${program}:${digest}`;
  let packaged = installedRuntimePackages.get(cacheKey);
  if (!packaged) {
    packaged = await Wasmer.fromFile(binary);
    installedRuntimePackages.set(cacheKey, packaged);
    while (installedRuntimePackages.size > 8) {
      const oldestKey = installedRuntimePackages.keys().next().value;
      const oldestPackage = installedRuntimePackages.get(oldestKey);
      installedRuntimePackages.delete(oldestKey);
      try {
        oldestPackage?.free();
      } catch {
      }
    }
  }
  const command = packaged.commands?.[program] || packaged.entrypoint;
  if (!command) {
    throw runtimeError(
      "external_shell_installed_command_invalid",
      `The installed ${program} package does not expose its command.`,
      false,
    );
  }
  return command;
}

async function readInstalledCommandMetadata(systemDirectories) {
  const usr = systemDirectories?.get("/usr");
  const commands = new Map();
  if (!usr) return commands;
  let entries = [];
  try {
    entries = directoryEntries(await usr.readDir("/local/share/edgeterm/commands"));
  } catch {
    return commands;
  }
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : String(entry?.name || entry?.path || "").split("/").pop();
    if (!name?.endsWith(".json")) continue;
    try {
      const bytes = await usr.readFile(`/local/share/edgeterm/commands/${name}`);
      const metadata = JSON.parse(new TextDecoder().decode(bytes));
      if (metadata?.schema !== "edgeterm.package-commands.v1") continue;
      const env = {};
      for (const [key, value] of Object.entries(metadata.env || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) continue;
        if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) continue;
        env[key] = value;
      }
      for (const command of Array.isArray(metadata.commands) ? metadata.commands : []) {
        if (!/^[A-Za-z0-9][A-Za-z0-9+._-]*$/.test(command)) continue;
        commands.set(command, {
          package: String(metadata.package || ""),
          version: String(metadata.version || ""),
          mode: String(metadata.mode || "streaming"),
          capability: String(metadata.capability || "full"),
          adapter: String(metadata.adapter || ""),
          threaded: metadata.threaded === true,
          bundle: typeof metadata.bundle === "string"
            && metadata.bundle.startsWith("/usr/")
            && !metadata.bundle.includes("..")
            ? metadata.bundle
            : "",
          env,
        });
      }
    } catch {
    }
  }
  return commands;
}

async function readInstalledPackageScripts(systemDirectories, installedCommands) {
  const usr = systemDirectories?.get("/usr");
  const scripts = {};
  if (!usr) return scripts;
  for (const command of installedCommands?.keys?.() || []) {
    for (const path of [`/local/bin/${command}`, `/local/sbin/${command}`]) {
      try {
        const bytes = new Uint8Array(await usr.readFile(path));
        if (bytes[0] === 0x23 && bytes[1] === 0x21) {
          scripts[command] = `/usr${path}`;
          break;
        }
      } catch {
      }
    }
  }
  return scripts;
}

function startProcessStreamCapture(stream, onData = () => {}) {
  if (!stream?.getReader) {
    return {
      done: Promise.resolve(),
      output: () => "",
      bytes: () => new Uint8Array(),
      cancel: async () => {},
    };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const chunks = [];
  let byteLength = 0;
  const done = (async () => {
    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
        chunks.push(bytes.slice());
        byteLength += bytes.byteLength;
        const data = decoder.decode(bytes, { stream: true });
        output += data;
        if (data) onData(data);
      }
      const tail = decoder.decode();
      output += tail;
      if (tail) onData(tail);
    } finally {
      try {
        reader.releaseLock();
      } catch {
      }
    }
  })();
  return {
    done,
    output: () => output,
    bytes: () => {
      const combined = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return combined;
    },
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
      }
    },
  };
}

function normalizeRelativePath(value) {
  const parts = [];
  for (const part of String(value || "").replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw runtimeError("external_shell_path_invalid", `Unsafe workspace path: ${value}`, false);
    parts.push(part);
  }
  return parts.join("/");
}

async function ensureDirectory(directory, path) {
  let current = "";
  for (const part of normalizeRelativePath(path).split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      await directory.createDir(current);
    } catch {
    }
  }
}

async function writeVirtualFile(directory, path, content) {
  const normalized = normalizeRelativePath(path);
  const parent = normalized.split("/").slice(0, -1).join("/");
  if (parent) await ensureDirectory(directory, parent);
  await directory.writeFile(`/${normalized}`, new TextEncoder().encode(String(content ?? "")));
}

async function writePosixProfile(directory, profile) {
  for (const path of profile.directories) {
    await ensureDirectory(directory, path);
  }
  for (const [path, content] of Object.entries(profile.files)) {
    await writeVirtualFile(directory, path, content);
  }
}

async function ensureVirtualFile(directory, path, content, { overwrite = false } = {}) {
  if (!overwrite) {
    try {
      await directory.readFile(`/${normalizeRelativePath(path)}`);
      return;
    } catch {
    }
  }
  await writeVirtualFile(directory, path, content);
}

async function initializePackageSystemDirectories(systemDirectories) {
  const etc = systemDirectories.get("/etc");
  const usr = systemDirectories.get("/usr");
  const varDirectory = systemDirectories.get("/var");
  const opt = systemDirectories.get("/opt");
  if (!etc || !usr || !varDirectory || !opt) {
    throw runtimeError("external_shell_mount_missing", "The package storage mounts are incomplete.");
  }
  for (const path of [
    "apt/apt.conf.d",
    "apt/preferences.d",
    "apt/sources.list.d",
    "dpkg/dpkg.cfg.d",
  ]) {
    await ensureDirectory(etc, path);
  }
  for (const path of [
    "local/bin",
    "local/sbin",
    "local/share/edgeterm/commands",
    "share/dpkg",
  ]) {
    await ensureDirectory(usr, path);
  }
  await ensureVirtualFile(etc, "apt/apt.conf.d/99edgeterm", [
    'Dpkg::Use-Pty "false";',
    'Dpkg::Progress-Fancy "false";',
    'APT::Architecture "wasm32-wasix";',
    'APT::Architectures { "wasm32-wasix"; "all"; };',
    'APT::Sandbox::User "root";',
    'Acquire::Languages "none";',
    'APT::Update::Error-Mode "all";',
    'Dir::Cache::pkgcache "";',
    'Dir::Cache::srcpkgcache "";',
    'Dir::Bin::Methods "/bin";',
    'Dir::Bin::dpkg "/bin/dpkg";',
    "",
  ].join("\n"), { overwrite: true });
  for (const path of [
    "cache/apt/archives/partial",
    "lib/apt/lists/partial",
    "lib/dpkg/info",
    "lib/dpkg/parts",
    "lib/dpkg/triggers",
    "lib/dpkg/updates",
    "log/apt",
  ]) {
    await ensureDirectory(varDirectory, path);
  }
  await ensureVirtualFile(varDirectory, "lib/dpkg/info/format", "1\n");
  for (const path of [
    "dpkg/status",
    "dpkg/available",
    "dpkg/diversions",
    "dpkg/diversions-old",
    "dpkg/statoverride",
    "dpkg/statoverride-old",
    "dpkg/triggers/File",
    "dpkg/triggers/Unincorp",
  ]) {
    await ensureVirtualFile(varDirectory, `lib/${path}`, "");
  }
  for (const [path, bytes] of Object.entries(runtimeDataEntries || {})) {
    const target = normalizeRelativePath(`share/dpkg/${path}`);
    const parent = target.split("/").slice(0, -1).join("/");
    if (parent) await ensureDirectory(usr, parent);
    try {
      await usr.readFile(`/${target}`);
    } catch {
      await usr.writeFile(`/${target}`, bytes);
    }
  }
}

async function createDirectoryFromEntries(fileEntries, directoryPaths = []) {
  const entries = [...fileEntries];
  const initialFiles = Object.fromEntries(
    entries.map(([path, bytes]) => [normalizeRelativePath(path), bytes]),
  );
  const directory = new Directory(initialFiles);
  const paths = new Set(directoryPaths);
  for (const [path] of entries) {
    const parts = normalizeRelativePath(path).split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      paths.add(current);
    }
  }
  for (const path of [...paths]
    .filter(Boolean)
    .sort((left, right) => left.split("/").length - right.split("/").length)) {
    await ensureDirectory(directory, path);
  }
  return directory;
}

async function createWorkspaceDirectoryFromEntries(fileEntries, directoryPaths = []) {
  return await createDirectoryFromEntries(fileEntries, directoryPaths);
}

function mountWorkspaceDirectory(mount, directory, workspaceRoot = "") {
  void workspaceRoot;
  delete mount[WORKSPACE_MOUNT_ROOT];
  delete mount[WORKSPACE_RUNTIME_ROOT];
  mount[WORKSPACE_MOUNT_ROOT] = directory;
}

function mountsForForegroundCommand(posix, program, { changesSystemPackages = false } = {}) {
  void program;
  void changesSystemPackages;
  const mounts = { ...posix.mounts };
  for (const path of PACKAGE_SYSTEM_MOUNTS) {
    if (!mounts[path]) mounts[path] = new Directory();
  }
  return mounts;
}

function splitDirectoryEntries(files) {
  const fileEntries = [];
  const directoryPaths = [];
  for (const file of Array.isArray(files) ? files : []) {
    const path = normalizeRelativePath(file.path);
    if (!path) continue;
    if (file.dir) {
      directoryPaths.push(path);
      continue;
    }
    const bytes = file.encoding === "base64"
      ? Uint8Array.from(atob(String(file.data || "")), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(String(file.data ?? file.text ?? ""));
    fileEntries.push([path, bytes]);
  }
  return { fileEntries, directoryPaths };
}

async function createPosixRuntime({
  workspaceRoot,
  command = "ash",
  files = [],
  systemMounts = [],
  packageArchivePaths = [],
  systemMountCacheKey = "",
}) {
  const user = workspaceRoot.split("/").filter(Boolean).pop() || "user";
  const systemDirectory = new Directory();
  let storageEstimate = {};
  try {
    storageEstimate = await navigator.storage?.estimate?.() || {};
  } catch {
  }
  const profile = createPosixProfile({
    workspaceRoot,
    username: user,
    command,
    uptimeSeconds: performance.now() / 1000,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    storageQuotaBytes: storageEstimate.quota,
    storageUsageBytes: storageEstimate.usage,
    bootId: crypto.randomUUID(),
  });
  await writePosixProfile(systemDirectory, profile);
  const workspaceEntries = splitDirectoryEntries(files);
  const workspaceDirectory = await createWorkspaceDirectoryFromEntries(
    workspaceEntries.fileEntries,
    workspaceEntries.directoryPaths,
  );
  const temporaryPrefix = `${WORKSPACE_TEMP_ROOT}/`;
  const temporaryDirectory = await createDirectoryFromEntries(
    workspaceEntries.fileEntries
      .filter(([path]) => path.startsWith(temporaryPrefix))
      .map(([path, bytes]) => [path.slice(temporaryPrefix.length), bytes]),
    workspaceEntries.directoryPaths
      .filter((path) => path.startsWith(temporaryPrefix))
      .map((path) => path.slice(temporaryPrefix.length)),
  );
  const mounts = {
    [POSIX_SEED_ROOT]: systemDirectory,
    "/.edgeterm-dpkg-data": new Directory(runtimeDataEntries),
    "/tmp": temporaryDirectory,
  };
  for (const path of POSIX_VIRTUAL_ROOT_MOUNTS) mounts[path] = new Directory();
  await mounts["/dev"].writeFile("/null", new Uint8Array());
  mountWorkspaceDirectory(mounts, workspaceDirectory, workspaceRoot);
  const commandDirectory = new Directory();
  for (const [name, bytes] of runtimeBinaries || []) {
    await commandDirectory.writeFile(`/${name}`, bytes);
  }
  mounts["/bin"] = commandDirectory;
  const cacheKey = String(systemMountCacheKey || "");
  const reuseSystemDirectories = cacheKey
    && commandSystemCache?.key === cacheKey;
  const systemDirectories = reuseSystemDirectories
    ? commandSystemCache.directories
    : new Map();
  let packageScripts = {};
  if (reuseSystemDirectories) {
    for (const [path, directory] of systemDirectories) mounts[path] = directory;
  } else {
    for (const mount of Array.isArray(systemMounts) ? systemMounts : []) {
      const path = String(mount?.path || "").replace(/\/+$/, "");
      if (!PACKAGE_SYSTEM_MOUNTS.has(path)) {
        throw runtimeError("external_shell_mount_forbidden", `The system mount is not allowed: ${path}`);
      }
      const entries = splitDirectoryEntries(mount.files);
      if (path === "/usr") {
        for (const [relativePath, bytes] of entries.fileEntries) {
          const match = relativePath.match(/^local\/(?:s?bin)\/([A-Za-z_][A-Za-z0-9_+-]*)$/);
          if (match && bytes[0] === 0x23 && bytes[1] === 0x21) {
            packageScripts[match[1]] = `/${path.replace(/^\/+/, "")}/${relativePath}`;
          }
        }
      }
      const directory = await createDirectoryFromEntries(entries.fileEntries, entries.directoryPaths);
      mounts[path] = directory;
      systemDirectories.set(path, directory);
    }
    if (cacheKey) commandSystemCache = { key: cacheKey, directories: systemDirectories };
  }
  await initializePackageSystemDirectories(systemDirectories);
  const { configureStagedAptRepository } = await import("./apt-repository.js");
  await configureStagedAptRepository(systemDirectories.get("/etc"), workspaceDirectory, WORKSPACE_RUNTIME_ROOT);
  const { unavailable: unavailablePackages } = await restoreInstalledPackagePayloads({
    archivePaths: packageArchivePaths,
    mounts,
    env: profile.env,
    workspaceRoot,
    systemDirectories,
  });
  const installedCommands = await readInstalledCommandMetadata(systemDirectories);
  for (const [commandName, metadata] of installedCommands) {
    if (unavailablePackages.has(String(metadata?.package || ""))) {
      installedCommands.delete(commandName);
    }
  }
  const packageEnvironment = {};
  for (const metadata of installedCommands.values()) {
    Object.assign(packageEnvironment, metadata.env || {});
  }
  packageScripts = {
    ...packageScripts,
    ...await readInstalledPackageScripts(systemDirectories, installedCommands),
  };
  return {
    directory: workspaceDirectory,
    temporaryDirectory,
    env: {
      ...profile.env,
      ...packageEnvironment,
      HOME: WORKSPACE_RUNTIME_ROOT,
      PWD: WORKSPACE_RUNTIME_ROOT,
    },
    mounts,
    systemDirectories,
    packageScripts,
    installedCommands,
    profile: profile.profile,
    startedAt: performance.now(),
  };
}

function rewritePackageScriptCommand(source, packageScripts = {}) {
  const value = String(source || "");
  const match = value.match(/^(\s*)([A-Za-z_][A-Za-z0-9_+-]*)(?=\s|$)/);
  if (!match) return value;
  const scriptPath = packageScripts[match[2]];
  if (!scriptPath) return value;
  return `${match[1]}. ${shellQuote(scriptPath)}${value.slice(match[0].length)}`;
}

function posixBootstrapScript() {
  return [
    "mkdir -p /bin /boot /dev /lib /lib64 /media /mnt /proc /root /run /run/lock /sbin /srv /sys /tmp /usr/bin /usr/include /usr/lib /usr/libexec /usr/local/bin /usr/local/lib /usr/local/sbin /usr/sbin /usr/share/dpkg /var/cache /var/empty /var/lib /var/local /var/lock /var/log /var/mail /var/opt /var/run /var/spool /var/tmp",
    "cp -R /.edgeterm-dpkg-data/. /usr/share/dpkg/",
    "mkdir -p /etc/apt/apt.conf.d /etc/apt/preferences.d /etc/apt/sources.list.d /etc/dpkg/dpkg.cfg.d /var/cache/apt/archives/partial /var/lib/apt/lists/partial /var/lib/dpkg/info /var/lib/dpkg/parts /var/lib/dpkg/triggers /var/lib/dpkg/updates /var/log/apt",
    "test -f /var/lib/dpkg/info/format || printf '1\\n' > /var/lib/dpkg/info/format",
    "test -f /var/lib/dpkg/status || : > /var/lib/dpkg/status",
    "test -f /var/lib/dpkg/available || : > /var/lib/dpkg/available",
    "test -f /var/lib/dpkg/diversions || : > /var/lib/dpkg/diversions",
    "test -f /var/lib/dpkg/diversions-old || : > /var/lib/dpkg/diversions-old",
    "test -f /var/lib/dpkg/statoverride || : > /var/lib/dpkg/statoverride",
    "test -f /var/lib/dpkg/statoverride-old || : > /var/lib/dpkg/statoverride-old",
    "test -f /var/lib/dpkg/triggers/File || : > /var/lib/dpkg/triggers/File",
    "test -f /var/lib/dpkg/triggers/Unincorp || : > /var/lib/dpkg/triggers/Unincorp",
    "printf '%s\\n' 'Dpkg::Use-Pty \"false\";' 'Dpkg::Progress-Fancy \"false\";' 'APT::Architecture \"wasm32-wasix\";' 'APT::Architectures { \"wasm32-wasix\"; \"all\"; };' 'APT::Sandbox::User \"root\";' 'Acquire::Languages \"none\";' 'Dir::Cache::pkgcache \"\";' 'Dir::Cache::srcpkgcache \"\";' 'Dir::Bin::Methods \"/bin\";' 'Dir::Bin::dpkg \"/bin/dpkg\";' > /etc/apt/apt.conf.d/99edgeterm",
    `cp -R ${POSIX_SEED_ROOT}/etc/. /etc/ 2>/dev/null || true`,
    `cp -R ${POSIX_SEED_ROOT}/proc/. /proc/ 2>/dev/null || true`,
    `cp -R ${POSIX_SEED_ROOT}/sys/. /sys/ 2>/dev/null || true`,
    `cp -R ${POSIX_SEED_ROOT}/run/. /run/ 2>/dev/null || true`,
    `cp -R ${POSIX_SEED_ROOT}/var/. /var/ 2>/dev/null || true`,
    "chmod 1777 /tmp /var/tmp 2>/dev/null || true",
    "chmod 755 /etc /proc /sys /run /var /root /home 2>/dev/null || true",
    `test -e "/home/$USER" || ln -s ${WORKSPACE_RUNTIME_ROOT} "/home/$USER"`,
    "chmod 755 /bin/* /usr/local/bin/* /usr/local/sbin/* /opt/*/bin/* 2>/dev/null || true",
    "for command in /usr/local/bin/*; do test -f \"$command\" || continue; name=${command##*/}; test -e \"/usr/bin/$name\" || ln -s \"$command\" \"/usr/bin/$name\"; done",
    "for command in /usr/local/sbin/*; do test -f \"$command\" || continue; name=${command##*/}; test -e \"/usr/sbin/$name\" || ln -s \"$command\" \"/usr/sbin/$name\"; done",
    `chmod u+rwx,go+rx ${WORKSPACE_RUNTIME_ROOT} 2>/dev/null || true`,
    "exec 2>&1",
  ].join("\n");
}

function directoryEntries(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.entries)) return value.entries;
  return [];
}

async function snapshotDirectory(
  directory,
  path = "/",
  output = { files: new Map(), directories: new Set() },
) {
  const base = normalizeRelativePath(path);
  const listing = directoryEntries(await directory.readDir(base ? `/${base}` : "/"));
  await Promise.all(listing.map(async (item) => {
    const name = typeof item === "string" ? item : String(item?.name || item?.path || "").split("/").pop();
    if (!name || name === "." || name === "..") return;
    const target = base ? `${base}/${name}` : name;
    let bytes = null;
    try {
      bytes = new Uint8Array(await directory.readFile(`/${target}`));
    } catch {
    }
    if (bytes) {
      output.files.set(normalizeRelativePath(target), bytes);
      return;
    }
    output.directories.add(normalizeRelativePath(target));
    await snapshotDirectory(directory, target, output);
  }));
  return output;
}

async function snapshotRuntimeWorkspace(directory, temporaryDirectory) {
  const snapshot = await snapshotDirectory(directory);
  for (const path of [...snapshot.files.keys()]) {
    if (path === WORKSPACE_TEMP_ROOT || path.startsWith(`${WORKSPACE_TEMP_ROOT}/`)) {
      snapshot.files.delete(path);
    }
  }
  for (const path of [...snapshot.directories]) {
    if (path === WORKSPACE_TEMP_ROOT || path.startsWith(`${WORKSPACE_TEMP_ROOT}/`)) {
      snapshot.directories.delete(path);
    }
  }
  snapshot.directories.add(".edgeterm-posix");
  snapshot.directories.add(WORKSPACE_TEMP_ROOT);
  const temporarySnapshot = await snapshotDirectory(temporaryDirectory);
  for (const [path, bytes] of temporarySnapshot.files) {
    snapshot.files.set(`${WORKSPACE_TEMP_ROOT}/${path}`, bytes);
  }
  for (const path of temporarySnapshot.directories) {
    snapshot.directories.add(`${WORKSPACE_TEMP_ROOT}/${path}`);
  }
  return snapshot;
}

async function snapshotSystemDirectories(directories) {
  const snapshots = new Map();
  for (const [path, directory] of directories || []) {
    snapshots.set(path, await snapshotDirectory(directory));
  }
  return snapshots;
}

async function diffSystemDirectories(before, directories) {
  const changes = [];
  const after = await snapshotSystemDirectories(directories);
  for (const [path, snapshot] of after) {
    const entries = diffSnapshots(before?.get(path) || emptySnapshot(), snapshot);
    if (entries.length) changes.push({ path, changes: entries });
  }
  return { changes, snapshots: after };
}

async function createWorkspaceFromSnapshot(snapshot) {
  return await createWorkspaceDirectoryFromEntries(snapshot.files, snapshot.directories);
}

function snapshotUnderDirectory(snapshot, directory) {
  const prefix = normalizeRelativePath(directory);
  const output = emptySnapshot();
  if (prefix) output.directories.add(prefix);
  for (const path of snapshot.directories || []) {
    output.directories.add(prefix ? `${prefix}/${path}` : path);
  }
  for (const [path, bytes] of snapshot.files || []) {
    output.files.set(prefix ? `${prefix}/${path}` : path, bytes);
  }
  return output;
}

function snapshotFromDirectory(snapshot, directory) {
  const prefix = `${normalizeRelativePath(directory)}/`;
  const output = emptySnapshot();
  for (const path of snapshot.directories || []) {
    if (!path.startsWith(prefix)) continue;
    const relative = normalizeRelativePath(path.slice(prefix.length));
    if (relative) output.directories.add(relative);
  }
  for (const [path, bytes] of snapshot.files || []) {
    if (!path.startsWith(prefix)) continue;
    output.files.set(normalizeRelativePath(path.slice(prefix.length)), bytes);
  }
  return output;
}

async function synchronizeDirectory(target, source) {
  const before = await snapshotDirectory(target);
  const after = await snapshotDirectory(source);
  const changes = diffSnapshots(before, after);
  await applySnapshotChanges(target, changes, after, before);
}

async function applySnapshotChanges(target, changes, after, before) {
  for (const change of changes.filter((entry) => entry.deleted && !entry.dir)) {
    try {
      await target.removeFile(`/${normalizeRelativePath(change.path)}`);
    } catch {
    }
  }
  for (const change of changes
    .filter((entry) => entry.deleted && entry.dir)
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
    try {
      await target.removeDir(`/${normalizeRelativePath(change.path)}`);
    } catch {
    }
  }
  for (const directory of [...after.directories]
    .sort((left, right) => left.split("/").length - right.split("/").length)) {
    await ensureDirectory(target, directory);
  }
  for (const [path, bytes] of after.files) {
    if (!changes.some((entry) => !entry.deleted && !entry.dir && entry.path === path)) continue;
    const previous = before.files.get(path);
    if (previous && previous.byteLength > bytes.byteLength) {
      try {
        await target.removeFile(`/${path}`);
      } catch {
      }
    }
    await target.writeFile(`/${path}`, bytes);
  }
}

function equalBytes(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function base64(bytes) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(value);
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [path, bytes] of after.files) {
    if (!equalBytes(before.files.get(path), bytes)) {
      changes.push({ path, encoding: "base64", data: base64(bytes) });
    }
  }
  for (const path of after.directories) {
    if (!before.directories.has(path)) changes.push({ path, dir: true });
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) changes.push({ path, deleted: true });
  }
  const removedDirectories = [...before.directories]
    .filter((path) => !after.directories.has(path))
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const path of removedDirectories) {
    changes.push({ path, deleted: true, dir: true });
  }
  return changes;
}

function applyChangesToSnapshot(snapshot, changes) {
  for (const entry of changes || []) {
    const path = normalizeRelativePath(entry.path);
    if (!path) continue;
    if (entry.deleted) {
      snapshot.files.delete(path);
      snapshot.directories.delete(path);
      for (const candidate of [...snapshot.files.keys()]) {
        if (candidate.startsWith(`${path}/`)) snapshot.files.delete(candidate);
      }
      for (const candidate of [...snapshot.directories]) {
        if (candidate.startsWith(`${path}/`)) snapshot.directories.delete(candidate);
      }
      continue;
    }
    if (entry.dir) {
      snapshot.directories.add(path);
      continue;
    }
    snapshot.files.set(
      path,
      Uint8Array.from(atob(String(entry.data || "")), (character) => character.charCodeAt(0)),
    );
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      snapshot.directories.add(current);
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function parseSimpleShellWords(source) {
  const words = [];
  let current = "";
  let quote = "";
  let active = false;
  const value = String(source || "");
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (!next) return null;
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) {
        current += "\\";
      } else if (next !== "\n") {
        current += next;
        index += 1;
      } else {
        index += 1;
      }
      active = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      active = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (active) words.push(current);
      current = "";
      active = false;
      continue;
    }
    if (["$", "`", ";", "&", "<", ">", "(", ")", "{", "}"].includes(character)) return null;
    current += character;
    active = true;
  }
  if (quote) return null;
  if (active) words.push(current);
  return words;
}

function parseSimpleRedirection(source) {
  const tokens = [];
  let current = "";
  let active = false;
  let quote = "";
  const pushWord = () => {
    if (!active) return;
    tokens.push({ type: "word", value: current });
    current = "";
    active = false;
  };
  const value = String(source || "");
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (!next) return null;
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) {
        current += "\\";
      } else if (next !== "\n") {
        current += next;
        index += 1;
      } else {
        index += 1;
      }
      active = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      active = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/.test(character)) {
      pushWord();
      continue;
    }
    if (character === "<" || character === ">") {
      const descriptor = active && /^[12]$/.test(current) ? Number(current) : null;
      if (descriptor === null) pushWord();
      else {
        current = "";
        active = false;
      }
      const append = character === ">" && value[index + 1] === ">";
      tokens.push({ type: "redirect", value: append ? ">>" : character, descriptor });
      if (append) index += 1;
      continue;
    }
    if (["$", "`", "|", ";", "&", "(", ")", "{", "}"].includes(character)) return null;
    current += character;
    active = true;
  }
  if (quote) return null;
  pushWord();
  if (!tokens.some((token) => token.type === "redirect")) return null;

  const words = [];
  let input = null;
  let output = null;
  let append = false;
  let errorOutput = null;
  let errorAppend = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "word") {
      words.push(token.value);
      continue;
    }
    const target = tokens[index + 1];
    if (!target || target.type !== "word") return null;
    if (token.descriptor === 2) {
      if (token.value === "<" || errorOutput !== null) return null;
      errorOutput = target.value;
      errorAppend = token.value === ">>";
    } else if (token.value === "<") {
      if (input !== null) return null;
      input = target.value;
    } else {
      if (output !== null) return null;
      output = target.value;
      append = token.value === ">>";
    }
    index += 1;
  }
  if (!words.length) return null;
  return { words, input, output, append, errorOutput, errorAppend };
}

function workspaceRelativePath(value, cwd, workspaceRoot) {
  const absolute = String(value || "").startsWith("/")
    ? String(value || "")
    : `${String(cwd || workspaceRoot).replace(/\/+$/, "")}/${String(value || "")}`;
  const parts = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  const root = `/${String(workspaceRoot || "/home/user").split("/").filter(Boolean).join("/")}`;
  if (normalized === root) return "";
  if (!normalized.startsWith(`${root}/`)) return null;
  return normalizeRelativePath(normalized.slice(root.length + 1));
}

function temporaryRelativePath(value, cwd) {
  const absolute = String(value || "").startsWith("/")
    ? String(value || "")
    : `${String(cwd || "/").replace(/\/+$/, "")}/${String(value || "")}`;
  const parts = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const normalized = `/${parts.join("/")}`;
  if (!normalized.startsWith("/tmp/")) return null;
  return normalizeRelativePath(normalized.slice(5));
}

function normalizeRuntimeAbsolutePath(value) {
  const parts = [];
  for (const part of String(value || "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function writableRuntimeTarget(value, cwd, workspaceRoot, posix, workspaceDirectory) {
  const workspacePath = workspaceRelativePath(value, cwd, workspaceRoot);
  if (workspacePath) return { directory: workspaceDirectory, path: workspacePath };
  const temporaryPath = temporaryRelativePath(value, cwd);
  const temporaryDirectory = posix?.mounts?.["/tmp"];
  if (temporaryPath && temporaryDirectory) {
    return { directory: temporaryDirectory, path: temporaryPath };
  }
  return null;
}

function readableRuntimeTarget(value, cwd, workspaceRoot, posix, workspaceDirectory) {
  const workspacePath = workspaceRelativePath(value, cwd, workspaceRoot);
  if (workspacePath) return { directory: workspaceDirectory, path: workspacePath };
  const absolute = String(value || "").startsWith("/")
    ? String(value)
    : `${String(cwd || "/").replace(/\/+$/, "")}/${String(value || "")}`;
  const mountPath = Object.keys(posix?.mounts || {})
    .filter((path) => absolute === path || absolute.startsWith(`${path}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (!mountPath) return null;
  return {
    directory: posix.mounts[mountPath],
    path: normalizeRelativePath(absolute.slice(mountPath.length)),
  };
}

async function resolveAvailableCommandCwd(value, workspaceRoot, posix, workspaceDirectory) {
  const candidate = normalizeRuntimeAbsolutePath(value || workspaceRoot);
  const normalizedRoot = normalizeRuntimeAbsolutePath(workspaceRoot || "/home/user");
  if (candidate === normalizedRoot) return candidate;
  const target = readableRuntimeTarget(
    candidate,
    normalizedRoot,
    normalizedRoot,
    posix,
    workspaceDirectory,
  );
  if (!target) return candidate;
  try {
    await target.directory.readDir(target.path ? `/${target.path}` : "/");
    return candidate;
  } catch {
    return normalizedRoot;
  }
}

async function writeRuntimeTargetBytes(target, bytes, append) {
  const parent = target.path.split("/").slice(0, -1).join("/");
  if (parent) await ensureDirectory(target.directory, parent);
  if (!append) {
    try {
      await target.directory.removeFile(`/${target.path}`);
    } catch {}
    await target.directory.writeFile(`/${target.path}`, bytes);
    return;
  }
  try {
    const existing = new Uint8Array(await target.directory.readFile(`/${target.path}`));
    const combined = new Uint8Array(existing.byteLength + bytes.byteLength);
    combined.set(existing);
    combined.set(bytes, existing.byteLength);
    await target.directory.writeFile(`/${target.path}`, combined);
  } catch {
    await target.directory.writeFile(`/${target.path}`, bytes);
  }
}

async function runWcAdapter({ words, cwd, workspaceRoot, directory, posix, stdin, streamOutput }) {
  const selected = new Set();
  const files = [];
  let optionsEnded = false;
  for (const word of words.slice(1)) {
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const names = word.startsWith("--") ? [word] : [...word.slice(1)].map((name) => `-${name}`);
      for (const name of names) {
        if (name === "-l" || name === "--lines") selected.add("lines");
        else if (name === "-w" || name === "--words") selected.add("words");
        else if (name === "-c" || name === "--bytes") selected.add("bytes");
        else if (name === "-m" || name === "--chars") selected.add("chars");
        else if (name === "-L" || name === "--max-line-length") selected.add("maxLine");
        else return null;
      }
      continue;
    }
    files.push(word);
  }
  if (!selected.size) {
    selected.add("lines");
    selected.add("words");
    selected.add("bytes");
  }

  const rows = [];
  const totals = [];
  let stderr = "";
  let exitCode = 0;
  const inputs = files.length ? files : ["-"];
  for (const file of inputs) {
    let bytes;
    try {
      if (file === "-") {
        if (stdin === null) return null;
        bytes = stdin instanceof Uint8Array ? stdin : new TextEncoder().encode(String(stdin));
      } else {
        const target = readableRuntimeTarget(file, cwd, workspaceRoot, posix, directory);
        if (!target) throw new Error("outside mounted filesystem");
        bytes = new Uint8Array(await target.directory.readFile(`/${target.path}`));
      }
    } catch {
      stderr += `wc: ${file}: No such file or directory\n`;
      exitCode = 1;
      continue;
    }
    const text = new TextDecoder().decode(bytes);
    const values = {
      lines: (text.match(/\n/g) || []).length,
      words: (text.match(/\S+/g) || []).length,
      bytes: bytes.byteLength,
      chars: [...text].length,
      maxLine: Math.max(0, ...text.split("\n").map((line) => [...line].length)),
    };
    const order = ["lines", "words", "bytes", "chars", "maxLine"];
    const counts = order.filter((name) => selected.has(name)).map((name) => values[name]);
    rows.push(`${counts.join(" ")}${file === "-" ? "" : ` ${file}`}\n`);
    counts.forEach((count, index) => {
      totals[index] = Number(totals[index] || 0) + Number(count || 0);
    });
  }
  if (inputs.length > 1 && rows.length > 1) rows.push(`${totals.join(" ")} total\n`);
  const stdout = rows.join("");
  if (streamOutput && stdout) {
    post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
  }
  if (streamOutput && stderr) {
    post("interactive-output", { sessionId: "", stream: "stderr", data: stderr });
  }
  return { exitCode, cwd, stdout, stderr, streamedOutput: streamOutput };
}

async function runCatAdapter({ words, cwd, workspaceRoot, directory, posix, stdin, streamOutput }) {
  let numberAll = false;
  let numberNonBlank = false;
  let squeezeBlank = false;
  let showEnds = false;
  let showTabs = false;
  let optionsEnded = false;
  const files = [];
  for (const word of words.slice(1)) {
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const flags = word.startsWith("--") ? [word] : [...word.slice(1)].map((flag) => `-${flag}`);
      for (const flag of flags) {
        if (["-n", "--number"].includes(flag)) numberAll = true;
        else if (["-b", "--number-nonblank"].includes(flag)) numberNonBlank = true;
        else if (["-s", "--squeeze-blank"].includes(flag)) squeezeBlank = true;
        else if (["-E", "--show-ends"].includes(flag)) showEnds = true;
        else if (["-T", "--show-tabs"].includes(flag)) showTabs = true;
        else return null;
      }
      continue;
    }
    files.push(word);
  }

  const inputs = files.length ? files : ["-"];
  const chunks = [];
  let stderr = "";
  let exitCode = 0;
  for (const file of inputs) {
    try {
      if (file === "-") {
        if (stdin === null) return null;
        chunks.push(stdin instanceof Uint8Array ? stdin : new TextEncoder().encode(String(stdin)));
      } else {
        const target = readableRuntimeTarget(file, cwd, workspaceRoot, posix, directory);
        if (!target) throw new Error("outside mounted filesystem");
        chunks.push(new Uint8Array(await target.directory.readFile(`/${target.path}`)));
      }
    } catch {
      stderr += `cat: ${file}: No such file or directory\n`;
      exitCode = 1;
    }
  }
  const totalLength = chunks.reduce((total, bytes) => total + bytes.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let stdout = new TextDecoder().decode(bytes);
  if (numberAll || numberNonBlank || squeezeBlank || showEnds || showTabs) {
    const lines = stdout.split("\n");
    let lineNumber = 0;
    let previousBlank = false;
    const rendered = [];
    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      const isLastEmpty = index === lines.length - 1 && line === "" && stdout.endsWith("\n");
      if (isLastEmpty) continue;
      const blank = line.length === 0;
      if (squeezeBlank && blank && previousBlank) continue;
      previousBlank = blank;
      if (showTabs) line = line.replace(/\t/g, "^I");
      if (showEnds) line += "$";
      const numbered = numberAll || (numberNonBlank && !blank);
      if (numbered) {
        lineNumber += 1;
        line = `${String(lineNumber).padStart(6)}\t${line}`;
      }
      rendered.push(line);
    }
    stdout = `${rendered.join("\n")}${stdout.endsWith("\n") ? "\n" : ""}`;
  }
  if (streamOutput && stdout) post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
  if (streamOutput && stderr) post("interactive-output", { sessionId: "", stream: "stderr", data: stderr });
  return { exitCode, cwd, stdout, stdoutBytes: bytes, stderr, streamedOutput: streamOutput };
}

async function runHeadTailAdapter({ words, cwd, workspaceRoot, directory, posix, stdin, streamOutput }) {
  const program = String(words[0] || "").replace(/^.*\//, "");
  if (!['head', 'tail'].includes(program)) return null;
  let mode = "lines";
  let count = 10;
  const files = [];
  let optionsEnded = false;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && /^-\d+$/.test(word)) {
      count = Number(word.slice(1));
      continue;
    }
    if (!optionsEnded && ["-n", "--lines", "-c", "--bytes"].includes(word)) {
      const next = words[index + 1];
      if (!/^\d+$/.test(String(next || ""))) return null;
      mode = word === "-c" || word === "--bytes" ? "bytes" : "lines";
      count = Number(next);
      index += 1;
      continue;
    }
    if (!optionsEnded && (word.startsWith("--lines=") || word.startsWith("--bytes="))) {
      const value = word.slice(word.indexOf("=") + 1);
      if (!/^\d+$/.test(value)) return null;
      mode = word.startsWith("--bytes=") ? "bytes" : "lines";
      count = Number(value);
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") return null;
    files.push(word);
  }

  const inputs = files.length ? files : ["-"];
  if (inputs.length > 1) return null;
  let bytes;
  try {
    if (inputs[0] === "-") {
      if (stdin === null) return null;
      bytes = stdin instanceof Uint8Array ? stdin : new TextEncoder().encode(String(stdin));
    } else {
      const target = readableRuntimeTarget(inputs[0], cwd, workspaceRoot, posix, directory);
      if (!target) throw new Error("outside mounted filesystem");
      bytes = new Uint8Array(await target.directory.readFile(`/${target.path}`));
    }
  } catch {
    const stderr = `${program}: ${inputs[0]}: No such file or directory\n`;
    if (streamOutput) post("interactive-output", { sessionId: "", stream: "stderr", data: stderr });
    return { exitCode: 1, cwd, stdout: "", stderr, streamedOutput: streamOutput };
  }

  let outputBytes;
  if (mode === "bytes") {
    outputBytes = program === "head"
      ? bytes.slice(0, count)
      : bytes.slice(Math.max(0, bytes.byteLength - count));
  } else {
    const text = new TextDecoder().decode(bytes);
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const output = program === "head"
      ? lines.slice(0, count).join("")
      : lines.slice(Math.max(0, lines.length - count)).join("");
    outputBytes = new TextEncoder().encode(output);
  }
  const stdout = new TextDecoder().decode(outputBytes);
  if (streamOutput && stdout) post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
  return {
    exitCode: 0,
    cwd,
    stdout,
    stdoutBytes: outputBytes,
    stderr: "",
    streamedOutput: streamOutput,
  };
}

async function runLsAdapter({ words, cwd, workspaceRoot, directory, posix, streamOutput }) {
  let showAll = false;
  let showAlmostAll = false;
  let longFormat = false;
  let directoryOnly = false;
  let reverse = false;
  let optionsEnded = false;
  const targets = [];
  for (const word of words.slice(1)) {
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const flags = word.startsWith("--") ? [word] : [...word.slice(1)].map((flag) => `-${flag}`);
      for (const flag of flags) {
        if (["-a", "--all"].includes(flag)) showAll = true;
        else if (["-A", "--almost-all"].includes(flag)) showAlmostAll = true;
        else if (["-l", "--long"].includes(flag)) longFormat = true;
        else if (["-d", "--directory"].includes(flag)) directoryOnly = true;
        else if (["-r", "--reverse"].includes(flag)) reverse = true;
        else if (["-1", "-h", "--human-readable", "--color=auto", "--color=never"].includes(flag)) continue;
        else return null;
      }
      continue;
    }
    targets.push(word);
  }
  const requested = targets.length ? targets : ["."];
  const workspaceSnapshot = await snapshotDirectory(directory);
  const rows = [];
  let stderr = "";
  let exitCode = 0;
  for (const value of requested) {
    const rawAbsolute = String(value).startsWith("/")
      ? String(value)
      : `${cwd.replace(/\/+$/, "")}/${value}`;
    const absoluteParts = [];
    for (const part of rawAbsolute.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") absoluteParts.pop();
      else absoluteParts.push(part);
    }
    const absolute = `/${absoluteParts.join("/")}`;
    if (absolute === "/") {
      let names = new Set(Object.keys(posix?.mounts || {}).map((path) => path.split("/").filter(Boolean)[0]).filter(Boolean));
      names.add("home");
      const sorted = [...names].sort();
      if (reverse) sorted.reverse();
      rows.push(...sorted.map((name) => longFormat ? `drwxr-xr-x 1 user user 0 ${name}` : name));
      continue;
    }
    let relative = workspaceRelativePath(value, cwd, workspaceRoot);
    let snapshot = workspaceSnapshot;
    if (relative === null) {
      const target = readableRuntimeTarget(value, cwd, workspaceRoot, posix, directory);
      if (target) {
        relative = target.path;
        snapshot = await snapshotDirectory(target.directory);
      }
    }
    if (relative === null) {
      stderr += `ls: cannot access '${value}': No such file or directory\n`;
      exitCode = 2;
      continue;
    }
    if (snapshot.files.has(relative)) {
      const name = relative.split("/").pop();
      rows.push(longFormat ? `-rw-r--r-- 1 user user ${snapshot.files.get(relative).byteLength} ${name}` : name);
      continue;
    }
    if (!snapshotHasDirectory(snapshot, relative)) {
      stderr += `ls: cannot access '${value}': No such file or directory\n`;
      exitCode = 2;
      continue;
    }
    if (directoryOnly) {
      rows.push(relative.split("/").pop() || workspaceRoot);
      continue;
    }
    const prefix = relative ? `${relative}/` : "";
    const children = new Map();
    for (const path of snapshot.directories) {
      if (!path.startsWith(prefix) || path === relative) continue;
      const name = path.slice(prefix.length).split("/")[0];
      if (name) children.set(name, { directory: true, size: 0 });
    }
    for (const [path, bytes] of snapshot.files) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      if (!remainder || remainder.includes("/")) continue;
      children.set(remainder, { directory: false, size: bytes.byteLength });
    }
    let entries = [...children.entries()].filter(([name]) => showAll || showAlmostAll || !name.startsWith("."));
    entries.sort(([left], [right]) => left.localeCompare(right));
    if (reverse) entries.reverse();
    if (showAll) entries.unshift([".", { directory: true, size: 0 }], ["..", { directory: true, size: 0 }]);
    rows.push(...entries.map(([name, info]) => longFormat
      ? `${info.directory ? "d" : "-"}rw${info.directory ? "x" : "-"}r-xr-x 1 user user ${info.size} ${name}`
      : name));
  }
  const stdout = rows.length ? `${rows.join("\n")}\n` : "";
  if (streamOutput && stdout) post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
  if (streamOutput && stderr) post("interactive-output", { sessionId: "", stream: "stderr", data: stderr });
  return { exitCode, cwd, stdout, stderr, streamedOutput: streamOutput };
}

async function runCdAdapter({ words, cwd, workspaceRoot, directory, posix }) {
  if (words.length > 2) return null;
  const requested = String(words[1] || workspaceRoot);
  if (requested === "/") {
    return {
      exitCode: 0,
      cwd: "/",
      stdout: "",
      stderr: "",
      streamedOutput: false,
    };
  }
  let relative = workspaceRelativePath(requested, cwd, workspaceRoot);
  let snapshot = await snapshotDirectory(directory);
  let resolvedCwd = relative === null ? "" : (relative ? `${workspaceRoot.replace(/\/+$/, "")}/${relative}` : workspaceRoot);
  if (relative === null) {
    const target = readableRuntimeTarget(requested, cwd, workspaceRoot, posix, directory);
    if (!target) return null;
    relative = target.path;
    snapshot = await snapshotDirectory(target.directory);
    resolvedCwd = String(requested).startsWith("/")
      ? normalizeRuntimeAbsolutePath(requested)
      : normalizeRuntimeAbsolutePath(`${cwd.replace(/\/+$/, "")}/${requested}`);
  }
  if (relative && !snapshot.directories.has(relative)) {
    return {
      exitCode: 1,
      cwd,
      stdout: "",
      stderr: `cd: ${requested}: No such file or directory\n`,
      streamedOutput: false,
    };
  }
  return {
    exitCode: 0,
    cwd: resolvedCwd,
    stdout: "",
    stderr: "",
    streamedOutput: false,
  };
}

async function runTemporaryMutationAdapter({ words, cwd, workspaceRoot, directory, posix }) {
  const program = String(words?.[0] || "").split("/").pop();
  if (!["mkdir", "rm", "rmdir"].includes(program)) return null;
  const recursive = words.slice(1).some((word) => /^-[^-]*[rR]/.test(word) || word === "--recursive");
  const force = words.slice(1).some((word) => /^-[^-]*f/.test(word) || word === "--force");
  const parents = words.slice(1).some((word) => /^-[^-]*p/.test(word) || word === "--parents");
  const operands = words.slice(1).filter((word) => word === "-" || !word.startsWith("-"));
  if (!operands.length) return null;
  const targets = operands.map((value) => ({
    value,
    path: temporaryRelativePath(value, cwd),
    directory: posix?.temporaryDirectory || posix?.mounts?.["/tmp"],
  }));
  if (targets.some((target) => target.path === null || !target.directory)) return null;
  let stderr = "";
  let exitCode = 0;
  for (const target of targets) {
    const before = await snapshotDirectory(target.directory);
    if (program === "mkdir") {
      if (snapshotHasDirectory(before, target.path)) {
        if (!parents) {
          stderr += `mkdir: cannot create directory '${target.value}': File exists\n`;
          exitCode = 1;
        }
        continue;
      }
      await ensureDirectory(target.directory, target.path);
      continue;
    }
    const isFile = before.files.has(target.path);
    const isDirectory = before.directories.has(target.path);
    if (!isFile && !isDirectory) {
      if (!force) {
        stderr += `${program}: cannot remove '${target.value}': No such file or directory\n`;
        exitCode = 1;
      }
      continue;
    }
    if (isFile) {
      if (program === "rmdir") {
        stderr += `rmdir: failed to remove '${target.value}': Not a directory\n`;
        exitCode = 1;
      } else {
        await target.directory.removeFile(`/${target.path}`);
      }
      continue;
    }
    const prefix = `${target.path}/`;
    const childFiles = [...before.files.keys()].filter((path) => path.startsWith(prefix));
    const childDirectories = [...before.directories].filter((path) => path.startsWith(prefix));
    if ((childFiles.length || childDirectories.length) && program === "rmdir") {
      stderr += `rmdir: failed to remove '${target.value}': Directory not empty\n`;
      exitCode = 1;
      continue;
    }
    if ((childFiles.length || childDirectories.length) && !recursive) return null;
    for (const path of childFiles) await target.directory.removeFile(`/${path}`);
    for (const path of childDirectories.sort((left, right) => right.length - left.length)) {
      await target.directory.removeDir(`/${path}`);
    }
    await target.directory.removeDir(`/${target.path}`);
  }
  return { exitCode, cwd, stdout: "", stderr, streamedOutput: false };
}

function runPwdAdapter({ words, cwd, streamOutput }) {
  if (words.slice(1).some((word) => !["-L", "-P", "--logical", "--physical"].includes(word))) return null;
  const stdout = `${cwd}\n`;
  if (streamOutput) post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
  return { exitCode: 0, cwd, stdout, stderr: "", streamedOutput: streamOutput };
}

function globExpression(value) {
  const escaped = String(value || "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

async function runFindAdapter({ words, cwd, workspaceRoot, directory, streamOutput }) {
  const operands = words.slice(1);
  const roots = [];
  let index = 0;
  while (index < operands.length && !operands[index].startsWith("-") && !["!", "("].includes(operands[index])) {
    roots.push(operands[index]);
    index += 1;
  }
  if (!roots.length) roots.push(".");
  let minDepth = 0;
  let maxDepth = Number.POSITIVE_INFINITY;
  let type = "";
  let namePattern = null;
  let insensitive = false;
  let printNull = false;
  while (index < operands.length) {
    const option = operands[index];
    if (option === "-maxdepth" || option === "-mindepth") {
      const value = Number(operands[index + 1]);
      if (!Number.isInteger(value) || value < 0) return null;
      if (option === "-maxdepth") maxDepth = value;
      else minDepth = value;
      index += 2;
    } else if (option === "-type" && ["f", "d"].includes(operands[index + 1])) {
      type = operands[index + 1];
      index += 2;
    } else if (["-name", "-iname"].includes(option) && operands[index + 1] !== undefined) {
      insensitive = option === "-iname";
      namePattern = globExpression(insensitive ? operands[index + 1].toLowerCase() : operands[index + 1]);
      index += 2;
    } else if (option === "-print") index += 1;
    else if (option === "-print0") {
      printNull = true;
      index += 1;
    } else return null;
  }

  const snapshot = await snapshotDirectory(directory);
  const output = [];
  let stderr = "";
  let exitCode = 0;
  for (const rootValue of roots) {
    const root = workspaceRelativePath(rootValue, cwd, workspaceRoot);
    if (root === null || (!snapshot.files.has(root) && !snapshotHasDirectory(snapshot, root))) {
      stderr += `find: '${rootValue}': No such file or directory\n`;
      exitCode = 1;
      continue;
    }
    const candidates = [];
    if (snapshot.files.has(root)) candidates.push({ path: root, type: "f" });
    else {
      candidates.push({ path: root, type: "d" });
      const prefix = root ? `${root}/` : "";
      for (const path of snapshot.directories) if (path.startsWith(prefix) && path !== root) candidates.push({ path, type: "d" });
      for (const path of snapshot.files.keys()) if (path.startsWith(prefix)) candidates.push({ path, type: "f" });
    }
    for (const candidate of candidates) {
      const depth = root ? candidate.path.slice(root.length).split("/").filter(Boolean).length : candidate.path.split("/").filter(Boolean).length;
      if (depth < minDepth || depth > maxDepth || (type && candidate.type !== type)) continue;
      const basename = candidate.path.split("/").pop() || ".";
      const testedName = insensitive ? basename.toLowerCase() : basename;
      if (namePattern && !namePattern.test(testedName)) continue;
      const visible = rootValue.startsWith("/")
        ? `${workspaceRoot}/${candidate.path}`.replace(/\/$/, "")
        : candidate.path === root
          ? rootValue
          : `${rootValue.replace(/\/$/, "")}/${candidate.path.slice(root.length).replace(/^\//, "")}`;
      output.push(visible || ".");
    }
  }
  const stdout = output.length ? `${output.join(printNull ? "\0" : "\n")}${printNull ? "\0" : "\n"}` : "";
  if (streamOutput && stdout) post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
  if (streamOutput && stderr) post("interactive-output", { sessionId: "", stream: "stderr", data: stderr });
  return { exitCode, cwd, stdout, stderr, streamedOutput: streamOutput };
}

async function runGrepAdapter({ words, cwd, workspaceRoot, directory, posix, stdin, streamOutput }) {
  let insensitive = false;
  let invert = false;
  let number = false;
  let count = false;
  let fixed = false;
  let quiet = false;
  let pattern = null;
  const files = [];
  let optionsEnded = false;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word === "-e") {
      pattern = words[index + 1];
      index += 1;
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const flags = word.startsWith("--") ? [word] : [...word.slice(1)].map((flag) => `-${flag}`);
      for (const flag of flags) {
        if (["-i", "--ignore-case"].includes(flag)) insensitive = true;
        else if (["-v", "--invert-match"].includes(flag)) invert = true;
        else if (["-n", "--line-number"].includes(flag)) number = true;
        else if (["-c", "--count"].includes(flag)) count = true;
        else if (["-q", "--quiet", "--silent"].includes(flag)) quiet = true;
        else if (["-F", "--fixed-strings"].includes(flag)) fixed = true;
        else if (["-E", "--extended-regexp"].includes(flag)) continue;
        else return null;
      }
      continue;
    }
    if (pattern === null) pattern = word;
    else files.push(word);
  }
  if (pattern === null) return null;
  let matcher;
  try {
    matcher = fixed
      ? (line) => (insensitive ? line.toLowerCase() : line).includes(insensitive ? pattern.toLowerCase() : pattern)
      : (line) => new RegExp(pattern, insensitive ? "i" : "").test(line);
  } catch {
    return null;
  }
  const inputs = files.length ? files : ["-"];
  const rows = [];
  let stderr = "";
  let exitCode = 1;
  for (const file of inputs) {
    let text;
    try {
      if (file === "-") {
        if (stdin === null) return null;
        text = new TextDecoder().decode(stdin instanceof Uint8Array ? stdin : new TextEncoder().encode(String(stdin)));
      } else {
        const target = readableRuntimeTarget(file, cwd, workspaceRoot, posix, directory);
        if (!target) throw new Error("outside mounted filesystem");
        text = new TextDecoder().decode(await target.directory.readFile(`/${target.path}`));
      }
    } catch {
      stderr += `grep: ${file}: No such file or directory\n`;
      exitCode = 2;
      continue;
    }
    const matches = text.split("\n").filter((line, lineIndex, lines) => !(lineIndex === lines.length - 1 && line === "")).map((line, lineIndex) => ({ line, lineNumber: lineIndex + 1 })).filter(({ line }) => invert ? !matcher(line) : matcher(line));
    if (matches.length && exitCode !== 2) exitCode = 0;
    if (quiet && matches.length) break;
    if (count) rows.push(`${files.length > 1 ? `${file}:` : ""}${matches.length}`);
    else if (!quiet) rows.push(...matches.map(({ line, lineNumber }) => `${files.length > 1 ? `${file}:` : ""}${number ? `${lineNumber}:` : ""}${line}`));
  }
  const stdout = rows.length ? `${rows.join("\n")}\n` : "";
  if (streamOutput && stdout) post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
  if (streamOutput && stderr) post("interactive-output", { sessionId: "", stream: "stderr", data: stderr });
  return { exitCode, cwd, stdout, stderr, streamedOutput: streamOutput };
}

function absoluteWorkspacePath(value, cwd, workspaceRoot, runtimeRoot = WORKSPACE_RUNTIME_ROOT) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(String(value || ""))) return String(value || "");
  const relative = workspaceRelativePath(value, cwd, workspaceRoot);
  if (relative === null) return String(value || "");
  return relative ? `${runtimeRoot}/${relative}` : runtimeRoot;
}

function displayWorkspacePaths(value, workspaceRoot) {
  const visibleRoot = String(workspaceRoot || "/home/user").replace(/\/+$/, "") || "/";
  let output = String(value || "")
    .split(DIRECT_RUNTIME_ROOT).join(visibleRoot)
    .split(WORKSPACE_RUNTIME_ROOT).join(visibleRoot);
  const duplicatedRoot = `${visibleRoot}/${visibleRoot}`;
  while (visibleRoot !== "/" && output.includes(duplicatedRoot)) {
    output = output.split(duplicatedRoot).join(visibleRoot);
  }
  return output;
}

function rsyncLocalOperands(words) {
  const operands = [];
  let optionsEnded = false;
  let verbose = false;
  for (const word of words.slice(1)) {
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith("-")) {
      if (["-a", "-r", "-v", "-q", "-av", "-va", "-ar", "-ra", "-rv", "-vr", "-arv", "-avr", "-rav", "-rva", "-var", "-vra"].includes(word)) {
        if (word.includes("v")) verbose = true;
        continue;
      }
      if (["--archive", "--recursive", "--quiet"].includes(word)) continue;
      if (word === "--verbose") {
        verbose = true;
        continue;
      }
      return null;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word) || /^[^/][^:]*:/.test(word)) return null;
    operands.push(word);
  }
  return operands.length === 2 ? { operands, verbose } : null;
}

async function runLocalRsyncAdapter({ words, cwd, workspaceRoot, directory }) {
  const parsed = rsyncLocalOperands(words);
  if (!parsed) return null;
  const [sourceValue, destinationValue] = parsed.operands;
  const source = workspaceRelativePath(sourceValue, cwd, workspaceRoot);
  const destination = workspaceRelativePath(destinationValue, cwd, workspaceRoot);
  if (source === null || destination === null || !source) return null;

  const snapshot = await snapshotDirectory(directory);
  const sourceIsFile = snapshot.files.has(source);
  const sourceIsDirectory = snapshot.directories.has(source);
  if (!sourceIsFile && !sourceIsDirectory) {
    return {
      exitCode: 23,
      cwd,
      stdout: "",
      stderr: `rsync: link_stat \"${sourceValue}\" failed: No such file or directory\n`,
    };
  }

  const destinationIsDirectory = snapshotHasDirectory(snapshot, destination);
  const sourceName = source.split("/").pop();
  const copyContents = sourceIsDirectory && /\/$/.test(sourceValue);
  const targetRoot = sourceIsFile
    ? (destinationIsDirectory ? `${destination}/${sourceName}` : destination)
    : (copyContents ? destination : `${destination}/${sourceName}`);
  const copied = [];

  if (sourceIsFile) {
    const parent = targetRoot.split("/").slice(0, -1).join("/");
    if (parent) await ensureDirectory(directory, parent);
    await directory.writeFile(`/${targetRoot}`, snapshot.files.get(source));
    copied.push(targetRoot);
  } else {
    await ensureDirectory(directory, targetRoot);
    for (const path of snapshot.directories) {
      if (!path.startsWith(`${source}/`)) continue;
      const relative = path.slice(source.length + 1);
      await ensureDirectory(directory, relative ? `${targetRoot}/${relative}` : targetRoot);
    }
    for (const [path, bytes] of snapshot.files) {
      if (!path.startsWith(`${source}/`)) continue;
      const relative = path.slice(source.length + 1);
      const target = `${targetRoot}/${relative}`;
      const parent = target.split("/").slice(0, -1).join("/");
      if (parent) await ensureDirectory(directory, parent);
      await directory.writeFile(`/${target}`, bytes);
      copied.push(target);
    }
  }

  const stdout = parsed.verbose
    ? ["sending incremental file list", ...copied.map((path) => `${path}\n`), ""].join("\n")
    : "";
  return { exitCode: 0, cwd, stdout, stderr: "" };
}

async function runLocalFileMutationAdapter({ words, cwd, workspaceRoot, directory }) {
  const program = String(words?.[0] || "").split("/").pop();
  if (!["cp", "mv", "rm"].includes(program)) return null;

  let recursive = false;
  let force = false;
  let verbose = false;
  let optionsEnded = false;
  const operands = [];
  for (const word of words.slice(1)) {
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const flags = word.startsWith("--") ? [word] : [...word.slice(1)].map((flag) => `-${flag}`);
      for (const flag of flags) {
        if (["-r", "-R", "--recursive"].includes(flag)) recursive = true;
        else if (["-f", "--force"].includes(flag)) force = true;
        else if (["-v", "--verbose"].includes(flag)) verbose = true;
        else if (program === "rm" && ["-d", "--dir"].includes(flag)) recursive = true;
        else return null;
      }
      continue;
    }
    operands.push(word);
  }

  const snapshot = await snapshotDirectory(directory);
  const pathFor = (value) => workspaceRelativePath(value, cwd, workspaceRoot);
  const exists = (path) => snapshot.files.has(path) || snapshotHasDirectory(snapshot, path);
  const basename = (path) => path.split("/").filter(Boolean).pop() || "";
  const removePath = async (path, allowDirectory) => {
    if (snapshot.files.has(path)) {
      await directory.removeFile(`/${path}`);
      snapshot.files.delete(path);
      return true;
    }
    if (!snapshot.directories.has(path) || !allowDirectory) return false;
    const prefix = `${path}/`;
    const files = [...snapshot.files.keys()].filter((entry) => entry.startsWith(prefix));
    const directories = [...snapshot.directories].filter((entry) => entry === path || entry.startsWith(prefix));
    for (const file of files) {
      await directory.removeFile(`/${file}`);
      snapshot.files.delete(file);
    }
    for (const entry of directories.sort((left, right) => right.length - left.length)) {
      await directory.removeDir(`/${entry}`);
      snapshot.directories.delete(entry);
    }
    return true;
  };
  const copyPath = async (source, target, allowDirectory) => {
    if (snapshot.files.has(source)) {
      const parent = target.split("/").slice(0, -1).join("/");
      if (parent) await ensureDirectory(directory, parent);
      await directory.writeFile(`/${target}`, snapshot.files.get(source));
      snapshot.files.set(target, snapshot.files.get(source));
      return true;
    }
    if (!snapshot.directories.has(source) || !allowDirectory || target === source || target.startsWith(`${source}/`)) {
      return false;
    }
    await ensureDirectory(directory, target);
    snapshot.directories.add(target);
    const prefix = `${source}/`;
    for (const entry of [...snapshot.directories].filter((path) => path.startsWith(prefix)).sort()) {
      const destination = `${target}/${entry.slice(prefix.length)}`;
      await ensureDirectory(directory, destination);
      snapshot.directories.add(destination);
    }
    for (const [entry, bytes] of [...snapshot.files.entries()].filter(([path]) => path.startsWith(prefix))) {
      const destination = `${target}/${entry.slice(prefix.length)}`;
      const parent = destination.split("/").slice(0, -1).join("/");
      if (parent) await ensureDirectory(directory, parent);
      await directory.writeFile(`/${destination}`, bytes);
      snapshot.files.set(destination, bytes);
    }
    return true;
  };

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  if (program === "rm") {
    if (!operands.length) return null;
    for (const operand of operands) {
      const target = pathFor(operand);
      if (!target || !await removePath(target, recursive)) {
        if (!force) {
          stderr += `rm: cannot remove '${operand}': No such file or directory\n`;
          exitCode = 1;
        }
      } else if (verbose) stdout += `removed '${operand}'\n`;
    }
    return { exitCode, cwd, stdout, stderr };
  }

  if (operands.length < 2) return null;
  const destinationValue = operands.at(-1);
  const sources = operands.slice(0, -1);
  const destination = pathFor(destinationValue);
  if (destination === null || (!snapshotHasDirectory(snapshot, destination) && sources.length > 1)) return null;
  for (const sourceValue of sources) {
    const source = pathFor(sourceValue);
    if (!source || !exists(source)) {
      stderr += `${program}: cannot stat '${sourceValue}': No such file or directory\n`;
      exitCode = 1;
      continue;
    }
    const target = snapshotHasDirectory(snapshot, destination)
      ? `${destination}/${basename(source)}`
      : destination;
    if (exists(target) && target !== source) await removePath(target, true);
    const copied = await copyPath(source, target, program === "mv" || recursive);
    if (!copied) {
      stderr += `${program}: cannot copy '${sourceValue}' to '${destinationValue}'\n`;
      exitCode = 1;
      continue;
    }
    if (program === "mv" && source !== target) await removePath(source, true);
    if (verbose) stdout += `'${sourceValue}' -> '${destinationValue}'\n`;
  }
  return { exitCode, cwd, stdout, stderr };
}

function rewriteDirectRuntimeArguments(
  program,
  args,
  cwd,
  workspaceRoot,
  runtimeRoot = WORKSPACE_RUNTIME_ROOT,
  forceWorkspacePaths = false,
) {
  if (program === "tar") {
    const values = [...args];
    const rewritten = [];
    let pathOption = "";
    let hasDirectoryOption = false;
    let firstSourceIndex = -1;
    const pathOptions = new Set(["-f", "--file", "-T", "--files-from", "-X", "--exclude-from"]);
    for (const rawValue of values) {
      const value = String(rawValue || "");
      if (pathOption) {
        rewritten.push(absoluteWorkspacePath(value, cwd, workspaceRoot, runtimeRoot));
        if (pathOption === "directory") hasDirectoryOption = true;
        pathOption = "";
        continue;
      }
      if (value === "-C" || value === "--directory") {
        rewritten.push(value);
        pathOption = "directory";
        continue;
      }
      if (pathOptions.has(value)) {
        rewritten.push(value);
        pathOption = "file";
        continue;
      }
      if (value.startsWith("--directory=")) {
        rewritten.push(`--directory=${absoluteWorkspacePath(value.slice(12), cwd, workspaceRoot, runtimeRoot)}`);
        hasDirectoryOption = true;
        continue;
      }
      const longPathOption = ["--file=", "--files-from=", "--exclude-from="]
        .find((prefix) => value.startsWith(prefix));
      if (longPathOption) {
        rewritten.push(`${longPathOption}${absoluteWorkspacePath(value.slice(longPathOption.length), cwd, workspaceRoot, runtimeRoot)}`);
        continue;
      }
      if (/^-[^-]/.test(value)) {
        rewritten.push(value);
        if (value.includes("C")) pathOption = "directory";
        else if (/[fTX]/.test(value)) pathOption = "file";
        continue;
      }
      if (rewritten.length === 0 && /^[A-Za-z]+$/.test(value) && /[crtux]/.test(value)) {
        rewritten.push(value);
        if (value.includes("C")) pathOption = "directory";
        else if (/[fTX]/.test(value)) pathOption = "file";
        continue;
      }
      if (firstSourceIndex < 0) firstSourceIndex = rewritten.length;
      rewritten.push(value);
    }
    if (!hasDirectoryOption) {
      const insertionIndex = firstSourceIndex < 0 ? rewritten.length : firstSourceIndex;
      rewritten.splice(
        insertionIndex,
        0,
        "-C",
        absoluteWorkspacePath(cwd, cwd, workspaceRoot, runtimeRoot),
      );
    }
    return rewritten;
  }
  const values = [...args];
  const testFileOperandIndexes = new Set();
  if (program === "test" || program === "[") {
    const unaryFileOperators = new Set([
      "-b", "-c", "-d", "-e", "-f", "-G", "-g", "-h", "-k", "-L",
      "-N", "-O", "-p", "-r", "-S", "-s", "-u", "-w", "-x",
    ]);
    const binaryFileOperators = new Set(["-ef", "-nt", "-ot"]);
    for (let index = 0; index < values.length; index += 1) {
      if (unaryFileOperators.has(String(values[index - 1] || ""))) {
        testFileOperandIndexes.add(index);
      }
      if (binaryFileOperators.has(String(values[index] || ""))) {
        if (index > 0) testFileOperandIndexes.add(index - 1);
        if (index + 1 < values.length) testFileOperandIndexes.add(index + 1);
      }
    }
  }
  if (program === "gojq" && !values.some((value) => value === "-L" || value === "--library-path")) {
    values.unshift("-L", runtimeRoot);
  }
  const localPackageCommands = new Set(["apt", "apt-get", "dpkg", "dpkg-deb"]);
  const fileCommands = new Set([
    "7z", "7za", "7zr", "actionlint", "ar", "awk", "base64", "bat", "bison", "brotli", "bunzip2", "bzcat", "bzip2", "cat", "cksum", "cmark",
    "cmp", "comm", "cp", "cpio", "cut", "diff", "du", "file", "find", "grep",
    "eza", "gawk", "gzip", "gunzip", "head", "hexedit", "install", "less", "ln", "ls", "lua", "luac", "lz4", "lz4cat", "mawk", "mkdir", "mv", "ncdu", "patch",
    "readlink", "realpath", "rm", "rmdir", "sed", "sha256sum", "sort", "stat",
    "tail", "tar", "tee", "test", "touch", "tree", "truncate", "unlz4", "unxz", "unzip", "wc",
    "ctags", "qjs", "sq", "uncrustify", "wasm-tools", "wasm3", "xargs", "xdelta3",
    "xxhsum", "xz", "zcat", "zopfli", "zstd", "zstdcat", "unzstd",
    "spectest-interp", "wat-desugar", "wast2json", "wasm-decompile", "wasm-interp",
    "wasm-objdump", "wasm-stats", "wasm-strip", "wasm-validate", "wasm2c", "wasm2wat", "wat2wasm",
  ]);
  let grepPatternSeen = false;
  let sedScriptSeen = false;
  let awkProgramSeen = false;
  let replacementOperandCount = 0;
  let skipNextValue = false;
  let positionalOperandCount = 0;
  let findExpressionStarted = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value || value === "-") continue;
    if (skipNextValue) {
      skipNextValue = false;
      continue;
    }
    if (value.startsWith("-")) {
      if (["7z", "7za", "7zr"].includes(program) && value.startsWith("-o") && value.length > 2) {
        values[index] = `-o${absoluteWorkspacePath(value.slice(2), cwd, workspaceRoot, runtimeRoot)}`;
      }
      if (program === "find") findExpressionStarted = true;
      const nonPathValueOptions = {
        awk: new Set(["-F", "-v"]),
        ctags: new Set(["--language-force", "--languages", "--fields", "--extras", "--kinds-all"]),
        gawk: new Set(["-F", "-v"]),
        lua: new Set(["-e", "-l"]),
        mawk: new Set(["-F", "-v"]),
        qjs: new Set(["-e", "--eval", "--stack-size", "--memory-limit"]),
        uncrustify: new Set(["-l", "--language"]),
        wasm3: new Set(["--func", "--stack-size"]),
      };
      if (nonPathValueOptions[program]?.has(value)) skipNextValue = true;
      if (program === "grep" && (/^-e.+/.test(value) || value.startsWith("--regexp="))) {
        grepPatternSeen = true;
      }
      continue;
    }
    if (program === "find" && findExpressionStarted) {
      if (["-newer", "-anewer", "-cnewer"].includes(String(values[index - 1] || ""))) {
        values[index] = absoluteWorkspacePath(value, cwd, workspaceRoot, runtimeRoot);
      }
      continue;
    }
    if (program === "wasm-tools" && positionalOperandCount === 0) {
      positionalOperandCount += 1;
      continue;
    }
    if (program === "wasm3" && positionalOperandCount > 0) {
      positionalOperandCount += 1;
      continue;
    }
    if (["7z", "7za", "7zr"].includes(program) && index === 0 && /^[aehiltrux]$/.test(value)) continue;
    if ((program === "head" || program === "tail") && /^\+?\d+$/.test(value)) continue;
    if (program === "cpio" && index > 0 && values[index - 1] === "-H") continue;
    let shouldRewrite = program === "test" || program === "["
      ? testFileOperandIndexes.has(index)
      : fileCommands.has(program)
        || (localPackageCommands.has(program) && value.startsWith("/"));
    if (program === "grep") {
      const previous = String(values[index - 1] || "");
      if (previous === "-e" || previous === "--regexp") {
        grepPatternSeen = true;
        continue;
      }
      if (previous === "-f" || previous === "--file") {
        grepPatternSeen = true;
        shouldRewrite = true;
      } else if (!grepPatternSeen) {
        grepPatternSeen = true;
        continue;
      }
    }
    if (program === "sed") {
      const previous = String(values[index - 1] || "");
      if (previous === "-e" || previous === "--expression") {
        sedScriptSeen = true;
        continue;
      }
      if (previous === "-f" || previous === "--file") {
        sedScriptSeen = true;
        shouldRewrite = true;
      } else if (!sedScriptSeen) {
        sedScriptSeen = true;
        continue;
      }
    }
    if (["awk", "gawk", "mawk"].includes(program)) {
      const previous = String(values[index - 1] || "");
      if (previous === "-f" || previous === "--file") {
        awkProgramSeen = true;
        shouldRewrite = true;
      } else if (!awkProgramSeen) {
        awkProgramSeen = true;
        continue;
      }
    }
    if (["sd", "ruplacer"].includes(program) && replacementOperandCount < 2) {
      replacementOperandCount += 1;
      continue;
    }
    if (["sd", "ruplacer"].includes(program)) shouldRewrite = true;
    if (!shouldRewrite) continue;
    if (forceWorkspacePaths && !value.startsWith("/")) {
      const relative = workspaceRelativePath(value, cwd, workspaceRoot);
      values[index] = relative === null
        ? value
        : relative
          ? `${runtimeRoot}/${relative}`
          : runtimeRoot;
    } else {
      values[index] = absoluteWorkspacePath(value, cwd, workspaceRoot, runtimeRoot);
    }
    positionalOperandCount += 1;
  }
  if (
    positionalOperandCount === 0
    && new Set(["du", "eza", "find", "ls", "ncdu", "tree"]).has(program)
  ) {
    values.push(absoluteWorkspacePath(".", cwd, workspaceRoot, runtimeRoot));
  }
  return values;
}

function emptySnapshot() {
  return { files: new Map(), directories: new Set() };
}

function snapshotHasDirectory(snapshot, path) {
  return path === "" || snapshot.directories.has(path);
}

function addSnapshotDirectory(snapshot, path) {
  const normalized = normalizeRelativePath(path);
  if (!normalized) return;
  const parts = normalized.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    snapshot.directories.add(parts.slice(0, index).join("/"));
  }
}

function addSnapshotPath(source, target, path) {
  const normalized = normalizeRelativePath(path);
  if (!normalized) {
    for (const directory of source.directories) addSnapshotDirectory(target, directory);
    for (const [file, bytes] of source.files) target.files.set(file, bytes);
    return true;
  }
  if (source.files.has(normalized)) {
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent) addSnapshotDirectory(target, parent);
    target.files.set(normalized, source.files.get(normalized));
    return true;
  }
  if (!source.directories.has(normalized)) return false;
  addSnapshotDirectory(target, normalized);
  const prefix = `${normalized}/`;
  for (const directory of source.directories) {
    if (directory.startsWith(prefix)) addSnapshotDirectory(target, directory);
  }
  for (const [file, bytes] of source.files) {
    if (!file.startsWith(prefix)) continue;
    target.files.set(file, bytes);
  }
  return true;
}

function selectPipelineSnapshot(sourceSnapshot, source, cwd, workspaceRoot) {
  const sequence = splitSimpleCommandSequence(source);
  const pipeline = sequence
    ? sequence.map((entry) => entry.source)
    : splitSimplePipeline(source);
  if (!pipeline) return sourceSnapshot;
  const target = emptySnapshot();
  const cwdRelative = workspaceRelativePath(cwd, workspaceRoot, workspaceRoot);
  if (cwdRelative) addSnapshotDirectory(target, cwdRelative);
  const explicitFileCommands = new Set([
    "awk", "base64", "basename", "cat", "cksum", "comm", "cut", "dirname", "echo",
    "env", "expand", "expr", "false", "fmt", "fold", "grep", "head", "hexdump",
    "md5sum", "od", "paste", "printf", "rev", "sed", "seq", "sha1sum", "sha256sum",
    "sha512sum", "sort", "strings", "sum", "tac", "tail", "tee", "test", "tr", "true",
    "uniq", "wc", "xargs", "yes",
  ]);
  const implicitDirectoryCommands = new Set(["du", "find", "ls", "tree"]);
  const targetedMutationCommands = new Set(["cp", "ln", "mkdir", "mv", "rm", "rmdir", "touch", "truncate"]);

  for (const segment of pipeline) {
    if (/[$`*?\[\]{}]/.test(segment)) return sourceSnapshot;
    const redirection = parseSimpleRedirection(segment);
    const words = redirection?.words || parseSimpleShellWords(segment);
    if (!words?.length) return sourceSnapshot;
    const command = words[0].split("/").pop();
    if (
      !explicitFileCommands.has(command)
      && !implicitDirectoryCommands.has(command)
      && !targetedMutationCommands.has(command)
    ) return sourceSnapshot;
    let matchedPath = false;
    for (const word of words.slice(1)) {
      if (!word || word === "-" || word.startsWith("-")) continue;
      const relative = workspaceRelativePath(word, cwd, workspaceRoot);
      if (relative === null || !relative) continue;
      matchedPath = addSnapshotPath(sourceSnapshot, target, relative) || matchedPath;
    }
    for (const path of [redirection?.input, redirection?.output, redirection?.errorOutput]) {
      if (!path || path === "/dev/null") continue;
      const relative = workspaceRelativePath(path, cwd, workspaceRoot);
      if (relative === null || !relative) continue;
      matchedPath = addSnapshotPath(sourceSnapshot, target, relative) || matchedPath;
    }
    if (implicitDirectoryCommands.has(command) && !matchedPath && cwdRelative !== null) {
      addSnapshotPath(sourceSnapshot, target, cwdRelative);
    }
  }
  return target;
}

async function runBufferedPipelineAdapter({ source, stdin, cwd, workspaceRoot, directory }) {
  const words = parseSimpleShellWords(source);
  if (!words?.length || stdin === null) return null;
  const command = words[0].split("/").pop();
  if (command !== "tee") return null;

  let append = false;
  const targets = [];
  let optionsEnded = false;
  for (const word of words.slice(1)) {
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") {
      for (const option of word.slice(1)) {
        if (option === "a") append = true;
        else if (option !== "i") {
          return {
            exitCode: 1,
            cwd,
            stdout: "",
            stderr: `tee: unsupported option -- ${option}\n`,
          };
        }
      }
      continue;
    }
    targets.push(word);
  }

  const inputBytes = new TextEncoder().encode(String(stdin || ""));
  for (const target of targets) {
    const relative = workspaceRelativePath(target, cwd, workspaceRoot);
    if (relative === null || !relative) {
      return {
        exitCode: 1,
        cwd,
        stdout: "",
        stderr: `tee: ${target}: path is outside the workspace\n`,
      };
    }
    const parent = relative.split("/").slice(0, -1).join("/");
    if (parent) await ensureDirectory(directory, parent);
    let outputBytes = inputBytes;
    if (append) {
      try {
        const existing = new Uint8Array(await directory.readFile(`/${relative}`));
        outputBytes = new Uint8Array(existing.byteLength + inputBytes.byteLength);
        outputBytes.set(existing);
        outputBytes.set(inputBytes, existing.byteLength);
      } catch {
      }
    }
    await directory.writeFile(`/${relative}`, outputBytes);
  }
  return {
    exitCode: 0,
    cwd,
    stdout: String(stdin || ""),
    stderr: "",
  };
}

function splitSimplePipeline(source) {
  const value = String(source || "");
  const segments = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let compoundDepth = 0;
  let commandPosition = true;
  let word = "";
  let hasPipeline = false;
  const flushWord = () => {
    if (!word) return;
    if (commandPosition && ["case", "for", "if", "select", "until", "while"].includes(word)) {
      compoundDepth += 1;
    } else if (["done", "esac", "fi"].includes(word)) {
      compoundDepth = Math.max(0, compoundDepth - 1);
    }
    commandPosition = ["do", "elif", "else", "then"].includes(word);
    word = "";
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      continue;
    }
    if (character === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (parenDepth || braceDepth) continue;
    if (/[A-Za-z0-9_]/.test(character)) {
      word += character;
      continue;
    }
    flushWord();
    if (character === ";" || character === "\n") {
      if (
        !compoundDepth
        && !/^\s*(?:case|for|if|select|until|while)\b/.test(value.slice(index + 1))
      ) return null;
      commandPosition = true;
      continue;
    }
    if (character === "&") {
      if (!compoundDepth) return null;
      if (value[index + 1] === "&") index += 1;
      commandPosition = true;
      continue;
    }
    if (character !== "|") continue;
    if (compoundDepth) {
      if (value[index + 1] === "|") index += 1;
      commandPosition = true;
      continue;
    }
    if (value[index - 1] === ">" || value[index - 1] === "|") continue;
    if (value[index + 1] === "|") return null;
    const segment = value.slice(start, index).trim();
    if (!segment) return null;
    segments.push(segment);
    start = index + 1;
    hasPipeline = true;
    commandPosition = true;
  }
  flushWord();
  if (!hasPipeline || quote || parenDepth || braceDepth || compoundDepth) return null;
  const finalSegment = value.slice(start).trim();
  if (!finalSegment) return null;
  segments.push(finalSegment);
  return segments;
}

function expandShellLastStatus(source, status) {
  const value = String(source || "");
  const replacement = String(Number(status || 0));
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      output += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = "";
        output += character;
      } else if (quote !== "'" && character === "$" && value[index + 1] === "?") {
        output += replacement;
        index += 1;
      } else {
        output += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === "$" && value[index + 1] === "?") {
      output += replacement;
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function splitSimpleCommandSequence(source) {
  const value = String(source || "");
  if (/(?:^|[;\n]|&&|\|\|)\s*(?:if|for|while|until|case|select)\b/.test(value)) {
    return splitCompoundCommandSequence(value);
  }
  const commands = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let operator = "";
  const substitutions = [];
  const append = (end, nextOperator) => {
    const command = value.slice(start, end).trim();
    if (!command) return false;
    commands.push({ source: command, operator });
    operator = nextOperator;
    return true;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (substitutions.length) {
      const context = substitutions[substitutions.length - 1];
      if (context.escaped) {
        context.escaped = false;
        continue;
      }
      if (character === "\\" && context.quote !== "'") {
        context.escaped = true;
        continue;
      }
      if (context.quote) {
        if (context.quote === '"' && character === "$" && value[index + 1] === "(" && value[index + 2] === "(") return null;
        if (context.quote === '"' && character === "$" && value[index + 1] === "(") {
          substitutions.push({ kind: "paren", quote: "", escaped: false });
          index += 1;
        } else if (context.quote === '"' && character === "`") {
          substitutions.push({ kind: "backtick", quote: "", escaped: false });
        } else if (character === context.quote) {
          context.quote = "";
        }
        continue;
      }
      if (character === "$" && value[index + 1] === "(" && value[index + 2] === "(") return null;
      if (context.kind === "backtick" && character === "`") {
        substitutions.pop();
        continue;
      }
      if (character === "'" || character === '"') {
        context.quote = character;
        continue;
      }
      if (character === "$" && value[index + 1] === "(") {
        substitutions.push({ kind: "paren", quote: "", escaped: false });
        index += 1;
        continue;
      }
      if (character === "`") {
        substitutions.push({ kind: "backtick", quote: "", escaped: false });
        continue;
      }
      if (context.kind === "paren" && character === ")") substitutions.pop();
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (quote === '"' && character === "$" && value[index + 1] === "(" && value[index + 2] === "(") return null;
      if (quote === '"' && character === "$" && value[index + 1] === "(") {
        substitutions.push({ kind: "paren", quote: "", escaped: false });
        index += 1;
      } else if (quote === '"' && character === "`") {
        substitutions.push({ kind: "backtick", quote: "", escaped: false });
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$" && value[index + 1] === "(" && value[index + 2] === "(") return null;
    if (character === "$" && value[index + 1] === "(") {
      substitutions.push({ kind: "paren", quote: "", escaped: false });
      index += 1;
      continue;
    }
    if (character === "`") {
      substitutions.push({ kind: "backtick", quote: "", escaped: false });
      continue;
    }
    if (["(", ")", "{", "}"].includes(character)) return null;
    let delimiter = "";
    let width = 1;
    if (character === ";" || character === "\n") delimiter = ";";
    else if (character === "&" && value[index + 1] === "&") {
      delimiter = "&&";
      width = 2;
    } else if (character === "|" && value[index + 1] === "|") {
      delimiter = "||";
      width = 2;
    } else if (character === "&") {
      return null;
    }
    if (!delimiter) continue;
    if (!append(index, delimiter)) return null;
    index += width - 1;
    start = index + 1;
  }
  if (quote || escaped || substitutions.length || commands.length === 0 || !append(value.length, "")) return null;
  const stateful = new Set([".", "alias", "eval", "exec", "export", "read", "set", "shift", "source", "trap", "umask", "unalias", "unset"]);
  if (commands.some((entry) => stateful.has(parseSimpleShellWords(entry.source)?.[0] || ""))) return null;
  return commands;
}

function splitCompoundCommandSequence(value) {
  const commands = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let substitutionDepth = 0;
  let compoundDepth = 0;
  let commandPosition = true;
  let word = "";
  let operator = "";
  const append = (end, nextOperator) => {
    const source = value.slice(start, end).trim();
    if (!source) return false;
    commands.push({ source, operator });
    operator = nextOperator;
    return true;
  };
  const flushWord = () => {
    if (!word) return;
    if (commandPosition && ["case", "for", "if", "select", "until", "while"].includes(word)) compoundDepth += 1;
    else if (["done", "esac", "fi"].includes(word)) compoundDepth = Math.max(0, compoundDepth - 1);
    commandPosition = ["do", "elif", "else", "then"].includes(word);
    word = "";
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"' || character === "`") { flushWord(); quote = character; continue; }
    if (character === "$" && value[index + 1] === "(") { flushWord(); substitutionDepth += 1; index += 1; continue; }
    if (substitutionDepth) { if (character === "(") substitutionDepth += 1; else if (character === ")") substitutionDepth -= 1; continue; }
    if (/[A-Za-z0-9_]/.test(character)) { word += character; continue; }
    flushWord();
    let delimiter = "";
    let width = 1;
    if (character === ";" || character === "\n") delimiter = ";";
    else if (character === "&" && value[index + 1] === "&") { delimiter = "&&"; width = 2; }
    else if (character === "|" && value[index + 1] === "|") { delimiter = "||"; width = 2; }
    else if (character === "&" && !compoundDepth) return null;
    if (!delimiter) continue;
    commandPosition = true;
    if (compoundDepth) { index += width - 1; continue; }
    if (!append(index, delimiter)) return null;
    index += width - 1;
    start = index + 1;
  }
  flushWord();
  if (quote || escaped || substitutionDepth || compoundDepth || !append(value.length, "")) return null;
  for (let index = commands.length - 2; index >= 0; index -= 1) {
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;]+\s*)+$/.test(commands[index].source)) continue;
    commands[index + 1] = {
      ...commands[index + 1],
      source: `${commands[index].source}; ${commands[index + 1].source}`,
      operator: commands[index].operator,
    };
    commands.splice(index, 1);
  }
  return commands.length > 1 ? commands : null;
}

function isCompoundShellProgram(source) {
  return /(?:^|[;\n])\s*(?:if|for|while|until|case|select)\b/.test(String(source || ""));
}

async function runShellProcess({
  source,
  cwd,
  workspaceRoot,
  directory,
  posix,
  stdin = null,
  streamOutput = true,
  stdoutMode = "terminal",
}) {
  const command = rewritePackageScriptCommand(source, posix.packageScripts);
  const runtimeCwd = absoluteWorkspacePath(cwd, cwd, workspaceRoot);
  const stateName = `.edgeterm-runtime-state-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const statePath = `${WORKSPACE_RUNTIME_ROOT}/${stateName}`;
  const wrapped = `chmod 755 /usr/local/bin/* /usr/local/sbin/* /opt/*/bin/* 2>/dev/null || true\ncd ${shellQuote(runtimeCwd)} || exit $?\n${command}\n__edgeterm_status=$?\nprintf '%s\\037%s\\n' \"$PWD\" \"$__edgeterm_status\" > ${shellQuote(statePath)}\nexit \"$__edgeterm_status\"`;
  const commandDirectory = await createWorkspaceFromSnapshot(await snapshotDirectory(directory));
  const mount = { ...posix.mounts };
  delete mount[workspaceRoot];
  mountWorkspaceDirectory(mount, commandDirectory, workspaceRoot);
  const options = {
    args: ["-c", wrapped],
    stdin: stdin === null
      ? new Uint8Array()
      : stdin instanceof Uint8Array
        ? stdin
        : String(stdin),
    env: {
      ...posix.env,
      HOME: WORKSPACE_RUNTIME_ROOT,
      PWD: runtimeCwd,
      PATH: `/usr/local/bin:/usr/local/sbin:/.edgeterm-bin:${String(posix.env?.PATH || "/usr/bin:/bin")}`,
      ...(stdin === null ? {} : { EDGETERM_STDIN_MODE: "pipe" }),
      ...(stdoutMode === "terminal" ? {} : { EDGETERM_STDOUT_MODE: stdoutMode }),
    },
    mount,
  };
  const commandRuntime = await getSharedCommandRuntime(options.mount);
  const instance = await runWasix(runtimeBinaries.get("ash"), {
    program: "ash",
    runtime: commandRuntime,
    ...options,
  });
  const stdoutCapture = startProcessStreamCapture(instance.stdout, (data) => {
    const visibleData = displayWorkspacePaths(data, workspaceRoot);
    if (streamOutput && visibleData) {
      post("interactive-output", { sessionId: "", stream: "stdout", data: visibleData });
    }
  });
  const stderrCapture = startProcessStreamCapture(instance.stderr, (data) => {
    const visibleData = stripRuntimeExitNoise(displayWorkspacePaths(data, workspaceRoot));
    if (streamOutput && visibleData) {
      post("interactive-output", { sessionId: "", stream: "stderr", data: visibleData });
    }
  });
  await closeProcessStdin(instance, options.stdin);
  const result = await waitForRuntimeProcess(instance);
  await Promise.race([
    Promise.allSettled([stdoutCapture.done, stderrCapture.done]),
    new Promise((resolve) => setTimeout(resolve, PROCESS_CAPTURE_DRAIN_TIMEOUT_MS)),
  ]);
  const stdout = stdoutCapture.output() || String(result.stdout || "");
  let finalCwd = cwd;
  let exitCode = Number(result.code || 0);
  try {
    const state = new TextDecoder()
      .decode(new Uint8Array(await commandDirectory.readFile(`/${stateName}`)))
      .trimEnd()
      .split("\u001f");
    finalCwd = displayWorkspacePaths(String(state[0] || runtimeCwd), workspaceRoot);
    exitCode = Number(state[1] || exitCode);
    await commandDirectory.removeFile(`/${stateName}`);
  } catch {
  }
  await synchronizeDirectory(directory, commandDirectory);
  const stderr = stripRuntimeExitNoise(stderrCapture.output() || result.stderr);
  return {
    exitCode,
    cwd: finalCwd,
    stdout,
    stderr,
    streamedOutput: streamOutput,
  };
}

function hasShellControlSyntax(source) {
  const value = String(source || "");
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (quote === '"' && (character === "$" || character === "`")) return true;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$" || character === "`" || character === ";" || character === "&"
      || character === "|" || character === "<" || character === ">"
      || character === "\n") {
      return true;
    }
  }
  return false;
}

function expandSimpleShellVariables(source, environment) {
  const input = String(source || "");
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (!quote) quote = character;
      else if (quote === character) quote = "";
      output += character;
      continue;
    }
    if (character !== "$" || quote === "'") {
      output += character;
      continue;
    }
    const braced = input[index + 1] === "{";
    const match = braced
      ? input.slice(index + 2).match(/^([A-Za-z_][A-Za-z0-9_]*)\}/)
      : input.slice(index + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!match) {
      output += character;
      continue;
    }
    output += String(environment?.[match[1]] ?? "");
    index += match[1].length + (braced ? 2 : 0);
  }
  return output;
}

async function runDirectRuntimeCommand({
  source,
  cwd,
  workspaceRoot,
  directory,
  posix,
  stdin = null,
  isolatedRuntime = true,
  streamOutput = true,
  streamStderr = true,
  skipAdapters = false,
  preferBusyBox = false,
  stdoutMode = "terminal",
}) {
  const expandedSource = expandSimpleShellVariables(source, {
    ...posix?.env,
    HOME: workspaceRoot,
    PWD: cwd,
  });
  if (hasShellControlSyntax(expandedSource)) return null;
  const words = parseSimpleShellWords(expandedSource);
  if (!words?.length) return null;
  const program = words[0].replace(/^.*\//, "");
  const explicitBusyBoxApplet = program === "busybox"
    && BUSYBOX_APPLET_NAMES.includes(String(words[1] || ""));
  if (explicitBusyBoxApplet) {
    return await runDirectRuntimeCommand({
      source: words.slice(1).map(shellQuote).join(" "),
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      isolatedRuntime,
      streamOutput,
      streamStderr,
      skipAdapters,
      preferBusyBox: true,
      stdoutMode,
    });
  }
  const installedBinary = preferBusyBox ? null : await readInstalledRuntimeBinary(posix, program);
  const metadata = posix?.installedCommands?.get(program);
  const hyperfineBinary = program === "hyperfine"
    ? await readInstalledRuntimeBinary(posix, "hyperfine-real")
    : null;
  if (
    !runtimeBinaries?.has(program)
    && !installedBinary
    && !hyperfineBinary
    && !BUSYBOX_APPLET_NAMES.includes(program)
  ) {
    return null;
  }
  if (!skipAdapters && program === "rsync" && installedBinary) {
    const adapted = await runLocalRsyncAdapter({ words, cwd, workspaceRoot, directory });
    if (adapted) return adapted;
  }
  if (!skipAdapters && program === "wc") {
    const adapted = await runWcAdapter({
      words,
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      streamOutput,
    });
    if (adapted) return adapted;
  }
  if (!skipAdapters && program === "cat") {
    const adapted = await runCatAdapter({
      words,
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      streamOutput,
    });
    if (adapted) return adapted;
  }
  if (!skipAdapters && (program === "head" || program === "tail")) {
    const adapted = await runHeadTailAdapter({
      words,
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      streamOutput,
    });
    if (adapted) return adapted;
  }
  if (!skipAdapters && program === "ls") {
    const adapted = await runLsAdapter({ words, cwd, workspaceRoot, directory, posix, streamOutput });
    if (adapted) return adapted;
  }
  if (!skipAdapters && program === "pwd") {
    return runPwdAdapter({ words, cwd, streamOutput });
  }
  if (!skipAdapters && program === "find") {
    const adapted = await runFindAdapter({ words, cwd, workspaceRoot, directory, streamOutput });
    if (adapted) return adapted;
  }
  if (!skipAdapters && program === "grep") {
    const adapted = await runGrepAdapter({ words, cwd, workspaceRoot, directory, posix, stdin, streamOutput });
    if (adapted) return adapted;
  }
  if (!skipAdapters && (metadata?.adapter === "hyperfine-direct" || hyperfineBinary)) {
    const argumentsList = words.slice(1);
    const usesExplicitShell = argumentsList.some((argument, index) => (
      argument === "--shell"
      || argument.startsWith("--shell=")
      || argument === "-S"
      || (argument.startsWith("-S") && index < argumentsList.length)
    ));
    const command = [
      "hyperfine-real",
      ...(usesExplicitShell ? [] : ["--shell=none"]),
      ...argumentsList,
    ].map((word) => shellQuote(word)).join(" ");
    return await runDirectRuntimeCommand({
      source: command,
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      isolatedRuntime,
      streamOutput,
      skipAdapters: true,
      stdoutMode,
    });
  }
  if (!skipAdapters && metadata?.adapter === "yamlfmt-stdin") {
    return await runYamlfmtStdinAdapter({
      words,
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      streamOutput,
    });
  }
  if (!preferBusyBox && posix?.packageScripts?.[program]) {
    return null;
  }
  post("progress", { phase: "execute", message: `Starting ${program}...` });
  const env = {
    ...posix.env,
    ...(metadata?.env || {}),
    HOME: WORKSPACE_RUNTIME_ROOT,
    PWD: WORKSPACE_RUNTIME_ROOT,
    PATH: `/usr/local/bin:/usr/local/sbin:/.edgeterm-bin:${String(posix.env?.PATH || "/usr/bin:/bin")}`,
    ...(stdin === null ? {} : { EDGETERM_STDIN_MODE: "pipe" }),
    ...(stdoutMode === "terminal" ? {} : { EDGETERM_STDOUT_MODE: stdoutMode }),
  };
  const mount = { ...posix.mounts };
  delete mount[workspaceRoot];
  mountWorkspaceDirectory(mount, directory, workspaceRoot);
  const commandMount = mountsForForegroundCommand({ ...posix, mounts: mount }, program);
  const directRuntimeRoot = WORKSPACE_RUNTIME_ROOT;
  const directArgs = rewriteDirectRuntimeArguments(
      program,
      words.slice(1),
      cwd,
      workspaceRoot,
      directRuntimeRoot,
      preferBusyBox,
    );
  let directCwd = absoluteWorkspacePath(cwd, cwd, workspaceRoot, directRuntimeRoot);
  env.PWD = directCwd;
  if (["ash", "bash", "dash", "sh"].includes(program)) {
    const commandIndex = directArgs.indexOf("-c");
    if (commandIndex >= 0 && directArgs[commandIndex + 1]) {
      directArgs[commandIndex + 1] = `cd ${shellQuote(directRuntimeRoot)} || exit $?; ${String(directArgs[commandIndex + 1]).split(workspaceRoot).join(directRuntimeRoot)}`;
      directCwd = "/";
    }
  }
  const options = {
    args: directArgs,
    cwd: directCwd,
    env,
    mount: commandMount,
    stdin: stdin === null
      ? new Uint8Array()
      : stdin instanceof Uint8Array
        ? stdin
        : String(stdin),
  };
  const commandRuntime = isolatedRuntime && !BUSYBOX_APPLET_NAMES.includes(program)
    ? await getSharedCommandRuntime(mount)
    : null;
  if (commandRuntime) options.runtime = commandRuntime;
  let instance;
  if (installedBinary) {
    const command = await getInstalledRuntimeCommand(program, installedBinary);
    instance = await command.run(options);
  } else if (BUSYBOX_APPLET_NAMES.includes(program)) {
    instance = await runWasix(runtimeBinaries.get("busybox"), {
      ...options,
      program: "busybox",
      args: [program, ...options.args],
    });
  } else {
    instance = await runPackagedCommand(program, options);
  }
  const stdoutCapture = startProcessStreamCapture(instance.stdout, (data) => {
    const visibleData = displayWorkspacePaths(data, workspaceRoot);
    if (streamOutput) post("interactive-output", { sessionId: "", stream: "stdout", data: visibleData });
  });
  const stderrCapture = startProcessStreamCapture(instance.stderr, (data) => {
    const visibleData = stripRuntimeExitNoise(displayWorkspacePaths(data, workspaceRoot));
    if (streamOutput && streamStderr) post("interactive-output", { sessionId: "", stream: "stderr", data: visibleData });
  });
  await closeProcessStdin(instance, options.stdin);
  post("progress", { phase: "execute", message: `${program} is running...` });
  const result = await waitForRuntimeProcess(instance);
  const drainTimeout = streamOutput
    ? PROCESS_STREAM_DRAIN_TIMEOUT_MS
    : PROCESS_CAPTURE_DRAIN_TIMEOUT_MS;
  await Promise.race([
    Promise.allSettled([stdoutCapture.done, stderrCapture.done]),
    new Promise((resolve) => setTimeout(resolve, drainTimeout)),
  ]);
  const streamedStdout = stdoutCapture?.output() || "";
  const streamedStdoutBytes = stdoutCapture?.bytes() || new Uint8Array();
  const streamedStderr = stderrCapture?.output() || "";
  const resultStdout = String(result.stdout || "");
  const resultStderr = stripRuntimeExitNoise(result.stderr);
  if (streamOutput && !streamedStdout && resultStdout) {
    post("interactive-output", {
      sessionId: "",
      stream: "stdout",
      data: displayWorkspacePaths(resultStdout, workspaceRoot),
    });
  }
  if (streamOutput && streamStderr && !streamedStderr && resultStderr) {
    post("interactive-output", {
      sessionId: "",
      stream: "stderr",
      data: displayWorkspacePaths(resultStderr, workspaceRoot),
    });
  }
  await Promise.allSettled([stdoutCapture.cancel(), stderrCapture.cancel()]);
  await Promise.race([
    Promise.allSettled([stdoutCapture.done, stderrCapture.done]),
    new Promise((resolve) => setTimeout(resolve, PROCESS_STREAM_CANCEL_TIMEOUT_MS)),
  ]);
  const exitCode = Number(result.code || 0);
  const stdout = streamedStdout || resultStdout;
  const stdoutBytes = streamedStdoutBytes.byteLength
    ? streamedStdoutBytes
    : new TextEncoder().encode(resultStdout);
  let stderr = streamedStderr || resultStderr;
  if (exitCode !== 0 && !stdout && !stderr && !new Set(["[", "false", "test"]).has(program)) {
    stderr = `${program}: exited with status ${exitCode}\n`;
    if (streamOutput && streamStderr) {
      post("interactive-output", {
        sessionId: "",
        stream: "stderr",
        data: stderr,
      });
    }
  }
  try {
    instance.free();
  } catch {
  }
  return {
    exitCode,
    cwd,
    stdout: displayWorkspacePaths(stdout, workspaceRoot),
    stdoutBytes,
    stderr: displayWorkspacePaths(stderr, workspaceRoot),
    streamedOutput: streamOutput,
  };
}

async function runYamlfmtStdinAdapter({
  words,
  cwd,
  workspaceRoot,
  directory,
  posix,
  stdin = null,
  streamOutput = true,
}) {
  const argumentsList = words.slice(1);
  if (
    stdin !== null
    || !argumentsList.length
    || argumentsList.includes("-")
    || argumentsList.includes("/dev/stdin")
    || argumentsList.some((argument) => ["-h", "--help", "-version", "--version"].includes(argument))
  ) {
    return await runDirectRuntimeCommand({
      source: words.map(shellQuote).join(" "),
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      streamOutput,
      skipAdapters: true,
    });
  }

  const flags = [];
  const paths = [];
  const valueFlags = new Set([
    "-conf", "-debug", "-exclude", "-extensions", "-formatter",
    "-gitignore_path", "-match_type", "-output_format",
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument.startsWith("-")) {
      flags.push(argument);
      if (valueFlags.has(argument) && index + 1 < argumentsList.length) {
        flags.push(argumentsList[index + 1]);
        index += 1;
      }
      continue;
    }
    paths.push(argument);
  }
  if (!paths.length) {
    return await runDirectRuntimeCommand({
      source: words.map(shellQuote).join(" "),
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      streamOutput,
      skipAdapters: true,
    });
  }
  if (paths.some((path) => /[*?\[\]{}]/.test(path))) {
    return {
      exitCode: 2,
      cwd,
      stdout: "",
      stderr: "yamlfmt: glob paths are not available in this runtime; pass explicit file paths\n",
      streamedOutput: false,
    };
  }

  const doesNotWrite = flags.some((flag) => ["-dry", "-lint", "-print_conf"].includes(flag));
  let stdout = "";
  let stderr = "";
  for (const path of paths) {
    const relative = workspaceRelativePath(path, cwd, workspaceRoot);
    if (relative === null || !relative) {
      return {
        exitCode: 2,
        cwd,
        stdout,
        stderr: `${stderr}yamlfmt: ${path}: path is outside the workspace\n`,
        streamedOutput: false,
      };
    }
    let input;
    try {
      input = new TextDecoder().decode(await directory.readFile(`/${relative}`));
    } catch {
      return {
        exitCode: 1,
        cwd,
        stdout,
        stderr: `${stderr}yamlfmt: ${path}: file not found\n`,
        streamedOutput: false,
      };
    }
    const result = await runDirectRuntimeCommand({
      source: ["yamlfmt", ...flags, "-"].map(shellQuote).join(" "),
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin: input,
      streamOutput: false,
      skipAdapters: true,
    });
    stdout += String(result?.stdout || "");
    stderr += String(result?.stderr || "");
    if (!result || Number(result.exitCode || 0) !== 0) {
      return {
        exitCode: Number(result?.exitCode || 1),
        cwd,
        stdout,
        stderr,
        streamedOutput: false,
      };
    }
    if (!doesNotWrite) {
      await directory.writeFile(`/${relative}`, new TextEncoder().encode(String(result.stdout || "")));
      stdout = "";
    }
  }
  if (streamOutput) {
    if (stdout) post("interactive-output", { sessionId: "", stream: "stdout", data: stdout });
    if (stderr) post("interactive-output", { sessionId: "", stream: "stderr", data: stderr });
  }
  return { exitCode: 0, cwd, stdout, stderr, streamedOutput: streamOutput };
}

async function runFlexM4Adapter({ source, cwd, workspaceRoot, directory, posix, stdin = null }) {
  const words = parseSimpleShellWords(source);
  const program = String(words?.[0] || "").replace(/^.*\//, "");
  const metadata = posix?.installedCommands?.get(program);
  if (!words?.length || metadata?.adapter !== "flex-m4") return null;

  const argumentsList = words.slice(1);
  if (argumentsList.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))) {
    return await runDirectRuntimeCommand({
      source: ["flex-real", ...argumentsList].map(shellQuote).join(" "),
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin,
      isolatedRuntime: true,
    });
  }

  let outputPath = program === "flex++" ? "lex.yy.cc" : "lex.yy.c";
  let writesStdout = false;
  const scannerArguments = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "-o" || argument === "--outfile") {
      if (index + 1 >= argumentsList.length) {
        return { exitCode: 2, cwd, stdout: "", stderr: `${program}: option requires an argument: ${argument}\n` };
      }
      outputPath = argumentsList[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--outfile=")) {
      outputPath = argument.slice("--outfile=".length);
      continue;
    }
    if (argument.startsWith("-o") && argument.length > 2) {
      outputPath = argument.slice(2);
      continue;
    }
    if (argument === "-t" || argument === "--stdout") {
      writesStdout = true;
      continue;
    }
    scannerArguments.push(argument);
  }
  if (program === "flex++" && !scannerArguments.includes("-+")) scannerArguments.unshift("-+");

  const intermediatePath = `.edgeterm-flex-${crypto.randomUUID()}.m4`;
  const scanner = await runDirectRuntimeCommand({
    source: ["flex-real", "--preproc=0", "-o", intermediatePath, ...scannerArguments].map(shellQuote).join(" "),
    cwd,
    workspaceRoot,
    directory,
    posix,
    stdin,
    isolatedRuntime: false,
    streamOutput: false,
  });
  if (!scanner || scanner.exitCode !== 0) return scanner;

  const processed = await runDirectRuntimeCommand({
    source: ["m4", "-P", intermediatePath].map(shellQuote).join(" "),
    cwd,
    workspaceRoot,
    directory,
    posix,
    stdin: null,
    isolatedRuntime: false,
    streamOutput: writesStdout,
  });
  try {
    const relativeIntermediate = workspaceRelativePath(intermediatePath, cwd, workspaceRoot);
    if (relativeIntermediate) await directory.removeFile(`/${relativeIntermediate}`);
  } catch {
  }
  if (!processed) return null;
  processed.stderr = `${scanner.stderr || ""}${processed.stderr || ""}`;
  if (processed.exitCode !== 0 || writesStdout) return processed;

  const relativeOutput = workspaceRelativePath(outputPath, cwd, workspaceRoot);
  if (relativeOutput === null || !relativeOutput) {
    return { exitCode: 2, cwd, stdout: "", stderr: `${program}: output path is outside the workspace\n` };
  }
  const parent = relativeOutput.split("/").slice(0, -1).join("/");
  if (parent) await ensureDirectory(directory, parent);
  await directory.writeFile(`/${relativeOutput}`, new TextEncoder().encode(String(processed.stdout || "")));
  processed.stdout = "";
  return processed;
}

function commandSubstitutionEnd(source, start) {
  let depth = 1;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function commandSubstitutionValue(value, quote) {
  const normalized = String(value || "").replace(/\n+$/, "");
  if (quote === '"') {
    return normalized.replace(/([\\"$`])/g, "\\$1");
  }
  if (!normalized) return "";
  return normalized.split(/[ \t\r\n]+/).filter(Boolean).map(shellQuote).join(" ");
}

async function expandCommandSubstitutions({
  source,
  cwd,
  workspaceRoot,
  directory,
  posix,
  configUrl,
  depth = 0,
}) {
  if (depth > 8) {
    throw runtimeError(
      "external_shell_substitution_depth",
      "Command substitution nesting exceeds the supported depth.",
      false,
    );
  }
  const input = String(source || "");
  let output = "";
  let stderr = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      output += character;
      escaped = true;
      continue;
    }
    if (quote === "'") {
      output += character;
      if (character === "'") quote = "";
      continue;
    }
    if (character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? "" : '"';
      output += character;
      continue;
    }
    if (character !== "$" || input[index + 1] !== "(" || input[index + 2] === "(") {
      output += character;
      continue;
    }
    const end = commandSubstitutionEnd(input, index + 2);
    if (end < 0) {
      throw runtimeError(
        "external_shell_substitution_unclosed",
        "Command substitution is missing a closing parenthesis.",
        false,
      );
    }
    const nested = await runCommand({
      configUrl,
      source: input.slice(index + 2, end),
      cwd,
      workspaceRoot,
      files: [],
      streamOutput: false,
      captureChanges: false,
      substitutionDepth: depth + 1,
      preparedRuntime: { posix, directory },
    });
    stderr += String(nested.stderr || "");
    output += commandSubstitutionValue(nested.stdout, quote);
    index = end;
  }
  return { source: output, stderr };
}

async function runCommand(payload) {
  await prepareRuntime(payload.configUrl);
  const workspaceRoot = String(payload.workspaceRoot || "/home/user");
  const cwd = String(payload.cwd || workspaceRoot);
  let source = String(payload.source || "");
  const streamOutput = payload.streamOutput !== false;
  const captureChanges = payload.captureChanges !== false;
  const preparedRuntime = payload.preparedRuntime || null;
  const posix = preparedRuntime?.posix || await createPosixRuntime({
    workspaceRoot,
    command: source || "ash",
    files: payload.files,
    systemMounts: payload.systemMounts,
    packageArchivePaths: payload.packageArchivePaths,
    systemMountCacheKey: payload.systemMountCacheKey,
  });
  let directory = preparedRuntime?.directory || posix.directory;
  const before = captureChanges
    ? (preparedRuntime?.before || await snapshotRuntimeWorkspace(directory, posix.temporaryDirectory))
    : null;
  const systemBefore = captureChanges
    ? (preparedRuntime?.systemBefore || await snapshotSystemDirectories(posix.systemDirectories))
    : null;
  const sequence = splitSimpleCommandSequence(source);
  const compoundShellProgram = isCompoundShellProgram(source);
  let substitutionStderr = "";
  const expandsBeforeCompoundExecution = /^\s*case\b/.test(source)
    || (compoundShellProgram && /\$\((?!\()|`/.test(source));
  if (!sequence && (!compoundShellProgram || expandsBeforeCompoundExecution)) {
    const substitution = await expandCommandSubstitutions({
      source,
      cwd,
      workspaceRoot,
      directory,
      posix,
      configUrl: payload.configUrl,
      depth: Number(payload.substitutionDepth || 0),
    });
    source = substitution.source;
    substitutionStderr = substitution.stderr;
  }
  post("progress", { phase: "filesystem", message: "The command filesystem is ready." });
  post("progress", { phase: "execute", message: "Starting the command..." });
  let processResult = null;
  let pipeline = null;
  let stderr = substitutionStderr;
  if (sequence) {
    let sequenceStdout = "";
    let sequenceStderr = "";
    let sequenceCwd = cwd;
    let sequenceExitCode = 0;
    let sequenceStreamedOutput = false;
    for (const entry of sequence) {
      if (entry.operator === "&&" && sequenceExitCode !== 0) continue;
      if (entry.operator === "||" && sequenceExitCode === 0) continue;
      const result = await runCommand({
        configUrl: payload.configUrl,
        source: expandShellLastStatus(entry.source, sequenceExitCode),
        cwd: sequenceCwd,
        workspaceRoot,
        files: [],
        streamOutput,
        captureChanges: false,
        preparedRuntime: { posix, directory },
      });
      if (streamOutput) {
        sequenceStreamedOutput = true;
        if (!result.streamedOutput && result.stdout) {
          post("interactive-output", { sessionId: "", stream: "stdout", data: result.stdout });
        }
        if (!result.streamedOutput && result.stderr) {
          post("interactive-output", { sessionId: "", stream: "stderr", data: result.stderr });
        }
      } else {
        sequenceStdout += String(result.stdout || "");
        sequenceStderr += String(result.stderr || "");
      }
      sequenceCwd = await resolveAvailableCommandCwd(
        String(result.cwd || sequenceCwd),
        workspaceRoot,
        posix,
        directory,
      );
      sequenceExitCode = Number(result.exitCode || 0);
    }
    processResult = {
      exitCode: sequenceExitCode,
      cwd: sequenceCwd,
      stdout: sequenceStdout,
      stderr: sequenceStderr,
      streamedOutput: sequenceStreamedOutput,
    };
  } else {
    const parsedRedirection = compoundShellProgram ? null : parseSimpleRedirection(source);
    const redirectionProgram = String(parsedRedirection?.words?.[0] || "").replace(/^.*\//, "");
    const redirectionBinary = parsedRedirection
      ? await readInstalledRuntimeBinary(posix, redirectionProgram)
      : null;
    const redirection = parsedRedirection
      && (
        redirectionBinary
        || runtimeBinaries?.has(redirectionProgram)
        || BUSYBOX_APPLET_NAMES.includes(redirectionProgram)
      )
      ? parsedRedirection
      : null;
    pipeline = redirection ? null : splitSimplePipeline(source);
    let pipelineInput = null;
    if (redirection) {
    if (redirection.input !== null) {
      const inputTarget = writableRuntimeTarget(
        redirection.input,
        cwd,
        workspaceRoot,
        posix,
        directory,
      );
      if (!inputTarget) {
        throw runtimeError("external_shell_redirection_path_invalid", "The input path is outside the workspace.", false);
      }
      try {
        pipelineInput = new Uint8Array(await inputTarget.directory.readFile(`/${inputTarget.path}`));
      } catch {
        throw runtimeError("external_shell_redirection_input_missing", `The input file does not exist: ${redirection.input}`, false);
      }
    }
    const explicitBusyBoxApplet = redirectionProgram === "busybox"
      && BUSYBOX_APPLET_NAMES.includes(String(redirection.words[1] || ""));
    const redirectionWords = explicitBusyBoxApplet
      ? redirection.words.slice(1)
      : redirection.words;
    processResult = await runDirectRuntimeCommand({
      source: redirectionWords.map(shellQuote).join(" "),
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin: pipelineInput,
      streamOutput: streamOutput && redirection.output === null,
      streamStderr: redirection.errorOutput === null,
      preferBusyBox: explicitBusyBoxApplet
        || (!redirectionBinary && BUSYBOX_APPLET_NAMES.includes(redirectionProgram)),
      stdoutMode: redirection.output === null ? "terminal" : "pipe",
    });
    if (processResult && redirection.output !== null) {
      if (redirection.output !== "/dev/null") {
        const outputTarget = writableRuntimeTarget(
          redirection.output,
          cwd,
          workspaceRoot,
          posix,
          directory,
        );
        if (!outputTarget) {
          throw runtimeError("external_shell_redirection_path_invalid", "The output path is outside the workspace.", false);
        }
        const bytes = processResult.stdoutBytes instanceof Uint8Array
          ? processResult.stdoutBytes
          : new TextEncoder().encode(String(processResult.stdout || ""));
        await writeRuntimeTargetBytes(outputTarget, bytes, redirection.append);
      }
      processResult.stdout = "";
    }
    if (processResult && redirection.errorOutput !== null) {
      if (redirection.errorOutput !== "/dev/null") {
        const errorTarget = writableRuntimeTarget(
          redirection.errorOutput,
          cwd,
          workspaceRoot,
          posix,
          directory,
        );
        if (!errorTarget) {
          throw runtimeError("external_shell_redirection_path_invalid", "The error output path is outside the workspace.", false);
        }
        await writeRuntimeTargetBytes(
          errorTarget,
          new TextEncoder().encode(String(processResult.stderr || "")),
          redirection.errorAppend,
        );
      }
      processResult.stderr = "";
    }
    }
    const segments = redirection ? [] : (pipeline || [source]);
    for (let index = 0; index < segments.length; index += 1) {
    const segmentSource = segments[index];
    const segmentRedirection = compoundShellProgram ? null : parseSimpleRedirection(segmentSource);
    const segmentProgram = String(segmentRedirection?.words?.[0] || "").replace(/^.*\//, "");
    const segmentBinary = segmentRedirection
      ? await readInstalledRuntimeBinary(posix, segmentProgram)
      : null;
    const supportedSegmentRedirection = segmentRedirection
      && (
        segmentBinary
        || runtimeBinaries?.has(segmentProgram)
        || BUSYBOX_APPLET_NAMES.includes(segmentProgram)
      )
      ? segmentRedirection
      : null;
    let segmentInput = pipelineInput;
    if (supportedSegmentRedirection?.input !== null && supportedSegmentRedirection?.input !== undefined) {
      const inputTarget = writableRuntimeTarget(
        supportedSegmentRedirection.input,
        cwd,
        workspaceRoot,
        posix,
        directory,
      );
      if (!inputTarget) {
        throw runtimeError("external_shell_redirection_path_invalid", "The input path is outside the workspace.", false);
      }
      try {
        segmentInput = new Uint8Array(await inputTarget.directory.readFile(`/${inputTarget.path}`));
      } catch {
        throw runtimeError(
          "external_shell_redirection_input_missing",
          `The input file does not exist: ${supportedSegmentRedirection.input}`,
          false,
        );
      }
    }
    if (supportedSegmentRedirection) {
      const explicitBusyBoxApplet = segmentProgram === "busybox"
        && BUSYBOX_APPLET_NAMES.includes(String(supportedSegmentRedirection.words[1] || ""));
      const segmentWords = explicitBusyBoxApplet
        ? supportedSegmentRedirection.words.slice(1)
        : supportedSegmentRedirection.words;
      processResult = await runDirectRuntimeCommand({
        source: segmentWords.map(shellQuote).join(" "),
        cwd,
        workspaceRoot,
        directory,
        posix,
        stdin: segmentInput,
        streamOutput: streamOutput
          && (!pipeline || index === segments.length - 1)
          && supportedSegmentRedirection.output === null,
        streamStderr: supportedSegmentRedirection.errorOutput === null,
        preferBusyBox: explicitBusyBoxApplet
          || (!segmentBinary && BUSYBOX_APPLET_NAMES.includes(segmentProgram)),
        stdoutMode: pipeline && index < segments.length - 1 ? "pipe" : "terminal",
      });
      if (processResult && supportedSegmentRedirection.output !== null) {
        if (supportedSegmentRedirection.output !== "/dev/null") {
          const outputTarget = writableRuntimeTarget(
            supportedSegmentRedirection.output,
            cwd,
            workspaceRoot,
            posix,
            directory,
          );
          if (!outputTarget) {
            throw runtimeError("external_shell_redirection_path_invalid", "The output path is outside the workspace.", false);
          }
          const bytes = processResult.stdoutBytes instanceof Uint8Array
            ? processResult.stdoutBytes
            : new TextEncoder().encode(String(processResult.stdout || ""));
          await writeRuntimeTargetBytes(outputTarget, bytes, supportedSegmentRedirection.append);
        }
        processResult.stdout = "";
        processResult.stdoutBytes = new Uint8Array();
      }
      if (processResult && supportedSegmentRedirection.errorOutput !== null) {
        if (supportedSegmentRedirection.errorOutput !== "/dev/null") {
          const errorTarget = writableRuntimeTarget(
            supportedSegmentRedirection.errorOutput,
            cwd,
            workspaceRoot,
            posix,
            directory,
          );
          if (!errorTarget) {
            throw runtimeError("external_shell_redirection_path_invalid", "The error output path is outside the workspace.", false);
          }
          await writeRuntimeTargetBytes(
            errorTarget,
            new TextEncoder().encode(String(processResult.stderr || "")),
            supportedSegmentRedirection.errorAppend,
          );
        }
        processResult.stderr = "";
      }
    } else {
    const segmentWords = parseSimpleShellWords(segmentSource);
    processResult = segmentWords?.[0] === "cd"
      ? await runCdAdapter({
          words: segmentWords,
          cwd,
          workspaceRoot,
          directory,
          posix,
        })
      : null;
    processResult ||= await runTemporaryMutationAdapter({
      words: segmentWords,
      cwd,
      workspaceRoot,
      directory,
      posix,
    });
    processResult ||= await runLocalFileMutationAdapter({
      words: segmentWords,
      cwd,
      workspaceRoot,
      directory,
    });
    processResult ||= await runFlexM4Adapter({
      source: segmentSource,
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin: pipelineInput,
    });
    processResult ||= await runDirectRuntimeCommand({
      source: segmentSource,
      cwd,
      workspaceRoot,
      directory,
      posix,
      stdin: pipelineInput,
      streamOutput: streamOutput && (!pipeline || index === segments.length - 1),
      stdoutMode: pipeline && index < segments.length - 1 ? "pipe" : "terminal",
    });
    if (!processResult) {
      processResult = await runBufferedPipelineAdapter({
        source: segments[index],
        stdin: pipelineInput,
        cwd,
        workspaceRoot,
        directory,
      });
    }
    if (!processResult && index > 0) {
      directory = await createWorkspaceFromSnapshot(await snapshotDirectory(directory));
      posix.directory = directory;
      mountWorkspaceDirectory(posix.mounts, directory, workspaceRoot);
    }
    processResult ||= await runShellProcess({
        source: segmentSource,
        cwd,
        workspaceRoot,
        directory,
        posix,
        stdin: pipelineInput,
        streamOutput: streamOutput && (!pipeline || index === segments.length - 1),
        stdoutMode: pipeline && index < segments.length - 1 ? "pipe" : "terminal",
      });
    }
    stderr += processResult.stderr;
    if (processResult.exitCode !== 0) break;
    pipelineInput = processResult.stdoutBytes || processResult.stdout;
    const pipelineByteLength = pipelineInput instanceof Uint8Array
      ? pipelineInput.byteLength
      : new TextEncoder().encode(String(pipelineInput || "")).byteLength;
    if (pipelineByteLength > 16 * 1024 * 1024) {
      throw runtimeError(
        "external_shell_pipeline_output_limit",
        "The pipeline produced more than 16 MiB of intermediate output.",
      );
    }
    }
  }
  const stdout = processResult?.stdout || "";
  const finalCwd = pipeline ? cwd : String(processResult?.cwd || cwd);
  const exitCode = Number(processResult?.exitCode || 0);
  let changes = [];
  let systemChanges = [];
  if (captureChanges) {
    post("progress", { phase: "snapshot-workspace", message: "Checking workspace changes..." });
    const after = await snapshotRuntimeWorkspace(directory, posix.temporaryDirectory);
    changes = diffSnapshots(before, after);
    post("progress", { phase: "snapshot-system", message: "Checking package changes..." });
    const system = await diffSystemDirectories(systemBefore, posix.systemDirectories);
    systemChanges = system.changes;
  }
  const installedCommands = await readInstalledCommandMetadata(posix.systemDirectories);
  post("progress", { phase: "complete", message: "The command finished." });
  return {
    exitCode,
    cwd: finalCwd,
    stdout,
    stderr,
    streamedOutput: Boolean(processResult?.streamedOutput),
    changes,
    systemChanges,
    changedFiles: changes.length,
    changedSystemFiles: systemChanges.reduce(
      (total, entry) => total + entry.changes.length,
      0,
    ),
    installedCommands: [...installedCommands.keys()],
  };
}

async function writeInteractiveText(session, value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    await session.stdinWriter.write(bytes.subarray(offset, offset + 64 * 1024));
  }
}

async function applyChangesThroughInteractiveShell(session, changes) {
  const deletions = (changes || [])
    .filter((entry) => entry.deleted)
    .sort((left, right) => String(right.path || "").split("/").length - String(left.path || "").split("/").length);
  const directories = (changes || [])
    .filter((entry) => entry.dir && !entry.deleted)
    .sort((left, right) => String(left.path || "").split("/").length - String(right.path || "").split("/").length);
  const files = (changes || []).filter((entry) => !entry.dir && !entry.deleted);
  const lines = [];

  for (const entry of deletions) {
    const relative = normalizeRelativePath(entry.path);
    if (!relative) continue;
    const target = `${session.workspaceRoot.replace(/\/+$/, "")}/${relative}`;
    lines.push(entry.dir ? `rm -rf -- ${shellQuote(target)}` : `rm -f -- ${shellQuote(target)}`);
  }
  for (const entry of directories) {
    const relative = normalizeRelativePath(entry.path);
    if (!relative) continue;
    const target = `${session.workspaceRoot.replace(/\/+$/, "")}/${relative}`;
    lines.push(`mkdir -p -- ${shellQuote(target)}`);
  }
  for (const entry of files) {
    const relative = normalizeRelativePath(entry.path);
    if (!relative) continue;
    const target = `${session.workspaceRoot.replace(/\/+$/, "")}/${relative}`;
    const parent = target.split("/").slice(0, -1).join("/") || session.workspaceRoot;
    const bytes = Uint8Array.from(atob(String(entry.data || "")), (character) => character.charCodeAt(0));
    lines.push(`mkdir -p -- ${shellQuote(parent)}`);
    lines.push(`: > ${shellQuote(target)}`);
    for (let offset = 0; offset < bytes.byteLength; offset += 4 * 1024) {
      const chunk = bytes.subarray(offset, offset + 4 * 1024);
      let encoded = "";
      for (const byte of chunk) encoded += `\\${byte.toString(8).padStart(3, "0")}`;
      lines.push(`printf '%b' '${encoded}' >> ${shellQuote(target)}`);
    }
  }
  if (!lines.length) return;
  await writeInteractiveText(session, `${lines.join("\n")}\n`);
  await queryInteractiveCwd(session);
}

async function runInteractiveFlexM4Adapter(payload, session, source) {
  const words = parseSimpleShellWords(source);
  const program = String(words?.[0] || "").replace(/^.*\//, "");
  const metadata = session.posix.installedCommands.get(program);
  if (!words?.length || metadata?.adapter !== "flex-m4") return null;

  const argumentsList = words.slice(1);
  if (argumentsList.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))) {
    const result = await runInteractiveCommandAndWait({
      ...payload,
      source: ["flex-real", ...argumentsList].map(shellQuote).join(" "),
    });
    return { ...result, cwd: session.cwd, stdout: "", stderr: "", streamedOutput: true };
  }

  let outputPath = program === "flex++" ? "lex.yy.cc" : "lex.yy.c";
  let writesStdout = false;
  const scannerArguments = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "-o" || argument === "--outfile") {
      if (index + 1 >= argumentsList.length) {
        return { exitCode: 2, cwd: session.cwd, stdout: "", stderr: `${program}: option requires an argument: ${argument}\n` };
      }
      outputPath = argumentsList[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--outfile=")) {
      outputPath = argument.slice("--outfile=".length);
      continue;
    }
    if (argument.startsWith("-o") && argument.length > 2) {
      outputPath = argument.slice(2);
      continue;
    }
    if (argument === "-t" || argument === "--stdout") {
      writesStdout = true;
      continue;
    }
    scannerArguments.push(argument);
  }
  if (program === "flex++" && !scannerArguments.includes("-+")) scannerArguments.unshift("-+");

  const intermediatePath = `.edgeterm-flex-${crypto.randomUUID()}.m4`;
  post("interactive-output", { sessionId: session.id, stream: "stderr", data: "[flex adapter: scanner]\n" });
  const scanner = await runInteractiveCommandAndWait({
    ...payload,
    source: ["flex-real", "--preproc=0", "-o", intermediatePath, ...scannerArguments].map(shellQuote).join(" "),
  });
  post("interactive-output", { sessionId: session.id, stream: "stderr", data: "[flex adapter: postprocess]\n" });
  if (Number(scanner.exitCode || 0) !== 0) return { ...scanner, cwd: session.cwd, stdout: "", stderr: "", streamedOutput: true };

  const m4Source = writesStdout
    ? ["m4", "-P", intermediatePath].map(shellQuote).join(" ")
    : `${["m4", "-P", intermediatePath].map(shellQuote).join(" ")} > ${shellQuote(outputPath)}`;
  const processed = await runInteractivePipeline({ ...payload, source: m4Source });
  post("interactive-output", { sessionId: session.id, stream: "stderr", data: "[flex adapter: complete]\n" });
  try {
    const relativeIntermediate = workspaceRelativePath(intermediatePath, session.cwd, session.workspaceRoot);
    if (relativeIntermediate) await session.directory.removeFile(`/${relativeIntermediate}`);
    session.baseline = await snapshotRuntimeWorkspace(session.directory, session.posix.temporaryDirectory);
  } catch {
  }
  return processed;
}

async function runInteractivePipeline(payload) {
  await prepareRuntime(payload.configUrl);
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The BusyBox ash session is no longer running.",
    );
  }
  const source = String(payload.source || "").trim();
  const commandCwd = String(payload.cwd || session.cwd || session.workspaceRoot);
  if (!source) {
    throw runtimeError(
      "external_shell_command_invalid",
      "The buffered shell command is empty.",
      false,
    );
  }

  post("progress", { phase: "pipeline-prepare", message: "Preparing the command pipeline..." });
  const operation = session.syncPromise
    .catch(() => {})
    .then(async () => {
      const before = session.baseline;
      const pipelineBefore = selectPipelineSnapshot(
        before,
        source,
        commandCwd,
        session.workspaceRoot,
      );
      const directory = await createWorkspaceFromSnapshot(pipelineBefore);
      const posix = {
        ...session.posix,
        mounts: { ...session.posix.mounts },
        systemDirectories: new Map(session.posix.systemDirectories || []),
        packageScripts: { ...(session.posix.packageScripts || {}) },
        installedCommands: new Map(session.posix.installedCommands || []),
      };
      posix.directory = directory;
      mountWorkspaceDirectory(posix.mounts, directory, session.workspaceRoot);

      post("progress", { phase: "pipeline-run", message: "Running the command pipeline..." });
      const result = await runCommand({
        configUrl: payload.configUrl,
        source,
        cwd: commandCwd,
        workspaceRoot: session.workspaceRoot,
        files: [],
        streamOutput: true,
        captureChanges: false,
        preparedRuntime: { posix, directory, before: pipelineBefore },
      });
      post("progress", { phase: "pipeline-apply", message: "Applying command changes..." });
      const pipelineAfter = await snapshotRuntimeWorkspace(directory, posix.temporaryDirectory);
      const pipelineChanges = diffSnapshots(pipelineBefore, pipelineAfter);
      await applySnapshotChanges(session.directory, pipelineChanges, pipelineAfter, pipelineBefore);
      post("progress", { phase: "pipeline-finish", message: "Finishing the command pipeline..." });
      applyChangesToSnapshot(session.baseline, pipelineChanges);
      return {
        exitCode: result.exitCode,
        cwd: String(result.cwd || commandCwd),
        stdout: result.stdout,
        stderr: result.stderr,
        streamedOutput: result.streamedOutput,
        changes: pipelineChanges,
        changedFiles: pipelineChanges.length,
      };
    });
  session.syncPromise = operation.then(() => []);
  return await operation;
}

async function pumpInteractiveStream(session, streamName, stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      const data = displayWorkspacePaths(
        decoder.decode(bytes, { stream: true }),
        session.workspaceRoot,
      );
      if (data) queueInteractiveOutput(session, streamName, data);
    }
    const tail = displayWorkspacePaths(decoder.decode(), session.workspaceRoot);
    if (tail) queueInteractiveOutput(session, streamName, tail);
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
}

async function pumpForegroundStream(session, streamName, stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      const data = displayWorkspacePaths(
        decoder.decode(bytes, { stream: true }),
        session.workspaceRoot,
      );
      if (data) {
        post("interactive-output", {
          sessionId: session.id,
          stream: streamName,
          data,
        });
      }
    }
    const tail = displayWorkspacePaths(decoder.decode(), session.workspaceRoot);
    if (tail) {
      post("interactive-output", {
        sessionId: session.id,
        stream: streamName,
        data: tail,
      });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }
}

function trailingControlFragment(text) {
  let fragment = "";
  for (const marker of [
    ASH_PROMPT_PREFIX,
    ASH_CONTINUATION_MARKER,
    ASH_CWD_QUERY_PREFIX,
    ASH_COMMAND_QUERY_PREFIX,
  ]) {
    const limit = Math.min(text.length, marker.length - 1);
    for (let length = limit; length > fragment.length; length -= 1) {
      const candidate = text.slice(-length);
      if (marker.startsWith(candidate)) {
        fragment = candidate;
        break;
      }
    }
  }
  return fragment;
}

function stripInteractiveInputEcho(session, streamName, data) {
  if (streamName !== "stdout") return String(data || "");
  let text = `${session.inputEchoRemainder || ""}${String(data || "")}`;
  session.inputEchoRemainder = "";
  if (session.skipInputEchoLineBreak) {
    if (/^(?:\r\n|\r|\n)/.test(text)) {
      text = text.replace(/^(?:\r\n|\r|\n)/, "");
    }
    session.skipInputEchoLineBreak = false;
  }
  while (session.pendingInputEchoes?.length) {
    const target = String(session.pendingInputEchoes[0] || "");
    const targetIndex = text.indexOf(target);
    if (targetIndex >= 0) {
      session.pendingInputEchoes.shift();
      session.skipInputEchoLineBreak = true;
      const remainder = `${text.slice(0, targetIndex)}${text.slice(targetIndex + target.length)}`;
      if (/^(?:\r\n|\r|\n)/.test(remainder.slice(targetIndex))) {
        session.skipInputEchoLineBreak = false;
        text = `${remainder.slice(0, targetIndex)}${remainder.slice(targetIndex).replace(/^(?:\r\n|\r|\n)/, "")}`;
        continue;
      }
      text = remainder;
      continue;
    }
    const limit = Math.min(text.length, target.length - 1);
    for (let length = limit; length > 0; length -= 1) {
      if (text.endsWith(target.slice(0, length))) {
        session.inputEchoRemainder = text.slice(-length);
        return text.slice(0, -length);
      }
    }
    return text;
  }
  return text;
}

function stripInteractiveControls(session, streamName, data) {
  let text = `${session.controlRemainders[streamName]}${stripInteractiveInputEcho(session, streamName, data)}`;
  let output = "";
  session.controlRemainders[streamName] = "";
  while (text) {
    const promptIndex = text.indexOf(ASH_PROMPT_PREFIX);
    const continuationIndex = text.indexOf(ASH_CONTINUATION_MARKER);
    const cwdQueryIndex = text.indexOf(ASH_CWD_QUERY_PREFIX);
    const commandQueryIndex = text.indexOf(ASH_COMMAND_QUERY_PREFIX);
    const indexes = [promptIndex, continuationIndex, cwdQueryIndex, commandQueryIndex]
      .filter((index) => index >= 0);
    if (!indexes.length) {
      const fragment = trailingControlFragment(text);
      output += fragment ? text.slice(0, -fragment.length) : text;
      session.controlRemainders[streamName] = fragment;
      break;
    }
    const index = Math.min(...indexes);
    output += text.slice(0, index);
    text = text.slice(index);
    if (text.startsWith(ASH_CONTINUATION_MARKER)) {
      text = text.slice(ASH_CONTINUATION_MARKER.length);
      continue;
    }
    if (text.startsWith(ASH_CWD_QUERY_PREFIX)) {
      const suffixIndex = text.indexOf(ASH_CWD_QUERY_SUFFIX, ASH_CWD_QUERY_PREFIX.length);
      if (suffixIndex < 0) {
        session.controlRemainders[streamName] = text;
        break;
      }
      const state = text.slice(ASH_CWD_QUERY_PREFIX.length, suffixIndex);
      const separator = state.indexOf(":");
      const queryId = separator >= 0 ? state.slice(0, separator) : "";
      const cwd = separator >= 0 ? state.slice(separator + 1) : "";
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        post("interactive-cwd", { sessionId: session.id, cwd });
      }
      const query = session.cwdQueries.get(queryId);
      if (query) {
        clearTimeout(query.timer);
        session.cwdQueries.delete(queryId);
        query.resolve(session.cwd);
      }
      text = text.slice(suffixIndex + ASH_CWD_QUERY_SUFFIX.length);
      continue;
    }
    if (text.startsWith(ASH_COMMAND_QUERY_PREFIX)) {
      const suffixIndex = text.indexOf(ASH_PROMPT_SUFFIX, ASH_COMMAND_QUERY_PREFIX.length);
      if (suffixIndex < 0) {
        session.controlRemainders[streamName] = text;
        break;
      }
      const state = text.slice(ASH_COMMAND_QUERY_PREFIX.length, suffixIndex);
      const firstSeparator = state.indexOf(":");
      const secondSeparator = firstSeparator >= 0 ? state.indexOf(":", firstSeparator + 1) : -1;
      const queryId = firstSeparator >= 0 ? state.slice(0, firstSeparator) : "";
      const exitCode = firstSeparator >= 0
        ? Number(state.slice(firstSeparator + 1, secondSeparator >= 0 ? secondSeparator : undefined))
        : 1;
      const cwd = secondSeparator >= 0 ? state.slice(secondSeparator + 1) : session.cwd;
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        post("interactive-cwd", { sessionId: session.id, cwd });
      }
      const query = session.commandQueries.get(queryId);
      if (query) {
        clearTimeout(query.timer);
        session.commandQueries.delete(queryId);
        if (session.foreground === query.foreground) session.foreground = null;
        const sync = query.foreground.syncFiles
          ? queueInteractiveSync(session)
          : Promise.resolve({ changedFiles: 0 });
        void sync.then((syncResult) => {
          query.resolve({
            sessionId: session.id,
            program: query.foreground.program,
            exitCode: Number.isFinite(exitCode) ? exitCode : 1,
            changedFiles: Number(syncResult?.changedFiles || 0),
            cwd: session.cwd,
          });
        }, query.reject);
      }
      text = text.slice(suffixIndex + ASH_PROMPT_SUFFIX.length);
      continue;
    }
    const suffixIndex = text.indexOf(ASH_PROMPT_SUFFIX, ASH_PROMPT_PREFIX.length);
    if (suffixIndex < 0) {
      session.controlRemainders[streamName] = text;
      break;
    }
    const cwd = text.slice(ASH_PROMPT_PREFIX.length, suffixIndex);
    if (cwd && cwd !== session.cwd) {
      session.cwd = cwd;
      post("interactive-cwd", { sessionId: session.id, cwd });
    }
    if (session.syncRequested) {
      session.syncRequested = false;
      void queueInteractiveSync(session).catch((error) => {
        post("interactive-error", {
          sessionId: session.id,
          error: errorDetails(error, "external_shell_sync_failed"),
        });
      });
    }
    text = text.slice(suffixIndex + ASH_PROMPT_SUFFIX.length);
  }
  return output;
}

function flushInteractiveOutput(session, streamName) {
  const data = stripInteractiveControls(session, streamName, session.outputBuffers[streamName]);
  session.outputBuffers[streamName] = "";
  session.outputTimers[streamName] = null;
  if (!data || session.suppressOutput) return;
  post("interactive-output", {
    sessionId: session.id,
    stream: streamName,
    data,
  });
}

function queueInteractiveOutput(session, streamName, data) {
  session.outputBuffers[streamName] += String(data || "");
  if (session.outputTimers[streamName]) return;
  session.outputTimers[streamName] = setTimeout(() => {
    flushInteractiveOutput(session, streamName);
  }, 16);
}

async function syncInteractiveDirectory(session, { includeSystem = false, emit = true } = {}) {
  const after = await snapshotRuntimeWorkspace(session.directory, session.posix.temporaryDirectory);
  const changes = diffSnapshots(session.baseline, after);
  session.baseline = after;
  const system = includeSystem
    ? await diffSystemDirectories(
      session.systemBaselines?.size
        ? session.systemBaselines
        : await snapshotSystemDirectories(session.posix.systemDirectories),
      session.posix.systemDirectories,
    )
    : { changes: [], snapshots: session.systemBaselines || new Map() };
  if (includeSystem) session.systemBaselines = system.snapshots;
  if (system.changes.length) {
    session.posix.installedCommands = await readInstalledCommandMetadata(
      session.posix.systemDirectories,
    );
    session.posix.packageScripts = await readInstalledPackageScripts(
      session.posix.systemDirectories,
      session.posix.installedCommands,
    );
  }
  if (emit && (changes.length || system.changes.length)) {
    post("interactive-sync", {
      sessionId: session.id,
      workspaceRoot: session.workspaceRoot,
      changes,
      systemChanges: system.changes,
      installedCommands: [...session.posix.installedCommands.keys()],
    });
  }
  return {
    changes,
    systemChanges: system.changes,
    changedFiles: changes.length + system.changes.reduce(
      (total, entry) => total + entry.changes.length,
      0,
    ),
  };
}

function queueInteractiveSync(session) {
  session.syncPromise = session.syncPromise
    .catch(() => {})
    .then(() => syncInteractiveDirectory(session));
  return session.syncPromise;
}

async function finalizeInteractiveSession(session) {
  if (session.finalizing) return await session.finished;
  session.finalizing = true;
  if (session.syncTimer) clearInterval(session.syncTimer);
  for (const query of session.cwdQueries.values()) {
    clearTimeout(query.timer);
    query.reject(runtimeError("external_shell_session_missing", "The BusyBox ash session is no longer running."));
  }
  session.cwdQueries.clear();
  for (const query of session.commandQueries.values()) {
    clearTimeout(query.timer);
    query.reject(runtimeError("external_shell_session_missing", "The BusyBox ash session is no longer running."));
  }
  session.commandQueries.clear();
  for (const streamName of ["stdout", "stderr"]) {
    if (session.outputTimers[streamName]) clearTimeout(session.outputTimers[streamName]);
    flushInteractiveOutput(session, streamName);
  }
  let syncError = null;
  try {
    if (session.syncRequested) {
      session.syncRequested = false;
      await queueInteractiveSync(session);
    } else {
      await session.syncPromise.catch(() => {});
    }
  } catch (error) {
    syncError = error;
    post("interactive-error", {
      sessionId: session.id,
      error: errorDetails(error, "external_shell_sync_failed"),
    });
  }
  try {
    session.stdinWriter.releaseLock();
  } catch {
  }
  try {
    session.instance.free();
  } catch {
  }
  const result = {
    sessionId: session.id,
    workspaceRoot: session.workspaceRoot,
    exitCode: syncError ? 1 : 0,
    synced: !syncError,
  };
  if (session.restarting) {
    session.resolveFinished({ ...result, restarting: true });
    return { ...result, restarting: true };
  }
  if (interactiveSession === session) interactiveSession = null;
  post("interactive-exit", result);
  session.resolveFinished(result);
  return result;
}

async function launchInteractiveProcess(session) {
  const instance = await runPackagedCommand("ash", {
    args: ["-c", `${posixBootstrapScript()}\nexec ash -il`],
    cwd: absoluteWorkspacePath(session.cwd, session.cwd, session.workspaceRoot),
    env: {
      ...session.posix.env,
      PS1: `${ASH_PROMPT_PREFIX}$PWD${ASH_PROMPT_SUFFIX}`,
      PS2: ASH_CONTINUATION_MARKER,
    },
    mount: { ...session.posix.mounts },
  });
  if (!instance.stdin) {
    try {
      instance.free();
    } catch {
    }
    throw runtimeError(
      "external_shell_stdin_unavailable",
      "The BusyBox ash process did not provide a writable stdin stream.",
    );
  }
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  Object.assign(session, {
    instance,
    stdinWriter: instance.stdin.getWriter(),
    finalizing: false,
    restarting: false,
    controlRemainders: { stdout: "", stderr: "" },
    outputBuffers: { stdout: "", stderr: "" },
    outputTimers: { stdout: null, stderr: null },
    suppressOutput: false,
    pendingInputEchoes: [],
    inputEchoRemainder: "",
    skipInputEchoLineBreak: false,
    finished,
    resolveFinished,
  });
  Promise.all([
    pumpInteractiveStream(session, "stdout", instance.stdout),
    pumpInteractiveStream(session, "stderr", instance.stderr),
  ])
    .catch((error) => {
      post("interactive-error", {
        sessionId: session.id,
        error: errorDetails(error, "external_shell_stream_failed"),
      });
    })
    .finally(() => {
      void finalizeInteractiveSession(session);
    });
}

async function startInteractiveSession(payload) {
  await prepareRuntime(payload.configUrl);
  if (interactiveSession) {
    throw runtimeError(
      "external_shell_session_exists",
      "A BusyBox ash session is already running.",
      false,
    );
  }
  const workspaceRoot = String(payload.workspaceRoot || "/home/user");
  const cwd = String(payload.cwd || workspaceRoot);
  const posix = await createPosixRuntime({
    workspaceRoot,
    command: "ash",
    files: payload.files,
    systemMounts: payload.systemMounts,
    packageArchivePaths: payload.packageArchivePaths,
  });
  const directory = posix.directory;
  await prepareMountedDirectoryPermissions(directory);
  const baseline = await snapshotRuntimeWorkspace(directory, posix.temporaryDirectory);
  const systemBaselines = new Map();
  const session = {
    id: crypto.randomUUID(),
    directory,
    posix,
    baseline,
    systemBaselines,
    workspaceRoot,
    systemMounts: Array.isArray(payload.systemMounts) ? payload.systemMounts : [],
    cwd,
    syncPromise: Promise.resolve([]),
    syncTimer: null,
    syncRequested: false,
    finalizing: false,
    restarting: false,
    controlRemainders: { stdout: "", stderr: "" },
    outputBuffers: { stdout: "", stderr: "" },
    outputTimers: { stdout: null, stderr: null },
    pendingInputEchoes: [],
    inputEchoRemainder: "",
    skipInputEchoLineBreak: false,
    cwdQueries: new Map(),
    commandQueries: new Map(),
    instance: null,
    stdinWriter: null,
    foreground: null,
    finished: null,
    resolveFinished: null,
  };
  interactiveSession = session;
  await launchInteractiveProcess(session);
  return {
    sessionId: session.id,
    workspaceRoot,
    cwd,
    running: true,
    installedCommands: [...session.posix.installedCommands.keys()],
  };
}

async function writeInteractiveInput(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The BusyBox ash session is no longer running.",
    );
  }
  const data = String(payload.data ?? "");
  if (payload.syncFiles) session.syncRequested = true;
  if (data) {
    const foreground = session.foreground;
    if (foreground && data.includes("\u0003")) {
      foreground.superseded = true;
      try {
        foreground.instance.free();
      } catch {
      }
      try {
        foreground.stdinWriter?.releaseLock();
      } catch {
      }
      if (session.foreground === foreground) session.foreground = null;
      let syncResult = null;
      try {
        syncResult = await syncInteractiveDirectory(session, {
          includeSystem: foreground.changesSystemPackages,
        });
      } catch (error) {
        post("interactive-error", {
          sessionId: session.id,
          error: errorDetails(error, "external_shell_sync_failed"),
        });
      }
      const completionResult = {
        sessionId: session.id,
        program: foreground.program,
        exitCode: 130,
        interrupted: true,
        changedFiles: Number(syncResult?.changedFiles || 0),
      };
      foreground.resolveCompletion(completionResult);
      post("interactive-command-exit", completionResult);
      return {
        sessionId: session.id,
        accepted: true,
        interrupted: true,
        bytes: 1,
      };
    }
    const confirmation = data.replace(/\r\n?|\n/g, "\n");
    if (
      foreground
      && !foreground.shellManaged
      && ["apt", "apt-get"].includes(foreground.program)
      && /^y\n$/i.test(confirmation)
    ) {
      foreground.superseded = true;
      try {
        foreground.instance.free();
      } catch {
      }
      session.foreground = null;
      const confirmed = [foreground.program, ...foreground.args, "-y"]
        .map((word) => shellQuote(word))
        .join(" ");
      await startInteractiveCommand({ sessionId: session.id, source: confirmed });
      const replacement = session.foreground;
      if (!replacement?.completion) {
        foreground.rejectCompletion(runtimeError(
          "external_shell_command_restart_failed",
          "The confirmed package operation did not start.",
        ));
      } else {
        replacement.completion.then(
          foreground.resolveCompletion,
          foreground.rejectCompletion,
        );
      }
      return {
        sessionId: session.id,
        accepted: true,
        confirmed: true,
        bytes: new TextEncoder().encode(data).byteLength,
      };
    }
    const writer = foreground?.stdinWriter || session.stdinWriter;
    const input = foreground ? confirmation : data;
    await writer.write(new TextEncoder().encode(input));
    if (foreground && !foreground.shellManaged && /^n\n$/i.test(input)) {
      await writer.close();
      foreground.stdinWriter = null;
    }
  }
  if (payload.syncCwd) await queryInteractiveCwd(session);
  return { sessionId: session.id, accepted: true, bytes: new TextEncoder().encode(data).byteLength };
}

async function startInteractiveCommand(payload) {
  await prepareRuntime(payload.configUrl);
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The BusyBox ash session is no longer running.",
    );
  }
  if (session.foreground) {
    throw runtimeError(
      "external_shell_command_running",
      "Another foreground command is already running.",
    );
  }
  const words = parseSimpleShellWords(payload.source);
  const program = String(words?.[0] || "").replace(/^.*\//, "");
  const commandCwd = String(payload.cwd || session.cwd || session.workspaceRoot);
  const installedBinary = words?.length
    ? await readInstalledRuntimeBinary(session.posix, program)
    : null;
  const packageScript = words?.length
    ? session.posix.packageScripts?.[program]
    : null;
  if (!words?.length) {
    throw runtimeError(
      "external_shell_command_unavailable",
      `${program || "command"}: command not found. Install the package with APT if it is available.`,
    );
  }
  const packageOperations = new Set([
    "update", "install", "reinstall", "remove", "purge", "upgrade", "full-upgrade",
    "dist-upgrade", "autoremove", "satisfy",
  ]);
  const packageOperation = words.slice(1).find(
    (word) => packageOperations.has(String(word || "")),
  ) || "";
  const changesSystemPackages = (
    ["apt", "apt-get"].includes(program)
      ? packageOperations.has(packageOperation)
      : program === "apt-mark"
        ? new Set(["auto", "manual", "hold", "unhold", "minimize-manual"]).has(packageOperation)
        : new Set(["dpkg", "dpkg-divert", "dpkg-statoverride", "dpkg-trigger"]).has(program)
  );
  const syncFiles = payload.syncFiles !== false;
  if (changesSystemPackages && !session.systemBaselines.size) {
    session.systemBaselines = await snapshotSystemDirectories(session.posix.systemDirectories);
  }
  const commandBefore = changesSystemPackages || !syncFiles
    ? null
    : selectPipelineSnapshot(
      session.baseline,
      payload.source,
      commandCwd,
      session.workspaceRoot,
    );
  const commandDirectory = commandBefore
    ? await createWorkspaceFromSnapshot(commandBefore)
    : null;
  const foregroundArgs = rewriteDirectRuntimeArguments(
    program,
    words.slice(1),
    commandCwd,
    session.workspaceRoot,
    WORKSPACE_RUNTIME_ROOT,
  );
  const desiredCwd = absoluteWorkspacePath(
    commandCwd,
    commandCwd,
    session.workspaceRoot,
  );
  let foregroundCwd = desiredCwd;
  if (["bash", "dash"].includes(program)) {
    const commandIndex = foregroundArgs.indexOf("-c");
    if (commandIndex >= 0 && foregroundArgs[commandIndex + 1]) {
      foregroundArgs[commandIndex + 1] = `cd ${shellQuote(desiredCwd)} || exit $?; ${foregroundArgs[commandIndex + 1]}`;
      foregroundCwd = "/";
    }
  }
  const foregroundEnv = {
    ...session.posix.env,
    ...(session.posix.installedCommands.get(program)?.env || {}),
    HOME: WORKSPACE_RUNTIME_ROOT,
    PWD: foregroundCwd,
    PATH: `/usr/local/bin:/usr/local/sbin:/.edgeterm-bin:${String(session.posix.env?.PATH || "/usr/bin:/bin")}`,
  };
  const commandMounts = mountsForForegroundCommand(
    session.posix,
    program,
    { changesSystemPackages },
  );
  if (commandDirectory) mountWorkspaceDirectory(commandMounts, commandDirectory, session.workspaceRoot);
  const processRuntime = changesSystemPackages
    ? new Runtime()
    : await getSharedCommandRuntime(commandMounts);
  const options = {
    args: foregroundArgs,
    cwd: foregroundCwd,
    env: foregroundEnv,
    runtime: processRuntime,
    mount: commandMounts,
  };
  const packageScriptCommand = packageScript
    ? rewritePackageScriptCommand(
      [program, ...foregroundArgs].map((word) => shellQuote(word)).join(" "),
      session.posix.packageScripts,
    )
    : "";
  const shellFallbackCommand = [program, ...foregroundArgs]
    .map((word) => shellQuote(word))
    .join(" ");
  let instance;
  try {
    instance = packageScript
      ? await runPackagedCommand("ash", {
        ...options,
        program: "ash",
        args: ["-c", packageScriptCommand],
      })
      : installedBinary
      ? await (await getInstalledRuntimeCommand(program, installedBinary)).run(options)
      : BUSYBOX_APPLET_NAMES.includes(program)
        ? await runWasix(runtimeBinaries.get("busybox"), {
          ...options,
          program: "busybox",
          args: [program, ...options.args],
        })
        : runtimeBinaries?.has(program)
          ? await runPackagedCommand(program, options)
          : await runPackagedCommand("ash", {
            ...options,
            program: "ash",
            args: ["-c", shellFallbackCommand],
          });
  } catch (error) {
    throw error;
  }
  if (!instance.stdin) {
    try {
      instance.free();
    } catch {
    }
    throw runtimeError(
      "external_shell_stdin_unavailable",
      "The foreground process did not provide a writable stdin stream.",
    );
  }
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => {});
  let stdinWriter = instance.stdin.getWriter();
  const commandArguments = words.slice(1);
  const interactiveStdinPrograms = new Set([
    "apt", "apt-get", "ash", "bash", "dash", "dialog", "ed", "hexedit", "less",
    "lua", "mujs", "nano", "nc", "ncdu", "netcat", "openssl", "picoc", "qjs",
    "quickjs", "sftp", "sh", "sqlite3", "squirrel", "ssh", "tclsh",
  ]);
  const stdinFilterPrograms = new Set([
    "awk", "cat", "cmark", "gawk", "gojq", "grep", "jq", "mawk", "sed", "shfmt",
    "sort", "tee", "tr", "wc", "yq",
  ]);
  const explicitVersionOrHelp = commandArguments.some((argument) => [
    "-h", "--help", "-V", "--version", "-version", "version",
  ].includes(argument));
  const nonInteractiveApt = ["apt", "apt-get"].includes(program)
    && commandArguments.some((argument) => ["-y", "--yes", "--assume-yes"].includes(argument));
  const nonInteractiveLanguageCommand = (
    program === "lua"
    && commandArguments.some((argument) => argument === "-e" || argument.startsWith("-e"))
  );
  const interactiveRsync = program === "rsync"
    && commandArguments.some((argument) => /^rsync:\/\//.test(argument) || /^[^/][^:]*:/.test(argument));
  const keepsStdinOpen = !explicitVersionOrHelp
    && !nonInteractiveApt
    && !nonInteractiveLanguageCommand
    && (
      interactiveStdinPrograms.has(program)
      || interactiveRsync
      || (stdinFilterPrograms.has(program) && commandArguments.length === 0)
      || commandArguments.some((argument) => argument === "-" || argument.endsWith("@-"))
    );
  const closesStdinImmediately = !keepsStdinOpen;
  if (closesStdinImmediately) {
    await stdinWriter.close();
    stdinWriter.releaseLock();
    stdinWriter = null;
  }
  const foreground = {
    instance,
    program,
    args: words.slice(1),
    superseded: false,
    stdinWriter,
    completion,
    resolveCompletion,
    rejectCompletion,
    changesSystemPackages,
    captureChanges: Boolean(payload.captureChanges),
    syncFiles,
    commandBefore,
    commandDirectory,
  };
  session.foreground = foreground;
  const stdoutCapture = startProcessStreamCapture(instance.stdout, (data) => {
    const visibleData = displayWorkspacePaths(data, session.workspaceRoot);
    if (visibleData) post("interactive-output", { sessionId: session.id, stream: "stdout", data: visibleData });
  });
  const stderrCapture = startProcessStreamCapture(instance.stderr, (data) => {
    const visibleData = displayWorkspacePaths(data, session.workspaceRoot).replace(
      /^Runtime execution failed: (?:Unable to (?:persist|snapshot) mount \/bin: entry not found|.*ExitCode::\d+.*)\r?\n?/gm,
      "",
    );
    if (visibleData) post("interactive-output", { sessionId: session.id, stream: "stderr", data: visibleData });
  });
  const outputTasks = [stdoutCapture.done, stderrCapture.done];
  const waitForExit = instance.wait().catch((error) => {
    const message = String(error?.message || error || "");
    const match = message.match(/ExitCode::(\d+)/);
    if (match) return { code: Number(match[1]) };
    if (
      !changesSystemPackages
      && /Unable to (?:persist|snapshot) mount \/bin: entry not found/.test(message)
    ) return { code: 1 };
    throw error;
  });
  void waitForExit.then(async (result) => {
    if (foreground.superseded) {
      try {
        foreground.stdinWriter?.releaseLock();
      } catch {
      }
      return;
    }
    await Promise.race([
      Promise.allSettled(outputTasks),
      new Promise((resolve) => setTimeout(resolve, PROCESS_STREAM_DRAIN_TIMEOUT_MS)),
    ]);
    const resultStdout = String(result.stdout || "");
    const resultStderr = String(result.stderr || "");
    if (!stdoutCapture.output() && resultStdout) {
      post("interactive-output", {
        sessionId: session.id,
        stream: "stdout",
        data: displayWorkspacePaths(resultStdout, session.workspaceRoot),
      });
    }
    if (!stderrCapture.output() && resultStderr) {
      post("interactive-output", {
        sessionId: session.id,
        stream: "stderr",
        data: displayWorkspacePaths(resultStderr, session.workspaceRoot),
      });
    }
    await Promise.allSettled([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.race([
      Promise.allSettled(outputTasks),
      new Promise((resolve) => setTimeout(resolve, PROCESS_STREAM_CANCEL_TIMEOUT_MS)),
    ]);
    let syncError = null;
    let syncResult = null;
    try {
      if (foreground.syncFiles && foreground.commandDirectory && foreground.commandBefore) {
        const commandAfter = await snapshotDirectory(foreground.commandDirectory);
        const changes = diffSnapshots(foreground.commandBefore, commandAfter);
        await applySnapshotChanges(
          session.directory,
          changes,
          commandAfter,
          foreground.commandBefore,
        );
        applyChangesToSnapshot(session.baseline, changes);
        if (changes.length && !foreground.captureChanges) {
          post("interactive-sync", {
            sessionId: session.id,
            workspaceRoot: session.workspaceRoot,
            changes,
          });
        }
        syncResult = {
          changes,
          systemChanges: [],
          changedFiles: changes.length,
        };
      } else {
        syncResult = foreground.syncFiles
          ? await syncInteractiveDirectory(session, {
            includeSystem: foreground.changesSystemPackages,
            emit: !foreground.captureChanges,
          })
          : { changes: [], systemChanges: [], changedFiles: 0 };
      }
    } catch (error) {
      syncError = error;
      post("interactive-error", {
        sessionId: session.id,
        error: errorDetails(error, "external_shell_sync_failed"),
      });
    }
    try {
      foreground.stdinWriter?.releaseLock();
    } catch {
    }
    try {
      instance.free();
    } catch {
    }
    if (session.foreground === foreground) session.foreground = null;
    const completionResult = {
      sessionId: session.id,
      program,
      cwd: commandCwd,
      exitCode: syncError ? 1 : Number(result.code || 0),
      changedFiles: Number(syncResult?.changedFiles || 0),
      changes: foreground.captureChanges ? syncResult?.changes || [] : [],
      systemChanges: foreground.captureChanges ? syncResult?.systemChanges || [] : [],
      ...(foreground.captureChanges
        ? { installedCommands: [...session.posix.installedCommands.keys()] }
        : {}),
    };
    foreground.resolveCompletion(completionResult);
    post("interactive-command-exit", completionResult);
  }).catch(async (error) => {
    if (foreground.superseded) {
      try {
        foreground.stdinWriter?.releaseLock();
      } catch {
      }
      return;
    }
    if (session.foreground === foreground) session.foreground = null;
    const message = String(error?.message || error || "");
    if (
      !foreground.changesSystemPackages
      && /Unable to (?:persist|snapshot) mount \/bin: entry not found/.test(message)
    ) {
      const completionResult = {
        sessionId: session.id,
        program,
        cwd: commandCwd,
        exitCode: 1,
        changedFiles: 0,
        changes: [],
        systemChanges: [],
      };
      foreground.resolveCompletion(completionResult);
      post("interactive-command-exit", completionResult);
      return;
    }
    foreground.rejectCompletion(error);
    post("interactive-error", {
      sessionId: session.id,
      error: errorDetails(error, "external_shell_command_failed"),
    });
    post("interactive-command-exit", {
      sessionId: session.id,
      program,
      exitCode: 1,
    });
  });
  return { sessionId: session.id, program, running: true };
}

async function runInteractiveCommandAndWait(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The persistent command session is no longer running.",
    );
  }
  await startInteractiveCommand({ ...payload, captureChanges: true });
  const foreground = session.foreground;
  if (!foreground?.completion) {
    throw runtimeError(
      "external_shell_command_start_failed",
      "The command did not create a foreground process.",
    );
  }
  return await foreground.completion;
}

async function runInteractiveShellCommandAndWait(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The persistent command session is no longer running.",
    );
  }
  if (session.foreground) {
    throw runtimeError(
      "external_shell_command_running",
      "Another foreground command is already running.",
    );
  }
  const source = String(payload.source || "").trim();
  const program = String(parseSimpleShellWords(source)?.[0] || "command").replace(/^.*\//, "");
  const commandCwd = String(payload.cwd || session.cwd || session.workspaceRoot);
  const queryId = crypto.randomUUID();
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const foreground = {
    program,
    args: [],
    shellManaged: true,
    completion,
    resolveCompletion,
    rejectCompletion,
    changesSystemPackages: false,
    syncFiles: payload.syncFiles !== false,
  };
  session.foreground = foreground;
  const timer = setTimeout(() => {
    session.commandQueries.delete(queryId);
    if (session.foreground === foreground) session.foreground = null;
    rejectCompletion(runtimeError(
      "external_shell_command_timeout",
      "The persistent command did not return to the shell prompt in time.",
    ));
  }, Math.max(1_000, Math.min(Number(payload.timeoutMs || 180_000), 600_000)));
  session.commandQueries.set(queryId, {
    foreground,
    resolve(value) {
      clearTimeout(timer);
      resolveCompletion(value);
    },
    reject(error) {
      clearTimeout(timer);
      rejectCompletion(error);
    },
    timer,
  });
  const commands = [
    `cd ${shellQuote(commandCwd)}`,
    source,
    `__edgeterm_status=$?; printf '\\036EDGETERM_ASH_COMMAND:${queryId}:%s:%s\\037' \"$__edgeterm_status\" \"$PWD\"`,
  ];
  try {
    for (const command of commands) {
      session.pendingInputEchoes.push(command);
      await writeInteractiveText(session, command);
      await writeInteractiveText(session, "\r");
    }
  } catch (error) {
    clearTimeout(timer);
    session.commandQueries.delete(queryId);
    if (session.foreground === foreground) session.foreground = null;
    rejectCompletion(error);
  }
  return await completion;
}

async function queryInteractiveCwd(session) {
  const queryId = crypto.randomUUID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.cwdQueries.delete(queryId);
      reject(runtimeError(
        "external_shell_cwd_query_timeout",
        "The native shell did not report its working directory in time.",
      ));
    }, 10_000);
    session.cwdQueries.set(queryId, { resolve, reject, timer });
  });
  const command = `printf '%s%s:%s%s' '__EDGETERM_' 'ASH_CWD:${queryId}' \"$PWD\" ':EDGETERM_CWD_END__'`;
  session.pendingInputEchoes.push(command);
  await writeInteractiveText(session, command);
  await writeInteractiveText(session, "\r");
  return await result;
}

async function syncInteractiveSession(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The BusyBox ash session is no longer running.",
    );
  }
  await queryInteractiveCwd(session);
  const result = await queueInteractiveSync(session);
  return { sessionId: session.id, synced: true, changedFiles: result.changedFiles };
}

async function addInteractiveFiles(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The BusyBox ash session is no longer running.",
    );
  }
  const entries = splitDirectoryEntries(payload.files);
  const directoryPaths = new Set(entries.directoryPaths);
  for (const [path] of entries.fileEntries) {
    const parts = normalizeRelativePath(path).split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (current) directoryPaths.add(current);
    }
  }
  for (const path of [...directoryPaths]
    .filter(Boolean)
    .sort((left, right) => left.split("/").length - right.split("/").length)) {
    await ensureDirectory(session.directory, path);
  }
  for (const [path, bytes] of entries.fileEntries) {
    await session.directory.writeFile(`/${normalizeRelativePath(path)}`, bytes);
  }
  if (payload.configureRepository !== false) try {
    const { configureStagedAptRepository } = await import("./apt-repository.js");
    await configureStagedAptRepository(session.posix.systemDirectories.get("/etc"), session.directory, WORKSPACE_RUNTIME_ROOT);
    const varDirectory = session.posix.systemDirectories.get("/var");
    await ensureDirectory(varDirectory, "lib/apt/lists/partial");
    try {
      await varDirectory.removeFile("/lib/apt/lists/_workspace_apt-repository_._Packages");
    } catch {
    }
    await ensureDirectory(varDirectory, "cache/apt/archives/partial");
    for (const [path, bytes] of entries.fileEntries) {
      if (!path.endsWith(".deb")) continue;
      const basename = path.split("/").pop();
      await varDirectory.writeFile(`/cache/apt/archives/${basename}`, bytes);
    }
  } catch {
  }
  if (payload.finalize !== false) {
    session.baseline = await snapshotRuntimeWorkspace(session.directory, session.posix.temporaryDirectory);
  }
  return { sessionId: session.id, files: entries.fileEntries.length };
}

async function addInteractivePackageArchives(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The persistent command session is no longer running.",
    );
  }
  const systemBefore = await snapshotSystemDirectories(session.posix.systemDirectories);
  const entries = splitDirectoryEntries(payload.files);
  for (const path of entries.directoryPaths) {
    await ensureDirectory(session.directory, path);
  }
  for (const [path, bytes] of entries.fileEntries) {
    await ensureDirectory(session.directory, path.split("/").slice(0, -1).join("/"));
    await session.directory.writeFile(`/${normalizeRelativePath(path)}`, bytes);
  }
  if (payload.commitCurrentSystem === true) {
    const snapshots = await snapshotSystemDirectories(session.posix.systemDirectories);
    const systemChanges = [];
    for (const [path, snapshot] of snapshots) {
      const changes = diffSnapshots(emptySnapshot(), snapshot);
      if (changes.length) systemChanges.push({ path, changes });
    }
    session.systemBaselines = snapshots;
    session.posix.installedCommands = await readInstalledCommandMetadata(session.posix.systemDirectories);
    session.posix.packageScripts = await readInstalledPackageScripts(
      session.posix.systemDirectories,
      session.posix.installedCommands,
    );
    session.baseline = await snapshotRuntimeWorkspace(session.directory, session.posix.temporaryDirectory);
    return {
      sessionId: session.id,
      files: entries.fileEntries.length,
      systemChanges,
      changedSystemFiles: systemChanges.reduce(
        (total, group) => total + group.changes.length,
        0,
      ),
      installedCommands: [...session.posix.installedCommands.keys()],
    };
  }
  const restored = await restoreInstalledPackagePayloads({
    archivePaths: payload.archivePaths,
    mounts: session.posix.mounts,
    env: session.posix.env,
    workspaceRoot: String(payload.workspaceRoot || session.workspaceRoot),
    systemDirectories: session.posix.systemDirectories,
    force: true,
  });
  session.posix.installedCommands = await readInstalledCommandMetadata(session.posix.systemDirectories);
  session.posix.packageScripts = await readInstalledPackageScripts(
    session.posix.systemDirectories,
    session.posix.installedCommands,
  );
  const system = await diffSystemDirectories(systemBefore, session.posix.systemDirectories);
  const restoredSystemChanges = restored.systemChanges || [];
  const systemChanges = restoredSystemChanges.length ? restoredSystemChanges : system.changes;
  session.systemBaselines = system.snapshots;
  session.baseline = await snapshotRuntimeWorkspace(session.directory, session.posix.temporaryDirectory);
  return {
    sessionId: session.id,
    files: entries.fileEntries.length,
    systemChanges,
    changedSystemFiles: systemChanges.reduce(
      (total, group) => total + group.changes.length,
      0,
    ),
    installedCommands: [...session.posix.installedCommands.keys()],
  };
}

async function addInteractivePackagePayload(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    throw runtimeError(
      "external_shell_session_missing",
      "The persistent command session is no longer running.",
    );
  }
  for (const mount of Array.isArray(payload.systemMounts) ? payload.systemMounts : []) {
    const path = String(mount?.path || "").replace(/\/+$/, "");
    if (!PACKAGE_SYSTEM_MOUNTS.has(path)) {
      throw runtimeError("external_shell_mount_forbidden", `The system mount is not allowed: ${path}`);
    }
    const target = session.posix.systemDirectories.get(path);
    if (!target) continue;
    const entries = splitDirectoryEntries(mount.files);
    for (const directoryPath of entries.directoryPaths) {
      await ensureDirectory(target, directoryPath);
    }
    for (const [filePath, bytes] of entries.fileEntries) {
      await ensureDirectory(target, filePath.split("/").slice(0, -1).join("/"));
      await target.writeFile(`/${normalizeRelativePath(filePath)}`, bytes);
    }
  }
  if (payload.refreshMetadata !== false) {
    session.posix.installedCommands = await readInstalledCommandMetadata(session.posix.systemDirectories);
    session.posix.packageScripts = await readInstalledPackageScripts(
      session.posix.systemDirectories,
      session.posix.installedCommands,
    );
  }
  return {
    sessionId: session.id,
    installedCommands: [...session.posix.installedCommands.keys()],
  };
}

async function stopInteractiveSession(payload) {
  const session = interactiveSession;
  if (!session || String(payload.sessionId || "") !== session.id) {
    return { sessionId: String(payload.sessionId || ""), running: false, exitCode: 0 };
  }
  session.suppressOutput = true;
  session.outputBuffers.stdout = "";
  session.outputBuffers.stderr = "";
  await session.stdinWriter.write(new TextEncoder().encode("exit\r\n"));
  await session.stdinWriter.close();
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve(null), 3_000);
  });
  const result = await Promise.race([session.finished, timeout]);
  if (result) return result;
  return await finalizeInteractiveSession(session);
}

self.onmessage = (event) => {
  const message = event.data || {};
  const requestId = String(message.requestId || "");
  if (message.type === "prepare") {
    prepareRuntime(message.payload?.configUrl)
      .then((current) => post("result", {
        requestId,
        result: {
          ready: true,
          runtime: current.runtime,
          version: current.version,
          license: current.license,
          posixProfile: "edgeterm-posix-v2",
          sourceRepository: current.source_repository,
        },
      }))
      .catch((error) => post("error", { requestId, error: errorDetails(error, "external_shell_prepare_failed") }));
    return;
  }
  if (message.type === "run") {
    runCommand({ ...(message.payload || {}), configUrl: message.payload?.configUrl })
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-start") {
    startInteractiveSession({ ...(message.payload || {}), configUrl: message.payload?.configUrl })
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-write") {
    writeInteractiveInput(message.payload || {})
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-add-files") {
    addInteractiveFiles(message.payload || {})
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-add-package-archives") {
    addInteractivePackageArchives(message.payload || {})
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-add-package-payload") {
    addInteractivePackagePayload(message.payload || {})
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-command-start") {
    startInteractiveCommand({ ...(message.payload || {}), configUrl: message.payload?.configUrl })
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-command-run") {
    runInteractiveCommandAndWait({ ...(message.payload || {}), configUrl: message.payload?.configUrl })
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-shell-command-run") {
    runInteractiveShellCommandAndWait({ ...(message.payload || {}), configUrl: message.payload?.configUrl })
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-sync-now") {
    syncInteractiveSession(message.payload || {})
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-run-buffered") {
    runInteractivePipeline({ ...(message.payload || {}), configUrl: message.payload?.configUrl })
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
    return;
  }
  if (message.type === "interactive-stop") {
    stopInteractiveSession(message.payload || {})
      .then((result) => post("result", { requestId, result }))
      .catch((error) => post("error", { requestId, error: errorDetails(error) }));
  }
};

self.postMessage({ type: "bootstrap-stage", stage: "ready" });
