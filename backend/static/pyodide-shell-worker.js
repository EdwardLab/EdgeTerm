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
let syncfsAgain = false;
let workspaceStorageLoadPromise = null;
let displayInputQueue = [];
let displayInputSessionId = "default";

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
    .catch((err) => post({ type: "stderr", text: `[storage] sync failed: ${err?.message || err}\n` }))
    .finally(() => {
      syncfsPromise = null;
      if (syncfsAgain) {
        syncfsAgain = false;
        scheduleWorkspaceSync();
      }
    });
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
}

async function unmountWorkspaceStorage() {
  if (!workspaceMounted || !mountedWorkspaceRoot) return;
  await syncfs(false);
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
    /^var$/,
    /^var\/lib$/,
    /^var\/lib\/pkg$/,
    /^var\/lib\/pkg\/status\.json$/,
    /^var\/lib\/pkg\/installed(?:\/[^/]+\.json)?$/,
    /^packages$/,
    /^packages\/[^/]+$/,
    /^packages\/[^/]+\/package\.json$/,
  ];
  if (preserve.some((pattern) => pattern.test(normalized))) return false;
  return true;
}

function workspaceStorageRelativePath(workspaceId, value) {
  const raw = typeof value === "string" ? value : String(value?.path || value?.name || value?.filename || value?.key || "");
  if (!raw) return "";
  let normalized = raw.replaceAll("\\", "/").replace(/^\/+/, "");
  const escapedId = String(workspaceId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  normalized = normalized.replace(new RegExp(`^workspace-store/${escapedId}/?`), "");
  normalized = normalized.replace(new RegExp(`^${escapedId}/?`), "");
  if (!normalized || normalized === "." || normalized.includes("..")) return "";
  return normalized;
}

function shouldHydrateWorkspaceStoragePath(path) {
  return (
    /^home(?:\/|$)/.test(path) ||
    /^etc\/appmode(?:\/|$)/.test(path) ||
    /^var\/lib\/pkg(?:\/|$)/.test(path) ||
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
  try {
    if (indexedDB.databases) {
      for (const db of await indexedDB.databases()) {
        if (db?.name && /EM_FS_|workspace-store/.test(db.name)) dbNames.add(db.name);
      }
    }
  } catch {}
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
  const dbNames = new Set([`EM_FS_${workspaceRoot}`, "EM_FS_/workspace-store"]);
  try {
    if (indexedDB.databases) {
      for (const db of await indexedDB.databases()) {
        if (db?.name && /EM_FS_|workspace-store/.test(db.name)) dbNames.add(db.name);
      }
    }
  } catch {}
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
  const stat = isLink ? pyodide.FS.stat(path) : linkStat;
  return {
    path,
    isDir: pyodide.FS.isDir(stat.mode),
    isFile: pyodide.FS.isFile(stat.mode),
    isLink,
    size: Number(stat.size || 0),
    mtime: stat.mtime instanceof Date ? stat.mtime.getTime() : Number(stat.mtime || Date.now()),
    mode: stat.mode,
  };
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

function normalizeWasmCommandEntries(manifest, packageName) {
  const entries = [];
  const append = (commandName, definition = {}) => {
    const entry = typeof definition === "string" ? { launcher: definition } : { ...definition };
    const launcher = entry.launcher || entry.js || entry.main || manifest.launcher || manifest.main || commandName;
    const wasm = entry.wasm || manifest.wasm || `${commandName}.wasm`;
    const packageRoot = packageRootPath(packageName);
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
  if (!pyodide?.FS?.analyzePath("/packages").exists) return registry;
  for (const packageName of pyodide.FS.readdir("/packages")) {
    if (packageName === "." || packageName === "..") continue;
    const manifestPath = `/packages/${packageName}/package.json`;
    if (!pyodide.FS.analyzePath(manifestPath).exists) continue;
    try {
      const manifest = readJsonFile(manifestPath);
      for (const entry of normalizeWasmCommandEntries(manifest, packageName)) registry.set(entry.command, entry);
    } catch (error) {
      post({ type: "stderr", text: `[WASM] Invalid package manifest ${manifestPath}: ${error?.message || error}\n` });
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

function collectWasmSyncRoots(cwd, args, entry, env = {}) {
  let requestedRoots = [];
  try {
    requestedRoots = env.EDGETERM_WASM_SYNC_ROOTS ? JSON.parse(String(env.EDGETERM_WASM_SYNC_ROOTS)) : [];
  } catch {
    requestedRoots = [];
  }
  const roots = new Set(
    Array.isArray(requestedRoots) && requestedRoots.length
      ? requestedRoots.map((root) => normalizePath(root)).filter(Boolean)
      : ["/home", "/tmp", "/var", "/etc", "/packages"]
  );
  if (entry?.packageName === "php" || entry?.command === "php") roots.add("/packages/php");
  roots.add(cwd || "/");
  for (const arg of args || []) {
    if (!arg || String(arg).startsWith("-")) continue;
    const path = String(arg).startsWith("/") ? normalizePath(arg) : normalizePath(`${cwd || "/"}/${arg}`);
    if (pyodide.FS.analyzePath(path).exists) roots.add(path);
  }
  return [...roots].sort();
}

function serializeFsTree(sourcePath, targetPath = sourcePath, out = []) {
  if (!pyodide.FS.analyzePath(sourcePath).exists) return out;
  const stat = pyodide.FS.stat(sourcePath);
  if (pyodide.FS.isDir(stat.mode)) {
    out.push({ path: targetPath, dir: true });
    for (const entry of pyodide.FS.readdir(sourcePath)) {
      if (entry === "." || entry === "..") continue;
      serializeFsTree(`${sourcePath}/${entry}`, `${targetPath}/${entry}`, out);
    }
    return out;
  }
  out.push({ path: targetPath, dir: false, data: pyodide.FS.readFile(sourcePath) });
  return out;
}

function applyFsEntries(entries = []) {
  for (const entry of entries) {
    if (!entry?.path) continue;
    if (entry.dir) {
      ensureDir(entry.path);
      continue;
    }
    ensureDir(entry.path.split("/").slice(0, -1).join("/") || "/");
    pyodide.FS.writeFile(entry.path, new Uint8Array(entry.data || []));
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
  const env = JSON.parse(envJson || "{}");
  const effectiveArgs = entry.command === "sqlite3" && !stdinText && args.length === 0 ? ["-interactive"] : args;
  const syncRoots = collectWasmSyncRoots(cwd || "/", effectiveArgs, entry, env);
  const fsEntries = [];
  for (const root of syncRoots) serializeFsTree(root, root, fsEntries);
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
        applyFsEntries(data.fsEntries || []);
        if (workspaceMounted) await syncfs(false);
        finish({
          found: true,
          code: Number(data.code || 0),
          stdout: data.stdout || "",
          stderr: data.stderr || "",
          sapi: !!data.sapi,
        });
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
        ...(entry.packageName === "php" || entry.command === "php" ? { intl: "/packages/php/intl.so" } : {}),
        ...(entry.manifest?.extensions || {}),
      },
      fsEntries,
      syncRoots,
      streamOutput: (entry.packageName === "php" || entry.command === "php") && String(env.EDGETERM_PHP_STREAM || "") !== "0",
      phpRequest: env.EDGETERM_PHP_SAPI_REQUEST ? JSON.parse(String(env.EDGETERM_PHP_SAPI_REQUEST || "{}")) : null,
      ttyBrokerUrl: self.location.origin,
      ttySessionId: `worker-tty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      debug: false,
    });
  });
}

async function runFsOperation(op, payload = {}) {
  const path = String(payload.path || "/");
  if (op === "list") {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (!pyodide.FS.analyzePath(normalized).exists) return { path: normalized, exists: false, entries: [] };
    const info = statInfo(normalized);
    if (!info.isDir) return { path: normalized, exists: true, isDir: false, entries: [] };
    const entries = pyodide.FS
      .readdir(normalized)
      .filter((entry) => entry !== "." && entry !== "..")
      .sort()
      .map((name) => {
        const fullPath = normalized === "/" ? `/${name}` : `${normalized}/${name}`;
        return { name, ...statInfo(fullPath) };
      });
    return { path: normalized, exists: true, isDir: true, entries };
  }
  if (op === "mkdir") {
    ensureDir(path);
    if (workspaceMounted) await syncfs(false);
    return { ok: true };
  }
  if (op === "writeFile") {
    ensureDir(path.split("/").slice(0, -1).join("/") || "/");
    const data = payload.encoding === "base64" ? decodeBase64Bytes(payload.data) : String(payload.data || "");
    pyodide.FS.writeFile(path, data);
    if (workspaceMounted) await syncfs(false);
    return { ok: true };
  }
  if (op === "readFile") {
    if (!pyodide.FS.analyzePath(path).exists) return { path, exists: false, text: "" };
    const info = statInfo(path);
    if (info.isDir) return { path, exists: true, isDir: true, text: "" };
    if (payload.encoding === "base64") {
      const bytes = pyodide.FS.readFile(path);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return { path, exists: true, isDir: false, data: btoa(binary), size: bytes.length };
    }
    return { path, exists: true, isDir: false, text: pyodide.FS.readFile(path, { encoding: "utf8" }) };
  }
  if (op === "stat") {
    if (!pyodide.FS.analyzePath(path).exists) return { path, exists: false };
    return { ...statInfo(path), exists: true };
  }
  if (op === "unlink") {
    if (pyodide.FS.analyzePath(path).exists) pyodide.FS.unlink(path);
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
    pyodide.globals.set("__edgeterm_edgeserve_json", JSON.stringify(payload || {}));
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

import edgeterm_wsgi

payload = json.loads(__edgeterm_edgeserve_json)
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
    if (!pyodide.FS.analyzePath(path).exists || !statInfo(path).isDir) throw new Error("Path is not a directory");
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
  const pruned = await pruneWorkerBootIdbStorage(workspaceId, workspaceRoot);
  if (pruned) post({ type: "stderr", text: `[storage] Pruned ${pruned} package/cache entries before workspace load.\n` });
  ensureDir(workspaceRoot);
  pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, workspaceRoot);
  workspaceMounted = true;

  ensureDir(`${workspaceRoot}/home`);
  ensureDir(`${workspaceRoot}/overlay`);
  ensureDir(`${workspaceRoot}/overlay/upper`);
  ensureDir(`${workspaceRoot}/overlay/work`);
  ensureDir(`${workspaceRoot}/etc`);
  ensureDir(`${workspaceRoot}/var`);
  ensureDir(`${workspaceRoot}/var/lib`);
  ensureDir(`${workspaceRoot}/var/cache`);
  await persistWorkerRootPath("/etc/appmode", `${workspaceRoot}/etc/appmode`, { seedExisting: true });
  await persistWorkerRootPath("/var/lib/pkg", `${workspaceRoot}/var/lib/pkg`, { seedExisting: true });
  ensureDir("/packages");
  ensureDir("/var/cache/pkg");
  restoreExternalPackageManifestsFromStatus();
  ensureDir("/overlay");
  linkWorkspaceHomes(users?.length ? users : workspaceUsers(workspaceRoot));
  registerPackageCommandLinks();
  pendingWorkspaceHydration = { workspaceId, workspaceRoot };
  return true;
}

function startPendingWorkspaceHydration() {
  if (!pendingWorkspaceHydration || workspaceStorageLoadPromise) return;
  const { workspaceId, workspaceRoot } = pendingWorkspaceHydration;
  pendingWorkspaceHydration = null;
  workspaceStorageLoadPromise = hydrateWorkspaceStorageFromIdb(workspaceId, workspaceRoot)
    .then((applied) => {
      post({ type: "stderr", text: `[storage] Workspace files restored (${applied} entries).\n` });
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
  shellReady = true;
  const cwd = pyodide.runPython(`
import builtins
getattr(builtins.EDGETERM_SHELL, "logical_cwd", "/home/user")
`);
  post({ type: "ready", cwd });
  setTimeout(startPendingWorkspaceHydration, 0);
}

async function runCommand(id, line) {
  if (!shellReady) throw new Error("Worker shell is still starting");
  pyodide.globals.set("__edgeterm_line", String(line || ""));
  await pyodide.runPythonAsync(`
import builtins
shell = getattr(builtins, "EDGETERM_SHELL", None)
if shell is None:
    raise RuntimeError("EdgeTerm worker shell is not initialized")
try:
    await shell.run_line(__edgeterm_line)
except Exception as exc:
    if exc.__class__.__name__ == "ShellExit" and hasattr(exc, "code"):
        shell._set_status(exc.code)
    else:
        raise
`);
  const cwd = pyodide.runPython(`
import builtins
getattr(builtins.EDGETERM_SHELL, "logical_cwd", "/home/user")
`);
  scheduleWorkspaceSync();
  post({ type: "result", id, cwd });
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
      .catch((error) => post({ type: "error", id: message.id, error: error?.stack || error?.message || String(error) }));
    return;
  }
  if (message.type === "run") {
    runCommand(message.id, message.line)
      .catch((error) => post({ type: "error", id: message.id, error: error?.stack || error?.message || String(error) }));
    return;
  }
  if (message.type === "fs") {
    runFsOperation(message.op, message.payload || {})
      .then((result) => post({ type: "fsResult", id: message.id, result }))
      .catch((error) => post({ type: "fsError", id: message.id, error: error?.stack || error?.message || String(error) }));
  }
};
