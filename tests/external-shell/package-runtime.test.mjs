import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  aptArchiveSelection,
  buildRecoveredDpkgFileLists,
  buildRecoveredDpkgStatus,
  isJustRecipeCommand,
  isBufferedInteractiveShellCommand,
  isAptMetadataRefresh,
  isInteractiveAptTransaction,
  isMakeRecipeCommand,
  isNonInteractiveAptTransaction,
  justDryRunCommand,
  makeDryRunCommand,
  mayChangeInteractiveFiles,
  parseJustDryRunCommands,
  parseDebianPackageIndex,
  parseInstalledPackageVersions,
  requiresInteractiveTerminal,
  rewriteAptCommandWithArchives,
} from "../../frontend/src/external-shell/runtime-controller.js";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeControllerSource = fs.readFileSync(
  path.join(root, "frontend/src/external-shell/runtime-controller.js"),
  "utf8",
);


test("APT package staging selects requested archives and dependency closures", () => {
  const packages = parseDebianPackageIndex(`Package: openssl
Version: 3.6.3-1edgeterm1
Filename: pool/candidate/openssl.deb
SHA256: abc

Package: openssh-client
Version: 10.4p1-1edgeterm1
Depends: openssl
Filename: pool/candidate/openssh-client.deb
SHA256: def
`);
  assert.deepEqual(
    aptArchiveSelection("apt install -y openssh-client", packages),
    ["openssl", "openssh-client"],
  );
});

test("APT skips archives that are already installed at the candidate version", () => {
  const packages = parseDebianPackageIndex(`Package: git
Version: 2.55.0-1edgeterm4
Filename: current/git.deb
SHA256: abc
`);
  const installed = new Map([["git", "2.55.0-1edgeterm4"]]);
  assert.deepEqual(aptArchiveSelection("apt install git", packages, installed), []);
  assert.deepEqual(aptArchiveSelection("apt reinstall git", packages, installed), ["git"]);
});

test("rebuilds dpkg status records from installed package manifests", () => {
  const packages = parseDebianPackageIndex(`Package: git
Version: 2.55.0-1edgeterm4
Architecture: wasm32-wasix
Depends: curl
Installed-Size: 2048
Maintainer: DigitalPlat <packages@digitalplat.org>
Description: distributed version control system
Filename: current/git.deb
SHA256: abc
`);
  const status = buildRecoveredDpkgStatus(packages, new Map([
    ["git", {
      package: "git",
      version: "2.55.0-1edgeterm3",
      commands: ["git"],
    }],
  ]));

  assert.deepEqual(
    parseInstalledPackageVersions(status),
    new Map([["git", "2.55.0-1edgeterm3"]]),
  );
  assert.match(status, /^Package: git$/m);
  assert.match(status, /^Status: install ok installed$/m);
  assert.match(status, /^Architecture: wasm32-wasix$/m);
  assert.match(status, /^Depends: curl$/m);
  assert.doesNotMatch(status, /^Filename:/m);
  assert.doesNotMatch(status, /^SHA256:/m);
});

test("rebuilds minimal dpkg ownership lists for recovered packages", () => {
  const lists = buildRecoveredDpkgFileLists(new Map([
    ["git", {
      package: "git",
      manifestPath: "/usr/local/share/edgeterm/commands/git.json",
      commands: ["git", "git-upload-pack"],
    }],
  ]));

  assert.equal(
    lists.get("git"),
    [
      "/usr/local/bin/git",
      "/usr/local/bin/git-upload-pack",
      "/usr/local/sbin/git",
      "/usr/local/sbin/git-upload-pack",
      "/usr/local/share/edgeterm/commands/git.json",
      "",
    ].join("\n"),
  );
});


test("non-interactive APT transactions remain detectable", () => {
  assert.equal(isNonInteractiveAptTransaction("apt install -y git"), true);
  assert.equal(isNonInteractiveAptTransaction("apt --yes upgrade"), true);
  assert.equal(isNonInteractiveAptTransaction("apt install git"), false);
});


test("only APT operations that can prompt use the persistent terminal process", () => {
  assert.equal(isInteractiveAptTransaction("apt update"), false);
  assert.equal(isInteractiveAptTransaction("apt list dash"), false);
  assert.equal(isInteractiveAptTransaction("apt install dash"), true);
  assert.equal(isInteractiveAptTransaction("apt upgrade"), true);
  assert.equal(isInteractiveAptTransaction("apt install -y dash"), false);
  assert.equal(isInteractiveAptTransaction("apt-get --assume-yes remove dash"), false);
});

test("APT metadata refreshes remain read-only to the workspace", () => {
  assert.equal(isAptMetadataRefresh("apt update"), true);
  assert.equal(isAptMetadataRefresh("apt-get update"), true);
  assert.equal(isAptMetadataRefresh("apt install git"), false);
});


test("only commands that need a terminal enter the persistent process", () => {
  assert.equal(requiresInteractiveTerminal("dash -c 'printf ready'"), false);
  assert.equal(requiresInteractiveTerminal("bison parser.y"), false);
  assert.equal(requiresInteractiveTerminal("ninja -C build"), false);
  assert.equal(requiresInteractiveTerminal("hexedit file.bin"), true);
  assert.equal(requiresInteractiveTerminal("less file.txt"), true);
  assert.equal(requiresInteractiveTerminal("apt install dash"), true);
  assert.equal(requiresInteractiveTerminal("apt install -y dash"), false);
});


test("just recipes are planned by the real parser before host-shell execution", () => {
  assert.equal(isJustRecipeCommand("just -f /home/user/justfile hello"), true);
  assert.equal(isJustRecipeCommand("just --list"), false);
  assert.equal(isJustRecipeCommand("just --dry-run hello"), false);
  assert.equal(
    justDryRunCommand("just -f /home/user/justfile hello"),
    "just --dry-run --no-highlight -f /home/user/justfile hello",
  );
  assert.deepEqual(parseJustDryRunCommands(" echo one\n\nprintf two\n"), [
    "echo one",
    "printf two",
  ]);
});


test("make recipes use dry-run planning before host-shell execution", () => {
  assert.equal(isMakeRecipeCommand("make -f /home/user/Makefile hello"), true);
  assert.equal(isMakeRecipeCommand("make --version"), false);
  assert.equal(isMakeRecipeCommand("make -n hello"), false);
  assert.equal(
    makeDryRunCommand("make -f /home/user/Makefile hello"),
    "make --dry-run --no-print-directory -f /home/user/Makefile hello",
  );
});

test("shfmt write mode synchronizes the formatted workspace file", () => {
  assert.equal(mayChangeInteractiveFiles("shfmt -i 2 -w /home/user/script.sh"), true);
  assert.equal(mayChangeInteractiveFiles("shfmt /home/user/script.sh"), false);
});

test("archive write modes synchronize generated and extracted files", () => {
  assert.equal(mayChangeInteractiveFiles("7za a archive.7z input.txt"), true);
  assert.equal(mayChangeInteractiveFiles("7z x archive.7z -oout"), true);
  assert.equal(mayChangeInteractiveFiles("7zr t archive.7z"), false);
  assert.equal(mayChangeInteractiveFiles("7za i"), false);
});

test("replacement tools preserve patterns and rewrite relative file operands", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /\["sd", "ruplacer"\]\.includes\(program\) && replacementOperandCount < 2/);
  assert.match(worker, /\["sd", "ruplacer"\]\.includes\(program\)\) shouldRewrite = true/);
});

test("language and WebAssembly tools receive mapped workspace file operands", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /"ctags", "qjs", "sq", "uncrustify", "wasm-tools", "wasm3"/);
  assert.match(worker, /"wasm-objdump", "wasm-stats", "wasm-strip", "wasm-validate", "wasm2c", "wasm2wat", "wat2wasm"/);
  assert.match(worker, /program === "wasm-tools" && positionalOperandCount === 0/);
  assert.match(worker, /program === "wasm3" && positionalOperandCount > 0/);
  assert.match(worker, /wasm3: new Set\(\["--func", "--stack-size"\]\)/);
});

test("7-Zip output directories are mapped into the persistent workspace", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /\["7z", "7za", "7zr"\]\.includes\(program\) && value\.startsWith\("-o"\)/);
  assert.match(worker, /`-o\$\{absoluteWorkspacePath\(value\.slice\(2\), cwd, workspaceRoot, runtimeRoot\)\}`/);
});

test("find expression values are not rewritten as workspace paths", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /let findExpressionStarted = false/);
  assert.match(worker, /if \(program === "find"\) findExpressionStarted = true/);
  assert.match(worker, /program === "find" && findExpressionStarted/);
  assert.match(worker, /"-newer", "-anewer", "-cnewer"/);
});



test("APT transactions use the freshly staged archives", () => {
  const archives = [
    "/home/user/apt-repository/pool/candidate/git_2.55.0-1edgeterm3_wasm32-wasix.deb",
  ];
  assert.equal(
    rewriteAptCommandWithArchives("apt install -y git", archives),
    `apt install -y ${archives[0]}`,
  );
  assert.equal(
    rewriteAptCommandWithArchives("apt reinstall -y git", archives),
    `apt install --reinstall -y ${archives[0]}`,
  );
  assert.equal(
    rewriteAptCommandWithArchives("apt upgrade", archives),
    `apt install ${archives[0]}`,
  );
});

test("APT package mutations return system changes to the controller", () => {
  assert.match(runtimeControllerSource, /captureChanges: needsWorkspacePackageRepository\(command\)/);
  assert.doesNotMatch(runtimeControllerSource, /&& !isAptMetadataRefresh\(command\)/);
  assert.match(
    runtimeControllerSource,
    /this\.state\.interactiveDormant[\s\S]*?needsWorkspacePackageRepository\(command\)[\s\S]*?!interactiveApt[\s\S]*?!isNonInteractiveAptTransaction\(command\)/,
  );
  assert.match(runtimeControllerSource, /async persistStagedPackagePayloads\(root, cwd = root, stagedArchivePaths = this\.stagedAptArchivePaths\)/);
  assert.match(runtimeControllerSource, /await this\.applySystemChanges\(result\.systemChanges \|\| \[\]\)/);
  assert.match(runtimeControllerSource, /function referencesInstalledPackageFilesystem\(source\)/);
  assert.match(runtimeControllerSource, /omitInstalledPayload: !referencesInstalledPackageFilesystem\(command\)/);
  assert.match(
    runtimeControllerSource,
    /shouldHydrateRuntimeFilesystemInBatches\(runtimeFilesystem\)[\s\S]*?omitInstalledPayload: !referencesInstalledPackageFilesystem\(command\)/,
  );
  const shellWorker = fs.readFileSync(
    path.join(root, "frontend/static/pyodide-shell-worker.js"),
    "utf8",
  );
  assert.match(shellWorker, /const writesExternalPackages = entries\.some/);
  assert.match(shellWorker, /workspaceMounted && writesExternalPackages[\s\S]*?persistDirtyWorkerEntries/);
});


test("APT upgrade staging downloads only installed packages with newer candidates", () => {
  const packages = parseDebianPackageIndex(`Package: gettext
Version: 1.0-1edgeterm3
Filename: pool/candidate/gettext.deb
SHA256: abc

Package: lua
Version: 5.5.0-1edgeterm2
Filename: pool/candidate/lua.deb
SHA256: def

Package: curl
Version: 8.21.0-1edgeterm1
Filename: pool/candidate/curl.deb
SHA256: ghi
`);
  const installed = parseInstalledPackageVersions(`Package: gettext
Status: install ok installed
Version: 1.0-1edgeterm1

Package: lua
Status: install ok installed
Version: 5.5.0-1edgeterm2
`);
  assert.deepEqual(aptArchiveSelection("apt upgrade", packages, installed), ["gettext"]);
});


test("installed WASIX commands take precedence over bundled fallback commands", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /const installedBinary = preferBusyBox \? null : await readInstalledRuntimeBinary\(posix, program\)/);
  assert.match(worker, /\/usr\/local\/bin:\/usr\/local\/sbin:\/\.edgeterm-bin:/);
  assert.match(worker, /\/share\/edgeterm\/commands/);
  assert.match(worker, /\/opt/);
  assert.match(worker, /getInstalledRuntimeCommand\(program, installedBinary\)/);
  assert.match(worker, /Wasmer\.fromFile\(binary\)/);
  assert.match(worker, /packaged\.entrypoint/);
  assert.match(worker, /command\.run\(options\)/);
  assert.match(worker, /await closeProcessStdin\(instance, options\.stdin\)/);
  assert.match(worker, /async function hydratedInstalledPackages\(systemDirectories\)/);
  assert.match(worker, /!hydrated\.has\(packageName\)/);
  assert.doesNotMatch(worker, /command\.run\(\{ runtime: new Runtime\(\), \.\.\.options }\)/);
  assert.match(worker, /const PACKAGE_SYSTEM_MOUNTS = new Set\(\[\s*"\/usr",\s*"\/opt",\s*"\/etc",\s*"\/var"/);
  assert.doesNotMatch(worker, /const PACKAGE_SYSTEM_MOUNTS = new Set\(\[\s*"\/usr\/local"/);
});

test("Lua expression mode closes stdin after starting the runtime", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /program === "lua"/);
  assert.match(worker, /argument === "-e" \|\| argument\.startsWith\("-e"\)/);
  assert.match(worker, /&& !nonInteractiveLanguageCommand/);
});

test("streaming shell output is rendered as terminal lines", () => {
  const runtime = fs.readFileSync(path.join(root, "frontend/src/core/runtime.js"), "utf8");
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  assert.match(runtime, /function queueExternalShellOutput\(stream, value\)/);
  assert.match(runtime, /externalShellLineStream\.push\(normalizedStream, text\)/);
  assert.match(runtime, /term\.update\(progressLine, entry\.text\)/);
  assert.match(runtime, /externalShellOutputQueue\.splice\(0, batchSize\)/);
  assert.match(runtime, /const EXTERNAL_SHELL_OUTPUT_INTERVAL_MS = 28/);
  assert.match(runtime, /EXTERNAL_SHELL_OUTPUT_INTERVAL_MS/);
  assert.match(runtime, /finishExternalShellOutput\(\)\.then/);
  assert.match(controller, /if \(!result\.streamedOutput && result\.stdout\) this\.output\("stdout", result\.stdout\)/);
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /streamedOutput: result\.streamedOutput/);
});

test("package filesystem changes are applied in bounded batches", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  assert.match(controller, /let pendingFiles = \[\]/);
  assert.match(controller, /await this\.fs\.writeFiles\(entries\)/);
  assert.match(controller, /pendingFiles\.length >= 200/);
  assert.match(controller, /this\.systemMountCache\.clear\(\)/);
});

test("read-only commands skip full filesystem change scans", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(controller, /captureChanges: mayChangeInteractiveFiles\(executionCommand\)/);
  assert.match(worker, /const captureChanges = payload\.captureChanges !== false/);
  assert.match(worker, /if \(captureChanges\) \{/);
  assert.match(controller, /systemMountCacheKey: this\.systemMountCacheKey/);
  assert.match(worker, /commandSystemCache\?\.key === cacheKey/);
});

test("installed package scripts are discovered inside the persistent usr mount", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /if \(path === "\/usr"\)/);
  assert.match(worker, /\^local\\\/\(\?:s\?bin\)\\\//);
  assert.match(worker, /packageScripts\[match\[1\]\]/);
});

test("Flex commands use the buffered two-stage runtime adapter", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.equal(isBufferedInteractiveShellCommand("flex scanner.l"), true);
  assert.equal(isBufferedInteractiveShellCommand("flex++ -o scanner.cc scanner.l"), true);
  assert.equal(isBufferedInteractiveShellCommand("yamlfmt config.yaml"), true);
  assert.match(worker, /metadata\?\.adapter !== "flex-m4"/);
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  assert.match(controller, /runFlexM4Command/);
  assert.match(controller, /"interactive-command-run"/);
  assert.match(controller, /syncFiles: true/);
  assert.match(controller, /"interactive-run-buffered"/);
  assert.match(worker, /source: \["flex-real", "--preproc=0", "-o", intermediatePath, \.\.\.scannerArguments\]/);
  assert.match(worker, /const m4Source = writesStdout/);
});

test("APT and dpkg state is persisted in the workspace package overlay", () => {
  const runtime = fs.readFileSync(
    path.join(root, "frontend/src/core/runtime.js"),
    "utf8",
  );
  assert.match(runtime, /const WORKSPACE_PACKAGE_OVERLAY_ENTRIES = new Set/);
  assert.match(runtime, /"\/usr\/local"/);
  assert.match(runtime, /"\/var\/lib\/dpkg"/);
  assert.match(runtime, /WORKSPACE_PACKAGE_OVERLAY_ENTRIES\.has\(rootEntry\)/);
  assert.match(runtime, /const packageRuntimePath = \(value\) =>/);
  assert.match(runtime, /return `\$\{activeRootfsPath\(\)\}\$\{target\}`/);
  assert.match(runtime, /if \(!packageRoots\.has\(target\)\) syncRuntimePathToWorkspace\(target\)/);
  assert.match(runtime, /if \(!packagePath\(target\)\) \{/);
});

test("the shell prompt returns only after package changes are persisted", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  assert.match(
    controller,
    /onCommandExit: async \(event\) => \{[\s\S]*?await this\.syncing\.catch[\s\S]*?await this\.persisting\.catch[\s\S]*?this\.state\.foreground = false/,
  );
  assert.match(
    controller,
    /onCommandExit: async \(event\) => \{[\s\S]*?Array\.isArray\(event\.installedCommands\)[\s\S]*?this\.state\.installedCommands = event\.installedCommands/,
  );
  assert.match(
    controller,
    /Array\.isArray\(result\.installedCommands\)[\s\S]*?Number\(result\.changedSystemFiles \|\| 0\) > 0/,
  );
});

test("package runtime snapshots only the package-managed system subtrees", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(controller, /const PACKAGE_SYSTEM_SUBTREES = new Map/);
  assert.match(controller, /"\/usr\/local"/);
  assert.match(controller, /"\/var\/lib\/dpkg"/);
  assert.match(controller, /for \(const subtree of PACKAGE_SYSTEM_SUBTREES\.get\(path\)/);
  assert.match(controller, /maxFiles: 50_000/);
  assert.match(controller, /maxBytes: 256 \* 1024 \* 1024/);
  assert.match(controller, /timeoutMs: 180_000/);
  assert.match(controller, /const PACKAGE_SYSTEM_EXCLUDES = \[/);
  assert.match(controller, /package-state-layout/);
  assert.match(controller, /exclude: subtree === "\/usr\/local" \? PACKAGE_SYSTEM_EXCLUDES : \[\]/);
  assert.match(controller, /interactive-add-files/);
  assert.match(controller, /includePackageRepository: !isExternalShellSessionEntry\(command\)/);
  assert.match(
    controller,
    /async resumeInteractiveSession[\s\S]*?omitInstalledPayload: true/,
  );
  assert.match(
    controller,
    /if \(requiresInteractiveTerminal\(command\)\)[\s\S]*?omitInstalledPayload: true/,
  );
  assert.match(worker, /async function addInteractiveFiles\(payload\)/);
  assert.match(worker, /Dir::Cache::pkgcache/);
  assert.match(worker, /return await finalizeInteractiveSession\(session\)/);
});

test("APT stages verified local archives without configuring an acquire source", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(
    worker,
    /const mounts = \{[\s\S]*?mountWorkspaceDirectory\(mounts, workspaceDirectory, workspaceRoot\)/,
  );
  assert.match(worker, /"\/tmp": new Directory\(\)/);
  assert.doesNotMatch(worker, /URIs: file:\$\{WORKSPACE_RUNTIME_ROOT\}\/apt-repository/);
  assert.match(controller, /stageAptRepository\(root, command\)/);
  assert.match(controller, /external_shell_package_checksum_mismatch/);
  assert.match(controller, /const PACKAGE_OVERRIDE_COMMANDS = new Set/);
  assert.match(controller, /await sha256Hex\(bytes\)/);
  assert.match(controller, /Downloading \$\{name\}/);
});

test("the POSIX bootstrap exposes locally installed commands through traditional system paths", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /for command in \/usr\/local\/bin\/\*/);
  assert.match(worker, /ln -s \\"\$command\\" \\"\/usr\/bin\/\$name\\"/);
  assert.match(worker, /for command in \/usr\/local\/sbin\/\*/);
  assert.match(worker, /ln -s \\"\$command\\" \\"\/usr\/sbin\/\$name\\"/);
});


test("non-interactive commands isolate process state while reusing the command runtime", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /isolatedRuntime = true/);
  assert.match(worker, /getSharedCommandRuntime\(mount\)/);
  assert.doesNotMatch(worker, /SHARED_RUNTIME_COMMANDS/);
  assert.match(worker, /const commandRuntime = isolatedRuntime && !BUSYBOX_APPLET_NAMES\.includes\(program\)[\s\S]*?getSharedCommandRuntime\(mount\)/);
  assert.match(worker, /getSharedCommandRuntime\(options\.mount\)/);
  assert.match(worker, /runWasix\(runtimeBinaries\.get\("ash"\), \{/);
  assert.match(worker, /function hasShellControlSyntax\(source\)/);
  assert.match(worker, /if \(hasShellControlSyntax\(expandedSource\)\) return null/);
  assert.doesNotMatch(worker, /runtimePackage\?\.commands\?\.ash/);
  assert.match(worker, /let commandRuntime = null/);
  assert.match(worker, /async function getSharedCommandRuntime\(mounts = \{\}\)[\s\S]*?if \(!commandRuntime\) commandRuntime = new Runtime\(\)[\s\S]*?return commandRuntime/);
  assert.match(worker, /const syncFiles = payload\.syncFiles !== false/);
  assert.match(worker, /const commandBefore = changesSystemPackages \|\| !syncFiles/);
  assert.match(worker, /syncFiles,\s*commandBefore/);
  assert.match(worker, /async function prepareMountedDirectoryPermissions[\s\S]*?runtime: await getSharedCommandRuntime\(mount\)/);
  assert.match(worker, /args: \["chmod", "u\+rwx,go\+rx", WORKSPACE_RUNTIME_ROOT\]/);
  assert.doesNotMatch(worker, /chmod(?:",| )\s*"?-R[\s\S]{0,80}WORKSPACE_RUNTIME_ROOT/);
  assert.match(worker, /processResult = await runDirectRuntimeCommand\(\{/);
  assert.doesNotMatch(worker, /async function runInteractivePipeline[\s\S]*?await queryInteractiveCwd\(session\)[\s\S]*?pipeline-prepare/);
  assert.match(worker, /mounts: \{ \.\.\.session\.posix\.mounts \}/);
  assert.match(worker, /installedCommands: new Map\(session\.posix\.installedCommands \|\| \[\]\)/);
  assert.match(worker, /program: "busybox",\s*args: \[program, \.\.\.options\.args\]/);
  assert.match(worker, /const WORKSPACE_RUNTIME_ROOT = WORKSPACE_MOUNT_ROOT/);
  assert.match(worker, /mountWorkspaceDirectory\(mount, commandDirectory, workspaceRoot\)/);
  assert.match(worker, /delete mount\[WORKSPACE_MOUNT_ROOT\]/);
  assert.match(worker, /function mountsForForegroundCommand[\s\S]*?PACKAGE_SYSTEM_MOUNTS/);
  assert.doesNotMatch(worker, /for \(const path of PACKAGE_SYSTEM_MOUNTS\) delete mounts\[path\]/);
  assert.match(worker, /const POSIX_VIRTUAL_ROOT_MOUNTS = \[/);
  assert.match(worker, /mountWorkspaceDirectory\(mounts, workspaceDirectory, workspaceRoot\)/);
  assert.match(worker, /const commandBefore = changesSystemPackages \|\| !syncFiles[\s\S]*?: selectPipelineSnapshot\(/);
  assert.match(worker, /const targetedMutationCommands = new Set\(\["cp", "ln", "mkdir", "mv", "rm", "rmdir", "touch", "truncate"\]\)/);
  assert.match(worker, /const DIRECT_RUNTIME_ROOT = "\/\.edgeterm-direct-workspace"/);
  assert.match(worker, /cwd: directCwd/);
  assert.doesNotMatch(worker, /createWorkspaceFromSnapshot\(executionSnapshot\)/);
  assert.match(worker, /mountWorkspaceDirectory\(mount, directory, workspaceRoot\)/);
  assert.doesNotMatch(worker, /mount\[DIRECT_RUNTIME_ROOT\] = directory/);
  assert.match(worker, /const directRuntimeRoot = WORKSPACE_RUNTIME_ROOT/);
  assert.match(worker, /env\.PWD = directCwd/);
  assert.match(worker, /program === "gojq"[\s\S]*?values\.unshift\("-L", runtimeRoot\)/);
  assert.match(worker, /preferBusyBox: explicitBusyBoxApplet[\s\S]*?BUSYBOX_APPLET_NAMES\.includes\(redirectionProgram\)/);
  assert.match(worker, /\["ash", "bash", "dash", "sh"\]\.includes\(program\)[\s\S]*?shellQuote\(directRuntimeRoot\)[\s\S]*?directCwd = "\/"/);
  assert.match(worker, /"bat", "bison", "brotli"/);
  assert.match(worker, /"7z", "7za", "7zr", "actionlint"/);
  assert.match(worker, /"cat", "cksum", "cmark"/);
  assert.match(worker, /"hexedit", "install", "less"/);
  assert.match(worker, /"mkdir", "mv", "ncdu", "patch"/);
  assert.match(worker, /const directRuntimeRoot = WORKSPACE_RUNTIME_ROOT/);
  assert.match(worker, /localPackageCommands\.has\(program\) && value\.startsWith\("\/"\)/);
  assert.match(worker, /const relative = workspaceRelativePath\(value, cwd, workspaceRoot\)/);
  assert.doesNotMatch(worker, /if \(!String\(value \|\| ""\)\.startsWith\("\/"\)\) return String\(value \|\| ""\)/);
  assert.doesNotMatch(worker, /program === "ls" && !hasPath/);
  assert.match(worker, /let grepPatternSeen = false/);
  assert.match(worker, /previous === "-e" \|\| previous === "--regexp"/);
  assert.doesNotMatch(worker, /mkdir -p [^"\n]*\/home/);
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  assert.match(controller, /for \(const path of PACKAGE_SYSTEM_MOUNTS\) \{[\s\S]*?await this\.fs\.mkdir\(path\)/);
  assert.match(controller, /await this\.fs\.ensureReady\?\.\(\)/);
  assert.doesNotMatch(worker, /URIs: file:\$\{WORKSPACE_RUNTIME_ROOT\}\/apt-repository/);
  assert.match(worker, /streamOutput: streamOutput && \(!pipeline \|\| index === segments\.length - 1\)/);
  assert.match(worker, /if \(streamOutput\) post\("interactive-output"/);
  const runtime = fs.readFileSync(path.join(root, "frontend/src/core/runtime.js"), "utf8");
  assert.match(runtime, /pyodide\.FS\.writeFile\(runtimeTarget, data\);\s*syncRuntimePathToWorkspace\(target\)/);
});

test("installed commands can load an optional multi-command runtime bundle", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /metadata\.bundle\.startsWith\("\/usr\/"\)/);
  assert.match(worker, /bundlePath\.startsWith\("\/usr\/"\)/);
  assert.match(worker, /usr\?\.readFile\(bundlePath\.slice\("\/usr"\.length\)\)/);
  assert.match(worker, /packaged\.commands\?\.\[program\] \|\| packaged\.entrypoint/);
});

test("workspace writes invalidate a stale dormant shell before changes are applied", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  assert.match(
    controller,
    /if \(\(workspaceChanged \|\| systemChanged\) && this\.state\.interactiveDormant\) \{\s*await this\.stopDormantSession\(\);\s*\}\s*this\.progress\(\{ phase: "apply-workspace"/,
  );
});

test("APT transactions preserve subprocess support and staged archive paths", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  for (const command of ["apt", "apt-get", "dpkg", "dpkg-deb"]) {
    assert.match(worker, new RegExp(`"${command.replace("-", "\\-")}"`));
  }
  assert.match(worker, /ASH_COMMAND_QUERY_PREFIX/);
  assert.match(worker, /_workspace_apt-repository_\._Packages/);
  assert.match(worker, /cache\/apt\/archives\/\$\{basename\}/);
  assert.match(worker, /const commandRuntime = isolatedRuntime[\s\S]*?getSharedCommandRuntime\(mount\)/);
  assert.match(worker, /runtime: wasixRuntime/);
  assert.match(worker, /!foreground\.shellManaged[\s\S]*?\^y\\n\$/);
  assert.match(controller, /rewriteAptCommandWithArchives\([\s\S]*?this\.stagedAptArchivePaths/);
  assert.match(controller, /const requiredFiles = new Set\(\[[\s\S]*?"Packages"[\s\S]*?this\.stagedAptArchivePaths/);
  assert.match(controller, /entry\.dir \? !requiredDirectories\.has\(path\) : !requiredFiles\.has\(path\)/);
  const ensureDormant = controller.match(/async ensureDormantSession[\s\S]*?\n  }\n\n  async warmup/)?.[0] || "";
  assert.doesNotMatch(ensureDormant, /stageAptRepository/);
  assert.match(controller, /async stageAptRepository[\s\S]*?await this\.fs\.ensureReady\?\.\(\)/);
  assert.match(controller, /refreshMetadata = isAptMetadataRefresh\(command\)/);
  assert.match(controller, /readText\(`\$\{repositoryRoot\}\/Packages`\)/);
  assert.match(controller, /loadPackageIndex\(repositoryRoot, \{ refresh: refreshMetadata \}\)/);
  assert.match(ensureDormant, /async ensureDormantSession\(root, cwd, \{ omitInstalledPayload = false \} = \{\}\)/);
  assert.match(ensureDormant, /includePackageRepository: false[\s\S]*?omitInstalledPayload,/);
  assert.match(controller, /packageArchivePaths: this\.runtimePackageArchivePaths/);
  assert.match(controller, /external_shell_installed_archive_missing/);
  assert.match(controller, /needsWorkspacePackageRepository\(command\)[\s\S]*?interactive-command-run[\s\S]*?source: executionCommand/);
  assert.match(
    controller,
    /needsWorkspacePackageRepository\(command\)[\s\S]*?await this\.stageAptRepository\(root, command\);[\s\S]*?!this\.stagedAptArchivePaths\.length[\s\S]*?runDormantCommand\(command, root,[\s\S]*?await this\.stopDormantSession\(\);[\s\S]*?transactionArchivePaths[\s\S]*?await this\.warmup[\s\S]*?this\.stagedAptArchivePaths = transactionArchivePaths[\s\S]*?repositoryStaged: true/,
  );
  assert.doesNotMatch(controller, /source: "apt update"/);
  assert.match(controller, /this\.packageRepositoryPaths\.clear\(\);[\s\S]*?this\.stagedAptArchivePaths = \[\]/);
  assert.match(worker, /async function restoreInstalledPackagePayloads\(/);
  assert.match(worker, /const extractionMounts = \{ \.\.\.mounts \}/);
  assert.match(worker, /await workspaceDirectory\.readFile\(`\/\$\{workspaceRelativeArchive\}`\)/);
  assert.match(worker, /extractionMounts\[archiveMountPath\] = new Directory/);
  assert.match(worker, /mount: extractionMounts/);
  assert.match(worker, /const changes = diffSnapshots\(before, after\);[\s\S]*?applySnapshotChanges\(target, changes, after, before\)/);
  assert.match(worker, /args: \["--fsys-tarfile", `\$\{archiveMountPath\}\/\$\{archiveName\}`\]/);
  assert.match(worker, /async function extractPackageTar\(bytes, directories\)/);
  assert.match(worker, /external_shell_package_archive_path_invalid/);
  assert.match(worker, /Skipping unavailable cached package/);
  assert.match(worker, /const \{ unavailable: unavailablePackages \} = await restoreInstalledPackagePayloads/);
  assert.match(worker, /unavailablePackages\.has\(String\(metadata\?\.package \|\| ""\)\)/);
  assert.match(worker, /command\.run\(options\)/);
  assert.match(worker, /external_shell_package_restore_failed/);
  assert.match(controller, /metadataOnly: true/);
  assert.match(controller, /omitInstalledPayload && subtree === "\/var\/cache\/apt"/);
  assert.match(controller, /omitInstalledPayload && path === "\/usr"/);
  assert.match(controller, /\/usr\/local\/share\/edgeterm\/commands/);
  assert.match(controller, /exclude: \["apt-repository"\]/);
  assert.match(controller, /this\.runtimePackageArchivePaths\.length[\s\S]*?this\.stagedAptArchivePaths/);
  assert.match(controller, /Package archive is outside the workspace repository/);
  assert.match(controller, /files\.push\(\{ \.\.\.archive, path: relativePath \}\)/);
  const shellWorker = fs.readFileSync(
    path.join(root, "frontend/static/pyodide-shell-worker.js"),
    "utf8",
  );
  assert.match(shellWorker, /if \(payload\.metadataOnly\)/);
});


test("interactive foreground routing is not tied to individual packages", () => {
  const controller = fs.readFileSync(
    path.join(root, "frontend/src/external-shell/runtime-controller.js"),
    "utf8",
  );
  assert.doesNotMatch(controller, /INTERACTIVE_FOREGROUND_COMMANDS/);
  assert.match(controller, /syncFiles: mayChangeInteractiveFiles\(command\)/);
  assert.match(controller, /const syncFiles = mayChangeInteractiveFiles\(executionCommand\)[\s\S]*?"interactive-command-run"[\s\S]*?syncFiles,/);
  assert.doesNotMatch(controller, /\"fastfetch\"/);
  assert.match(controller, /INTERACTIVE_SHELL_BUILTINS/);
  const runtime = fs.readFileSync(path.join(root, "frontend/src/core/runtime.js"), "utf8");
  assert.match(runtime, /status\?\.foreground && \(status\?\.interactive \|\| status\?\.interactiveDormant\)/);
  assert.match(runtime, /handleExternalForegroundInput\(event\)/);
  assert.match(runtime, /term\?\.set_prompt\?\.\(""\)/);
  assert.match(runtime, /else if \(externalShellForegroundActive\)/);
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.doesNotMatch(worker, /async function restartInteractiveProcess\(session\)/);
  assert.match(worker, /session\.posix\.installedCommands = await readInstalledCommandMetadata\(/);
  assert.match(worker, /session\.posix\.packageScripts = await readInstalledPackageScripts\(/);
  assert.match(worker, /const packageScript = words\?\.length/);
  assert.match(worker, /packageScript\s*\? await runPackagedCommand\("ash"/);
  assert.match(worker, /installedCommands: \[\.\.\.session\.posix\.installedCommands\.keys\(\)\]/);
  assert.doesNotMatch(
    worker,
    /installedCommands: foreground\.captureChanges \? \[\.\.\.session\.posix\.installedCommands\.keys\(\)\] : \[\]/,
  );
  assert.match(worker, /threaded: metadata\.threaded === true/);
  assert.doesNotMatch(worker, /requiresSharedRuntime/);
  assert.match(controller, /installedCommands: Array\.isArray\(result\.installedCommands\)/);
  assert.match(worker, /BUSYBOX_APPLET_NAMES\.includes\(program\)/);
  assert.match(worker, /const shellFallbackCommand = \[program, \.\.\.foregroundArgs\]/);
  assert.match(worker, /runtimeBinaries\?\.has\(program\)/);
  assert.match(worker, /runPackagedCommand\("ash", \{/);
  assert.match(worker, /args: \["-c", shellFallbackCommand\]/);
  assert.match(worker, /replacement\.completion\.then\([\s\S]*?foreground\.resolveCompletion/);
  assert.match(worker, /const foregroundArgs = rewriteDirectRuntimeArguments\([\s\S]*?WORKSPACE_RUNTIME_ROOT/);
  assert.match(worker, /const commandCwd = String\(payload\.cwd \|\| session\.cwd \|\| session\.workspaceRoot\)/);
  assert.match(worker, /cwd: commandCwd,\s*exitCode:/);
  assert.match(worker, /cwd: foregroundCwd/);
  assert.match(worker, /const processRuntime = changesSystemPackages[\s\S]*?new Runtime\(\)[\s\S]*?getSharedCommandRuntime\(commandMounts\)/);
  assert.match(worker, /cwd: foregroundCwd,\s*env: foregroundEnv,\s*runtime: processRuntime,/);
  assert.match(worker, /mount: \{ \.\.\.session\.posix\.mounts \}/);
  assert.match(worker, /function displayWorkspacePaths\(value, workspaceRoot\)/);
  assert.match(worker, /pumpForegroundStream[\s\S]*?displayWorkspacePaths\([\s\S]*?session\.workspaceRoot/);
  assert.match(worker, /data\.includes\("\\u0003"\)[\s\S]*?exitCode: 130[\s\S]*?interrupted: true/);
  assert.match(runtime, /externalRuntime\?\.running[\s\S]*?externalRuntime\?\.foreground/);
  assert.match(runtime, /externalRuntime\?\.interactive[\s\S]*?externalRuntime\?\.interactiveDormant[\s\S]*?externalRuntime\?\.foreground[\s\S]*?externalShellRuntime\.interrupt/);
});

test("installed commands handle simple workspace redirection without BusyBox fallback", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /function parseSimpleRedirection\(source\)/);
  assert.match(worker, /await readInstalledRuntimeBinary\(posix, redirectionProgram\)/);
  assert.match(worker, /external_shell_redirection_input_missing/);
  assert.match(worker, /redirectionWords\.map\(shellQuote\)\.join\(" "\)/);
});

test("hyperfine uses the direct command adapter in the browser runtime", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /metadata\?\.adapter === "hyperfine-direct"/);
  assert.match(worker, /readInstalledRuntimeBinary\(posix, "hyperfine-real"\)/);
  assert.match(worker, /"hyperfine-real"/);
  assert.match(worker, /usesExplicitShell \? \[\] : \["--shell=none"\]/);
});

test("local rsync uses the workspace compatibility adapter without spawning a child", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /function rsyncLocalOperands\(words\)/);
  assert.match(worker, /async function runLocalRsyncAdapter/);
  assert.match(worker, /program === "rsync" && installedBinary/);
  assert.match(worker, /await runLocalRsyncAdapter\(\{ words, cwd, workspaceRoot, directory \}\)/);
  assert.match(worker, /return operands\.length === 2 \? \{ operands, verbose \} : null/);
});

test("local file mutations use the workspace adapter instead of a fragile foreground process", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /async function runLocalFileMutationAdapter/);
  assert.match(worker, /\["cp", "mv", "rm"\]\.includes\(program\)/);
  assert.match(worker, /processResult \|\|= await runLocalFileMutationAdapter/);
});

test("interactive cwd queries hide control markers from tty echo", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /printf '%s%s:%s%s' '__EDGETERM_' 'ASH_CWD:\$\{queryId\}'/);
  assert.match(worker, /ASH_CWD_QUERY_SUFFIX/);
  assert.doesNotMatch(worker, /printf '\$\{ASH_CWD_QUERY_PREFIX\}/);
});

test("buffered command lists recover after deleting the current directory", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /async function resolveAvailableCommandCwd\(/);
  assert.match(worker, /sequenceCwd = await resolveAvailableCommandCwd\(/);
  assert.match(worker, /await target\.directory\.readDir\(/);
});

test("tar preserves member names while mapping its cwd and option files", () => {
  const worker = fs.readFileSync(
    path.join(root, "frontend/static/external-runtime-worker.js"),
    "utf8",
  );
  assert.match(worker, /if \(program === "tar"\) \{/);
  assert.match(worker, /const pathOptions = new Set\(\["-f", "--file", "-T", "--files-from", "-X", "--exclude-from"\]\)/);
  assert.match(worker, /rewritten\.splice\([\s\S]*?"-C",[\s\S]*?absoluteWorkspacePath\(cwd, cwd, workspaceRoot, runtimeRoot\)/);
});


test("Bridge exposes original APT transaction operations", () => {
  const runtime = fs.readFileSync(path.join(root, "frontend/src/core/runtime.js"), "utf8");
  for (const operation of ["update", "install", "remove", "upgrade", "status", "cancel"]) {
    assert.match(runtime, new RegExp(`packages\\.apt\\.${operation}`));
  }
  assert.match(runtime, /navigator\.storage\?\.estimate/);
  assert.match(runtime, /apt-get install -y/);
  assert.match(runtime, /command\.replace\(\" -y\", \" --simulate\"\)/);
  assert.match(runtime, /bridgeCreateAptPackageCheckpoint/);
  assert.match(runtime, /evidence\?\.kind === \"apt-package-state\"/);
  assert.match(runtime, /checkpoint_id: checkpoint\?\.id \|\| null/);
});
