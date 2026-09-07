import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = fs.readFileSync(path.join(root, "frontend/src/core/runtime.js"), "utf8");
const externalController = fs.readFileSync(path.join(root, "frontend/src/external-shell/runtime-controller.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "frontend/static/pyodide-shell-worker.js"), "utf8");
const externalWorker = fs.readFileSync(path.join(root, "frontend/static/external-runtime-worker.js"), "utf8");
const wasmCliWorker = fs.readFileSync(path.join(root, "wasm-cli-worker.js"), "utf8");
const buildScript = fs.readFileSync(path.join(root, "scripts/build.mjs"), "utf8");

test("workspace hydration is isolated to the selected workspace", () => {
  const hydrate = worker.match(/async function hydrateWorkspaceStorageFromIdb[\s\S]*?\n}\n\nfunction statInfo/)?.[0] || "";
  assert.match(hydrate, /new Set\(\["EM_FS_\/workspace-store"\]\)/);
  assert.doesNotMatch(hydrate, /indexedDB\.databases/);
  assert.doesNotMatch(hydrate, /allowUnscoped: true/);
  assert.match(worker, /const nativeLoad = syncfsRaw\(true\)/);
  assert.match(worker, /await mountWorkspaceStorage\(\{ workspaceId, users \}\)[\s\S]*?post\(\{ type: "ready", cwd \}\)/);
});

test("workspace switching removes runtime links before unmounting", () => {
  const unmount = worker.match(/async function unmountWorkspaceStorage[\s\S]*?\n}\n\nfunction syncfsRaw/)?.[0] || "";
  assert.match(unmount, /await waitForWorkspaceStorageReady\(\)/);
  assert.match(unmount, /unlinkWorkspaceRuntimePaths\(\)/);
  assert.match(unmount, /FS\.unmount\(mountedWorkspaceRoot\)/);
});

test("worker UI guards runtime-specific workspace operations", () => {
  assert.match(runtime, /if \(!WORKER_SHELL_ENABLED\) prepareActiveMounts\(\)/);
  assert.match(runtime, /async function interruptWorkerShellCommand\(\)/);
  assert.match(runtime, /workerShellCommandRunning[\s\S]*?worker_command_interrupted/);
  assert.match(runtime, /async function interruptActiveTerminalCommand\(\)/);
  assert.match(runtime, /externalStatus\?\.running[\s\S]*?externalShellRuntime\.cancel\(\)/);
  assert.match(runtime, /stopTerminalCommand[\s\S]*?interruptActiveTerminalCommand\(\)/);
});

test("worker shell commands use the visible terminal working directory", () => {
  const promptPath = runtime.match(/async function getShellPromptPath\(\)[\s\S]*?\n      }\n\n      async function updatePrompt/)?.[0] || "";
  assert.match(promptPath, /if \(WORKER_SHELL_ENABLED\)/);
  assert.match(promptPath, /return normalizePath\(terminalCurrentPath \|\| `\/home\/\$\{activeUser\(\)\}`\)/);
  assert.match(runtime, /let terminalCurrentPath = "\/home\/user"/);
  assert.match(runtime, /function setWorkerPrompt[\s\S]*?terminalCurrentPath = normalizePath/);
  assert.match(runtime, /if \(externalResult\.interactive\) \{[\s\S]*?await synchronizeShellWorkingDirectory\(externalResult\.cwd\);[\s\S]*?setWorkerPrompt\(externalResult\.cwd\);/);
  assert.match(externalController, /"interactive-command-run", \{[\s\S]*?cwd: commandCwd,/);
  assert.match(externalController, /"interactive-run-buffered", \{[\s\S]*?cwd: commandCwd,/);
  assert.match(externalWorker, /const commandCwd = String\(payload\.cwd \|\| session\.cwd \|\| session\.workspaceRoot\)/);
  assert.match(externalWorker, /cwd: String\(result\.cwd \|\| commandCwd\)/);
  assert.match(externalController, /onCommandExit: async \(event\) => \{[\s\S]*?this\.state\.cwd = String\(event\.cwd/);
  assert.match(externalController, /!this\.state\.interactive[\s\S]*?!this\.state\.interactiveDormant[\s\S]*?commands\.length === 1[\s\S]*?INTERACTIVE_SHELL_BUILTINS\.has\(commands\[0\]\)/);
  assert.match(externalController, /onCwd: \(event\) => \{[\s\S]*?if \(this\.state\.interactiveDormant\) return;/);
  assert.match(runtime, /const commandCwd = normalizePath\(options\.cwd \|\| terminalCurrentPath \|\| `\/home\/\$\{activeUser\(\)\}`\)/);
  assert.match(runtime, /type: "run",[\s\S]*?cwd: commandCwd,[\s\S]*?env: options\.env/);
  assert.match(runtime, /if \(WORKER_SHELL_ENABLED\) \{\s*setWorkerPrompt\(target\);\s*return;/);
  assert.match(worker, /async function runCommand\(id, line, cwd, environment = \{\}\)/);
  assert.match(worker, /__edgeterm_command_cwd/);
  assert.match(worker, /__edgeterm_command_environment_json/);
  assert.match(worker, /json\.loads\(globals\(\)\.get\("__edgeterm_command_environment_json", "\{\}"\)\)/);
  assert.doesNotMatch(worker, /dict\(provided_environment\)/);
  assert.match(worker, /shell\.logical_cwd = target/);
  assert.match(worker, /runCommand\(message\.id, message\.line, message\.cwd, message\.env\)/);
});

test("the terminal remains paused until POSIX warmup completes", () => {
  assert.match(runtime, /function setTerminalInputReady\(ready\)[\s\S]*?input\.disabled = !ready;[\s\S]*?input\.setAttribute\("aria-disabled", ready \? "false" : "true"\)/);
  assert.match(runtime, /if \(WORKER_SHELL_ENABLED\) \{[\s\S]*?setTerminalInputReady\(false\);[\s\S]*?term\?\.pause\?\.\(\);[\s\S]*?\}/);
  assert.match(runtime, /await readyPromise;[\s\S]*?await warmExternalShellForBoot\([\s\S]*?workerShellReady = true;[\s\S]*?setTerminalInputReady\(true\);[\s\S]*?term\?\.resume\?\.\(\)/);
  assert.doesNotMatch(runtime, /if \(message\.type === "ready"\) \{\s*workerShellReady = true;/);
  assert.match(runtime, /externalShellFallbackActive = true;[\s\S]*?POSIX command runtime unavailable\. Python tools remain available\./);
  assert.match(runtime, /externalShellFallbackActive \? "Python fallback active" : "Runtime ready"/);
});

test("Bridge output capture excludes prompts and nested terminal error rendering", () => {
  assert.match(runtime, /let renderingError = false/);
  assert.match(runtime, /if \(!renderingError\) recordBridgeTerminalOutput\("stdout", value\)/);
  assert.match(runtime, /if \(!execution \|\| execution\.captureSuppressed\) return/);
  assert.match(runtime, /execution\.captureSuppressed = true;[\s\S]*?term\.echo\(`\$\{commandCwd\} \$ \$\{command\}`\)[\s\S]*?execution\.captureSuppressed = false/);
});

test("worker shell startup hydrates package metadata before enabling the terminal", () => {
  const bootWorkerShell = runtime.match(
    /async function bootWorkerShell\([\s\S]*?\n      }\n\n      async function bootWorkerShellAfterReset/,
  )?.[0] || runtime.match(
    /async function bootWorkerShell\([\s\S]*?\n      }\n\n      function/,
  )?.[0] || "";
  assert.match(bootWorkerShell, /omitInstalledPayload: true/);
});

test("terminal input is gated until commands fully complete", () => {
  assert.match(runtime, /async \(command\) => \{\s*setTerminalInputReady\(false\);[\s\S]*?stopTerminalCommand[\s\S]*?try \{/);
  assert.match(runtime, /finally \{[\s\S]*?if \(!pageIsUnloading && !foreground[\s\S]*?setTerminalInputReady\(true\);/);
  assert.match(runtime, /if \(message\.type === "inputRequest"\) \{\s*setTerminalInputReady\(true\);[\s\S]*?setTerminalInputReady\(false\);/);
  assert.match(runtime, /let externalShellForegroundInputRequested = false/);
  assert.match(runtime, /if \(foregroundActive\) \{[\s\S]*?setTerminalInputReady\(externalShellForegroundInputRequested\);/);
  assert.match(runtime, /Continue\\\?\\s\*\\\[\[Yy\]\\\/n\\\][\s\S]*?externalShellForegroundInputRequested = true;[\s\S]*?setTerminalInputReady\(true\);/);
  assert.match(runtime, /Passphrase:\|\(\?:\^\|\\n\)> /);
  assert.match(runtime, /const input = `\$\{externalShellInputBuffer\}\\n`;[\s\S]*?externalShellForegroundInputRequested = false;[\s\S]*?setTerminalInputReady\(false\);/);
  assert.match(runtime, /const result = await runtime\.run\(line, normalizedCwd, workspaceRoot\);[\s\S]*?await finishExternalShellOutput\(\);[\s\S]*?return result;/);
});

test("POSIX warmup starts after the Python worker is ready", () => {
  assert.doesNotMatch(
    runtime,
    /void getExternalShellRuntime\(\)\.prepare\(\)\.catch/,
  );
  assert.match(
    runtime,
    /workerShell = new Worker[\s\S]*?await readyPromise;[\s\S]*?await warmExternalShellForBoot/,
  );
  assert.doesNotMatch(runtime, /externalShellPreparePromise/);
  assert.match(
    runtime,
    /showBootStatus\("Preparing POSIX command environment\.\.\."\)[\s\S]*?await warmExternalShellForBoot\([\s\S]*?setTerminalInputReady\(true\)/,
  );
});

test("external runtime preparation waits for Pyodide startup", () => {
  const pyodideReady = runtime.indexOf('await bootPhase("pyodide ready")');
  const pyodideImport = runtime.indexOf("await importPyodideLoader()");
  const externalWarmup = runtime.indexOf("await warmExternalShellForBoot", pyodideReady);
  assert.ok(pyodideImport >= 0 && pyodideReady > pyodideImport);
  assert.ok(externalWarmup > pyodideReady);
});

test("POSIX cold-start recovery retries only worker bootstrap failures", () => {
  assert.match(runtime, /async function warmExternalShellForBoot\([\s\S]*?external_shell_worker_crashed[\s\S]*?external_shell_worker_bootstrap_failed[\s\S]*?await runtime\.warmup\(cwd, workspaceRoot, options\)/);
  assert.match(runtime, /if \(!retryableCodes\.has\(String\(error\?\.code \|\| ""\)\)\) throw error;/);
  assert.match(runtime, /Retrying a recoverable cold-start failure/);
  assert.match(externalController, /workerGeneration = 0/);
  assert.match(externalController, /workerUrl\.searchParams\.set\("attempt", String\(\+\+this\.workerGeneration\)\)/);
});

test("external runtime assets resolve beside the page instead of under the Pyodide asset base", () => {
  assert.match(runtime, /const externalRuntimeAssetUrl = \(path\) => new URL\([\s\S]*?new URL\("\.\/", location\.href\)/);
  assert.match(runtime, /createEdgeTermExternalShellRuntime\(\{[\s\S]*?assetUrl: externalRuntimeAssetUrl/);
});

test("the versioned external worker name matches the embed build output", () => {
  const workerName = externalController.match(/external-runtime\/(external-runtime-worker-v[^"']+\.js)/)?.[1];
  assert.ok(workerName, "the controller must request a versioned external worker");
  assert.match(buildScript, new RegExp(workerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the isolated Python worker resolves beside the page", () => {
  assert.match(runtime, /const workerAssetBase = new URL\("\.\/", location\.href\)\.toString\(\)/);
  assert.match(runtime, /new URL\("pyodide-shell-worker\.js", workerAssetBase\)/);
  assert.match(runtime, /assetBase: workerAssetBase/);
});

test("external runtime resolves relative configuration URLs in the worker realm", () => {
  assert.match(externalWorker, /new URL\(String\(configUrl \|\| "runtime-config\.json"\), self\.location\.href\)/);
  assert.match(externalWorker, /new URL\(String\(config\.manifest_url \|\| ""\), resolvedConfigUrl\)/);
});

test("page unload terminates optional runtime workers", () => {
  assert.match(runtime, /externalShellRuntime\?\.cancel\?\.\(\);[\s\S]*?externalShellRuntime = null;/);
  assert.match(runtime, /nodeRuntime\?\.cancel\?\.\(\);[\s\S]*?nodeRuntime = null;/);
});

test("Bridge mutations retire a stale external shell workspace snapshot", () => {
  const notifier = runtime.match(
    /async function bridgeNotifyExternalShellWorkspaceChanged\(\)[\s\S]*?\n      }/,
  )?.[0] || "";
  assert.match(notifier, /externalShellRuntime\.notifyWorkspaceChanged\(\)/);

  const writeText = runtime.match(
    /async function bridgeWriteText\([\s\S]*?\n      }\n\n      async function bridgeListFiles/,
  )?.[0] || "";
  const writeBinary = runtime.match(
    /async function bridgeWriteBinary\([\s\S]*?\n      }\n\n      async function bridgeFileManifest/,
  )?.[0] || "";
  const removeFile = runtime.match(
    /async function bridgeRemoveFile\([\s\S]*?\n      }\n\n      async function bridgeRemoveSnapshotArchive/,
  )?.[0] || "";
  assert.match(writeText, /await bridgeNotifyExternalShellWorkspaceChanged\(\)/);
  assert.match(writeBinary, /await bridgeNotifyExternalShellWorkspaceChanged\(\)/);
  assert.match(removeFile, /await bridgeNotifyExternalShellWorkspaceChanged\(\)/);
});

test("compound cd commands use buffered ash and synchronize persistent cwd", () => {
  assert.match(externalController, /const PERSISTENT_SEQUENCE_BUILTINS = new Set/);
  assert.match(externalController, /filter\(\(command\) => command !== "cd"\)/);
  assert.match(externalController, /commands\.every\(\(command\) => !PERSISTENT_SEQUENCE_BUILTINS\.has\(command\)/);
  assert.match(externalController, /const nextCwd = String\(result\.cwd[\s\S]*?this\.state\.cwd = nextCwd;/);
  assert.match(externalController, /"interactive-shell-command-run", \{[\s\S]*?cwd: commandCwd,/);
  assert.match(externalController, /const syncFiles = mayChangeInteractiveFiles\(executionCommand\)/);
  assert.match(externalController, /const persistentShellExpansion = requiresPersistentShellExpansion\(executionCommand\)/);
  assert.match(externalController, /isBundledStandaloneRuntimeCommand\(executionCommand\)/);
  assert.match(externalController, /!directRuntimeCommand \|\| persistentShellExpansion/);
  assert.match(externalController, /"interactive-shell-command-run", \{[\s\S]*?syncFiles,/);
  assert.match(externalWorker, /syncFiles: payload\.syncFiles !== false/);
  assert.match(externalWorker, /query\.foreground\.syncFiles[\s\S]*?queueInteractiveSync\(session\)[\s\S]*?Promise\.resolve\(\{ changedFiles: 0 \}\)/);
  assert.match(externalWorker, /const commands = \[[\s\S]*?source,[\s\S]*?__edgeterm_status=\$\?/);
  assert.match(externalController, /"interactive-shell-command-run", \{[\s\S]*?source: executionCommand/);
  assert.match(externalWorker, /const commandCwd = String\(payload\.cwd \|\| session\.cwd \|\| session\.workspaceRoot\)/);
  assert.match(externalWorker, /`cd \$\{shellQuote\(commandCwd\)\}`/);
  assert.match(externalWorker, /for \(const command of commands\)[\s\S]*?pendingInputEchoes\.push\(command\)[\s\S]*?writeInteractiveText\(session, command\)[\s\S]*?writeInteractiveText\(session, "\\r"\)/);
  assert.match(externalWorker, /EDGETERM_CWD_END__'`;[\s\S]*?writeInteractiveText\(session, command\);[\s\S]*?writeInteractiveText\(session, "\\r"\)/);
  assert.match(externalWorker, /function stripInteractiveInputEcho/);
  assert.match(externalWorker, /session\.pendingInputEchoes\.push\(command\)/);
  assert.match(externalWorker, /const WORKSPACE_MOUNT_ROOT = "\/home\/user"/);
  assert.match(externalWorker, /mountWorkspaceDirectory\(mounts, workspaceDirectory, workspaceRoot\)/);
  assert.doesNotMatch(externalWorker, /const encodedSource = \[\.\.\.new TextEncoder/);
});

test("non-interactive foreground commands close stdin before waiting for exit", () => {
  assert.match(externalWorker, /const interactiveStdinPrograms = new Set/);
  assert.match(externalWorker, /const stdinFilterPrograms = new Set/);
  assert.match(externalWorker, /const nonInteractiveApt = \["apt", "apt-get"\]/);
  assert.match(externalWorker, /const interactiveRsync = program === "rsync"/);
  assert.match(externalWorker, /\|\| interactiveRsync/);
  assert.match(externalWorker, /const closesStdinImmediately = !keepsStdinOpen/);
  assert.match(externalWorker, /async function closeProcessStdin\(instance, input = ""\)/);
  assert.match(externalWorker, /await stdinWriter\.close\(\)/);
  assert.match(externalWorker, /stdinWriter = null/);
  assert.match(externalWorker, /captureChanges: Boolean\(payload\.captureChanges\)/);
  assert.match(externalWorker, /const syncFiles = payload\.syncFiles !== false/);
  assert.match(externalWorker, /syncFiles,\s*commandBefore/);
  assert.match(externalWorker, /foreground\.syncFiles[\s\S]*?emit: !foreground\.captureChanges/);
  assert.match(externalWorker, /await startInteractiveCommand\(\{ \.\.\.payload, captureChanges: true \}\)/);
});

test("foreground commands drain stdout and stderr before freeing the process", () => {
  assert.match(externalWorker, /const stdoutCapture = startProcessStreamCapture\(instance\.stdout/);
  assert.match(externalWorker, /const stderrCapture = startProcessStreamCapture\(instance\.stderr/);
  assert.match(externalWorker, /if \(!stdoutCapture\.output\(\) && resultStdout\)/);
  assert.match(externalWorker, /if \(!stderrCapture\.output\(\) && resultStderr\)/);
  assert.match(externalWorker, /PROCESS_STREAM_DRAIN_TIMEOUT_MS = 120/);
  assert.match(externalWorker, /PROCESS_STREAM_CANCEL_TIMEOUT_MS = 80/);
  assert.match(externalWorker, /PROCESS_CAPTURE_DRAIN_TIMEOUT_MS = 1000/);
  assert.match(externalWorker, /const drainTimeout = streamOutput/);
  assert.match(externalWorker, /const waitForExit = instance\.wait\(\)\.catch[\s\S]*?ExitCode::\(\\d\+\)/);
  assert.match(externalWorker, /!changesSystemPackages[\s\S]*?Unable to \(\?:persist\|snapshot\) mount \\\/bin/);
  assert.match(externalWorker, /Runtime execution failed: \(\?:Unable to/);
  assert.match(externalWorker, /ExitCode::\\d\+/);
});

test("non-zero WASIX exits remain command results instead of crashing the runtime", () => {
  assert.match(
    externalWorker,
    /async function waitForRuntimeProcess\(instance\)[\s\S]*?ExitCode::\(\\d\+\)[\s\S]*?code: Number\(match\[1\]\)/,
  );
  const directCommand = externalWorker.match(/async function runDirectRuntimeCommand[\s\S]*?\n}\n\nasync function runYamlfmtStdinAdapter/)?.[0] || "";
  assert.match(directCommand, /const result = await waitForRuntimeProcess\(instance\);/);
});

test("runtime hang diagnostics ignore background tab suspension", () => {
  const runtime = fs.readFileSync(path.join(root, "frontend/src/core/runtime.js"), "utf8");
  assert.match(runtime, /document\.addEventListener\("visibilitychange"/);
  assert.match(runtime, /if \(document\.hidden\) return/);
});

test("cancelled native commands return an interrupt status without an error banner", () => {
  const runner = runtime.match(/async function runExternalShellCommand[\s\S]*?\n      }\n\n      async function synchronizeShellWorkingDirectory/)?.[0] || "";
  assert.match(runner, /error\?\.code[^\n]*external_shell_cancelled/);
  assert.match(runner, /exitCode: 130/);
  assert.match(runner, /interrupted: true/);
});

test("failed native commands restore the terminal prompt after draining output", () => {
  const runner = runtime.match(/async function runExternalShellCommand[\s\S]*?\n      }\n\n      async function synchronizeShellWorkingDirectory/)?.[0] || "";
  assert.match(
    runner,
    /term\?\.error\?\.\(`\[BusyBox\] \$\{message\}`\);[\s\S]*?await finishExternalShellOutput\(\);[\s\S]*?setWorkerPrompt\(normalizedCwd\);/,
  );
});

test("completed non-interactive commands restore the terminal prompt deterministically", () => {
  const runner = runtime.match(/async function runExternalShellCommand[\s\S]*?\n      }\n\n      async function synchronizeShellWorkingDirectory/)?.[0] || "";
  assert.match(
    runner,
    /const result = await runtime\.run\(line, normalizedCwd, workspaceRoot\);[\s\S]*?await finishExternalShellOutput\(\);[\s\S]*?if \(!result\?\.interactive\) setWorkerPrompt\(result\?\.cwd \|\| normalizedCwd\);/,
  );
});

test("missing install-only overrides return command-not-found before runtime launch", () => {
  assert.match(externalController, /const INSTALL_REQUIRED_OVERRIDE_COMMANDS = new Set\(\["php"\]\)/);
  assert.match(
    externalController,
    /await this\.installedPackagesForCommand\(name\)[\s\S]*?ash: \$\{missingCommand\}: not found[\s\S]*?exitCode: 127/,
  );
});

test("buffered commands provide finite stdin when spawning the process", () => {
  const directCommand = externalWorker.match(/async function runDirectRuntimeCommand[\s\S]*?\n}\n\nasync function runYamlfmtStdinAdapter/)?.[0] || "";
  const stdoutIndex = directCommand.indexOf("const stdoutCapture = startProcessStreamCapture");
  const stderrIndex = directCommand.indexOf("const stderrCapture = startProcessStreamCapture");
  const stdinIndex = directCommand.indexOf("stdin: stdin === null");
  assert.ok(stdoutIndex >= 0 && stderrIndex >= 0 && stdinIndex >= 0);
  assert.ok(stdinIndex < stdoutIndex);
  assert.ok(stdinIndex < stderrIndex);
  assert.match(directCommand, /getInstalledRuntimeCommand\(program, installedBinary\)/);
  assert.match(directCommand, /await closeProcessStdin\(instance, options\.stdin\)/);
});

test("non-interactive bundled commands avoid the fragile foreground stream path", () => {
  assert.match(
    externalController,
    /!requiresInteractiveTerminal\(executionCommand\)[\s\S]*?isBundledStandaloneRuntimeCommand\(executionCommand\)/,
  );
});

test("shell builtin filesystem changes are synchronized from an isolated mount", () => {
  const shellProcess = externalWorker.match(/async function runShellProcess[\s\S]*?\n}\n\nfunction hasShellControlSyntax/)?.[0] || "";
  assert.match(shellProcess, /const commandDirectory = await createWorkspaceFromSnapshot/);
  assert.match(shellProcess, /mountWorkspaceDirectory\(mount, commandDirectory, workspaceRoot\)/);
  assert.match(shellProcess, /await synchronizeDirectory\(directory, commandDirectory\)/);
  const interactiveShell = externalWorker.match(/async function runInteractiveShellCommandAndWait[\s\S]*?\n}\n\nasync function queryInteractiveCwd/)?.[0] || "";
  assert.match(interactiveShell, /parseSimpleShellWords\(source\)/);
  assert.doesNotMatch(interactiveShell, /firstCommands/);
  assert.match(interactiveShell, /for \(const command of commands\)[\s\S]*?writeInteractiveText\(session, command\)[\s\S]*?writeInteractiveText\(session, "\\r"\)/);
});

test("buffered pipelines preserve binary stdout between processes", () => {
  assert.match(externalWorker, /chunks\.push\(bytes\.slice\(\)\)/);
  assert.match(externalWorker, /stdin instanceof Uint8Array/);
  assert.match(externalWorker, /stdoutBytes/);
  assert.match(externalWorker, /pipelineInput = processResult\.stdoutBytes \|\| processResult\.stdout/);
});

test("buffered commands expand command substitutions without persistent ash forks", () => {
  assert.match(externalWorker, /async function expandCommandSubstitutions/);
  assert.match(externalWorker, /function expandSimpleShellVariables/);
  assert.match(externalWorker, /function splitSimplePipeline[\s\S]*?let compoundDepth = 0;[\s\S]*?\["done", "esac", "fi"\]/);
  assert.match(externalWorker, /const sequence = splitSimpleCommandSequence\(source\);[\s\S]*?if \(!sequence && \(!compoundShellProgram \|\| expandsBeforeCompoundExecution\)\) \{[\s\S]*?expandCommandSubstitutions/);
  assert.match(externalWorker, /source = substitution\.source/);
  assert.match(externalWorker, /substitutionDepth: depth \+ 1/);
});

test("buffered pipelines merge only their own filesystem changes", () => {
  assert.match(externalWorker, /const pipelineChanges = diffSnapshots\(pipelineBefore, pipelineAfter\)/);
  assert.match(externalWorker, /applySnapshotChanges\(session\.directory, pipelineChanges, pipelineAfter, pipelineBefore\)/);
  assert.doesNotMatch(externalWorker, /synchronizeDirectory\(session\.directory, directory\)/);
});

test("buffered commands avoid duplicate workspace and system snapshots", () => {
  assert.match(
    externalWorker,
    /async function runInteractivePipeline[\s\S]*?captureChanges: false,[\s\S]*?preparedRuntime/,
  );
});

test("buffered workspace changes are returned and flushed before the prompt", () => {
  assert.match(externalWorker, /changes: pipelineChanges,/);
  assert.match(
    externalController,
    /Array\.isArray\(result\.changes\)[\s\S]*?applyChanges\(root, result\.changes, \{ persist: false \}\)[\s\S]*?fs\.flush/,
  );
});

test("buffered pipes and redirections expose non-terminal stream modes", () => {
  assert.match(externalWorker, /EDGETERM_STDIN_MODE: "pipe"/);
  assert.match(externalWorker, /EDGETERM_STDOUT_MODE: stdoutMode/);
  assert.match(externalWorker, /stdoutMode: redirection\.output === null \? "terminal" : "pipe"/);
  assert.match(externalWorker, /runtimeBinaries\?\.has\(redirectionProgram\)/);
  assert.match(externalWorker, /const explicitBusyBoxApplet = redirectionProgram === "busybox"/);
  assert.match(externalWorker, /source: redirectionWords\.map\(shellQuote\)\.join\(" "\)/);
  assert.match(externalWorker, /preferBusyBox: explicitBusyBoxApplet[\s\S]*?BUSYBOX_APPLET_NAMES\.includes\(redirectionProgram\)/);
  assert.match(externalWorker, /stdoutMode: pipeline && index < segments\.length - 1 \? "pipe" : "terminal"/);
  assert.match(externalWorker, /processResult\.stdoutBytes instanceof Uint8Array/);
  assert.match(externalWorker, /pipelineInput = new Uint8Array\(await inputTarget\.directory\.readFile/);
  assert.match(externalWorker, /token\.descriptor === 2/);
  assert.match(externalWorker, /streamStderr: redirection\.errorOutput === null/);
  assert.match(externalWorker, /redirection\.errorOutput !== "\/dev\/null"/);
  assert.match(externalWorker, /processResult\.stderr = ""/);
  assert.match(externalWorker, /const segmentRedirection = compoundShellProgram \? null : parseSimpleRedirection\(segmentSource\)/);
  assert.match(externalWorker, /streamStderr: supportedSegmentRedirection\.errorOutput === null/);
  assert.match(externalWorker, /supportedSegmentRedirection\.errorOutput !== "\/dev\/null"/);
});

test("quoted redirections preserve application escape sequences", () => {
  const parser = externalWorker.match(/function parseSimpleRedirection[\s\S]*?\n}\n\nfunction workspaceRelativePath/)?.[0] || "";
  assert.match(parser, /quote === '\"' && !\['\"', "\\\\", "\$", "`", "\\n"\]\.includes\(next\)/);
  assert.match(parser, /current \+= "\\\\"/);
});

test("explicit BusyBox applets reuse normal argument mapping", () => {
  assert.match(externalWorker, /const explicitBusyBoxApplet = program === "busybox"/);
  assert.match(externalWorker, /source: words\.slice\(1\)\.map\(shellQuote\)\.join\(" "\)/);
  assert.match(externalWorker, /preferBusyBox: true/);
  assert.match(externalWorker, /forceWorkspacePaths = false/);
  assert.match(externalWorker, /forceWorkspacePaths && !value\.startsWith\("\/"\)/);
  assert.match(externalWorker, /directRuntimeRoot,\s*preferBusyBox/);
});

test("buffered command lists run as ordered runtime operations", () => {
  assert.match(externalWorker, /function splitSimpleCommandSequence\(source\)/);
  assert.match(externalWorker, /return splitCompoundCommandSequence\(value\)/);
  assert.match(externalWorker, /const parsedRedirection = compoundShellProgram \? null : parseSimpleRedirection\(source\)/);
  assert.match(externalWorker, /const segmentRedirection = compoundShellProgram \? null : parseSimpleRedirection\(segmentSource\)/);
  assert.match(externalWorker, /const expandsBeforeCompoundExecution = \/\^\\s\*case\\b\/\.test\(source\)[\s\S]*?compoundShellProgram && \/\\\$\\\(\(\?!\\\(\)\|`\/\.test\(source\)/);
  assert.match(externalWorker, /if \(!sequence && \(!compoundShellProgram \|\| expandsBeforeCompoundExecution\)\) \{[\s\S]*?expandCommandSubstitutions/);
  assert.doesNotMatch(externalWorker, /const stateful = new Set\(\[[^\]]*"cd"/);
  assert.match(externalWorker, /entry\.operator === "&&"/);
  assert.match(externalWorker, /entry\.operator === "\|\|"/);
  assert.match(externalWorker, /captureChanges: false,[\s\S]*?preparedRuntime: \{ posix, directory \}/);
  assert.match(externalWorker, /let sequenceStreamedOutput = false/);
  assert.match(externalWorker, /streamedOutput: sequenceStreamedOutput/);
  assert.match(externalWorker, /interactive-output[\s\S]*?result\.stdout/);
});

test("buffered commands clone the live package runtime instead of rebuilding stale mounts", () => {
  assert.match(externalWorker, /installedCommands: new Map\(session\.posix\.installedCommands \|\| \[\]\)/);
  assert.match(externalWorker, /systemDirectories: new Map\(session\.posix\.systemDirectories \|\| \[\]\)/);
  assert.doesNotMatch(externalWorker, /inheritInteractiveSystemRuntime\(await createPosixRuntime/);
  assert.match(externalWorker, /files: \[\],\s*streamOutput: true,/);
});

test("direct package commands preserve the current working directory", () => {
  const directCommand = externalWorker.match(/async function runDirectRuntimeCommand[\s\S]*?\n}\n\nasync function runYamlfmtStdinAdapter/)?.[0] || "";
  assert.match(directCommand, /let directCwd = absoluteWorkspacePath\(cwd, cwd, workspaceRoot, directRuntimeRoot\)/);
  assert.match(directCommand, /env\.PWD = directCwd/);
  assert.match(directCommand, /\["ash", "bash", "dash", "sh"\]\.includes\(program\)/);
  assert.match(directCommand, /\.split\(workspaceRoot\)\.join\(directRuntimeRoot\)/);
  assert.match(directCommand, /command\.run\(options\)/);
  assert.doesNotMatch(directCommand, /command\.run\(\{ runtime: new Runtime\(\), \.\.\.options }\)/);
});

test("wc uses the POSIX mount and stream adapter", () => {
  assert.match(externalWorker, /function readableRuntimeTarget\(/);
  assert.match(externalWorker, /async function runWcAdapter\(/);
  assert.match(externalWorker, /if \(!skipAdapters && program === "wc"\)/);
  assert.match(externalWorker, /bytes: bytes\.byteLength/);
  assert.match(externalWorker, /words: \(text\.match\(\/\\S\+\/g\) \|\| \[\]\)\.length/);
});

test("cat uses the POSIX mount adapter without waiting on a foreground process", () => {
  assert.match(externalWorker, /async function runCatAdapter\(/);
  assert.match(externalWorker, /if \(!skipAdapters && program === "cat"\)/);
  assert.match(externalWorker, /await runCatAdapter\(\{/);
});

test("head and tail pipelines use finite in-memory input adapters", () => {
  assert.match(externalWorker, /async function runHeadTailAdapter\(/);
  assert.match(externalWorker, /if \(!skipAdapters && \(program === "head" \|\| program === "tail"\)\)/);
  assert.match(externalWorker, /bytes\.slice\(0, count\)/);
  assert.match(externalWorker, /lines\.slice\(Math\.max\(0, lines\.length - count\)\)/);
});

test("ls uses the POSIX mount adapter without waiting on a foreground process", () => {
  assert.match(externalWorker, /async function runLsAdapter\(/);
  assert.match(externalWorker, /if \(!skipAdapters && program === "ls"\)/);
  assert.match(externalWorker, /const absoluteParts = \[\]/);
  assert.match(externalWorker, /const absolute = `\/\$\{absoluteParts\.join\("\/"\)\}`/);
});

test("ls and find treat the workspace root as an existing directory", async () => {
  const normalizePath = externalWorker.match(/function normalizeRelativePath[\s\S]*?\n}/)?.[0] || "";
  const workspacePath = externalWorker.match(/function workspaceRelativePath[\s\S]*?\n}/)?.[0] || "";
  const snapshotDirectoryCheck = externalWorker.match(/function snapshotHasDirectory[\s\S]*?\n}/)?.[0] || "";
  const lsAdapter = externalWorker.match(/async function runLsAdapter[\s\S]*?\n}\n\nasync function runCdAdapter/)?.[0]
    ?.replace(/\n\nasync function runCdAdapter[\s\S]*$/, "") || "";
  const findAdapter = externalWorker.match(/function globExpression[\s\S]*?\n}\n\nasync function runGrepAdapter/)?.[0]
    ?.replace(/\n\nasync function runGrepAdapter[\s\S]*$/, "") || "";
  const fixture = {
    files: new Map([["alpha.txt", new TextEncoder().encode("alpha\n")]]),
    directories: new Set(["folder"]),
  };
  const createAdapter = new Function(
    "snapshotDirectory",
    "post",
    `${normalizePath}\n${workspacePath}\n${snapshotDirectoryCheck}\n${lsAdapter}\n${findAdapter}\nreturn { runLsAdapter, runFindAdapter };`,
  );
  const adapters = createAdapter(async () => fixture, () => {});
  const ls = await adapters.runLsAdapter({
    words: ["ls"],
    cwd: "/home/user",
    workspaceRoot: "/home/user",
    directory: {},
    posix: { mounts: {} },
    streamOutput: false,
  });
  const find = await adapters.runFindAdapter({
    words: ["find", ".", "-maxdepth", "0"],
    cwd: "/home/user",
    workspaceRoot: "/home/user",
    directory: {},
    streamOutput: false,
  });
  assert.equal(ls.exitCode, 0);
  assert.equal(ls.stderr, "");
  assert.equal(ls.stdout, "alpha.txt\nfolder\n");
  assert.equal(find.exitCode, 0);
  assert.equal(find.stdout, ".\n");
});

test("pwd uses the POSIX adapter without waiting on the persistent shell", () => {
  assert.match(externalWorker, /function runPwdAdapter\(/);
  assert.match(externalWorker, /if \(!skipAdapters && program === "pwd"\)/);
});

test("simple cd sequences use the POSIX adapter without spawning ash", () => {
  assert.match(externalWorker, /async function runCdAdapter\(/);
  assert.match(externalWorker, /segmentWords\?\.\[0\] === "cd"[\s\S]*?await runCdAdapter/);
  assert.match(externalWorker, /snapshot\.directories\.has\(relative\)/);
  assert.match(externalWorker, /if \(requested === "\/"\)/);
});

test("find and grep use POSIX adapters for common workspace operations", () => {
  assert.match(externalWorker, /async function runFindAdapter\(/);
  assert.match(externalWorker, /async function runGrepAdapter\(/);
  assert.match(externalWorker, /program === "find"/);
  assert.match(externalWorker, /program === "grep"/);
  assert.match(externalWorker, /\["-q", "--quiet", "--silent"\]\.includes\(flag\)/);
  assert.match(externalWorker, /if \(quiet && matches\.length\) break;/);
});

test("AWK programs keep their expression while mapping data files into the workspace", () => {
  const rewrite = externalWorker.match(/function rewriteDirectRuntimeArguments[\s\S]*?\n}\n\nfunction emptySnapshot/)?.[0] || "";
  assert.match(rewrite, /"awk"/);
  assert.match(rewrite, /"gawk"/);
  assert.match(rewrite, /"mawk"/);
  assert.match(rewrite, /let awkProgramSeen = false/);
  assert.match(rewrite, /\["awk", "gawk", "mawk"\]\.includes\(program\)/);
  assert.match(rewrite, /else if \(!awkProgramSeen\) \{[\s\S]*?awkProgramSeen = true;[\s\S]*?continue;/);
});

test("relative file operands are resolved inside the mounted workspace", () => {
  const pathMapping = externalWorker.match(/function absoluteWorkspacePath[\s\S]*?\n}/)?.[0] || "";
  assert.match(pathMapping, /workspaceRelativePath\(value, cwd, workspaceRoot\)/);
  assert.doesNotMatch(pathMapping, /if \(!String\(value \|\| ""\)\.startsWith\("\/"\)\)/);
  assert.ok(pathMapping.includes("`${runtimeRoot}/${relative}`"));
});

test("workspace creation uses bulk hydration and normalizes permissions", () => {
  const creation = externalWorker.match(/async function createDirectoryFromEntries[\s\S]*?\n}/)?.[0] || "";
  assert.match(creation, /const directory = new Directory\(initialFiles\)/);
  assert.match(externalWorker, /async function createWorkspaceDirectoryFromEntries[\s\S]*?return await createDirectoryFromEntries/);
  assert.doesNotMatch(externalWorker, /ScopedDirectory/);
  assert.match(externalWorker, /await warmRuntimeWorker\(\)/);
  assert.match(externalWorker, /await prepareMountedDirectoryPermissions\(directory\)/);
});

test("direct package runtimes expose a writable null device", () => {
  assert.match(externalWorker, /await mounts\["\/dev"\]\.writeFile\("\/null", new Uint8Array\(\)\)/);
});

test("buffered redirection supports the isolated temporary directory", () => {
  assert.match(externalWorker, /const WORKSPACE_TEMP_ROOT = "\.edgeterm-posix\/tmp"/);
  assert.match(externalWorker, /"\/tmp": temporaryDirectory/);
  assert.match(externalWorker, /function temporaryRelativePath\(value, cwd\)/);
  assert.match(externalWorker, /if \(!normalized\.startsWith\("\/tmp\/"\)\) return null;/);
  assert.match(externalWorker, /function writableRuntimeTarget\([\s\S]*?posix\?\.mounts\?\.\["\/tmp"\]/);
  assert.match(externalWorker, /inputTarget\.directory\.readFile\(`\/\$\{inputTarget\.path\}`\)/);
  assert.match(externalWorker, /writeRuntimeTargetBytes\(outputTarget, bytes, redirection\.append\)/);
});

test("installed package payloads hydrate inside the persistent session", () => {
  assert.match(externalWorker, /async function addInteractivePackageArchives/);
  assert.match(externalWorker, /await restoreInstalledPackagePayloads\(\{/);
  assert.match(externalWorker, /message\.type === "interactive-add-package-archives"/);
  assert.match(externalWorker, /async function addInteractivePackagePayload/);
  assert.match(externalWorker, /message\.type === "interactive-add-package-payload"/);
});

test("workspace synchronization truncates files before shorter replacements", () => {
  const synchronization = externalWorker.match(/async function synchronizeDirectory[\s\S]*?\n}\n\nfunction equalBytes/)?.[0] || "";
  assert.match(synchronization, /previous\.byteLength > bytes\.byteLength/);
  assert.match(synchronization, /await target\.removeFile\(`\/\$\{path\}`\)/);
  assert.match(synchronization, /await target\.writeFile\(`\/\$\{path\}`, bytes\)/);
});

test("shell output redirection truncates an existing file before writing", () => {
  const writer = externalWorker.match(/async function writeRuntimeTargetBytes[\s\S]*?\n}\n\nasync function runWcAdapter/)?.[0] || "";
  assert.match(writer, /if \(!append\)[\s\S]*?removeFile\(`\/\$\{target\.path\}`\)[\s\S]*?writeFile\(`\/\$\{target\.path\}`, bytes\)/);
});

test("stopping a Node preview also cancels its watcher and build tasks", () => {
  assert.match(runtime, /function stopRunCenterEntry\(entry, \{ cancelNodeRuntime = true \} = \{\}\)[\s\S]*?nodeRuntime\?\.status\?\.\(\)\.preview\?\.id === entry\.id[\s\S]*?nodeRuntime\.cancel\(\);/);
  assert.match(runtime, /stopPreview: \(app\) => \{[\s\S]*?stopRunCenterEntry\(app, \{ cancelNodeRuntime: false \}\)/);
});

test("EdgeServe exposes an application-relative location to static framework adapters", () => {
  const client = fs.readFileSync(path.join(root, "frontend/src/preview/client-script.js"), "utf8");
  assert.match(client, /const routePrefix = .*edgeServeDebug\?\.routePrefix/);
  assert.match(client, /const applicationPathname = \(\) =>/);
  assert.match(client, /Object\.defineProperty\(window, "__EDGETERM_APP_LOCATION__"/);
});

test("installed packages use the workspace home persistence layer", () => {
  assert.match(
    worker,
    /const persistedSystemRoot = `\$\{workspaceRoot\}\/home\/\.edgeterm-system`/,
  );
  assert.match(worker, /migratePersistedRuntimePath\(workspaceRoot, relativePath, storagePath\)/);
  assert.match(worker, /\.filter\(\(entry\) => !entry\.startsWith\("\."\)\)/);
  assert.match(worker, /const WORKER_PACKAGE_STORAGE_ROOT = "edgeterm-worker-packages-v1"/);
  assert.match(worker, /navigator\.storage\.getDirectory\(\)/);
  assert.match(worker, /await persistDirtyWorkerEntries\(\)/);
  assert.match(worker, /const restoredEntries = await restoreWorkerEntries\(workspaceId\)/);
  assert.match(externalController, /const prefixes = \(PACKAGE_SYSTEM_SUBTREES\.get\(root\) \|\| \[root\]\)/);
  assert.match(externalController, /path\.startsWith\(`\$\{prefix\}\/`\)/);
});

test("static preview strips its instance route before file lookup", () => {
  const dispatch = runtime.match(/async function dispatchWorkerStaticRequest[\s\S]*?\n      }\n\n      async function resolvePhpRequestTargetWorker/)?.[0] || "";
  assert.match(dispatch, /path\.slice\(routePrefix\.length\)/);
  assert.match(dispatch, /resolveWorkspaceDirectory\(root, `\.\$\{path\}`\)/);

  const appDispatch = runtime.match(/async function dispatchAppModeRequest[\s\S]*?\n      }\n\n      function resolveAppWebSocketUrl/)?.[0] || "";
  assert.match(appDispatch, /const \{ path, query \} = resolveAppRequestUrl/);
  assert.match(appDispatch, /const relativePath = path\.slice\(routePrefix\.length\)/);
  assert.doesNotMatch(appDispatch, /new URL\(String\(url/);
});

test("PHP projects keep absolute document roots and current worker versions", () => {
  const resolver = runtime.match(/function resolveWorkspaceDirectory[\s\S]*?\n      }/)?.[0] || "";
  assert.match(resolver, /const stack = \(input\.startsWith\("\/"\) \? "\/" : normalizePath\(baseDir \|\| "\/"\)\)\.split\("\/"\)\.filter\(Boolean\)/);
  assert.match(runtime, /workerUrl\.searchParams\.set\("v", EDGETERM_BOOT_BUNDLE_VERSION\)/);
});

test("PHP JSPI launchers accept browser WebSocket event methods", () => {
  assert.match(wasmCliWorker, /ws\.addEventListener\(event, listener, \{ once: true \}\)/);
  assert.match(wasmCliWorker, /ws\.removeEventListener\(event, listener\)/);
  assert.doesNotMatch(wasmCliWorker, /err\?\.stack/);
});

test("WASM command exports never delete package roots excluded from synchronization", () => {
  const exportedDelta = wasmCliWorker.match(
    /function exportedFsDelta[\s\S]*?\n}\n\nfunction deltaWalk/,
  )?.[0] || "";
  assert.match(exportedDelta, /const normalizedRoots = syncRoots\.map/);
  assert.match(exportedDelta, /const synchronized = normalizedRoots\.some/);
  assert.match(exportedDelta, /if \(synchronized && !seen\.has\(path\)\)/);
});

test("workspace export flushes storage and reports compression progress", () => {
  const exportWorkspace = runtime.match(/async function exportActiveWorkerWorkspace[\s\S]*?\n      }\n\n      async function resetWorkerEnvironment/)?.[0] || "";
  assert.match(exportWorkspace, /await workerFs\("flush"\)/);
  assert.match(exportWorkspace, /Compressing workspace/);
  assert.match(exportWorkspace, /URL\.revokeObjectURL/);
});

test("the editor bottom terminal keeps an idempotent late event binding", () => {
  const setup = runtime.match(/function setupEditorBottomPanelEvents[\s\S]*?\n      }\n\n      function editorDirectoryEntries/)?.[0] || "";
  assert.match(setup, /dataset\.editorBottomEventBound/);
  assert.match(setup, /selectEditorBottomPanel\(button\.dataset\.editorBottomTab\)/);
  assert.match(runtime, /if \(id === "editorView"\) \{\n          setupEditorWorkspaceEvents\(\);/);
});

test("the editor explorer uses the active worker workspace", () => {
  assert.match(runtime, /async function editorDirectoryEntriesForRuntime/);
  assert.match(runtime, /const listing = await workerFs\("list", \{ path: normalizePath\(path\) \}\)/);
  assert.match(runtime, /const refreshGeneration = \+\+editorExplorerRefreshGeneration/);
  assert.match(runtime, /if \(refreshGeneration !== editorExplorerRefreshGeneration\) return/);
  assert.match(runtime, /host\.replaceChildren\(tree\)/);
  assert.match(runtime, /for \(const path of await walkEditorFiles\(\)\)/);
  assert.match(runtime, /if \(WORKER_SHELL_ENABLED\) await workerFs\("mkdir", \{ path \}\)/);
});

test("editor workspace controls bind when the editor view opens", () => {
  const setup = runtime.match(/function setupEditorWorkspaceEvents[\s\S]*?\n      }\n\n      function editorDirectoryEntries/)?.[0] || "";
  assert.match(setup, /data-editor-activity/);
  assert.match(setup, /editorExplorerTree/);
  assert.match(setup, /editorGlobalSearch/);
  assert.match(runtime, /if \(id === "editorView"\) \{\n          setupEditorWorkspaceEvents\(\);/);
});

test("the editor terminal restores the primary terminal after a command", () => {
  const execute = runtime.match(/async function executeEditorTerminalCommand[\s\S]*?\n      }\n\n      function initializeEditorTerminal/)?.[0] || "";
  assert.match(execute, /term = primaryTerm \|\| previousTerm/);
  assert.match(execute, /!externalStatus\?\.foreground/);
  assert.match(execute, /setTerminalInputReady\(true\)/);
});

test("interactive standard server commands use the shared app adapter", () => {
  const run = runtime.match(/async function runWorkerCommand[\s\S]*?\n      }\n\n      async function workerFs/)?.[0] || "";
  assert.match(run, /runStandardServerCommand\(line, commandCwd\)/);
  assert.match(runtime, /async function runStandardServerCommand\(line, commandCwd\)/);
  assert.match(runtime, /const app = await bridgeStartApp/);
  assert.match(runtime, /EdgeTerm virtual listener ready at http:\/\/127\.0\.0\.1/);
  assert.match(runtime, /function commandSequenceNeedsHostRouting\(line\)/);
  assert.match(runtime, /bridgeStandardServerCommand\(source\)/);
});

test("all static editor controls use the editor lifecycle binding", () => {
  const setup = runtime.match(/function setupEditorWorkspaceEvents[\s\S]*?\n      }\n\n      function editorDirectoryEntries/)?.[0] || "";
  for (const id of ["editorPath", "editorTabs", "editorToggleBottomPanel", "openSplitEditorButton", "commandPaletteInput"]) {
    assert.match(setup, new RegExp(id));
  }
});

test("returning to the terminal resumes an idle primary terminal", () => {
  assert.match(runtime, /if \(id === "terminalView"\) \{/);
  assert.match(runtime, /const terminalCanResume =/);
  assert.match(runtime, /setTerminalInputReady\(true\);\s*term\?\.resume\?\.\(\);/);
});

test("file mutations keep open editor paths synchronized", () => {
  assert.match(runtime, /function remapEditorWorkspacePath\(source, target\)/);
  assert.match(runtime, /function removeEditorWorkspacePaths\(paths\)/);
  const rename = runtime.match(/async function renameSelectedPath[\s\S]*?\n      }\n\n      async function deleteSelectedPaths/)?.[0] || "";
  assert.match(rename, /remapEditorWorkspacePath\(path, target\)/);
  const remove = runtime.match(/async function deleteSelectedPaths[\s\S]*?\n      }\n\n      async function createFolderInCurrentPath/)?.[0] || "";
  assert.match(remove, /removeEditorWorkspacePaths\(paths\)/);
});

test("deleting the active terminal directory falls back before removal", () => {
  assert.match(runtime, /async function moveTerminalOutsideRemovedPaths\(paths\)/);
  const remove = runtime.match(/async function deleteSelectedPaths[\s\S]*?\n      }\n\n      async function createFolderInCurrentPath/)?.[0] || "";
  assert.match(remove, /await moveTerminalOutsideRemovedPaths\(paths\)/);
  assert.match(remove, /finally \{\s*hideProgressNotice\(\);\s*\}/);
});

test("workspace UI mutations invalidate dormant command snapshots", () => {
  const invalidator = runtime.match(/async function bridgeNotifyExternalShellWorkspaceChanged[\s\S]*?\n      }/)?.[0] || "";
  assert.match(invalidator, /markWorkspaceMutation\(\)/);
  for (const functionName of [
    "renameSelectedPath",
    "deleteSelectedPaths",
    "pasteClipboardItems",
    "uploadWorkerFiles",
    "createWorkerFolderInCurrentPath",
    "createWorkerFileInCurrentPath",
    "saveWorkerEditor",
  ]) {
    const start = runtime.indexOf(`function ${functionName}`);
    assert.notEqual(start, -1, `${functionName} should exist`);
    const next = runtime.indexOf("\n      function ", start + 1);
    const source = runtime.slice(start, next === -1 ? runtime.length : next);
    assert.match(source, /bridgeNotifyExternalShellWorkspaceChanged\(\)/, `${functionName} should invalidate snapshots`);
  }
});

test("worker workspace switches retire the previous POSIX runtime snapshot", () => {
  const start = runtime.indexOf("async function switchWorkerWorkspace(id)");
  const end = runtime.indexOf("\n      async function uploadWorkerFiles", start);
  const implementation = runtime.slice(start, end);
  assert.match(implementation, /activeWorkspaceId = id;[\s\S]*?await bridgeNotifyExternalShellWorkspaceChanged\(\);/);
  assert.ok(
    implementation.indexOf("activeWorkspaceId = id;") < implementation.indexOf("await bridgeNotifyExternalShellWorkspaceChanged();"),
    "the active workspace must change before the POSIX snapshot is retired",
  );
});

test("filesystem cache invalidation removes deleted descendants", () => {
  const invalidator = worker.match(/function invalidateFsEntriesCache[\s\S]*?\n}/)?.[0] || "";
  assert.match(invalidator, /root\.startsWith\(changedPath \+ "\/"\)/);
  assert.match(invalidator, /!entry\.path\.startsWith\(changedPath \+ "\/"\)/);
});

test("compound commands preserve the shell last-exit status", () => {
  assert.match(externalWorker, /function expandShellLastStatus\(source, status\)/);
  assert.match(externalWorker, /source: expandShellLastStatus\(entry\.source, sequenceExitCode\)/);
  assert.match(externalWorker, /Runtime execution failed: .*ExitCode::\\d\+/);
  assert.match(externalWorker, /\.edgeterm-runtime-state-/);
  assert.match(externalWorker, /streamedOutput: streamOutput/);
});

test("the terminal routes mixed-runtime command lists one segment at a time", () => {
  const dispatcher = runtime.match(/async function runRoutedCommandSequence[\s\S]*?\n      }\n\n      async function runCommand/)?.[0] || "";
  assert.match(dispatcher, /splitTopLevelCommandSequence\(line\)/);
  assert.match(dispatcher, /expandShellLastStatus\(entry\.source, previousExitCode\)/);
  assert.match(dispatcher, /currentCwd = String\(lastResult\?\.cwd \|\| currentCwd\)/);
  assert.match(runtime, /runWorkerCommand\(entry, \{[\s\S]*?sequencePart: true/);
  assert.match(runtime, /runCommand\(entry, \{[\s\S]*?sequencePart: true/);
});

test("nested package runtimes receive the current directory and shared temporary files", () => {
  assert.match(worker, /function collectWasmSyncRoots[\s\S]*?roots\.add\(cwd \|\| "\/"\)/);
  assert.doesNotMatch(worker, /const inlineOnly/);
  assert.match(worker, /const temporaryTarget = `\/home\/\$\{primaryUser\}\/\.edgeterm-posix\/tmp`/);
  assert.match(worker, /pyodide\.FS\.symlink\(temporaryTarget, "\/tmp"\)/);
  assert.match(externalWorker, /const WORKSPACE_TEMP_ROOT = "\.edgeterm-posix\/tmp"/);
  assert.match(externalWorker, /snapshotRuntimeWorkspace\(directory, posix\.temporaryDirectory\)/);
  assert.match(externalWorker, /async function runTemporaryMutationAdapter/);
  assert.match(externalWorker, /processResult \|\|= await runTemporaryMutationAdapter/);
  assert.match(externalWorker, /async function runCdAdapter\(\{ words, cwd, workspaceRoot, directory, posix \}\)/);
});

test("test expressions preserve operators and keep false results quiet", () => {
  assert.match(externalWorker, /const testFileOperandIndexes = new Set\(\)/);
  assert.match(externalWorker, /testFileOperandIndexes\.has\(index\)/);
  assert.match(externalWorker, /\[\"\[\", \"false\", \"test\"\]/);
  assert.match(externalWorker, /function stripRuntimeExitNoise\(value\)/);
});

test("APT global options do not hide package mutations from system snapshots", () => {
  assert.match(
    externalWorker,
    /packageOperation = words\.slice\(1\)\.find\([\s\S]*?packageOperations\.has/,
  );
  assert.match(
    externalWorker,
    /\["apt", "apt-get"\]\.includes\(program\)[\s\S]*?packageOperations\.has\(packageOperation\)/,
  );
});

test("compound shell execution restores package executable bits before PATH lookup", () => {
  assert.match(
    externalWorker,
    /const wrapped = `chmod 755 \/usr\/local\/bin\/\* \/usr\/local\/sbin\/\* \/opt\/\*\/bin\/\*/,
  );
  assert.match(externalWorker, /cd \$\{shellQuote\(runtimeCwd\)\} \|\| exit \$\?/);
});
