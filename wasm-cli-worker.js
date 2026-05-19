"use strict";

let stdinControl = null;
let stdinData = null;
let debugEnabled = false;
let ttyBrokerUrl = "";
let ttySessionId = "";

function debug(message) {
  if (debugEnabled) self.postMessage({ type: "debug", message });
}

function patchLauncherSource(source) {
  return String(source)
    .replace(/^#!.*(?:\r?\n|$)/, "")
    .replace(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];\s*/gm, 'const $1 = "$2";\n')
    .replace(/^export\s+\{[^}]*\};\s*/gm, "")
    .replace(/^export\s+const\s+/gm, "const ")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/\bvar wasmBinary;/, 'var wasmBinary=Module["wasmBinary"];')
    .replace(
      /var FS_stdin_getChar=\(\)=>\{[\s\S]*?\};var TTY=/,
      `var FS_stdin_getChar=()=>{if(!FS_stdin_getChar_buffer.length){var result=null;if(globalThis.__edgetermWorkerReadLine){try{var tty=typeof TTY!="undefined"&&TTY.ttys&&TTY.ttys[1];if(tty&&tty.output&&tty.output.length){out(UTF8ArrayToString(tty.output));tty.output=[]}}catch{}result=globalThis.__edgetermWorkerReadLine();if(result!==null&&result!==undefined){result+="\\n"}}else if(ENVIRONMENT_IS_NODE){var BUFSIZE=256;var buf=Buffer.alloc(BUFSIZE);var bytesRead=0;var fd=process.stdin.fd;try{bytesRead=fs.readSync(fd,buf,0,BUFSIZE)}catch(e){if(e.toString().includes("EOF"))bytesRead=0;else throw e}if(bytesRead>0){result=buf.slice(0,bytesRead).toString("utf-8")}}else{}if(result===null||result===undefined){return null}FS_stdin_getChar_buffer=intArrayFromString(result,true)}return FS_stdin_getChar_buffer.shift()};var TTY=`
    )
    .replace(
      /if\(!result\)\{return null\}/g,
      'if(!result&&globalThis.__edgetermWorkerReadLine){result=globalThis.__edgetermWorkerReadLine();if(result!==null){result+="\\n"}}if(!result){return null}'
    )
    .replace(
      /if\(result===null\|\|result===undefined\)break;bytesRead\+\+;buffer\[offset\+i\]=result\}/g,
      "if(result===null||result===undefined)break;bytesRead++;buffer[offset+i]=result;if(result===10)break}"
    )
    .replace(
      /ws\.once\(event,listener\)\}\);const cancel=\(\)=>\{ws\.removeListener\(event,listener\);setTimeout\(resolve\)\}/g,
      `if(typeof ws.once==="function"){ws.once(event,listener)}else if(typeof ws.addEventListener==="function"){ws.addEventListener(event,listener,{once:true})}else{ws["on"+event]=listener}});const cancel=()=>{if(typeof ws.removeListener==="function"){ws.removeListener(event,listener)}else if(typeof ws.removeEventListener==="function"){ws.removeEventListener(event,listener)}else if(typeof ws.off==="function"){ws.off(event,listener)}else if(ws["on"+event]===listener){ws["on"+event]=null}setTimeout(resolve)}`
    );
}

function createWasmRuntimeModuleFactory(source) {
  const ttyHook = `
if (Module["__edgetermStdinChar"] && Module["__edgetermStdoutChar"] && Module["__edgetermStderrChar"]) {
  const __edgetermPreRun = () => {
    try {
      if (typeof FS !== "undefined" && typeof FS.init === "function") {
        FS.init(Module["__edgetermStdinChar"], Module["__edgetermStdoutChar"], Module["__edgetermStderrChar"]);
      }
    } catch {}
  };
  if (typeof Module["preRun"] === "function") {
    Module["preRun"] = [Module["preRun"]];
  } else if (!Array.isArray(Module["preRun"])) {
    Module["preRun"] = [];
  }
  Module["preRun"].push(__edgetermPreRun);
}
`;
  const normalizedSource = patchLauncherSource(source)
    .replace(/var Module\s*=\s*typeof Module\s*!=\s*['"]undefined['"]\s*\?\s*Module\s*:\s*\{\s*\}\s*;/, (m) => `${m}${ttyHook}`)
    .replace(/var Module=typeof Module!=['"]undefined['"]\?Module:\{\};/, (m) => `${m}${ttyHook}`)
    .replace(/var Module=typeof PHPLoader!=['"]undefined['"]\?PHPLoader:\{\};/, (m) => `${m}${ttyHook}`);
  if (/function init\s*\(\s*RuntimeName\s*,\s*PHPLoader\s*\)/.test(normalizedSource)) {
    const patchedSource = normalizedSource.replace(
      /Module\["onRuntimeInitialized"\]\?\.\(\);/,
      'Module["FS"]=FS;Module["callMain"]=callMain;Module["run"]=run;Module["onRuntimeInitialized"]?.();'
    );
    return async (moduleArg = {}) => {
      const phpRunner = new Function(
        "moduleArg",
        "globalThis",
        `${patchedSource}
return new Promise((resolve, reject) => {
  const originalAbort = moduleArg["onAbort"];
  moduleArg["noExitRuntime"] = true;
  moduleArg["noInitialRun"] = true;
  moduleArg["onAbort"] = (what) => {
    try {
      if (typeof originalAbort === "function") originalAbort(what);
    } catch {}
    reject(new Error(String(what || "aborted")));
  };
  moduleArg["onRuntimeInitialized"] = () => resolve(moduleArg);
  try {
    const runtimeName = typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope ? "WORKER" : "WEB";
    init(runtimeName, moduleArg);
  } catch (err) {
    reject(err);
  }
});`
      );
      const phpModule = await phpRunner(moduleArg, globalThis);
      phpModule.__edgetermRunCli = async (args = []) => {
        const extensionArgs = [];
        const extensions = { ...(moduleArg.extensions || {}) };
        try {
          if (!extensions.intl && phpModule.FS?.analyzePath?.("/packages/php/intl.so")?.exists) {
            extensions.intl = "/packages/php/intl.so";
          }
        } catch {}
        for (const extensionPath of Object.values(extensions)) {
          if (extensionPath) extensionArgs.push("-d", `extension=${extensionPath}`);
        }
        const cliArgs = [phpModule.thisProgram || moduleArg.thisProgram || "php", ...extensionArgs, ...args];
        for (const arg of cliArgs) phpModule.ccall("wasm_add_cli_arg", "number", ["string"], [String(arg)]);
        try {
          const result = phpModule.ccall("run_cli", "number", [], [], { async: true });
          return Number((result && typeof result.then === "function" ? await result : result) || 0);
        } catch (err) {
          if (
            err?.name === "ExitStatus" ||
            err?.constructor?.name === "ExitStatus" ||
            typeof err?.status === "number" ||
            typeof err?.code === "number"
          ) {
            return Number(err.status ?? err.code ?? 0);
          }
          throw err;
        }
      };
      phpModule.__edgetermRunSapiRequest = async (request = {}) => {
        if (!phpModule.__edgetermWebSapiInitialized) {
          try {
            phpModule.ccall("wasm_set_sapi_name", "number", ["string"], ["apache"]);
          } catch {}
          const initResult = phpModule.ccall("php_wasm_init", "number", [], [], { async: true });
          if (initResult && typeof initResult.then === "function") await initResult;
          phpModule.__edgetermWebSapiInitialized = true;
        }
        const callString = (name, value) => phpModule.ccall(name, "number", ["string"], [String(value ?? "")]);
        const callNumber = (name, value) => phpModule.ccall(name, "number", ["number"], [Number(value || 0)]);
        const addServer = (name, value) => phpModule.ccall("wasm_add_SERVER_entry", "number", ["string", "string"], [String(name), String(value ?? "")]);
        const unlinkIfExists = (path) => {
          try {
            if (phpModule.FS?.analyzePath?.(path)?.exists) phpModule.FS.unlink(path);
          } catch {}
        };
        const collectText = (chunks) => {
          const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return new TextDecoder().decode(bytes);
        };
        const stdoutChunks = [];
        const stderrChunks = [];
        const headerChunks = [];
        const previousStdout = phpModule.onStdout;
        const previousStderr = phpModule.onStderr;
        const previousHeaders = phpModule.onHeaders;
        phpModule.onStdout = (chunk) => stdoutChunks.push(new Uint8Array(chunk || []));
        phpModule.onStderr = (chunk) => stderrChunks.push(new Uint8Array(chunk || []));
        phpModule.onHeaders = (chunk) => headerChunks.push(new Uint8Array(chunk || []));
        let bodyPtr = 0;
        try {
          unlinkIfExists("/internal/stdout");
          unlinkIfExists("/internal/stderr");
          unlinkIfExists("/internal/headers.json");
          callString("wasm_set_path_translated", request.scriptFilename || "");
          callString("wasm_set_request_uri", request.requestUri || "/");
          callString("wasm_set_request_method", request.method || "GET");
          callString("wasm_set_request_host", request.serverName || "edgeterm.local");
          callString("wasm_set_query_string", request.query || "");
          callString("wasm_set_content_type", request.contentType || "");
          const bodyBytes = request.bodyBase64
            ? Uint8Array.from(atob(String(request.bodyBase64 || "")), (char) => char.charCodeAt(0))
            : new TextEncoder().encode(String(request.body || ""));
          if (bodyBytes.length) {
            const malloc = phpModule.malloc || phpModule._malloc;
            bodyPtr = malloc(bodyBytes.length || 1);
            phpModule.HEAPU8.set(bodyBytes, bodyPtr);
            callNumber("wasm_set_request_body", bodyPtr);
          }
          callNumber("wasm_set_content_length", bodyBytes.length);
          callString("wasm_set_cookies", request.cookie || "");
          callNumber("wasm_set_request_port", Number(request.serverPort || 443));
          addServer("DOCUMENT_ROOT", request.documentRoot || "");
          addServer("SCRIPT_FILENAME", request.scriptFilename || "");
          addServer("SCRIPT_NAME", request.scriptName || "");
          addServer("PHP_SELF", request.scriptName || "");
          addServer("PATH_INFO", request.pathInfo || "");
          addServer("PATH_TRANSLATED", request.pathInfo ? `${request.documentRoot || ""}${request.pathInfo}` : "");
          addServer("REQUEST_URI", request.requestUri || "/");
          addServer("REQUEST_METHOD", request.method || "GET");
          addServer("QUERY_STRING", request.query || "");
          addServer("SERVER_NAME", request.serverName || "edgeterm.local");
          addServer("SERVER_PORT", request.serverPort || "443");
          addServer("SERVER_PROTOCOL", "HTTP/1.1");
          addServer("HTTPS", "on");
          addServer("REMOTE_ADDR", "127.0.0.1");
          for (const [name, value] of Object.entries(request.headers || {})) {
            const lower = String(name).toLowerCase();
            const key = ["content-type", "content-length"].includes(lower) ? lower.toUpperCase().replace(/-/g, "_") : "HTTP_" + String(name).toUpperCase().replace(/-/g, "_");
            addServer(key, value);
          }
          const result = phpModule.ccall("wasm_sapi_handle_request", "number", [], [], { async: true });
          const code = Number((result && typeof result.then === "function" ? await result : result) || 0);
          try {
            const shutdownResult = phpModule.ccall("wasm_sapi_request_shutdown", "number", [], [], { async: true });
            if (shutdownResult && typeof shutdownResult.then === "function") await shutdownResult;
          } catch {}
          const headersJson = phpModule.FS?.analyzePath?.("/internal/headers.json")?.exists
            ? new TextDecoder().decode(phpModule.FS.readFile("/internal/headers.json"))
            : "";
          const stdoutFile = phpModule.FS?.analyzePath?.("/internal/stdout")?.exists
            ? new TextDecoder().decode(phpModule.FS.readFile("/internal/stdout"))
            : "";
          const stderrFile = phpModule.FS?.analyzePath?.("/internal/stderr")?.exists
            ? new TextDecoder().decode(phpModule.FS.readFile("/internal/stderr"))
            : "";
          return {
            code,
            stdout: stdoutFile || collectText(stdoutChunks),
            stderr: stderrFile || collectText(stderrChunks),
            headers: collectText(headerChunks),
            headersJson,
          };
        } finally {
          phpModule.onStdout = previousStdout;
          phpModule.onStderr = previousStderr;
          phpModule.onHeaders = previousHeaders;
          if (bodyPtr) {
            try {
              (phpModule.free || phpModule._wasm_free || phpModule._free)?.(bodyPtr);
            } catch {}
          }
        }
      };
      return phpModule;
    };
  }
  if (/var wasmExports;/.test(normalizedSource) && /createWasm\s*\(\s*\)\s*;/.test(normalizedSource) && /run\s*\(\s*\)\s*;/.test(normalizedSource)) {
    const patchedSource = normalizedSource
      .replace(/var Module\s*=\s*typeof Module\s*!=\s*['"]undefined['"]\s*\?\s*Module\s*:\s*\{\s*\}\s*;/, "var Module = moduleArg || {};")
      .replace(/var Module=typeof Module!=['"]undefined['"]\?Module:\{\};/, "var Module = moduleArg || {};")
      .replace(
        /var wasmExports;[\s\S]*$/,
        `var wasmExports;
Module["noExitRuntime"] = true;
Module["noInitialRun"] = true;
return (async () => {
  return await new Promise((resolve, reject) => {
    const originalAbort = Module["onAbort"];
    Module["onAbort"] = (what) => {
      try {
        if (typeof originalAbort === "function") originalAbort(what);
      } catch {}
      reject(new Error(String(what || "aborted")));
    };
    Module["onRuntimeInitialized"] = () => {
      Module["FS"] = FS;
      Module["callMain"] = callMain;
      Module["run"] = run;
      resolve(Module);
    };
    try {
      createWasm();
      run();
    } catch (err) {
      reject(err);
    }
  });
})();`
      );

    return async (moduleArg = {}) => {
      const nonModularRunner = new Function("moduleArg", "globalThis", patchedSource);
      return await nonModularRunner(moduleArg, globalThis);
    };
  }

  const module = { exports: {} };
  const exports = module.exports;
  const runner = new Function(
    "module",
    "exports",
    "globalThis",
    `${normalizedSource}\n; return module.exports || exports.default || exports || globalThis.Module || globalThis.createModule || null;`
  );
  const result = runner(module, exports, globalThis);
  if (typeof result === "function") return result;
  if (result && typeof result.default === "function") return result.default;
  if (result && typeof result.createModule === "function") return result.createModule;
  if (typeof globalThis.createModule === "function") return globalThis.createModule;
  if (typeof globalThis.Module === "function") return globalThis.Module;
  return null;
}

function ensureModuleParentDirs(moduleFs, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    current += `/${parts[i]}`;
    try {
      moduleFs.mkdir(current);
    } catch {}
  }
}

function importFsEntries(moduleFs, entries) {
  for (const entry of entries) {
    if (entry.dir) {
      try {
        moduleFs.mkdir(entry.path);
      } catch {}
      continue;
    }
    ensureModuleParentDirs(moduleFs, entry.path);
    moduleFs.writeFile(entry.path, new Uint8Array(entry.data));
  }
}

function exportFsTree(moduleFs, sourcePath, out) {
  let stat;
  try {
    stat = moduleFs.stat(sourcePath);
  } catch {
    return;
  }
  if (moduleFs.isDir(stat.mode)) {
    out.push({ path: sourcePath, dir: true });
    for (const name of moduleFs.readdir(sourcePath)) {
      if (name === "." || name === "..") continue;
      exportFsTree(moduleFs, `${sourcePath}/${name}`, out);
    }
    return;
  }
  out.push({ path: sourcePath, dir: false, data: moduleFs.readFile(sourcePath) });
}

function wasmRuntimeFriendlyError(err, command) {
  let text = `${err?.message || err || "Unknown error"}`;
  if (text === "[object Object]") {
    try {
      text = JSON.stringify(err);
    } catch {}
  }
  if (/socket|network/i.test(text)) return `${command}: this package needs raw networking, which EdgeTerm does not provide in the browser`;
  if (/fork|spawn|exec/i.test(text)) return `${command}: this package needs process control that EdgeTerm cannot emulate`;
  if (/shared library|dynamic library|dylib|dlopen/i.test(text)) return `${command}: this package needs native dynamic libraries, which are not supported here`;
  return `${command}: ${text}`;
}

function readInteractiveLine(display) {
  self.postMessage({ type: "stdin_request", display });
  if (ttyBrokerUrl && ttySessionId) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${ttyBrokerUrl}/__edgeterm_tty_read?id=${encodeURIComponent(ttySessionId)}`, false);
    xhr.send();
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const payload = JSON.parse(xhr.responseText || "{}");
        return payload.line === null || payload.line === undefined ? null : String(payload.line);
      } catch {
        return xhr.responseText || "";
      }
    }
    throw new Error(`TTY broker read failed with HTTP ${xhr.status}`);
  }
  Atomics.store(stdinControl, 0, 0);
  Atomics.wait(stdinControl, 0, 0);
  const len = Atomics.load(stdinControl, 1);
  if (len < 0) return null;
  const bytes = new Uint8Array(stdinData, 0, len);
  return new TextDecoder().decode(bytes);
}

self.onmessage = async (event) => {
  let data;
  try {
    data = event.data || {};
    if (data.type !== "run") return;
    debugEnabled = Boolean(data.debug);

    const command = data.command || "wasm";
    debug(`${command}: worker start`);
    let stdinBuffer = data.stdinText || "";
    let interactiveRequested = false;
    let pendingDisplay = "";
    const stdout = [];
    const stderr = [];
    let streamOutput = data.streamOutput === true && String(data?.env?.EDGETERM_PHP_STREAM || "") !== "0";
    let streamedOutput = false;
    let stdinQueue = [];

    ttyBrokerUrl = data.ttyBrokerUrl || "";
    ttySessionId = data.ttySessionId || "";
    try {
      if (data.stdinControl && data.stdinData) {
        stdinControl = new Int32Array(data.stdinControl);
        stdinData = data.stdinData;
      } else if (!ttyBrokerUrl || !ttySessionId) {
        throw new Error("missing shared memory and TTY broker");
      }
    } catch (err) {
      self.postMessage({
        type: "error",
        code: 1,
        stdout: "",
        stderr: `${command}: shared memory bridge unavailable — page may not be cross-origin isolated. Reload from the EdgeTerm server (serve-edgeterm.bat).\n`,
      });
      return;
    }

    globalThis.__edgetermWorkerReadLine = () => {
      if (stdinBuffer) {
        const chunk = stdinBuffer;
        stdinBuffer = "";
        return chunk;
      }
      interactiveRequested = true;
      const line = readInteractiveLine(pendingDisplay);
      pendingDisplay = "";
      return line;
    };

    const stdinInput = () => {
      if (stdinQueue.length) return stdinQueue.shift();
      const line = globalThis.__edgetermWorkerReadLine();
      if (line === null || line === undefined) return null;
      const encoded = Array.from(new TextEncoder().encode(`${line}\n`));
      stdinQueue = encoded;
      return stdinQueue.length ? stdinQueue.shift() : null;
    };

    const stdoutOutput = (code) => {
      if (code === null || code === undefined) return;
      const chunk = String.fromCharCode(code);
      stdout.push(chunk);
      pendingDisplay += chunk;
      if (streamOutput) {
        streamedOutput = true;
        self.postMessage({ type: "stream", stream: "stdout", text: chunk });
      }
    };

    const stderrOutput = (code) => {
      if (code === null || code === undefined) return;
      const chunk = String.fromCharCode(code);
      stderr.push(chunk);
      pendingDisplay += chunk;
      if (streamOutput) {
        streamedOutput = true;
        self.postMessage({ type: "stream", stream: "stderr", text: chunk });
      }
    };

    const factory = createWasmRuntimeModuleFactory(data.launcherSource);
    if (!factory) throw new Error("package launcher did not expose an Emscripten module factory");
    debug(`${command}: factory ready`);
    const moduleInstance = await factory({
      noInitialRun: true,
      arguments: [...(data.args || [])],
      thisProgram: data.thisProgram,
      extensions: data.extensions || {},
      ENV: { ...(data.env || {}), PWD: data.cwd || "/" },
      wasmBinary: new Uint8Array(data.wasmBytes),
      locateFile: (path) => `${data.packageRoot}/${path}`,
      __edgetermStdinChar: stdinInput,
      __edgetermStdoutChar: stdoutOutput,
      __edgetermStderrChar: stderrOutput,
      onStdout: (chunk) => {
        for (const code of chunk || []) stdoutOutput(code);
      },
      onStderr: (chunk) => {
        for (const code of chunk || []) stderrOutput(code);
      },
      print: (text) => {
        const chunk = String(text);
        stdout.push(chunk);
        pendingDisplay += chunk;
      },
      printErr: (text) => {
        const chunk = String(text);
        stderr.push(chunk);
        pendingDisplay += chunk;
      },
    });
    if (!moduleInstance?.FS) throw new Error("package runtime did not expose FS after initialization");
    debug(`${command}: runtime initialized`);

    importFsEntries(moduleInstance.FS, data.fsEntries || []);
    try {
      ensureModuleParentDirs(moduleInstance.FS, (data.cwd || "/").endsWith("/") ? `${data.cwd}._` : `${data.cwd}/._`);
      moduleInstance.FS.chdir(data.cwd || "/");
    } catch {
      moduleInstance.FS.chdir("/");
    }

    let code = 0;
    try {
      debug(`${command}: callMain`);
      if (data.phpRequest && typeof moduleInstance.__edgetermRunSapiRequest === "function") {
        try {
          const response = await moduleInstance.__edgetermRunSapiRequest(data.phpRequest || {});
          stdout.length = 0;
          stderr.length = 0;
          stdout.push(JSON.stringify(response));
          code = Number(response.code || 0);
        } catch (sapiErr) {
          stdout.length = 0;
          stderr.length = 0;
          stderr.push(`SAPI request failed, falling back to CLI: ${sapiErr?.message || sapiErr}\n`);
          code = await moduleInstance.__edgetermRunCli([...(data.args || [])]);
          data.phpRequest = null;
        }
      } else if (typeof moduleInstance.__edgetermRunCli === "function") code = await moduleInstance.__edgetermRunCli([...(data.args || [])]);
      else if (typeof moduleInstance.callMain === "function") moduleInstance.callMain([...(data.args || [])]);
      else if (typeof moduleInstance.main === "function") code = Number(moduleInstance.main([...(data.args || [])]) || 0);
      else throw new Error("package did not expose callMain() or main()");
      debug(`${command}: main returned`);
    } catch (err) {
      if (err === "unwind") {
        code = 0;
      } else if (
        err?.name === "ExitStatus" ||
        err?.constructor?.name === "ExitStatus" ||
        typeof err?.status === "number" ||
        typeof err?.code === "number"
      ) {
        code = Number(err.status ?? err.code ?? 0);
      } else {
        throw err;
      }
    }

    const fsEntries = [];
    for (const root of data.syncRoots || []) exportFsTree(moduleInstance.FS, root, fsEntries);
    if (interactiveRequested && !stdinBuffer && code === 0) {
      code = 1;
      stderr.push(
        `${command}: interactive terminal input still needs the worker stdin bridge to stay active for the full program lifecycle.\n`
      );
    }
    self.postMessage({
      type: "done",
      code,
      stdout: streamedOutput ? "" : stdout.join(""),
      stderr: streamedOutput ? "" : stderr.join(""),
      fsEntries,
      tailDisplay: streamedOutput ? "" : pendingDisplay,
      streamed: interactiveRequested || streamedOutput,
      sapi: !!data.phpRequest,
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      code: 1,
      stdout: "",
      tailDisplay: "",
      stderr: `${wasmRuntimeFriendlyError(err, data?.command || "wasm")}\n`,
    });
  } finally {
    delete globalThis.__edgetermWorkerReadLine;
  }
};
