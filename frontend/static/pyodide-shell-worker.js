self.EdgeTermWasmCLI = {
  which(command) {
    const entry = findWasmCommand(String(command || ""));
    return entry ? `/bin/${entry.command}` : null;
  },
  commandForPath(path) {
    const normalized = normalizePath(String(path || ""));
    if (normalized.startsWith("/bin/")) {
      const command = normalized.split("/").filter(Boolean).pop();
      return findWasmCommand(command)?.command || null;
    }
    for (const entry of discoverWasmCommands().values()) {
      if (entry.launcherPath === normalized) return entry.command;
    }
    return null;
  },
  isPackageCommandPath(path) {
    const normalized = normalizePath(String(path || ""));
    return normalized.startsWith("/packages/") || normalized.startsWith("/bin/");
  },
  async runCommandJSON(command, argsJson = "[]", stdinText = "", cwd = "/", envJson = "{}") {
    return JSON.stringify(await runWasmPackageCommand(command, argsJson, stdinText, cwd, envJson));
  },
  runCommandText(command, argsJson, stdinText, cwd, envJson) {
    return this.runCommandJSON(command, argsJson, stdinText, cwd, envJson);
  },
};
self.window = self;
let workerAssetBase = "/static/";
let workerAssetVersion = "";
let pageBridgeSequence = 0;
const pendingPageBridgeRequests = new Map();
const post = (payload) => self.postMessage(payload);
let packageAssetManifestPromise = null;
let syncfsPromise = null;
let fsEntriesCache = new Map();
let fsEntriesDirtyPaths = new Set();
let workspaceMutationVersion = 0;
const WORKER_PACKAGE_STORAGE_ROOT = "edgeterm-worker-packages-v1";
let phpRequestQueue = Promise.resolve();
let syncfsAgain = false;
let workspaceStorageLoadPromise = null;
let displayInputQueue = [];
let displayInputSessionId = "default";
const EXTERNAL_PACKAGE_ROOTS = [
  "/usr/local",
  "/opt",
  "/etc/apt",
  "/etc/dpkg",
  "/var/cache/apt",
  "/var/lib",
  "/var/log/apt",
];

function isWorkspaceOrExternalPackagePath(path) {
  const target = normalizePath(String(path || ""));
  if (target.startsWith("/home/")) return true;
  return EXTERNAL_PACKAGE_ROOTS.some(
    (root) => target === root || target.startsWith(`${root}/`),
  );
}

function recordWorkerFsMutation(path) {
  const target = normalizePath(String(path || ""));
  if (!target || !isWorkspaceOrExternalPackagePath(target)) return;
  workspaceMutationVersion += 1;
  invalidateFsEntriesCache(target);
  markFsEntryDirty(target);
}

function installWorkerFsMutationTracking() {
  const fs = pyodide?.FS;
  if (!fs) return;
  const delegate = fs.trackingDelegate || (fs.trackingDelegate = {});
  if (delegate.__edgetermInstalled) return;
  const chain = (name, handler) => {
    const previous = typeof delegate[name] === "function" ? delegate[name] : null;
    delegate[name] = (...args) => {
      try {
        previous?.(...args);
      } finally {
        handler(...args);
      }
    };
  };
  chain("onWriteToFile", (path) => recordWorkerFsMutation(path));
  chain("onDeletePath", (path) => recordWorkerFsMutation(path));
  chain("onMakeDirectory", (path) => recordWorkerFsMutation(path));
  chain("onMovePath", (oldPath, newPath) => {
    recordWorkerFsMutation(oldPath);
    recordWorkerFsMutation(newPath);
  });
  chain("onMakeSymlink", (_target, linkPath) => recordWorkerFsMutation(linkPath));
  delegate.__edgetermInstalled = true;
}

function workerStoragePath(path) {
  const target = normalizePath(String(path || ""));
  if (
    workspaceMounted
    && mountedWorkspaceRoot
    && (target === "/home" || target.startsWith("/home/"))
  ) {
    return `${mountedWorkspaceRoot}${target}`;
  }
  return target;
}

function requestPageBridge(type, payload = {}) {
  pageBridgeSequence += 1;
  const id = pageBridgeSequence;
  post({ ...payload, type, id });
  return new Promise((resolve, reject) => {
    pendingPageBridgeRequests.set(id, { resolve, reject });
  });
}

function scheduleWorkspaceSync() {
  if (!workspaceMounted) return;
  if (workspaceStorageLoadPromise) {
    syncfsAgain = true;
    workspaceStorageLoadPromise.finally(() => scheduleWorkspaceSync());
    return;
  }
  if (syncfsPromise) {
    syncfsAgain = true;
    return;
  }
  syncfsPromise = syncfs(false)
    .catch((err) => console.warn("[storage] Filesystem sync deferred to the workspace journal", err))
    .then(() => persistDirtyWorkerEntries())
    .catch((err) => post({ type: "stderr", text: `[storage] journal failed: ${err?.message || err}\n` }))
    .finally(() => {
      syncfsPromise = null;
      if (syncfsAgain) {
        syncfsAgain = false;
        scheduleWorkspaceSync();
      }
    });
}

async function workerPackageStorageDirectory(workspaceId, { create = true } = {}) {
  if (!navigator?.storage?.getDirectory) throw new Error("Browser package storage is unavailable");
  const root = await navigator.storage.getDirectory();
  const packageRoot = await root.getDirectoryHandle(WORKER_PACKAGE_STORAGE_ROOT, { create });
  return await packageRoot.getDirectoryHandle(String(workspaceId || "default"), { create });
}

async function workerPackageStorageParent(root, path, { create = true } = {}) {
  const parts = normalizePath(path).split("/").filter(Boolean);
  const name = parts.pop() || "";
  let parent = root;
  for (const part of parts) parent = await parent.getDirectoryHandle(part, { create });
  return { parent, name };
}

function isExternalPackagePath(path) {
  const target = normalizePath(path);
  return EXTERNAL_PACKAGE_ROOTS.some(
    (root) => target === root || target.startsWith(`${root}/`),
  );
}

async function persistDirtyWorkerEntries() {
  if (!workspaceMounted || !mountedWorkspaceRoot || !fsEntriesDirtyPaths.size) return 0;
  const workspaceId = mountedWorkspaceRoot.split("/").filter(Boolean).pop() || "";
  const paths = [...fsEntriesDirtyPaths]
    .map((path) => normalizePath(path))
    .filter((path) => isExternalPackagePath(path));
  if (!paths.length) return 0;
  const entries = paths.map((path) => {
    if (!pyodide.FS.analyzePath(path).exists) return { path, deleted: true };
    const stat = pyodide.FS.stat(path);
    if (pyodide.FS.isDir(stat.mode)) return { path, dir: true, mode: Number(stat.mode || 0) };
    return {
      path,
      mode: Number(stat.mode || 0),
      contents: pyodide.FS.readFile(path),
    };
  });
  const root = await workerPackageStorageDirectory(workspaceId);
  for (const entry of entries) {
    const { parent, name } = await workerPackageStorageParent(root, entry.path);
    if (!name) continue;
    if (entry.deleted) {
      try {
        await parent.removeEntry(name, { recursive: true });
      } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
      }
    } else if (entry.dir) {
      await parent.getDirectoryHandle(name, { create: true });
    } else {
      const file = await parent.getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      await writable.write(entry.contents);
      await writable.close();
    }
  }
  for (const path of paths) clearFsEntryDirty(path);
  return entries.length;
}

async function collectWorkerPackageEntries(directory, prefix = "", entries = []) {
  for await (const [name, handle] of directory.entries()) {
    const path = `${prefix}/${name}`;
    if (handle.kind === "directory") {
      entries.push({ path, dir: true });
      await collectWorkerPackageEntries(handle, path, entries);
    } else {
      const file = await handle.getFile();
      entries.push({ path, contents: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  return entries;
}

async function restoreWorkerEntries(workspaceId) {
  if (!workspaceId || !navigator?.storage?.getDirectory) return 0;
  let root;
  try {
    root = await workerPackageStorageDirectory(workspaceId, { create: false });
  } catch (error) {
    if (error?.name === "NotFoundError") return 0;
    throw error;
  }
  const entries = await collectWorkerPackageEntries(root);
  const directories = entries
    .filter((entry) => entry?.dir)
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  for (const entry of directories) ensureDir(normalizePath(entry.path));
  for (const entry of entries.filter((item) => !item?.dir)) {
    const path = normalizePath(entry.path);
    ensureDir(path.split("/").slice(0, -1).join("/") || "/");
    pyodide.FS.writeFile(path, new Uint8Array(entry.contents || []));
  }
  return entries.length;
}

async function ensurePythonWebDependency(mode) {
  const normalizedMode = String(mode || "flask").trim().toLowerCase();
  if (["asgi", "fastapi", "starlette"].includes(normalizedMode)) {
    await pyodide.loadPackage("ssl");
    await pyodide.runPythonAsync(`
import importlib
import os
import shutil
import sys

user_site = "/home/user/.local/lib/python3.12/site-packages"
ssl_metadata = []
if os.path.isdir(user_site):
    ssl_metadata = [
        name for name in os.listdir(user_site)
        if name.lower().startswith("ssl-") and name.lower().endswith(".dist-info")
    ]
if ssl_metadata:
    for name in ("ssl.py", "_ssl.so"):
        path = os.path.join(user_site, name)
        if os.path.isfile(path):
            os.remove(path)
    for name in ssl_metadata:
        shutil.rmtree(os.path.join(user_site, name), ignore_errors=True)
    sys.modules.pop("ssl", None)
    sys.modules.pop("_ssl", None)
    importlib.invalidate_caches()
`);
  }
  const dependencies = {
    flask: { module: "flask", package: "Flask" },
    wsgi: { module: "flask", package: "Flask" },
    django: { module: "django", package: "Django" },
    asgi: {
      modules: ["fastapi", "jinja2"],
      packages: ["fastapi==0.109.0", "Jinja2"],
      pyodidePackages: ["pydantic", "Jinja2"],
    },
    fastapi: {
      modules: ["fastapi", "jinja2"],
      packages: ["fastapi==0.109.0", "Jinja2"],
      pyodidePackages: ["pydantic", "Jinja2"],
    },
    starlette: { module: "starlette", package: "Starlette" },
  };
  const dependency = dependencies[normalizedMode];
  if (!dependency) return { installed: false, required: false };

  pyodide.globals.set(
    "__edgeterm_dependency_modules",
    JSON.stringify(dependency.modules || [dependency.module]),
  );
  const present = Boolean(pyodide.runPython(`
import importlib.util
import json
import sys

module_names = json.loads(str(__edgeterm_dependency_modules))
all(
    module_name in sys.modules or importlib.util.find_spec(module_name) is not None
    for module_name in module_names
)
`));
  if (present) {
    await installPythonWebRuntimeCompatibility(normalizedMode);
    return { installed: false, required: true };
  }

  for (const packageName of dependency.pyodidePackages || []) {
    try {
      await pyodide.loadPackage(packageName);
    } catch {
      // Micropip will report a useful dependency error if no Pyodide package exists.
    }
  }
  await pyodide.loadPackage("micropip");
  pyodide.globals.set(
    "__edgeterm_dependency_packages",
    JSON.stringify(dependency.packages || [dependency.package]),
  );
  await pyodide.runPythonAsync(`
import json
import micropip

await micropip.install(json.loads(str(__edgeterm_dependency_packages)))
`);
  await installPythonWebRuntimeCompatibility(normalizedMode);
  return { installed: true, required: true };
}

async function installPythonWebRuntimeCompatibility(mode) {
  if (!["asgi", "fastapi", "starlette"].includes(String(mode || "").toLowerCase())) return;
  await pyodide.runPythonAsync(`
import anyio.to_thread

async def _edgeterm_inline_run_sync(
    func,
    *args,
    abandon_on_cancel=False,
    cancellable=None,
    limiter=None,
):
    return func(*args)

anyio.to_thread.run_sync = _edgeterm_inline_run_sync
`);
}

self.EdgeTermWine = {
  isAvailable() {
    return true;
  },
  async runCommand(alias, args = [], cwd = "/home/user", env = {}, options = {}) {
    const argv = Array.from(args || []).map((arg) => String(arg));
    const currentCwd = String(cwd || "/home/user");
    const currentEnv = { ...(env || {}) };
    const currentOptions = { ...(options || {}) };
    const prefix = normalizePath(String(currentOptions.prefix || currentEnv.WINEPREFIX || "/home/user/.wine"));
    ensureWinePrefix(prefix);
    const appFile = wineAppFilePayload(String(alias || "wine"), argv, currentCwd);
    const result = await requestPageBridge("wineRun", {
      alias: String(alias || "wine"),
      args: argv,
      cwd: currentCwd,
      env: currentEnv,
      options: currentOptions,
      wineManifest: readOptionalJson("/packages/wine/package.json"),
      appFile,
    });
    scheduleWorkspaceSync();
    return result;
  },
};
self.EdgeTermServe = {
  async start(mode, target, cwd = "/home/user") {
    return await requestPageBridge("edgeServeStart", {
      mode: String(mode || "flask"),
      target: String(target || ""),
      cwd: String(cwd || "/home/user"),
    });
  },
};
self.EdgeTermDisplay = {
  get sessionId() {
    return displayInputSessionId;
  },
  send(message) {
    post({ type: "display", message });
    return true;
  },
  sendPixels(pixelData, width, height) {
    try {
      const source = pixelData?.toJs ? pixelData.toJs() : pixelData;
      const bytes = source instanceof Uint8ClampedArray
        ? source
        : source instanceof Uint8Array
          ? new Uint8ClampedArray(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))
          : new Uint8ClampedArray(source || []);
      post(
        {
          type: "displayPixels",
          width: Number(width) || 0,
          height: Number(height) || 0,
          buffer: bytes.buffer,
        },
        [bytes.buffer],
      );
      return true;
    } catch {
      return false;
    }
  },
  clear(message = "Display cleared") {
    post({ type: "display", message: { type: "clear", message } });
    return true;
  },
  switchTab(focus = true) {
    post({ type: "display", message: { type: "switch", focus } });
    return true;
  },
  postInputEvent(event) {
    displayInputQueue.push({ ...(event || {}), ts: Date.now() });
    if (displayInputQueue.length > 200) displayInputQueue = displayInputQueue.slice(-200);
    return true;
  },
  consumeInputEvents() {
    const events = [...displayInputQueue];
    displayInputQueue = [];
    return events;
  },
};

let pyodide = null;
let shellReady = false;
let inputSequence = 0;
const pendingInputs = new Map();
let workspaceMounted = false;
let mountedWorkspaceRoot = "";
let pendingWorkspaceHydration = null;
const PERSISTED_RUNTIME_PATHS = [
  "/tmp",
  "/etc/appmode",
  "/etc/apt",
  "/etc/dpkg",
  "/var/lib",
  "/var/cache/apt",
  "/var/log",
  "/usr/local",
  "/opt",
];

function decodeBase64Bytes(data) {
  const binary = atob(String(data || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizePath(path) {
  const raw = String(path || "/").replaceAll("\\", "/");
  const absolute = raw.startsWith("/");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || "/";
}

function ensureDir(path) {
  if (!path || path === "/") return;
  const parts = String(path).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (!pyodide.FS.analyzePath(current).exists) pyodide.FS.mkdir(current);
  }
}

function removeTree(path) {
  if (!path || path === "/" || !pyodide.FS.analyzePath(path).exists) return;
  const stat = pyodide.FS.lstat(path);
  if (!pyodide.FS.isDir(stat.mode) || pyodide.FS.isLink(stat.mode)) {
    pyodide.FS.unlink(path);
    return;
  }
  for (const entry of pyodide.FS.readdir(path)) {
    if (entry === "." || entry === "..") continue;
    removeTree(`${path}/${entry}`);
  }
  pyodide.FS.rmdir(path);
}

function clearDirectoryContents(path) {
  ensureDir(path);
  for (const entry of pyodide.FS.readdir(path)) {
    if (entry === "." || entry === "..") continue;
    removeTree(`${path}/${entry}`);
  }
}

function copyTree(source, target, overwrite = false) {
  if (!pyodide.FS.analyzePath(source).exists) return;
  const stat = pyodide.FS.lstat(source);
  if (!pyodide.FS.isDir(stat.mode) || pyodide.FS.isLink(stat.mode)) {
    if (!overwrite && pyodide.FS.analyzePath(target).exists) return;
    ensureDir(target.split("/").slice(0, -1).join("/") || "/");
    if (pyodide.FS.isLink(stat.mode)) pyodide.FS.symlink(pyodide.FS.readlink(source), target);
    else pyodide.FS.writeFile(target, pyodide.FS.readFile(source));
    return;
  }
  ensureDir(target);
  for (const entry of pyodide.FS.readdir(source)) {
    if (entry === "." || entry === "..") continue;
    copyTree(`${source}/${entry}`, `${target}/${entry}`, overwrite);
  }
}

function workspaceUsers(root = mountedWorkspaceRoot) {
  const homeRoot = `${root || ""}/home`;
  if (!root || !pyodide.FS.analyzePath(homeRoot).exists) return ["user"];
  const users = pyodide.FS
    .readdir(homeRoot)
    .filter((entry) => entry !== "." && entry !== "..")
    .filter((entry) => !entry.startsWith("."))
    .filter((entry) => {
      try {
        return pyodide.FS.isDir(pyodide.FS.stat(`${homeRoot}/${entry}`).mode);
      } catch {
        return false;
      }
    });
  return users.length ? users : ["user"];
}

function linkWorkspaceHomes(users = ["user"]) {
  ensureDir("/home");
  ensureDir("/tmp");
  for (const entry of pyodide.FS.readdir("/home")) {
    if (entry === "." || entry === "..") continue;
    const path = `/home/${entry}`;
    try {
      const stat = pyodide.FS.lstat(path);
      if (pyodide.FS.isLink(stat.mode) || !pyodide.FS.isDir(stat.mode)) {
        pyodide.FS.unlink(path);
      } else {
        pyodide.FS.rename(path, `/tmp/edgeterm-home-shadow-${entry}-${Date.now()}`);
      }
    } catch {}
  }
  for (const user of users.length ? users : ["user"]) {
    const target = `${mountedWorkspaceRoot}/home/${user}`;
    const runtimeHome = `/home/${user}`;
    ensureDir(target);
    pyodide.FS.symlink(target, runtimeHome);
  }
  const primaryUser = (users.length ? users : ["user"])[0];
  const temporaryTarget = `/home/${primaryUser}/.edgeterm-posix/tmp`;
  ensureDir(temporaryTarget);
  try {
    if (pyodide.FS.analyzePath("/tmp").exists) {
      const stat = pyodide.FS.lstat("/tmp");
      if (!pyodide.FS.isLink(stat.mode)) copyTree("/tmp", temporaryTarget, false);
      removeTree("/tmp");
    }
  } catch {}
  pyodide.FS.symlink(temporaryTarget, "/tmp");
}

function unlinkWorkspaceRuntimePaths() {
  for (const path of PERSISTED_RUNTIME_PATHS) {
    try {
      if (!pyodide.FS.analyzePath(path).exists) continue;
      const stat = pyodide.FS.lstat(path);
      if (pyodide.FS.isLink(stat.mode)) pyodide.FS.unlink(path);
    } catch {}
  }
}

async function unmountWorkspaceStorage() {
  if (!workspaceMounted || !mountedWorkspaceRoot) return;
  await waitForWorkspaceStorageReady();
  try {
    await syncfs(false);
  } finally {
    await persistDirtyWorkerEntries();
  }
  unlinkWorkspaceRuntimePaths();
  try {
    for (const entry of pyodide.FS.readdir("/home")) {
      if (entry === "." || entry === "..") continue;
      removeTree(`/home/${entry}`);
    }
  } catch {}
  try {
    pyodide.FS.unmount(mountedWorkspaceRoot);
  } catch {}
  workspaceMounted = false;
  mountedWorkspaceRoot = "";
  pendingWorkspaceHydration = null;
}

function syncfsRaw(load = false) {
  return new Promise((resolve, reject) => {
    pyodide.FS.syncfs(load, (error) => (error ? reject(error) : resolve()));
  });
}

async function syncfs(load = false) {
  if (!load && workspaceStorageLoadPromise) {
    syncfsAgain = true;
    await workspaceStorageLoadPromise;
  }
  return await syncfsRaw(load);
}

async function syncfsWithTimeout(load = false, timeoutMs = 12000) {
  let settled = false;
  const syncPromise = syncfsRaw(load)
    .then(() => {
      settled = true;
      return true;
    })
    .catch((error) => {
      settled = true;
      throw error;
    });
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (!settled) resolve(false);
    }, timeoutMs);
  });
  return await Promise.race([syncPromise, timeoutPromise]);
}

async function startWorkspaceStorageLoad(timeoutMs = 12000) {
  let settled = false;
  const loadPromise = syncfsRaw(true)
    .then(() => {
      settled = true;
      return true;
    })
    .catch((error) => {
      settled = true;
      throw error;
    })
    .finally(() => {
      workspaceStorageLoadPromise = null;
      if (syncfsAgain) {
        syncfsAgain = false;
        scheduleWorkspaceSync();
      }
    });
  workspaceStorageLoadPromise = loadPromise;
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (!settled) resolve(false);
    }, timeoutMs);
  });
  return await Promise.race([loadPromise, timeoutPromise]);
}

function shouldPruneWorkerBootStoragePath(workspaceId, value) {
  const raw = typeof value === "string" ? value : String(value?.path || value?.name || value?.filename || value?.key || "");
  if (!raw) return false;
  let normalized = raw.replaceAll("\\", "/").replace(/^\/+/, "");
  const escapedId = String(workspaceId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  normalized = normalized.replace(new RegExp(`^workspace-store/${escapedId}/?`), "");
  normalized = normalized.replace(new RegExp(`^${escapedId}/?`), "");
  if (!normalized || normalized === "." || normalized === "/") return false;
  const preserve = [
    /^home(?:\/|$)/,
    /^etc$/,
    /^etc\/appmode(?:\/|$)/,
    /^etc\/apt(?:\/|$)/,
    /^var$/,
    /^var\/cache(?:\/|$)/,
    /^var\/cache\/apt(?:\/|$)/,
    /^var\/lib$/,
    /^var\/lib\/apt(?:\/|$)/,
    /^var\/lib\/dpkg(?:\/|$)/,
    /^var\/lib\/pkg$/,
    /^var\/lib\/pkg\/status\.json$/,
    /^var\/lib\/pkg\/installed(?:\/[^/]+\.json)?$/,
    /^packages$/,
    /^packages\/[^/]+$/,
    /^packages\/[^/]+\/package\.json$/,
    /^usr$/,
    /^usr\/local(?:\/|$)/,
    /^opt(?:\/|$)/,
  ];
  if (preserve.some((pattern) => pattern.test(normalized))) return false;
  return true;
}

function workspaceStorageRelativePath(workspaceId, value, { allowUnscoped = false } = {}) {
  const raw = typeof value === "string" ? value : String(value?.path || value?.name || value?.filename || value?.key || "");
  if (!raw) return "";
  let normalized = raw.replaceAll("\\", "/").replace(/^\/+/, "");
  const escapedId = String(workspaceId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scopedPattern = new RegExp(`^(?:workspace-store/)?${escapedId}/?`);
  const isScoped = scopedPattern.test(normalized);
  if (!isScoped && !allowUnscoped) return "";
  if (isScoped) normalized = normalized.replace(scopedPattern, "");
  if (!normalized || normalized === "." || normalized.includes("..")) return "";
  return normalized;
}

function shouldHydrateWorkspaceStoragePath(path) {
  return (
    /^home(?:\/|$)/.test(path) ||
    /^etc\/appmode(?:\/|$)/.test(path) ||
    /^etc\/apt(?:\/|$)/.test(path) ||
    /^var\/cache\/apt(?:\/|$)/.test(path) ||
    /^var\/lib\/apt(?:\/|$)/.test(path) ||
    /^var\/lib\/dpkg(?:\/|$)/.test(path) ||
    /^var\/lib\/pkg(?:\/|$)/.test(path) ||
    /^usr\/local(?:\/|$)/.test(path) ||
    /^opt(?:\/|$)/.test(path) ||
    /^packages\/[^/]+\/package\.json$/.test(path)
  );
}

function isDirectoryMode(mode) {
  return typeof mode === "number" && (mode & 0o170000) === 0o040000;
}

function applyPersistedStorageEntry(workspaceRoot, relativePath, value) {
  if (!relativePath || !shouldHydrateWorkspaceStoragePath(relativePath)) return false;
  const targetPath = `${workspaceRoot}/${relativePath}`;
  if (isDirectoryMode(value?.mode) || value?.contents === undefined || value?.contents === null) {
    ensureDir(targetPath);
    return true;
  }
  ensureDir(targetPath.split("/").slice(0, -1).join("/") || "/");
  pyodide.FS.writeFile(targetPath, new Uint8Array(value.contents));
  return true;
}

async function pruneWorkerBootIdbStorage(workspaceId, workspaceRoot) {
  if (!workspaceId || typeof indexedDB === "undefined") return 0;
  const dbNames = new Set([`EM_FS_${workspaceRoot}`, "EM_FS_/workspace-store"]);
  let deleted = 0;
  for (const dbName of dbNames) {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open(dbName);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        try {
          request.transaction?.abort?.();
        } catch {}
        resolve(null);
      };
      request.onsuccess = () => resolve(request.result);
    });
    if (!db || !db.objectStoreNames.contains("FILE_DATA")) {
      try {
        db?.close?.();
      } catch {}
      continue;
    }
    try {
      const result = await new Promise((resolve, reject) => {
        let count = 0;
        let scanned = 0;
        const tx = db.transaction("FILE_DATA", "readwrite");
        const store = tx.objectStore("FILE_DATA");
        const cursorRequest = store.openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          scanned += 1;
          if (
            shouldPruneWorkerBootStoragePath(workspaceId, cursor.key) ||
            shouldPruneWorkerBootStoragePath(workspaceId, cursor.value)
          ) {
            cursor.delete();
            count += 1;
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve({ count, scanned });
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB worker boot prune aborted"));
      });
      deleted += result.count || 0;
    } catch (error) {
      post({ type: "stderr", text: `[storage] worker boot prune skipped for ${dbName}: ${error?.message || error}\n` });
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
  return deleted;
}

async function hydrateWorkspaceStorageFromIdb(workspaceId, workspaceRoot) {
  if (!workspaceId || typeof indexedDB === "undefined") return 0;
  const dbNames = new Set(["EM_FS_/workspace-store"]);
  let applied = 0;
  for (const dbName of dbNames) {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open(dbName);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        try {
          request.transaction?.abort?.();
        } catch {}
        resolve(null);
      };
      request.onsuccess = () => resolve(request.result);
    });
    if (!db || !db.objectStoreNames.contains("FILE_DATA")) {
      try {
        db?.close?.();
      } catch {}
      continue;
    }
    try {
      applied += await new Promise((resolve, reject) => {
        let count = 0;
        const tx = db.transaction("FILE_DATA", "readonly");
        const store = tx.objectStore("FILE_DATA");
        const cursorRequest = store.openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const relativePath =
            workspaceStorageRelativePath(workspaceId, cursor.value) ||
            workspaceStorageRelativePath(workspaceId, cursor.key);
          try {
            if (applyPersistedStorageEntry(workspaceRoot, relativePath, cursor.value)) count += 1;
          } catch (error) {
            post({ type: "stderr", text: `[storage] hydrate skipped ${relativePath}: ${error?.message || error}\n` });
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve(count);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB workspace hydrate aborted"));
      });
    } catch (error) {
      post({ type: "stderr", text: `[storage] hydrate skipped for ${dbName}: ${error?.message || error}\n` });
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
  return applied;
}

function statInfo(path) {
  const linkStat = pyodide.FS.lstat(path);
  const isLink = pyodide.FS.isLink(linkStat.mode);
  return {
    path,
    isDir: !isLink && pyodide.FS.isDir(linkStat.mode),
    isFile: !isLink && pyodide.FS.isFile(linkStat.mode),
    isLink,
    target: isLink ? pyodide.FS.readlink(path) : "",
    size: Number(linkStat.size || 0),
    mtime: linkStat.mtime instanceof Date ? linkStat.mtime.getTime() : Number(linkStat.mtime || Date.now()),
    mode: linkStat.mode,
  };
}

function statInfoFollowingLink(path) {
  const info = statInfo(path);
  if (!info.isLink) return info;
  try {
    const targetStat = pyodide.FS.stat(path);
    return {
      ...info,
      isDir: pyodide.FS.isDir(targetStat.mode),
      isFile: pyodide.FS.isFile(targetStat.mode),
    };
  } catch {
    return info;
  }
}

function readJsonFile(path) {
  return JSON.parse(pyodide.FS.readFile(path, { encoding: "utf8" }));
}

function readOptionalJson(path) {
  try {
    if (!pyodide?.FS?.analyzePath(path).exists) return null;
    return readJsonFile(path);
  } catch {
    return null;
  }
}

function ensureWinePrefix(prefix) {
  ensureDir(prefix);
  ensureDir(`${prefix}/drive_c`);
  ensureDir(`${prefix}/drive_c/users/user`);
  ensureDir(`${prefix}/dosdevices`);
  const metaPath = `${prefix}/edgeterm-wine.json`;
  if (!pyodide.FS.analyzePath(metaPath).exists) {
    pyodide.FS.writeFile(
      metaPath,
      JSON.stringify({ runtime: "wine", engine: "boxedwine", storage: "workspace", experimental: true }, null, 2)
    );
  }
}

function wineCommandText(alias, args = []) {
  const invoked = String(alias || "wine");
  const argv = Array.from(args || []).map((arg) => String(arg));
  let command = argv.join(" ").trim();
  if (invoked === "winecfg" || argv[0] === "winecfg") command = "winecfg";
  else if (invoked === "winetricks" || argv[0] === "winetricks") {
    command = `winetricks ${argv.slice(argv[0] === "winetricks" ? 1 : 0).join(" ")}`.trim();
  } else if (invoked === "wineconsole") command = `wineconsole ${argv.join(" ")}`.trim();
  else if (!command) command = "explorer";
  return command;
}

function wineAppFilePayload(alias, args, cwd) {
  const command = wineCommandText(alias, args);
  if (!command || ["winecfg", "explorer", "winetricks"].includes(command.split(/\s+/, 1)[0])) return null;
  const head = command.split(/\s+/, 1)[0];
  const path = head.startsWith("/") ? normalizePath(head) : normalizePath(`${cwd || "/"}/${head}`);
  try {
    if (!pyodide.FS.analyzePath(path).exists) return null;
    const stat = pyodide.FS.stat(path);
    if (!pyodide.FS.isFile(stat.mode)) return null;
    return {
      path,
      filename: path.split("/").filter(Boolean).pop() || "app.exe",
      bytes: pyodide.FS.readFile(path),
    };
  } catch {
    return null;
  }
}

function packageRootPath(packageName) {
  return `/packages/${String(packageName || "").replace(/^\/+|\/+$/g, "")}`;
}

const INSTALLED_WASM_PACKAGE_ROOT = "/usr/local/share/edgeterm/runtime-packages";

function normalizeWasmCommandEntries(manifest, packageName, packageRootOverride = "") {
  const entries = [];
  const append = (commandName, definition = {}) => {
    const entry = typeof definition === "string" ? { launcher: definition } : { ...definition };
    const launcher = entry.launcher || entry.js || entry.main || manifest.launcher || manifest.main || commandName;
    const wasm = entry.wasm || manifest.wasm || `${commandName}.wasm`;
    const packageRoot = packageRootOverride || packageRootPath(packageName);
    entries.push({
      command: commandName,
      packageName,
      manifest,
      packageRoot,
      launcherPath: `${packageRoot}/${launcher}`,
      wasmPath: `${packageRoot}/${wasm}`,
      thisProgram: entry.thisProgram || manifest.thisProgram || commandName,
    });
  };
  if (typeof manifest.bin === "string") append(manifest.name || packageName, { launcher: manifest.bin });
  else if (manifest.bin && typeof manifest.bin === "object") {
    for (const [commandName, launcher] of Object.entries(manifest.bin)) append(commandName, { launcher });
  } else if (manifest.commands && typeof manifest.commands === "object") {
    for (const [commandName, definition] of Object.entries(manifest.commands)) append(commandName, definition);
  } else if (manifest.command) append(manifest.command, manifest);
  return entries;
}

function discoverWasmCommands() {
  const registry = new Map();
  const roots = [
    { path: "/packages", installed: false },
    { path: INSTALLED_WASM_PACKAGE_ROOT, installed: true },
  ];
  for (const root of roots) {
    if (!pyodide?.FS?.analyzePath(root.path).exists) continue;
    for (const packageName of pyodide.FS.readdir(root.path)) {
      if (packageName === "." || packageName === "..") continue;
      const packageRoot = `${root.path}/${packageName}`;
      const manifestPath = `${packageRoot}/package.json`;
      if (!pyodide.FS.analyzePath(manifestPath).exists) continue;
      try {
        const manifest = readJsonFile(manifestPath);
        for (const entry of normalizeWasmCommandEntries(manifest, packageName, packageRoot)) {
          registry.set(entry.command, entry);
        }
      } catch (error) {
        post({ type: "stderr", text: `[WASM] Invalid package manifest ${manifestPath}: ${error?.message || error}\n` });
      }
    }
  }
  return registry;
}

function findWasmCommand(command) {
  return discoverWasmCommands().get(String(command || ""));
}

function registerPackageCommandLinks() {
  for (const entry of discoverWasmCommands().values()) {
    const linkPath = `/bin/${entry.command}`;
    if (!pyodide.FS.analyzePath(entry.launcherPath).exists) continue;
    try {
      if (pyodide.FS.analyzePath(linkPath).exists) continue;
      pyodide.FS.symlink(entry.launcherPath, linkPath);
    } catch (error) {
      post({ type: "stderr", text: `[WASM] Failed to create command link: ${linkPath} ${error?.message || error}\n` });
    }
  }
}

async function persistWorkerRootPath(runtimePath, storagePath, { seedExisting = true } = {}) {
  ensureDir(storagePath);
  if (seedExisting && pyodide.FS.analyzePath(runtimePath).exists) copyTree(runtimePath, storagePath, false);
  if (pyodide.FS.analyzePath(runtimePath).exists) removeTree(runtimePath);
  ensureDir(runtimePath.split("/").slice(0, -1).join("/") || "/");
  pyodide.FS.symlink(storagePath, runtimePath);
}

function migratePersistedRuntimePath(workspaceRoot, relativePath, storagePath) {
  const legacyPath = `${workspaceRoot}/${String(relativePath || "").replace(/^\/+/, "")}`;
  if (legacyPath === storagePath || !pyodide.FS.analyzePath(legacyPath).exists) return;
  copyTree(legacyPath, storagePath, false);
}

function collectWasmSyncRoots(cwd, args, entry, env = {}) {
  let requestedRoots = [];
  try {
    requestedRoots = env.EDGETERM_WASM_SYNC_ROOTS ? JSON.parse(String(env.EDGETERM_WASM_SYNC_ROOTS)) : [];
  } catch {
    requestedRoots = [];
  }
  const explicitRoots = Array.isArray(requestedRoots) && requestedRoots.length;
  const roots = new Set(
    explicitRoots
      ? requestedRoots.map((root) => normalizePath(root)).filter(Boolean)
      : ["/tmp", "/var", "/etc"]
  );
  if (entry?.packageName === "php" || entry?.command === "php") roots.add(entry.packageRoot);
  roots.add(cwd || "/");
  for (const arg of args || []) {
    if (!arg || String(arg).startsWith("-")) continue;
    const path = String(arg).startsWith("/") ? normalizePath(arg) : normalizePath(`${cwd || "/"}/${arg}`);
    if (pyodide.FS.analyzePath(path).exists) roots.add(path);
  }
  const sorted = [...roots].sort();
  const deduped = [];
  for (const root of sorted) {
    if (!deduped.some((p) => root === p || root.startsWith(p + "/"))) {
      deduped.push(root);
    }
  }
  return deduped;
}

function serializeFsTree(sourcePath, targetPath = sourcePath, out = []) {
  const cached = fsEntriesCache.get(sourcePath);
  if (cached !== undefined) {
    for (const entry of cached) out.push(entry);
    return out;
  }
  const startLength = out.length;
  if (!pyodide.FS.analyzePath(sourcePath).exists) return out;
  const stat = pyodide.FS.stat(sourcePath);
  if (pyodide.FS.isDir(stat.mode)) {
    out.push({ path: targetPath, dir: true });
    for (const entry of pyodide.FS.readdir(sourcePath)) {
      if (entry === "." || entry === "..") continue;
      serializeFsTree(`${sourcePath}/${entry}`, `${targetPath}/${entry}`, out);
    }
    if (targetPath === sourcePath) fsEntriesCache.set(sourcePath, out.slice(startLength));
    return out;
  }
  out.push({ path: targetPath, dir: false, data: pyodide.FS.readFile(sourcePath) });
  if (targetPath === sourcePath) fsEntriesCache.set(sourcePath, out.slice(startLength));
  return out;
}

function invalidateFsEntriesCache(changedPath) {
  if (!changedPath || fsEntriesCache.size === 0) return;
  for (const root of fsEntriesCache.keys()) {
    if (changedPath === root || root.startsWith(changedPath + "/")) {
      fsEntriesCache.delete(root);
      continue;
    }
    if (changedPath.startsWith(root + "/")) {
      const entries = fsEntriesCache.get(root);
      if (!entries) continue;
      fsEntriesCache.set(
        root,
        entries.filter((entry) => entry.path !== changedPath && !entry.path.startsWith(changedPath + "/")),
      );
    }
  }
}

function markFsEntryDirty(filePath) {
  if (filePath) fsEntriesDirtyPaths.add(filePath);
}

function clearFsEntryDirty(filePath) {
  if (filePath) fsEntriesDirtyPaths.delete(filePath);
}

function updateFsEntriesCacheEntry(filePath, data, { dirty = true } = {}) {
  if (!filePath) return;
  if (fsEntriesCache.size === 0) {
    if (dirty) markFsEntryDirty(filePath);
    return;
  }
  for (const root of fsEntriesCache.keys()) {
    if (filePath.startsWith(root + "/")) {
      const entries = fsEntriesCache.get(root);
      if (!entries) continue;
      const idx = entries.findIndex((e) => e.path === filePath);
      if (idx >= 0) {
        entries[idx] = { path: filePath, dir: false, data: data };
      } else {
        entries.push({ path: filePath, dir: false, data: data });
      }
      if (dirty) markFsEntryDirty(filePath);
      return;
    }
  }
  if (dirty) markFsEntryDirty(filePath);
}

function collectDirtyFsEntries(syncRoots = []) {
  const entries = [];
  for (const path of fsEntriesDirtyPaths) {
    if (!syncRoots.some((root) => path === root || path.startsWith(root + "/"))) continue;
    if (!pyodide.FS.analyzePath(path).exists) {
      entries.push({ path, dir: false, deleted: true });
      continue;
    }
    const stat = pyodide.FS.stat(path);
    if (pyodide.FS.isDir(stat.mode)) entries.push({ path, dir: true });
    else entries.push({ path, dir: false, data: pyodide.FS.readFile(path) });
  }
  return entries;
}

function clearDirtyFsEntries(entries = []) {
  for (const entry of entries) clearFsEntryDirty(entry.path);
}

function phpRequestFromEnv(env = {}) {
  try {
    return env.EDGETERM_PHP_SAPI_REQUEST ? JSON.parse(String(env.EDGETERM_PHP_SAPI_REQUEST || "{}")) : null;
  } catch {
    return null;
  }
}

function canSkipPhpFsExport(request = null) {
  const method = String(request?.method || "GET").toUpperCase();
  return ["GET", "HEAD", "OPTIONS"].includes(method);
}

function applyFsEntries(entries = [], { markDirty = true } = {}) {
  for (const entry of entries) {
    if (!entry?.path) continue;
    if (entry.deleted) {
      if (pyodide.FS.analyzePath(entry.path).exists) {
        invalidateFsEntriesCache(entry.path);
        pyodide.FS.unlink(entry.path);
        if (markDirty) markFsEntryDirty(entry.path);
        else clearFsEntryDirty(entry.path);
      }
      continue;
    }
    if (entry.dir) {
      if (!pyodide.FS.analyzePath(entry.path).exists) {
        invalidateFsEntriesCache(entry.path);
        ensureDir(entry.path);
        if (markDirty) markFsEntryDirty(entry.path);
        else clearFsEntryDirty(entry.path);
      }
      continue;
    }
    const newData = new Uint8Array(entry.data || []);
    const targetDir = entry.path.split("/").slice(0, -1).join("/") || "/";
    ensureDir(targetDir);
    pyodide.FS.writeFile(entry.path, newData);
    updateFsEntriesCacheEntry(entry.path, newData, { dirty: markDirty });
    if (!markDirty) clearFsEntryDirty(entry.path);
  }
}

async function loadPackageAssetManifest() {
  if (!packageAssetManifestPromise) {
    packageAssetManifestPromise = fetch(`${workerAssetBase}bootfs-packages.json?v=${encodeURIComponent(workerAssetVersion)}`, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load bootfs-packages.json (${response.status})`);
        return response.json();
      });
  }
  return await packageAssetManifestPromise;
}

async function restorePackageAssets(packageName) {
  const manifest = await loadPackageAssetManifest();
  const prefix = `packages/${String(packageName || "").replace(/^\/+|\/+$/g, "")}/`;
  let restored = 0;
  for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
    const relative = String(file?.path || "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (!relative.startsWith(prefix) || relative.includes("..")) continue;
    const fullPath = `/${relative}`;
    if (pyodide.FS.analyzePath(fullPath).exists) continue;
    ensureDir(fullPath.split("/").slice(0, -1).join("/") || "/");
    const bytes = file.encoding === "base64" ? decodeBase64Bytes(file.data) : new TextEncoder().encode(String(file.data || ""));
    pyodide.FS.writeFile(fullPath, bytes);
    restored += 1;
  }
  return restored;
}

function restoreExternalPackageManifestsFromStatus() {
  const status = readOptionalJson("/var/lib/pkg/status.json");
  const installed = status?.installed && typeof status.installed === "object" ? status.installed : {};
  for (const [name, record] of Object.entries(installed)) {
    const manifest = record?.manifest && typeof record.manifest === "object" ? { ...record.manifest } : null;
    if (!manifest || !record?.external) continue;
    manifest.name = manifest.name || name;
    const packageRoot = `/packages/${name}`;
    const manifestPath = `${packageRoot}/package.json`;
    if (pyodide.FS.analyzePath(manifestPath).exists) continue;
    ensureDir(packageRoot);
    pyodide.FS.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
}

async function runWasmPackageCommand(command, argsJson = "[]", stdinText = "", cwd = "/", envJson = "{}") {
  const env = JSON.parse(envJson || "{}");
  const isPhpSapi = env.EDGETERM_PHP_SAPI_REQUEST && command === "php";
  if (isPhpSapi) {
    const run = phpRequestQueue.then(() => runWasmPackageCommandNow(command, argsJson, stdinText, cwd, envJson, env, isPhpSapi));
    phpRequestQueue = run.catch(() => {});
    return await run;
  }
  return await runWasmPackageCommandNow(command, argsJson, stdinText, cwd, envJson, env, isPhpSapi);
}

async function runWasmPackageCommandNow(command, argsJson = "[]", stdinText = "", cwd = "/", envJson = "{}", env = null, isPhpSapi = false) {
  env ||= JSON.parse(envJson || "{}");
  if (workspaceMounted || pendingWorkspaceHydration || workspaceStorageLoadPromise) await waitForWorkspaceStorageReady();
  const entry = findWasmCommand(command);
  if (!entry) return { found: false, code: 127, stdout: "", stderr: "" };
  if (!pyodide.FS.analyzePath(entry.launcherPath).exists || !pyodide.FS.analyzePath(entry.wasmPath).exists) {
    await restorePackageAssets(entry.packageName);
  }
  if (!pyodide.FS.analyzePath(entry.launcherPath).exists) {
    return { found: true, code: 1, stdout: "", stderr: `${command}: launcher file is missing from package ${entry.packageName}\n` };
  }
  if (!pyodide.FS.analyzePath(entry.wasmPath).exists) {
    return { found: true, code: 1, stdout: "", stderr: `${command}: wasm binary is missing from package ${entry.packageName}\n` };
  }
  const args = JSON.parse(argsJson || "[]");
  const effectiveArgs = entry.command === "sqlite3" && !stdinText && args.length === 0 ? ["-interactive"] : args;
  const importRoots = collectWasmSyncRoots(cwd || "/", effectiveArgs, entry, env);
  const packageRoot = normalizePath(entry.packageRoot || "");
  const syncRoots = importRoots.filter((root) => (
    !packageRoot || (root !== packageRoot && !root.startsWith(packageRoot + "/"))
  ));
  const fsEntries = [];
  for (const root of importRoots) serializeFsTree(root, root, fsEntries);
  const phpRequest = phpRequestFromEnv(env);
  const nestedWorker = new Worker(`${workerAssetBase}wasm-cli-worker.js?v=${encodeURIComponent(workerAssetVersion)}`);
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      nestedWorker.terminate();
      resolve(result);
    };
    nestedWorker.onmessage = async (event) => {
      const data = event.data || {};
      if (data.type === "stdin_request") {
        const input = await terminalInput(String(data.display || "") || "> ");
        nestedWorker.postMessage({ type: "stdin_response", value: input });
        return;
      }
      if (data.type === "stream") {
        post({ type: data.stream === "stderr" ? "stderr" : "stdout", text: String(data.text || "") });
        return;
      }
      if (data.type === "done") {
        const changedEntries = data.fsEntries || [];
        applyFsEntries(changedEntries, { markDirty: !isPhpSapi });
        if (isPhpSapi) clearDirtyFsEntries(fsEntries);
        finish({
          found: true,
          code: Number(data.code || 0),
          stdout: data.stdout || "",
          stderr: data.stderr || "",
          sapi: !!data.sapi,
        });
        if (workspaceMounted && changedEntries.length) setTimeout(scheduleWorkspaceSync, 0);
        return;
      }
      if (data.type === "error") {
        finish({ found: true, code: Number(data.code || 1), stdout: data.stdout || "", stderr: data.stderr || "" });
      }
    };
    nestedWorker.onerror = (event) => {
      finish({ found: true, code: 1, stdout: "", stderr: `${command}: worker failure: ${event.message || "unknown error"}\n` });
    };
    nestedWorker.postMessage({
      type: "run",
      command: entry.command,
      args: effectiveArgs,
      stdinText: stdinText || "",
      cwd: cwd || "/",
      env,
      launcherSource: pyodide.FS.readFile(entry.launcherPath, { encoding: "utf8" }),
      wasmBytes: pyodide.FS.readFile(entry.wasmPath),
      packageRoot: entry.packageRoot,
      thisProgram: entry.thisProgram,
      extensions: {
        ...(entry.packageName === "php" || entry.command === "php" ? { intl: `${entry.packageRoot}/intl.so` } : {}),
        ...(entry.manifest?.extensions || {}),
      },
      fsEntries,
      syncRoots,
      skipFsExport: isPhpSapi && canSkipPhpFsExport(phpRequest),
      streamOutput: (entry.packageName === "php" || entry.command === "php") && String(env.EDGETERM_PHP_STREAM || "") !== "0",
      phpRequest,
      ttyBrokerUrl: self.location.origin,
      ttySessionId: `worker-tty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      debug: false,
    });
  });
}

async function runFsOperation(op, payload = {}) {
  const path = String(payload.path || "/");
  if (op !== "switchWorkspace" && op !== "importWorkspaceEntries") {
    await waitForWorkspaceStorageReady();
  }
  if (op === "pythonDiagnostics") {
    pyodide.globals.set("__edgeterm_diagnostic_source", String(payload.source || ""));
    return JSON.parse(String(await pyodide.runPythonAsync(`
import ast
import json
try:
    ast.parse(__edgeterm_diagnostic_source)
    diagnostic_result = {"ok": True}
except SyntaxError as exc:
    diagnostic_result = {
        "ok": False,
        "message": exc.msg,
        "line": exc.lineno or 1,
        "column": exc.offset or 1,
    }
json.dumps(diagnostic_result)
`)));
  }
  if (op === "list") {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (!pyodide.FS.analyzePath(normalized).exists) return { path: normalized, exists: false, entries: [] };
    const info = statInfoFollowingLink(normalized);
    if (!info.isDir) return { path: normalized, exists: true, isDir: false, entries: [] };
    const entries = pyodide.FS
      .readdir(normalized)
      .filter((entry) => entry !== "." && entry !== "..")
      .sort()
      .map((name) => {
        const fullPath = normalized === "/" ? `/${name}` : `${normalized}/${name}`;
        return { name, ...statInfoFollowingLink(fullPath) };
      });
    return { path: normalized, exists: true, isDir: true, entries };
  }
  if (op === "mkdir") {
    ensureDir(workerStoragePath(path));
    for (const root of fsEntriesCache.keys()) {
      if (path.startsWith(root + "/") || path === root) {
        const entries = fsEntriesCache.get(root);
        if (entries) entries.push({ path, dir: true });
      }
    }
    markFsEntryDirty(path);
    if (workspaceMounted) {
      if (payload.deferFlush) {
        // The caller will flush one complete filesystem transaction.
      } else if (payload.deferPersist) scheduleWorkspaceSync();
      else await syncfs(false);
    }
    return { ok: true };
  }
  if (op === "setShellCwd") {
    const target = normalizePath(path || "/home/user");
    if (!pyodide.FS.analyzePath(target).exists || !statInfoFollowingLink(target).isDir) {
      throw new Error(`Shell working directory not found: ${target}`);
    }
    pyodide.globals.set("__edgeterm_external_shell_cwd", target);
    await pyodide.runPythonAsync(`
import builtins
import os

target = globals().get("__edgeterm_external_shell_cwd", "/home/user")
shell = getattr(builtins, "EDGETERM_SHELL", None)
os.chdir(target)
if shell is not None:
    shell.logical_cwd = target
    shell._sync_env()
else:
    os.environ["PWD"] = target
`);
    return { ok: true, path: target };
  }
  if (op === "symlink") {
    const target = String(payload.target || "");
    if (!target) throw new Error("A symbolic-link target is required");
    ensureDir(path.split("/").slice(0, -1).join("/") || "/");
    try {
      pyodide.FS.lstat(path);
      removeTree(path);
    } catch {}
    pyodide.FS.symlink(target, path);
    markFsEntryDirty(path);
    if (workspaceMounted) await syncfs(false);
    return { ok: true, path, target };
  }
  if (op === "writeFiles") {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (entries.length > 250) throw new Error("A filesystem batch is limited to 250 files");
    for (const entry of entries) {
      const target = normalizePath(String(entry?.path || ""));
      if (!isWorkspaceOrExternalPackagePath(target)) {
        throw new Error(`Write path is outside the workspace and package storage: ${target}`);
      }
      const storageTarget = workerStoragePath(target);
      ensureDir(storageTarget.split("/").slice(0, -1).join("/") || "/");
      const data =
        entry.encoding === "base64"
          ? decodeBase64Bytes(entry.data)
          : String(entry.data ?? entry.text ?? "");
      pyodide.FS.writeFile(storageTarget, data);
      const cacheData =
        data instanceof Uint8Array
          ? data
          : new TextEncoder().encode(String(data || ""));
      updateFsEntriesCacheEntry(target, cacheData);
      markFsEntryDirty(target);
    }
    const writesExternalPackages = entries.some((entry) => (
      isExternalPackagePath(normalizePath(String(entry?.path || "")))
    ));
    if (workspaceMounted && writesExternalPackages) {
      await persistDirtyWorkerEntries();
    }
    if (workspaceMounted) {
      if (payload.deferFlush) {
        // The caller will flush one complete filesystem transaction.
      } else if (payload.deferPersist) scheduleWorkspaceSync();
      else await syncfs(false);
    }
    return { ok: true, files: entries.length };
  }
  if (op === "writeFile") {
    const storagePath = workerStoragePath(path);
    ensureDir(storagePath.split("/").slice(0, -1).join("/") || "/");
    const data = payload.encoding === "base64" ? decodeBase64Bytes(payload.data) : String(payload.data || "");
    pyodide.FS.writeFile(storagePath, data);
    const cacheData = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data || ""));
    updateFsEntriesCacheEntry(path, cacheData);
    if (workspaceMounted) {
      if (payload.deferPersist) scheduleWorkspaceSync();
      else await syncfs(false);
    }
    return { ok: true };
  }
  if (op === "readFile") {
    const storagePath = workerStoragePath(path);
    if (!pyodide.FS.analyzePath(storagePath).exists) return { path, exists: false, text: "" };
    const info = statInfo(storagePath);
    if (info.isDir) return { path, exists: true, isDir: true, text: "" };
    if (payload.encoding === "base64") {
      const bytes = pyodide.FS.readFile(storagePath);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return { path, exists: true, isDir: false, data: btoa(binary), size: bytes.length };
    }
    return { path, exists: true, isDir: false, text: pyodide.FS.readFile(storagePath, { encoding: "utf8" }) };
  }
  if (op === "readTree") {
    const root = normalizePath(String(payload.root || path || "/home/user"));
    const storageRoot = workerStoragePath(root);
    const includeNodeModules = payload.includeNodeModules !== false;
    const maxFiles = Math.max(1, Math.min(Number(payload.maxFiles || 30000), 50000));
    const maxBytes = Math.max(1, Math.min(Number(payload.maxBytes || 157286400), 805306368));
    const excluded = new Set(
      (Array.isArray(payload.exclude) ? payload.exclude : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    if (!includeNodeModules) excluded.add("node_modules");
    const files = [];
    let totalBytes = 0;
    const stack = [storageRoot];
    let currentPath = storageRoot;
    let currentOperation = "read directory";
    try {
      while (stack.length) {
        const directory = stack.pop();
        currentPath = directory;
        currentOperation = "read directory";
        if (!pyodide.FS.analyzePath(directory).exists) continue;
        const entries = pyodide.FS.readdir(directory).filter((name) => name !== "." && name !== "..");
        for (const name of entries) {
        if (excluded.has(name)) continue;
        const target = normalizePath(`${directory}/${name}`);
        currentPath = target;
        currentOperation = "inspect entry";
        if (!pyodide.FS.analyzePath(target).exists) continue;
        const info = statInfo(target);
        if (info.isDir) {
          if (payload.includeDirectories) {
            files.push({
              path: target.slice(storageRoot.length).replace(/^\/+/, ""),
              dir: true,
              mtime: Number(info.mtime || 0),
            });
          }
          stack.push(target);
          continue;
        }
        if (payload.metadataOnly) {
          files.push({
            path: target.slice(storageRoot.length).replace(/^\/+/, ""),
            size: Number(info.size || 0),
            mtime: Number(info.mtime || 0),
          });
          if (files.length >= maxFiles) {
            throw new Error("The runtime filesystem exceeds the configured file limit");
          }
          continue;
        }
        currentOperation = "read file";
        const bytes = pyodide.FS.readFile(target);
        totalBytes += bytes.byteLength;
        if (files.length >= maxFiles || totalBytes > maxBytes) {
          throw new Error("The runtime filesystem exceeds the configured file or size limit");
        }
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        files.push({
          path: target.slice(storageRoot.length).replace(/^\/+/, ""),
          encoding: "base64",
          data: btoa(binary),
          size: bytes.byteLength,
          mtime: Number(info.mtime || 0),
        });
        }
      }
    } catch (error) {
      throw new Error(
        `Unable to ${currentOperation} ${currentPath}: ${serializeWorkerError(error)}`,
      );
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { root, files, totalBytes };
  }
  if (op === "fingerprint") {
    const root = normalizePath(String(payload.root || path || "/home/user"));
    const storageRoot = workerStoragePath(root);
    const excluded = new Set(
      (Array.isArray(payload.exclude) ? payload.exclude : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    let hash = 2166136261;
    let files = 0;
    let bytes = 0;
    const stack = [storageRoot];
    const mix = (value) => {
      for (const character of String(value || "")) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    };
    while (stack.length) {
      const directory = stack.pop();
      if (!pyodide.FS.analyzePath(directory).exists) continue;
      const entries = pyodide.FS.readdir(directory).filter((name) => name !== "." && name !== "..").sort();
      for (const name of entries) {
        if (excluded.has(name)) continue;
        const target = normalizePath(`${directory}/${name}`);
        const info = statInfo(target);
        if (info.isDir) stack.push(target);
        else {
          files += 1;
          bytes += Number(info.size || 0);
          mix(`${target}:${info.size || 0}:${info.mtime || 0}`);
        }
      }
    }
    return { fingerprint: `${files}:${bytes}:${hash.toString(16)}`, files, bytes };
  }
  if (op === "stat") {
    if (!pyodide.FS.analyzePath(path).exists) return { path, exists: false };
    return { ...statInfoFollowingLink(path), exists: true };
  }
  if (op === "databaseDiscover") {
    const root = normalizePath(String(payload.root || "/home/user"));
    const found = [];
    const visited = new Set();
    const ignored = new Set([".git", "node_modules", "__pycache__", ".cache", "vendor"]);
    let inspected = 0;
    const walk = (target, depth = 0) => {
      if (depth > 12 || inspected > 20000 || visited.has(target)) return;
      visited.add(target);
      inspected += 1;
      if (!pyodide.FS.analyzePath(target).exists) return;
      let info;
      try {
        info = statInfo(target);
      } catch {
        return;
      }
      if (!info.isDir) {
        if (/\.(?:db|sqlite|sqlite3)$/i.test(target)) found.push(normalizePath(target));
        return;
      }
      let entries = [];
      try {
        entries = pyodide.FS.readdir(target);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === "." || entry === ".." || ignored.has(entry)) continue;
        walk(`${target === "/" ? "" : target}/${entry}`, depth + 1);
      }
    };
    walk(root);
    return { databases: [...new Set(found)].sort((left, right) => left.localeCompare(right)) };
  }
  if (op === "databaseSqlite") {
    await pyodide.loadPackage("sqlite3");
    pyodide.globals.set("__edgeterm_database_json", JSON.stringify(payload || {}));
    const raw = await pyodide.runPythonAsync(`
import difflib
import json
import sqlite3
import time

request = json.loads(__edgeterm_database_json)
database_path = request.get("path") or ""
operation = request.get("operation") or "query"
started = time.perf_counter()


def encode_value(value):
    if value is None or isinstance(value, (str, int, float)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return {"type": "blob", "bytes": len(data), "hex": data[:128].hex()}
    return str(value)


connection = sqlite3.connect(database_path)
connection.row_factory = sqlite3.Row
try:
    if operation == "schema":
        rows = connection.execute(
            "SELECT name, type, sql FROM sqlite_master "
            "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).fetchall()
        result = {
            "schema": [dict(row) for row in rows],
            "columns": ["name", "type", "sql"],
            "rows": [[encode_value(row[key]) for key in row.keys()] for row in rows],
            "changes": 0,
        }
    else:
        statement = request.get("query") or ""
        before_changes = connection.total_changes
        cursor = connection.execute(statement)
        columns = [item[0] for item in (cursor.description or [])]
        rows = cursor.fetchmany(500) if columns else []
        connection.commit()
        result = {
            "columns": columns,
            "rows": [[encode_value(row[column]) for column in columns] for row in rows],
            "changes": connection.total_changes - before_changes,
            "truncated": bool(columns and len(rows) == 500),
        }
    result["durationMs"] = round((time.perf_counter() - started) * 1000, 2)
finally:
    connection.close()
json.dumps(result)
`);
    if (workspaceMounted) await syncfs(false);
    return JSON.parse(String(raw || "{}"));
  }
  if (op === "developerGit") {
    await pyodide.loadPackage("micropip");
    pyodide.globals.set("__edgeterm_git_payload", JSON.stringify(payload || {}));
    const raw = await pyodide.runPythonAsync(`
import difflib
import json
import os
import subprocess

payload = json.loads(__edgeterm_git_payload)
root = os.path.abspath(payload.get("root") or "/home/user")
operation = payload.get("operation") or "status"

if not hasattr(subprocess.Popen, "__class_getitem__"):
    subprocess.Popen.__class_getitem__ = classmethod(lambda cls, item: cls)

try:
    from dulwich import porcelain
    from dulwich.repo import Repo
except ImportError:
    import micropip
    await micropip.install("dulwich")
    from dulwich import porcelain
    from dulwich.repo import Repo

os.makedirs(root, exist_ok=True)

if operation == "init" and not os.path.isdir(os.path.join(root, ".git")):
    Repo.init(root)

if not os.path.isdir(os.path.join(root, ".git")):
    result = {"initialized": False, "root": root, "branch": "", "staged": [], "unstaged": [], "untracked": [], "history": []}
else:
    repo = Repo(root)
    if operation == "commit":
        paths = [str(path) for path in payload.get("paths", []) if str(path).strip()]
        if not paths:
            current_status = porcelain.status(repo)
            paths = sorted({
                path.decode("utf-8", "replace") if isinstance(path, bytes) else str(path)
                for changed_paths in current_status.staged.values()
                for path in changed_paths
            } | {
                path.decode("utf-8", "replace") if isinstance(path, bytes) else str(path)
                for path in current_status.unstaged
            } | {
                path.decode("utf-8", "replace") if isinstance(path, bytes) else str(path)
                for path in current_status.untracked
            })
        if not paths:
            raise ValueError("There are no changes to commit")
        porcelain.add(repo, paths=paths)
        commit_id = porcelain.commit(
            repo,
            message=(payload.get("message") or "Update project").encode("utf-8"),
            author=b"EdgeTerm User <user@edgeterm.local>",
            committer=b"EdgeTerm User <user@edgeterm.local>",
            no_verify=True,
        )
    else:
        commit_id = b""

    def clean_path(value):
        if isinstance(value, bytes):
            return value.decode("utf-8", "replace")
        return str(value)

    status = porcelain.status(repo)
    staged = []
    for change_type, paths in status.staged.items():
        for changed_path in paths:
            staged.append({"path": clean_path(changed_path), "state": clean_path(change_type)})
    unstaged = [{"path": clean_path(changed_path), "state": "modified"} for changed_path in status.unstaged]
    untracked = [{"path": clean_path(changed_path), "state": "untracked"} for changed_path in status.untracked]
    try:
        branch = porcelain.active_branch(repo).decode("utf-8", "replace")
    except Exception:
        branch = "HEAD"
    history = []
    try:
        for entry in repo.get_walker(max_entries=12):
            commit = entry.commit
            history.append({
                "id": commit.id.decode("ascii", "replace")[:10],
                "message": commit.message.decode("utf-8", "replace").strip(),
                "author": commit.author.decode("utf-8", "replace"),
                "time": int(commit.commit_time),
            })
    except Exception:
        pass
    diff_text = ""
    if operation == "diff":
        head_files = {}
        try:
            from dulwich.object_store import iter_tree_contents
            commit = repo[repo.head()]
            for tree_entry in iter_tree_contents(repo.object_store, commit.tree):
                entry_path = clean_path(tree_entry.path)
                blob = repo[tree_entry.sha]
                head_files[entry_path] = bytes(blob.data)
        except Exception:
            head_files = {}
        changed_paths = {
            clean_path(path)
            for paths in status.staged.values()
            for path in paths
        }
        changed_paths.update(clean_path(path) for path in status.unstaged)
        changed_paths.update(clean_path(path) for path in status.untracked)
        rendered = []
        for changed_path in sorted(changed_paths):
            before_bytes = head_files.get(changed_path, b"")
            absolute_path = os.path.join(root, changed_path)
            try:
                with open(absolute_path, "rb") as handle:
                    after_bytes = handle.read()
            except FileNotFoundError:
                after_bytes = b""
            if before_bytes == after_bytes:
                continue
            before_text = before_bytes.decode("utf-8", "replace").splitlines(True)
            after_text = after_bytes.decode("utf-8", "replace").splitlines(True)
            rendered.extend(difflib.unified_diff(
                before_text,
                after_text,
                fromfile=f"a/{changed_path}",
                tofile=f"b/{changed_path}",
            ))
        diff_text = "".join(rendered)
    result = {
        "initialized": True,
        "root": root,
        "branch": branch,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "history": history,
        "commit": clean_path(commit_id)[:10] if commit_id else "",
        "diff": diff_text,
        "diff_available": operation == "diff",
    }

json.dumps(result)
`);
    if (workspaceMounted) await syncfs(false);
    return JSON.parse(String(raw || "{}"));
  }
  if (op === "installedPythonPackages") {
    const raw = await pyodide.runPythonAsync(`
import importlib.metadata
import json
import re

def normalized(value):
    return re.sub(r"[-_.]+", "-", value).lower()

packages = {}
for distribution in importlib.metadata.distributions():
    name = distribution.metadata.get("Name") or ""
    if name:
        packages[normalized(name)] = distribution.version
json.dumps(packages)
`);
    return JSON.parse(String(raw || "{}"));
  }
  if (op === "developerWordPressScan") {
    const root = normalizePath(String(payload.root || "/home/user"));
    const files = [];
    const ignored = new Set([".git", "node_modules", "__pycache__", ".cache", "vendor"]);
    let inspected = 0;
    const walk = (target, depth = 0) => {
      if (depth > 14 || inspected > 30000 || !pyodide.FS.analyzePath(target).exists) return;
      inspected += 1;
      const info = statInfo(target);
      if (!info.isDir) {
        files.push(target);
        return;
      }
      for (const entry of pyodide.FS.readdir(target)) {
        if (entry === "." || entry === ".." || ignored.has(entry)) continue;
        walk(`${target === "/" ? "" : target}/${entry}`, depth + 1);
      }
    };
    walk(root);
    const sites = [];
    for (const settingsPath of files.filter((target) => target.endsWith("/wp-settings.php"))) {
      const siteRoot = settingsPath.slice(0, -"/wp-settings.php".length) || "/";
      const versionPath = `${siteRoot}/wp-includes/version.php`;
      let version = "Unknown";
      if (pyodide.FS.analyzePath(versionPath).exists) {
        const source = pyodide.FS.readFile(versionPath, { encoding: "utf8" });
        const match = source.match(/\$wp_version\s*=\s*['"]([^'"]+)/);
        if (match) version = match[1];
      }
      const database = files.find((target) => target.startsWith(`${siteRoot}/wp-content/`) && /\.(?:db|sqlite|sqlite3)$/i.test(target)) || "";
      const pluginsPath = `${siteRoot}/wp-content/plugins`;
      const plugins = pyodide.FS.analyzePath(pluginsPath).exists
        ? pyodide.FS.readdir(pluginsPath).filter((name) => name !== "." && name !== ".." && name !== "index.php").length
        : 0;
      sites.push({ root: siteRoot, version, database, plugins });
    }
    return { sites };
  }
  if (op === "developerTreeStats") {
    const root = normalizePath(String(payload.root || "/home/user"));
    const files = [];
    let bytes = 0;
    let directories = 0;
    let inspected = 0;
    const walk = (target, depth = 0) => {
      if (depth > 20 || inspected > 50000 || !pyodide.FS.analyzePath(target).exists) return;
      inspected += 1;
      const info = statInfo(target);
      if (!info.isDir) {
        const size = Number(info.size || 0);
        bytes += size;
        files.push({ path: target, size });
        return;
      }
      directories += 1;
      for (const entry of pyodide.FS.readdir(target)) {
        if (entry === "." || entry === "..") continue;
        walk(`${target === "/" ? "" : target}/${entry}`, depth + 1);
      }
    };
    walk(root);
    files.sort((left, right) => right.size - left.size);
    return { exists: pyodide.FS.analyzePath(root).exists, files: files.length, directories, bytes, largestFiles: files.slice(0, 12) };
  }
  if (op === "removeTree") {
    removeTree(workerStoragePath(path));
    invalidateFsEntriesCache(path);
    markFsEntryDirty(path);
    if (workspaceMounted) {
      if (payload.deferFlush) {
        // The caller will flush one complete filesystem transaction.
      } else if (payload.deferPersist) scheduleWorkspaceSync();
      else await syncfs(false);
    }
    return { ok: true };
  }
  if (op === "flush") {
    if (workspaceStorageLoadPromise) await workspaceStorageLoadPromise;
    if (syncfsPromise) await syncfsPromise;
    syncfsAgain = false;
    let persistedEntries = 0;
    if (workspaceMounted) {
      try {
        await syncfs(false);
      } finally {
        persistedEntries = await persistDirtyWorkerEntries();
      }
    }
    return { ok: true, persisted: true, persistedEntries };
  }
  if (op === "rename") {
    const target = normalizePath(String(payload.target || ""));
    if (!target) throw new Error("Rename target is required");
    const storageTarget = workerStoragePath(target);
    ensureDir(storageTarget.split("/").slice(0, -1).join("/") || "/");
    pyodide.FS.rename(workerStoragePath(path), storageTarget);
    invalidateFsEntriesCache(path);
    invalidateFsEntriesCache(target);
    markFsEntryDirty(path);
    markFsEntryDirty(target);
    if (workspaceMounted) await syncfs(false);
    return { ok: true, path: target };
  }
  if (op === "copyTree") {
    const source = normalizePath(String(payload.source || path || ""));
    const target = normalizePath(String(payload.target || ""));
    if (!source || !target) throw new Error("Copy source and target are required");
    const storageTarget = workerStoragePath(target);
    removeTree(storageTarget);
    copyTree(workerStoragePath(source), storageTarget, true);
    invalidateFsEntriesCache(target);
    markFsEntryDirty(target);
    if (workspaceMounted) await syncfs(false);
    return { ok: true, path: target };
  }
  if (op === "unlink") {
    const storagePath = workerStoragePath(path);
    if (pyodide.FS.analyzePath(storagePath).exists) { pyodide.FS.unlink(storagePath); invalidateFsEntriesCache(path); markFsEntryDirty(path); }
    if (workspaceMounted) await syncfs(false);
    return { ok: true };
  }
  if (op === "switchWorkspace") {
    const workspaceId = String(payload.workspaceId || "");
    if (!workspaceId) throw new Error("Workspace id is required");
    if (workspaceMounted && mountedWorkspaceRoot !== `/workspace-store/${workspaceId}`) await unmountWorkspaceStorage();
    await mountWorkspaceStorage({ workspaceId, users: payload.users || ["user"] });
    if (payload.clear) clearDirectoryContents(mountedWorkspaceRoot);
    const users = workspaceUsers();
    linkWorkspaceHomes(users);
    registerPackageCommandLinks();
    await syncfs(false);
    return { ok: true, users };
  }
  if (op === "importWorkspaceEntries") {
    const workspaceId = String(payload.workspaceId || "");
    if (!workspaceId) throw new Error("Workspace id is required");
    if (workspaceMounted && mountedWorkspaceRoot !== `/workspace-store/${workspaceId}`) await unmountWorkspaceStorage();
    await mountWorkspaceStorage({ workspaceId, users: payload.users || ["user"] });
    if (payload.clear) clearDirectoryContents(mountedWorkspaceRoot);
    const mode = payload.mode === "workspace" ? "workspace" : "rootfs";
    for (const entry of Array.isArray(payload.entries) ? payload.entries : []) {
      const relative = normalizePath(String(entry.relative || "").replaceAll("\\", "/")).replace(/^\/+/, "");
      if (!relative || relative.includes("..")) continue;
      const target = mode === "workspace" ? `${mountedWorkspaceRoot}/${relative}` : `/${relative}`;
      if (entry.dir) {
        ensureDir(target);
      } else {
        ensureDir(target.split("/").slice(0, -1).join("/") || "/");
        pyodide.FS.writeFile(target, new Uint8Array(entry.data || []));
      }
    }
    const users = workspaceUsers();
    linkWorkspaceHomes(users);
    registerPackageCommandLinks();
    await syncfs(false);
    return { ok: true, users };
  }
  if (op === "wasmRunCommandJSON") {
    return {
      text: await self.EdgeTermWasmCLI.runCommandJSON(
        payload.command || "",
        payload.argsJson || "[]",
        payload.stdinText || "",
        payload.cwd || "/",
        payload.envJson || "{}"
      ),
    };
  }
  if (op === "pythonAppCreate") {
    const requestedMode = String(payload.mode || "").toLowerCase();
    if (["asgi", "fastapi", "starlette"].includes(requestedMode)) {
      const userSite = "/home/user/.local/lib/python3.12/site-packages";
      for (const name of ["ssl.py", "_ssl.so"]) {
        const target = `${userSite}/${name}`;
        if (pyodide.FS.analyzePath(target).exists) pyodide.FS.unlink(target);
      }
      if (pyodide.FS.analyzePath(userSite).exists) {
        for (const name of pyodide.FS.readdir(userSite)) {
          if (/^ssl-.*\.dist-info$/i.test(name)) removeTree(`${userSite}/${name}`);
        }
      }
      invalidateFsEntriesCache(userSite);
      markFsEntryDirty(userSite);
    }
    await ensurePythonWebDependency(payload.mode);
    pyodide.globals.set("__edgeterm_edgeserve_json", JSON.stringify(payload || {}));
    const text = await pyodide.runPythonAsync(`
import json
import importlib
import os
import sys

for command_path in ("/bin/bigbox", "/bin"):
    try:
        sys.path.remove(command_path)
    except ValueError:
        pass
cached_base64 = sys.modules.get("base64")
if cached_base64 is not None and str(getattr(cached_base64, "__file__", "")).startswith(("/bin/bigbox", "/bin")):
    del sys.modules["base64"]
rootfs_lib = os.environ.get("EDGETERM_ROOTFS_LIB", "/usr/lib")
if rootfs_lib and os.path.isdir(rootfs_lib) and rootfs_lib not in sys.path:
    sys.path.insert(0, rootfs_lib)

import edgeterm_wsgi

payload = json.loads(__edgeterm_edgeserve_json)
requested_mode = str(payload.get("mode") or "").lower()
if requested_mode in {"asgi", "fastapi", "starlette"}:
    import glob
    import shutil

    user_site = "/home/user/.local/lib/python3.12/site-packages"
    for name in ("ssl.py", "_ssl.so"):
        path = os.path.join(user_site, name)
        if os.path.isfile(path):
            os.remove(path)
    for path in glob.glob(os.path.join(user_site, "ssl-*.dist-info")):
        shutil.rmtree(path, ignore_errors=True)
    sys.modules.pop("ssl", None)
    sys.modules.pop("_ssl", None)
    importlib.invalidate_caches()
    removed_user_site = False
    if user_site in sys.path:
        sys.path.remove(user_site)
        removed_user_site = True
    try:
        import ssl
    finally:
        if removed_user_site and user_site not in sys.path:
            sys.path.insert(0, user_site)
app_spec = str(payload.get("target") or "")
app_module = app_spec.split(":", 1)[0].strip()
if app_module.endswith(".py"):
    app_module = app_module[:-3].replace("/", ".").replace("\\\\", ".")
app_root = app_module.split(".", 1)[0] if app_module else ""
working_directory = os.path.abspath(payload.get("cwd") or os.getcwd())
for module_name, module in list(sys.modules.items()):
    module_file = str(getattr(module, "__file__", "") or "")
    project_local = False
    if module_file:
        try:
            project_local = os.path.commonpath([working_directory, os.path.abspath(module_file)]) == working_directory
        except (OSError, ValueError):
            project_local = False
    target_module = bool(app_root) and (module_name == app_root or module_name.startswith(app_root + "."))
    if project_local or target_module:
        sys.modules.pop(module_name, None)
importlib.invalidate_caches()
info = edgeterm_wsgi.create_instance(
    payload.get("mode") or "flask",
    payload.get("target") or "",
    payload.get("cwd") or os.getcwd(),
    instance_id=payload.get("instanceId") or "",
    route_prefix=payload.get("routePrefix") or "",
)
json.dumps(info)
`);
    scheduleWorkspaceSync();
    return JSON.parse(String(text || "{}"));
  }
  if (op === "pythonAppDispatch") {
    pyodide.globals.set("__edgeterm_app_request_json", JSON.stringify(payload || {}));
    const text = await pyodide.runPythonAsync(`
import json
import os
import sys

for command_path in ("/bin/bigbox", "/bin"):
    try:
        sys.path.remove(command_path)
    except ValueError:
        pass
cached_base64 = sys.modules.get("base64")
if cached_base64 is not None and str(getattr(cached_base64, "__file__", "")).startswith(("/bin/bigbox", "/bin")):
    del sys.modules["base64"]
rootfs_lib = os.environ.get("EDGETERM_ROOTFS_LIB", "/usr/lib")
if rootfs_lib and os.path.isdir(rootfs_lib) and rootfs_lib not in sys.path:
    sys.path.insert(0, rootfs_lib)

import base64
import edgeterm_wsgi

request_data = json.loads(__edgeterm_app_request_json)
request_body = request_data.get("body", "")
request_body_b64 = request_data.get("bodyBase64", "")
if request_body_b64:
    request_body = base64.b64decode(request_body_b64)

result = await edgeterm_wsgi.dispatch_instance(
    request_data.get("instanceId") or "",
    path=request_data.get("path", "/"),
    method=request_data.get("method", "GET"),
    query_string=request_data.get("query_string", ""),
    headers=request_data.get("headers", {}),
    body=request_body,
)
json.dumps(result)
`);
    return JSON.parse(String(text || "{}"));
  }
  if (op === "chdir") {
    if (!pyodide.FS.analyzePath(path).exists || !statInfoFollowingLink(path).isDir) throw new Error("Path is not a directory");
    pyodide.FS.chdir(path);
    pyodide.runPython(`
import builtins, os
target = ${JSON.stringify(path)}
os.chdir(target)
shell = getattr(builtins, "EDGETERM_SHELL", None)
if shell is not None:
    shell.logical_cwd = target
    shell._sync_env()
`);
    return { ok: true, cwd: path };
  }
  if (op === "ensureUser") {
    const user = String(payload.user || "user");
    if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error("Invalid username");
    const runtimeHome = `/home/${user}`;
    const target = mountedWorkspaceRoot ? `${mountedWorkspaceRoot}/home/${user}` : runtimeHome;
    ensureDir(target);
    ensureDir("/home");
    if (mountedWorkspaceRoot && !pyodide.FS.analyzePath(runtimeHome).exists) pyodide.FS.symlink(target, runtimeHome);
    if (workspaceMounted) await syncfs(false);
    return { ok: true, path: runtimeHome };
  }
  throw new Error(`Unsupported worker fs op: ${op}`);
}

async function mountWorkspaceStorage({ workspaceId = "", users = ["user"] } = {}) {
  if (!workspaceId || workspaceMounted) return false;
  ensureDir("/workspace-store");
  const workspaceRoot = `/workspace-store/${workspaceId}`;
  mountedWorkspaceRoot = workspaceRoot;
  // The main thread already prunes heavy runtime entries before creating this
  // worker. Repeating the IndexedDB scan here can wait indefinitely when
  // another tab still owns a connection, blocking the shell's ready signal.
  ensureDir(workspaceRoot);
  pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, workspaceRoot);
  workspaceMounted = true;
  const nativeLoad = syncfsRaw(true).finally(() => {
    if (workspaceStorageLoadPromise === nativeLoad) workspaceStorageLoadPromise = null;
  });
  workspaceStorageLoadPromise = nativeLoad;
  await nativeLoad;

  const homeRoot = `${workspaceRoot}/home`;
  const hasNativeHomeData = pyodide.FS.analyzePath(homeRoot).exists
    && pyodide.FS.readdir(homeRoot).some((entry) => entry !== "." && entry !== "..");
  if (!hasNativeHomeData) {
    const applied = await hydrateWorkspaceStorageFromIdb(workspaceId, workspaceRoot);
    if (applied) post({ type: "boot", message: `Legacy workspace restored · ${applied} entries` });
  }

  ensureDir(`${workspaceRoot}/home`);
  const persistedSystemRoot = `${workspaceRoot}/home/.edgeterm-system`;
  ensureDir(persistedSystemRoot);
  ensureDir(`${workspaceRoot}/overlay`);
  ensureDir(`${workspaceRoot}/overlay/upper`);
  ensureDir(`${workspaceRoot}/overlay/work`);
  ensureDir(`${workspaceRoot}/etc`);
  ensureDir(`${workspaceRoot}/var`);
  ensureDir(`${workspaceRoot}/var/lib`);
  ensureDir(`${workspaceRoot}/var/cache`);
  ensureDir(`${workspaceRoot}/var/log`);
  const persistedRuntimePaths = [
    ["/etc/appmode", "etc/appmode", true],
    ["/etc/apt", "etc/apt", true],
    ["/etc/dpkg", "etc/dpkg", true],
    ["/var/lib", "var/lib", true],
    ["/var/cache/apt", "var/cache/apt", true],
    ["/var/log", "var/log", true],
    ["/usr/local", "usr/local", false],
    ["/opt", "opt", false],
  ];
  for (const [runtimePath, relativePath, seedExisting] of persistedRuntimePaths) {
    const storagePath = `${persistedSystemRoot}/${relativePath}`;
    migratePersistedRuntimePath(workspaceRoot, relativePath, storagePath);
    await persistWorkerRootPath(runtimePath, storagePath, { seedExisting });
  }
  ensureDir("/packages");
  ensureDir("/var/cache/pkg");
  restoreExternalPackageManifestsFromStatus();
  ensureDir("/overlay");
  linkWorkspaceHomes(users?.length ? users : workspaceUsers(workspaceRoot));
  const restoredEntries = await restoreWorkerEntries(workspaceId);
  if (restoredEntries) post({ type: "boot", message: `Workspace journal restored · ${restoredEntries} entries` });
  registerPackageCommandLinks();
  return true;
}

function startPendingWorkspaceHydration() {
  if (!pendingWorkspaceHydration || workspaceStorageLoadPromise) return;
  const { workspaceId, workspaceRoot } = pendingWorkspaceHydration;
  pendingWorkspaceHydration = null;
  workspaceStorageLoadPromise = hydrateWorkspaceStorageFromIdb(workspaceId, workspaceRoot)
    .then((applied) => {
      post({ type: "boot", message: `Workspace restored · ${applied} entries` });
      restoreExternalPackageManifestsFromStatus();
      registerPackageCommandLinks();
    })
    .catch((error) => {
      post({ type: "stderr", text: `[storage] Workspace restore failed: ${error?.message || error}\n` });
    })
    .finally(() => {
      workspaceStorageLoadPromise = null;
      if (syncfsAgain) {
        syncfsAgain = false;
        scheduleWorkspaceSync();
      }
    });
}

async function waitForWorkspaceStorageReady() {
  if (pendingWorkspaceHydration && !workspaceStorageLoadPromise) startPendingWorkspaceHydration();
  if (workspaceStorageLoadPromise) await workspaceStorageLoadPromise;
}

async function terminalInput(prompt = "") {
  inputSequence += 1;
  const id = inputSequence;
  post({ type: "inputRequest", id, prompt: String(prompt || "") });
  return await new Promise((resolve) => pendingInputs.set(id, resolve));
}

self.term = {
  read(prompt = "") {
    return terminalInput(prompt);
  },
};
self.terminal = {
  input(prompt = "") {
    return terminalInput(prompt);
  },
  write(text = "", isError = false) {
    post({ type: isError ? "stderr" : "stdout", text: String(text || "") });
  },
};

async function seedBootRootfs(assetBase, version) {
  const response = await fetch(`${assetBase}bootfs.json?v=${encodeURIComponent(version)}`, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Failed to load bootfs.json (${response.status})`);
  const manifest = await response.json();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    const relative = String(file?.path || "").replaceAll("\\", "/").replace(/^\/+/, "");
    if (!relative || relative.includes("..")) continue;
    const fullPath = `/${relative}`;
    ensureDir(fullPath.split("/").slice(0, -1).join("/") || "/");
    const bytes = file.encoding === "base64" ? decodeBase64Bytes(file.data) : new TextEncoder().encode(String(file.data || ""));
    pyodide.FS.writeFile(fullPath, bytes);
  }
}

async function boot({ assetBase = "/static/", version = "", user = "user", workspaceId = "", displayInputSessionId: inputSessionId = "", users = ["user"] } = {}) {
  workerAssetBase = assetBase || "/static/";
  workerAssetVersion = version || "";
  displayInputSessionId = String(inputSessionId || workspaceId || "default");
  post({ type: "boot", message: "Loading Pyodide worker..." });
  const pyodideIndexURL = "https://cdn.jsdelivr.net/pyodide/v0.27.5/full/";
  importScripts(`${pyodideIndexURL}pyodide.js`);
  pyodide = await loadPyodide({ indexURL: pyodideIndexURL, fullStdLib: false });
  self.pyodide = pyodide;
  globalThis.pyodide = pyodide;
  pyodide.setStdout({ batched: (text) => post({ type: "stdout", text: String(text || "") }) });
  pyodide.setStderr({ batched: (text) => post({ type: "stderr", text: String(text || "") }) });
  post({ type: "boot", message: "Loading shell files..." });
  await seedBootRootfs(assetBase, version);
  registerPackageCommandLinks();
  post({ type: "boot", message: "Opening workspace files..." });
  await mountWorkspaceStorage({ workspaceId, users });
  ensureDir(`/home/${user}`);
  pyodide.globals.set("__edgeterm_user", user);
  pyodide.runPython(`
import os
import sys
os.environ["EDGE_USER"] = __edgeterm_user
os.environ["EDGETERM_ROOTFS_LIB"] = "/usr/lib"
if "/usr/lib" not in sys.path:
    sys.path.insert(0, "/usr/lib")
`);
  const shellCode = pyodide.FS.readFile("/bin/shell.py", { encoding: "utf8" });
  pyodide.runPython(shellCode);
  await pyodide.runPythonAsync(`
import builtins
shell = getattr(builtins, "EDGETERM_SHELL", None)
if shell is None:
    raise RuntimeError("EdgeTerm worker shell failed to initialize")
`);
  post({ type: "boot", message: "Preparing Python commands..." });
  await pyodide.runPythonAsync(`
from pyodide.console import PyodideConsole
`);
  installWorkerFsMutationTracking();
  workspaceMutationVersion = 0;
  shellReady = true;
  const cwd = pyodide.runPython(`
import builtins
getattr(builtins.EDGETERM_SHELL, "logical_cwd", "/home/user")
`);
  post({ type: "ready", cwd });
}

async function runCommand(id, line, cwd, environment = {}) {
  if (!shellReady) throw new Error("Worker shell is still starting");
  await waitForWorkspaceStorageReady();
  const mutationVersionBefore = workspaceMutationVersion;
  pyodide.globals.set("__edgeterm_line", String(line || ""));
  pyodide.globals.set("__edgeterm_command_cwd", normalizePath(cwd || "/home/user"));
  pyodide.globals.set(
    "__edgeterm_command_environment_json",
    JSON.stringify(environment && typeof environment === "object" ? environment : {}),
  );
  await pyodide.runPythonAsync(`
import builtins
import json
import os
shell = getattr(builtins, "EDGETERM_SHELL", None)
if shell is None:
    raise RuntimeError("EdgeTerm worker shell is not initialized")
target = globals().get("__edgeterm_command_cwd", "/home/user")
provided_environment = json.loads(globals().get("__edgeterm_command_environment_json", "{}"))
previous_environment = {}
for key, value in provided_environment.items():
    if not isinstance(key, str) or not key.replace("_", "a").isalnum() or (key and key[0].isdigit()):
        raise RuntimeError(f"Invalid environment key: {key}")
    previous_environment[key] = os.environ.get(key)
    os.environ[key] = str(value)
if getattr(shell, "logical_cwd", None) != target:
    os.chdir(target)
    shell.logical_cwd = target
    shell._sync_env()
try:
    await shell.run_line(__edgeterm_line)
except Exception as exc:
    if exc.__class__.__name__ == "ShellExit" and hasattr(exc, "code"):
        shell._set_status(exc.code)
    else:
        raise
finally:
    for key, value in previous_environment.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
`);
  const resultCwd = pyodide.runPython(`
import builtins
getattr(builtins.EDGETERM_SHELL, "logical_cwd", "/home/user")
`);
  const exitCode = Number(pyodide.runPython(`
import builtins
int(getattr(builtins.EDGETERM_SHELL, "last_status", 0))
`)) || 0;
  post({ type: "result", id, cwd: resultCwd, exitCode });
  if (workspaceMutationVersion !== mutationVersionBefore) setTimeout(scheduleWorkspaceSync, 0);
}

function serializeWorkerError(error) {
  const candidate = error?.stack || error?.message || error;
  try {
    const message = String(candidate || "").trim();
    if (message && message !== "[object Object]") return message;
  } catch {}
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {}
  return "Worker shell failed";
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "inputResponse") {
    const resolve = pendingInputs.get(message.id);
    pendingInputs.delete(message.id);
    resolve?.(String(message.value ?? ""));
    return;
  }
  if (message.type === "bridgeResponse") {
    const pending = pendingPageBridgeRequests.get(message.id);
    if (!pending) return;
    pendingPageBridgeRequests.delete(message.id);
    if (message.ok === false) pending.reject(new Error(message.error || "Page bridge request failed"));
    else pending.resolve(message.result);
    return;
  }
  if (message.type === "displayInputEvents") {
    const events = Array.isArray(message.events) ? message.events : [];
    displayInputQueue.push(...events);
    if (displayInputQueue.length > 200) displayInputQueue = displayInputQueue.slice(-200);
    return;
  }
  if (message.type === "boot") {
    boot(message)
      .catch((error) => post({ type: "error", id: message.id, error: serializeWorkerError(error) }));
    return;
  }
  if (message.type === "run") {
    runCommand(message.id, message.line, message.cwd, message.env)
      .catch((error) => post({ type: "error", id: message.id, error: serializeWorkerError(error) }));
    return;
  }
  if (message.type === "fs") {
    runFsOperation(message.op, message.payload || {})
      .then((result) => post({ type: "fsResult", id: message.id, result }))
      .catch((error) => post({ type: "fsError", id: message.id, error: serializeWorkerError(error) }));
  }
};
