import { BrowserNpmCache } from "./npm-cache.js";
import { BrowserNpmInstaller } from "./npm-installer.js";
import { NpmRegistryClient, parsePackageSpec } from "./npm-registry.js";

const NPM_VERSION = "0.1.0-edgeterm";

function runtimeError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function normalizePath(value) {
  const raw = String(value || "/").replaceAll("\\", "/");
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function joinPath(...values) {
  return normalizePath(values.join("/"));
}

export function tokenizeCommand(source) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of String(source || "")) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped || quote) {
    throw runtimeError("node_command_parse_failed", "The command contains an unfinished quote or escape.");
  }
  if (current) tokens.push(current);
  return tokens;
}

function splitCommandChain(source) {
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "&" && source[index + 1] === "&") {
      if (current.trim()) parts.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function isNodeCommand(source) {
  const commands = splitCommandChain(String(source || ""));
  if (!commands.length) return false;
  return commands.every((command, index) => {
    const tokens = tokenizeCommand(command);
    if (index === 0 && tokens[0] === "cd" && tokens.length === 2) return true;
    return ["npm", "npx", "node"].includes(tokens[0]);
  }) && commands.some((command) =>
    ["npm", "npx", "node"].includes(tokenizeCommand(command)[0]),
  );
}

export function frontendAdapterOptions(command, args = []) {
  const executable = String(command || "");
  const mode = String(args[0] || "dev");
  if (executable === "vite" || executable === "react-scripts") {
    return {
      framework: executable === "vite" ? "vite" : "react",
      mode,
      production: mode === "build",
      preview: mode !== "build",
      watch: mode !== "build" && mode !== "preview",
    };
  }
  if (executable !== "next") return null;
  if (!["dev", "build", "start", "export"].includes(mode)) {
    return {
      framework: "nextjs-static",
      mode,
      unsupported: true,
    };
  }
  return {
    framework: "nextjs-static",
    mode,
    production: mode !== "dev",
    preview: mode === "dev" || mode === "start",
    watch: mode === "dev",
  };
}

export function inlineNodeCodeNeedsWorkspace(args = []) {
  const mode = String(args[0] || "");
  if (!["-e", "--eval", "-p", "--print"].includes(mode)) return true;
  const source = String(args[1] || "");
  return /\b(?:require|import)\s*\(|\b(?:readFile|writeFile|appendFile|open|chdir)\b|\bprocess\s*\.\s*cwd\b|(?:node:)?(?:fs|path)\b/.test(
    source,
  );
}

class WorkerRequestClient {
  constructor({
    url,
    onOutput = () => {},
    onProgress = () => {},
    crashCode = "node_worker_crashed",
    crashMessage = "The runtime worker stopped unexpectedly.",
  }) {
    this.url = url;
    this.onOutput = onOutput;
    this.onProgress = onProgress;
    this.crashCode = crashCode;
    this.crashMessage = crashMessage;
    this.worker = null;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(this.url, { type: "module" });
    this.worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "output") {
        this.onOutput(message.stream || "stdout", message.text || "");
        return;
      }
      if (message.type === "progress") {
        this.onProgress(message);
        return;
      }
      if (message.type === "runtime-diagnostic") {
        console.error("[NODE WORKER] " + String(message.message || "Runtime diagnostic"));
        return;
      }
      const request = this.pending.get(String(message.requestId || ""));
      if (!request) return;
      if (message.type === "result") {
        this.pending.delete(String(message.requestId || ""));
        request.resolve(message.result);
      } else if (message.type === "error") {
        this.pending.delete(String(message.requestId || ""));
        request.reject(
          runtimeError(
            message.error?.code || "node_worker_failed",
            message.error?.message || "Node worker failed.",
            { stack: message.error?.stack || "" },
          ),
        );
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      console.error("[NODE] Runtime worker crashed " + JSON.stringify({
        message: String(event.message || ""),
        filename: String(event.filename || ""),
        lineno: Number(event.lineno || 0),
        colno: Number(event.colno || 0),
        error: event.error ? String(event.error.stack || event.error.message || event.error) : "",
      }));
      const error = runtimeError(
        this.crashCode,
        this.crashMessage,
        { workerMessage: String(event.message || "") },
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    return this.worker;
  }

  async request(type, payload = {}) {
    const requestId = crypto.randomUUID();
    const worker = this.ensureWorker();
    const promise = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });
    worker.postMessage({ type, requestId, payload });
    return await promise;
  }

  cancel(code = "node_command_cancelled") {
    const error = runtimeError(code, "The Node task was cancelled.");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

function packageNameFromBin(command) {
  if (command.startsWith("@")) return command;
  return command;
}

export class EdgeTermNodeRuntime {
  constructor({
    fs,
    assetUrl,
    output = () => {},
    progress = () => {},
    confirm = async () => false,
    startPreview = async () => null,
    refreshPreview = async () => null,
    stopPreview = () => {},
    onStatus = () => {},
  } = {}) {
    this.fs = fs;
    this.assetUrl = assetUrl;
    this.output = output;
    this.progress = progress;
    this.confirm = confirm;
    this.startPreview = startPreview;
    this.refreshPreview = refreshPreview;
    this.stopPreview = stopPreview;
    this.onStatus = onStatus;
    this.cache = new BrowserNpmCache();
    this.registry = new NpmRegistryClient({ cache: this.cache });
    this.installer = new BrowserNpmInstaller({
      fs,
      registry: this.registry,
      onProgress: (event) => this.reportProgress(event),
    });
    this.edgeWorker = new WorkerRequestClient({
      url: assetUrl("node-runtime/node-runtime-worker-v9-sdk011.js"),
      onOutput: (stream, text) => this.output(stream, text),
      onProgress: (event) => this.reportProgress(event),
      crashCode: "node_runtime_smoke_failed",
      crashMessage:
        "The Edge.js runtime could not start in this browser. npm frontend commands remain available.",
    });
    this.buildWorker = new WorkerRequestClient({
      url: assetUrl("node-runtime/frontend-build-worker.js"),
      onProgress: (event) => this.reportProgress(event),
      crashCode: "frontend_build_worker_crashed",
      crashMessage:
        "The frontend build worker stopped unexpectedly. Retry the build to start a new worker.",
    });
    this.state = {
      phase: "idle",
      ready: false,
      running: false,
      runtimeVersion: "",
      lastError: null,
      lastResult: null,
      preview: null,
      progress: null,
    };
    this.watchTimer = null;
    this.watchRoot = "";
    this.watchFingerprint = "";
    this.watchRunning = false;
    this.installProgressCount = 0;
    this.lastProgressMessage = "";
  }

  reportProgress(event) {
    this.state.phase = String(event.phase || this.state.phase);
    const message = String(event.message || "");
    const completedValue = Number(event.completed ?? event.current ?? 0);
    const totalValue = Number(event.total ?? 0);
    const explicitPercent = Number(event.percent);
    const completed = Number.isFinite(completedValue) && completedValue > 0
      ? completedValue
      : String(event.phase || "") === "download"
        ? this.installProgressCount + 1
        : this.installProgressCount;
    const percent = Number.isFinite(explicitPercent)
      ? Math.max(0, Math.min(explicitPercent, 100))
      : totalValue > 0
        ? Math.max(0, Math.min((completed / totalValue) * 100, 100))
        : null;
    this.state.progress = {
      phase: this.state.phase,
      message,
      completed,
      total: totalValue > 0 ? totalValue : null,
      percent,
      indeterminate: percent == null,
      updatedAt: Date.now(),
    };
    if (message && message !== this.lastProgressMessage) {
      const packageProgress = ["resolve", "download"].includes(String(event.phase || ""));
      if (packageProgress) {
        if (event.phase === "download") this.installProgressCount += 1;
        if (
          (event.phase === "resolve" && this.installProgressCount === 0) ||
          (event.phase === "download" &&
            (this.installProgressCount === 1 || this.installProgressCount % 10 === 0))
        ) {
          this.output("stdout", `${message}\n`);
        }
      } else {
        this.output("stdout", `${message}\n`);
      }
      this.lastProgressMessage = message;
    }
    this.progress(event);
    this.onStatus(this.status());
  }

  status() {
    const lastResult = this.state.lastResult;
    const compactLastResult = lastResult
      ? {
          status: String(lastResult.status || "completed"),
          exitCode: lastResult.exitCode ?? lastResult.exit_code ?? null,
          summary: String(lastResult.summary || lastResult.message || "").slice(0, 1_000),
          runtimeVersion: String(lastResult.runtimeVersion || ""),
          framework: String(lastResult.framework || ""),
          outputDirectory: String(lastResult.outputDirectory || ""),
          fileCount: Array.isArray(lastResult.files) ? lastResult.files.length : null,
          installedCount: Array.isArray(lastResult.installed) ? lastResult.installed.length : null,
        }
      : null;
    return {
      ...this.state,
      lastResult: compactLastResult,
      experimental: true,
      npmVersion: NPM_VERSION,
      watching: Boolean(this.watchTimer),
      watchRoot: this.watchRoot,
    };
  }

  async prepare() {
    this.state.phase = "prepare";
    this.state.lastError = null;
    this.state.progress = {
      phase: "prepare",
      message: "Preparing the browser runtime...",
      completed: 0,
      total: null,
      percent: null,
      indeterminate: true,
      updatedAt: Date.now(),
    };
    this.onStatus(this.status());
    try {
      const result = await this.edgeWorker.request("prepare");
      this.state.ready = true;
      this.state.phase = "ready";
      this.state.runtimeVersion = String(result.runtimeVersion || "");
      this.state.lastResult = result;
      this.state.progress = {
        phase: "ready",
        message: "Browser runtime ready.",
        completed: 1,
        total: 1,
        percent: 100,
        indeterminate: false,
        updatedAt: Date.now(),
      };
      return { ...result, status: this.status() };
    } catch (error) {
      console.error("[NODE] Runtime preparation failed", error);
      this.state.ready = false;
      this.state.phase = "failed";
      this.state.lastError = {
        code: error.code || "node_runtime_prepare_failed",
        message: error.message || String(error),
      };
      throw error;
    } finally {
      this.onStatus(this.status());
    }
  }

  async storageStatus() {
    const cache = await this.cache.estimate();
    let storage = {};
    try {
      storage = (await globalThis.navigator?.storage?.estimate?.()) || {};
    } catch {
      storage = {};
    }
    return {
      cache,
      quota: Number(storage?.quota || 0),
      usage: Number(storage?.usage || 0),
      remaining: Math.max(0, Number(storage?.quota || 0) - Number(storage?.usage || 0)),
    };
  }

  async assertStorageAvailable() {
    const storage = await this.storageStatus();
    if (storage.quota && storage.remaining < Math.min(100 * 1024 * 1024, storage.quota * 0.1)) {
      throw runtimeError(
        "node_storage_quota_low",
        "Browser storage is almost full. Clear the npm cache or remove unused workspace dependencies.",
        storage,
      );
    }
    return storage;
  }

  async projectFiles(root, { includeNodeModules = true } = {}) {
    return await this.fs.readTree(root, {
      includeNodeModules,
      maxFiles: 30_000,
      maxBytes: 150 * 1024 * 1024,
    });
  }

  async runEdge(root, args, env = {}) {
    await this.prepare();
    const versionOnly =
      args.length === 1 && ["--version", "-v"].includes(String(args[0] || ""));
    const files = versionOnly || !inlineNodeCodeNeedsWorkspace(args)
      ? []
      : await this.projectFiles(root, { includeNodeModules: true });
    this.state.running = true;
    this.state.phase = "execute";
    this.onStatus(this.status());
    try {
      const result = await this.edgeWorker.request("run", {
        args,
        cwd: "/workspace",
        env: {
          NODE_ENV: "development",
          HOME: "/workspace",
          PATH: "/workspace/node_modules/.bin:/usr/bin:/bin",
          ...env,
        },
        files,
      });
      this.state.lastResult = result;
      this.state.phase = result.exitCode === 0 ? "ready" : "failed";
      return result;
    } finally {
      this.state.running = false;
      this.onStatus(this.status());
    }
  }

  async buildFrontend(root, { production = false, preview = false, watch = false } = {}) {
    this.state.running = true;
    this.state.phase = "build";
    this.onStatus(this.status());
    try {
      const files = await this.projectFiles(root, { includeNodeModules: true });
      const result = await this.buildWorker.request("build", { files, production });
      await this.fs.removeTree(joinPath(root, result.outputDirectory || "dist"));
      await this.fs.writeFiles(
        result.files.map((file) => ({
          path: joinPath(root, file.path),
          encoding: file.encoding,
          data: file.data,
        })),
      );
      for (const warning of result.warnings || []) this.output("stderr", `warning: ${warning}\n`);
      this.output(
        "stdout",
        `Built ${result.files.length} files in ${joinPath(root, result.outputDirectory || "dist")}.\n`,
      );
      if (preview) {
        const previewTarget = result.outputDirectory || "dist";
        const samePreview =
          this.state.preview &&
          this.state.preview.projectRoot === root &&
          this.state.preview.target === previewTarget;
        if (samePreview) {
          await this.refreshPreview(this.state.preview);
        } else {
          if (this.state.preview) {
            await Promise.resolve(this.stopPreview(this.state.preview));
          }
          const previewResult = await this.startPreview({
            mode: "static",
            target: previewTarget,
            cwd: root,
            virtualPort: 3000,
            spaFallback: true,
          });
          this.state.preview = {
            ...previewResult,
            projectRoot: root,
            target: previewTarget,
          };
          this.output("stdout", "EdgeServe: http://127.0.0.1:3000\n");
        }
      } else if (this.state.preview) {
        await this.refreshPreview(this.state.preview);
      }
      if (watch) await this.startWatcher(root);
      this.state.phase = "ready";
      this.state.lastResult = result;
      return result;
    } finally {
      this.state.running = false;
      this.onStatus(this.status());
    }
  }

  async startWatcher(root) {
    this.stopWatcher();
    this.watchRoot = root;
    this.watchFingerprint = await this.fs.fingerprint(root, {
      exclude: ["node_modules", "dist", ".git"],
    });
    this.watchTimer = setInterval(async () => {
      if (this.watchRunning) return;
      this.watchRunning = true;
      try {
        const next = await this.fs.fingerprint(root, {
          exclude: ["node_modules", "dist", ".git"],
        });
        if (next && next !== this.watchFingerprint) {
          this.watchFingerprint = next;
          await this.buildFrontend(root, { preview: true, watch: false });
          this.output("stdout", "Frontend rebuilt after file changes.\n");
        }
      } catch (error) {
        this.output("stderr", `watch: ${error.message || error}\n`);
      } finally {
        this.watchRunning = false;
      }
    }, 900);
    return { watching: true, root };
  }

  stopWatcher() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.watchRoot = "";
    this.watchFingerprint = "";
    this.watchRunning = false;
  }

  async readProjectMetadata(root) {
    try {
      return JSON.parse(await this.fs.readText(joinPath(root, "package.json")));
    } catch (error) {
      throw runtimeError(
        "npm_package_json_invalid",
        `Unable to read package.json: ${error.message || error}`,
      );
    }
  }

  async resolvePackageBin(root, command, modulesPath = "node_modules") {
    const requestedName = packageNameFromBin(command);
    const candidates = [requestedName];
    if (modulesPath === "node_modules") {
      try {
        const rootMetadata = await this.readProjectMetadata(root);
        candidates.push(
          ...Object.keys({
            ...(rootMetadata.dependencies || {}),
            ...(rootMetadata.devDependencies || {}),
          }),
        );
      } catch {}
    }
    for (const packageName of [...new Set(candidates)]) {
      try {
        const metadata = JSON.parse(
          await this.fs.readText(joinPath(root, modulesPath, packageName, "package.json")),
        );
        const bin =
          typeof metadata.bin === "string"
            ? metadata.bin
            : metadata.bin?.[command] || metadata.bin?.[packageName.split("/").pop()];
        if (bin) {
          return joinPath(modulesPath, packageName, bin).replace(/^\/+/, "");
        }
      } catch {}
    }
    throw runtimeError("npm_executable_not_found", `No executable named ${command} is installed.`);
  }

  async runScriptText(root, script, { lifecycle = false } = {}) {
    const commands = splitCommandChain(String(script || ""));
    let result = { exitCode: 0 };
    for (const source of commands) {
      const tokens = tokenizeCommand(source);
      if (!tokens.length) continue;
      const [command, ...args] = tokens;
      const frontendAdapter = frontendAdapterOptions(command, args);
      if (frontendAdapter) {
        if (frontendAdapter.unsupported) {
          throw runtimeError(
            "next_command_unsupported",
            `Next.js ${frontendAdapter.mode} is not available in the browser-local static adapter.`,
          );
        }
        if (frontendAdapter.framework === "nextjs-static") {
          this.output(
            "stdout",
            `Next.js ${frontendAdapter.mode} is running through the EdgeTerm static adapter. SSR, API routes, and Server Actions are not enabled.\n`,
          );
        }
        result = {
          ...(await this.buildFrontend(root, {
            production: frontendAdapter.production,
            preview: frontendAdapter.preview,
            watch: frontendAdapter.watch,
          })),
          exitCode: 0,
        };
        continue;
      }
      if (command === "node") {
        result = await this.runEdge(root, args);
      } else {
        const binPath = await this.resolvePackageBin(root, command);
        result = await this.runEdge(root, [binPath, ...args], {
          npm_lifecycle_event: lifecycle ? "install" : "",
        });
      }
      if (Number(result.exitCode || 0) !== 0) return result;
    }
    return result;
  }

  async runLifecycleScripts(root, blockedScripts) {
    for (const packageInfo of blockedScripts || []) {
      const packageRoot = joinPath(root, packageInfo.installPath);
      for (const [name, script] of Object.entries(packageInfo.scripts || {})) {
        this.output("stdout", `Running ${packageInfo.package} ${name}...\n`);
        const result = await this.runScriptText(packageRoot, script, { lifecycle: true });
        if (Number(result.exitCode || 0) !== 0) {
          throw runtimeError(
            "npm_lifecycle_script_failed",
            `${packageInfo.package} ${name} failed with exit code ${result.exitCode}.`,
          );
        }
      }
    }
  }

  printInstallResult(result) {
    this.output(
      "stdout",
      `added ${result.packages} packages (${Math.round(result.expandedBytes / 1024)} KB)\n`,
    );
    for (const warning of result.warnings || []) this.output("stderr", `warning: ${warning}\n`);
    if (result.blockedScripts?.length) {
      const packages = result.blockedScripts.map((entry) => entry.package).join(", ");
      this.output(
        "stderr",
        `Install scripts were blocked for: ${packages}. Re-run with --allow-scripts to approve them.\n`,
      );
    }
  }

  async executeNpm(root, args) {
    this.state.lastError = null;
    this.state.running = true;
    this.state.phase = "npm";
    this.state.progress = {
      phase: "npm",
      message: "Starting npm...",
      completed: 0,
      total: null,
      percent: null,
      indeterminate: true,
      updatedAt: Date.now(),
    };
    this.onStatus(this.status());
    try {
      const result = await this.runNpm(root, args);
      this.state.lastResult = result;
      this.state.phase = "completed";
      this.state.progress = {
        phase: "completed",
        message: "npm completed.",
        completed: Math.max(1, this.installProgressCount),
        total: Math.max(1, this.installProgressCount),
        percent: 100,
        indeterminate: false,
        updatedAt: Date.now(),
      };
      return result;
    } catch (error) {
      const cancelled =
        error?.name === "AbortError" ||
        error?.code === "npm_request_cancelled" ||
        this.state.phase === "cancelled";
      this.state.lastError = {
        code: cancelled ? "npm_request_cancelled" : error.code || "npm_command_failed",
        message: cancelled ? "The npm task was cancelled." : error.message || String(error),
      };
      this.state.phase = cancelled ? "cancelled" : "failed";
      if (cancelled) {
        throw runtimeError("npm_request_cancelled", "The npm task was cancelled.");
      }
      throw error;
    } finally {
      this.state.running = false;
      this.onStatus(this.status());
    }
  }

  async runNpm(root, args) {
    this.registry.resetAbort();
    const command = args[0] || "";
    if (!command || command === "--help" || command === "help") {
      this.output(
        "stdout",
        "EdgeTerm npm supports install, ci, uninstall, run, exec, list, cache clean, and --version.\n",
      );
      return { exitCode: 0 };
    }
    if (command === "--version" || command === "-v") {
      this.output("stdout", `${NPM_VERSION}\n`);
      return { exitCode: 0, version: NPM_VERSION };
    }
    if (command === "install" || command === "i") {
      this.installProgressCount = 0;
      this.lastProgressMessage = "";
      this.output("stdout", "Resolving npm dependencies...\n");
      await this.assertStorageAvailable();
      const allowScripts = args.includes("--allow-scripts");
      const dev = args.includes("--save-dev") || args.includes("-D");
      const production = args.includes("--production") || args.includes("--omit=dev");
      const offline = args.includes("--offline");
      const supportedFlags = new Set([
        "--allow-scripts",
        "--ignore-scripts",
        "--save-dev",
        "-D",
        "--production",
        "--omit=dev",
        "--offline",
      ]);
      const packageSpecs = args
        .slice(1)
        .filter((value) => !value.startsWith("-"));
      const unsupported = args
        .slice(1)
        .filter((value) => value.startsWith("-") && !supportedFlags.has(value));
      if (unsupported.length) {
        throw runtimeError(
          "npm_flag_unsupported",
          `Unsupported npm flag: ${unsupported.join(", ")}`,
        );
      }
      this.registry.setOffline(offline);
      let result;
      try {
        result = await this.installer.install(root, {
          packages: packageSpecs,
          dev,
          production,
        });
      } finally {
        this.registry.setOffline(false);
        await this.fs.flush?.();
      }
      this.printInstallResult(result);
      if (allowScripts && result.blockedScripts.length) {
        const approved = await this.confirm(
          "Run package install scripts?",
          `${result.blockedScripts.length} packages requested lifecycle scripts. These scripts can execute code in the local workspace.`,
        );
        if (!approved) {
          throw runtimeError(
            "npm_lifecycle_scripts_not_approved",
            "Package install scripts were not approved.",
          );
        }
        await this.runLifecycleScripts(root, result.blockedScripts);
      }
      return { ...result, exitCode: 0 };
    }
    if (command === "ci") {
      this.installProgressCount = 0;
      this.lastProgressMessage = "";
      this.output("stdout", "Restoring npm dependencies from package-lock.json...\n");
      await this.assertStorageAvailable();
      const unsupported = args.slice(1).filter((value) => value !== "--offline");
      if (unsupported.length) {
        throw runtimeError(
          "npm_flag_unsupported",
          `Unsupported npm flag: ${unsupported.join(", ")}`,
        );
      }
      this.registry.setOffline(args.includes("--offline"));
      let result;
      try {
        result = await this.installer.ci(root);
      } finally {
        this.registry.setOffline(false);
        await this.fs.flush?.();
      }
      this.printInstallResult(result);
      return { ...result, exitCode: 0 };
    }
    if (command === "uninstall" || command === "remove" || command === "rm") {
      const packageNames = args.slice(1).map((value) => parsePackageSpec(value).name);
      if (!packageNames.length) {
        throw runtimeError("npm_package_spec_invalid", "Choose at least one package to uninstall.");
      }
      let result;
      try {
        result = await this.installer.uninstall(root, packageNames);
      } finally {
        await this.fs.flush?.();
      }
      this.output(
        "stdout",
        `removed ${result.removed} ${result.removed === 1 ? "package" : "packages"}\n`,
      );
      return { ...result, exitCode: 0 };
    }
    if (command === "list" || command === "ls") {
      const packages = await this.installer.list(root);
      for (const item of packages) {
        this.output(
          item.installed ? "stdout" : "stderr",
          `${item.installed ? "├──" : "└── missing"} ${item.name}@${item.version || item.requested}\n`,
        );
      }
      return { packages, exitCode: packages.some((item) => !item.installed) ? 1 : 0 };
    }
    if (command === "cache" && args[1] === "clean") {
      await this.cache.clear();
      this.output("stdout", "npm cache cleared.\n");
      return { exitCode: 0 };
    }
    if (command === "run" || command === "run-script") {
      const metadata = await this.readProjectMetadata(root);
      const scriptName = args[1] || "";
      if (!scriptName) {
        for (const [name, script] of Object.entries(metadata.scripts || {})) {
          this.output("stdout", `${name}: ${script}\n`);
        }
        return { exitCode: 0, scripts: metadata.scripts || {} };
      }
      const script = metadata.scripts?.[scriptName];
      if (!script) {
        throw runtimeError("npm_script_not_found", `Missing package script: ${scriptName}`);
      }
      const forwardedIndex = args.indexOf("--");
      const forwarded = forwardedIndex >= 0 ? args.slice(forwardedIndex + 1) : [];
      return await this.runScriptText(
        root,
        `${script}${forwarded.length ? ` ${forwarded.map((value) => JSON.stringify(value)).join(" ")}` : ""}`,
      );
    }
    if (command === "exec") {
      return await this.runNpx(root, args.slice(1));
    }
    throw runtimeError("npm_command_unsupported", `Unsupported npm command: ${command}`);
  }

  async runNpx(root, args) {
    this.registry.resetAbort();
    const [command, ...commandArgs] = args;
    if (!command) throw runtimeError("npm_executable_not_found", "Choose an executable to run.");
    const frontendAdapter = frontendAdapterOptions(command, commandArgs);
    if (frontendAdapter) {
      if (frontendAdapter.unsupported) {
        throw runtimeError(
          "next_command_unsupported",
          `Next.js ${frontendAdapter.mode} is not available in the browser-local static adapter.`,
        );
      }
      if (frontendAdapter.framework === "nextjs-static") {
        this.output(
          "stdout",
          `Next.js ${frontendAdapter.mode} is running through the EdgeTerm static adapter. SSR, API routes, and Server Actions are not enabled.\n`,
        );
      }
      return {
        ...(await this.buildFrontend(root, {
          production: frontendAdapter.production,
          preview: frontendAdapter.preview,
          watch: frontendAdapter.watch,
        })),
        exitCode: 0,
      };
    }
    let binPath;
    try {
      binPath = await this.resolvePackageBin(root, command);
    } catch (error) {
      if (!["fs_not_found", "npm_executable_not_found"].includes(error?.code)) throw error;
      await this.assertStorageAvailable();
      this.output("stdout", `Installing ${command} for this npm exec session...\n`);
      const installed = await this.installer.installTransient(root, command);
      await this.fs.flush?.();
      if (installed.blockedScripts.length) {
        throw runtimeError(
          "npm_lifecycle_scripts_blocked",
          `${command} requires an install script and cannot run without separate approval.`,
        );
      }
      binPath = await this.resolvePackageBin(root, installed.packageName, installed.modulesPath);
    }
    return await this.runEdge(root, [binPath, ...commandArgs]);
  }

  async runCommand(source, cwd) {
    const commands = splitCommandChain(String(source || ""));
    let root = normalizePath(cwd || "/home/user");
    let finalResult = { exitCode: 0, cwd: root };
    this.registry.resetAbort();
    this.state.lastError = null;
    this.state.running = true;
    this.state.phase = "command";
    this.onStatus(this.status());
    try {
      for (const sourceCommand of commands) {
        const tokens = tokenizeCommand(sourceCommand);
        const [command, ...args] = tokens;
        if (command === "cd") {
          if (args.length !== 1) {
            throw runtimeError("node_command_parse_failed", "cd requires exactly one path.");
          }
          root = args[0].startsWith("/")
            ? normalizePath(args[0])
            : joinPath(root, args[0]);
          finalResult = { exitCode: 0, cwd: root };
          continue;
        }
        let result;
        if (command === "npm") result = await this.runNpm(root, args);
        else if (command === "npx") result = await this.runNpx(root, args);
        else if (command === "node") result = await this.runEdge(root, args);
        else {
          throw runtimeError("node_command_unsupported", `Unsupported Node command: ${command}`);
        }
        finalResult = {
          ...result,
          exitCode: Number(result?.exitCode || 0),
          cwd: root,
          summary: result?.summary || `${command} completed`,
        };
        if (finalResult.exitCode !== 0) break;
      }
      this.state.lastResult = finalResult;
      return finalResult;
    } catch (error) {
      const cancelled =
        error?.code === "node_command_cancelled" || this.state.phase === "cancelled";
      if (cancelled) {
        this.state.lastError = null;
        this.state.phase = "cancelled";
        return {
          exitCode: 130,
          cwd: root,
          cancelled: true,
          summary: "Node command cancelled",
        };
      }
      this.state.lastError = {
        code: error.code || "node_command_failed",
        message: error.message || String(error),
      };
      this.state.phase = "failed";
      const errorCode = error.code || "node_command_failed";
      this.output("stderr", `${error.message || error} (${errorCode})\n`);
      return {
        exitCode: 1,
        cwd: root,
        error: error.message || String(error),
        errorCode: error.code || "node_command_failed",
      };
    } finally {
      this.state.running = false;
      this.onStatus(this.status());
    }
  }

  cancel() {
    this.stopWatcher();
    this.registry.cancel();
    this.edgeWorker.cancel();
    this.buildWorker.cancel("frontend_build_cancelled");
    if (this.state.preview) {
      try {
        this.stopPreview(this.state.preview);
      } catch {}
      this.state.preview = null;
    }
    this.state.running = false;
    this.state.phase = "cancelled";
    this.state.progress = {
      phase: "cancelled",
      message: "The npm task was cancelled.",
      completed: this.installProgressCount,
      total: null,
      percent: null,
      indeterminate: true,
      updatedAt: Date.now(),
    };
    this.onStatus(this.status());
    return { cancelled: true };
  }

  reset() {
    this.cancel();
    this.state = {
      phase: "idle",
      ready: false,
      running: false,
      runtimeVersion: "",
      lastError: null,
      lastResult: null,
      preview: null,
      progress: null,
    };
    return this.status();
  }
}

export function createEdgeTermNodeRuntime(options) {
  return new EdgeTermNodeRuntime(options);
}
